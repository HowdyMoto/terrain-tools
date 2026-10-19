/** Observe the camera actually bound to native draws, without editor test hooks.
 * WGSL reflection is limited to Three's scalar/vector/matrix camera uniform block. */
export function installNavigationProbe() {
  const modules = new WeakMap(),
    pipelines = new WeakMap(),
    groups = new WeakMap(),
    data = new WeakMap(),
    passes = new WeakMap();
  window.navigationFrames = 0;
  const module = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (descriptor) {
    const result = module.call(this, descriptor),
      code = descriptor.code;
    const block = /struct renderStruct\s*\{([\s\S]*?)\}/.exec(code);
    const binding =
      /@binding\(\s*(\d+)\s*\)\s*@group\(\s*(\d+)\s*\)\s*var<uniform> render/.exec(
        code,
      );
    if (block && binding) {
      let offset = 0,
        valid = true;
      const fields = {};
      for (const member of block[1].trim().split(',')) {
        const match = /([a-zA-Z0-9_]+)\s*:\s*(\S+)/.exec(member.trim());
        if (!match) continue;
        const [, name, type] = match;
        const sizes = {
          f32: [4, 4],
          u32: [4, 4],
          i32: [4, 4],
          'vec2<f32>': [8, 8],
          'vec3<f32>': [16, 12],
          'vec4<f32>': [16, 16],
          'mat3x3<f32>': [16, 48],
          'mat4x4<f32>': [16, 64],
        };
        const size = sizes[type];
        if (!size) {
          valid = false;
          break;
        }
        offset = Math.ceil(offset / size[0]) * size[0];
        fields[name] = offset;
        offset += size[1];
        if (
          fields.cameraViewMatrix !== undefined &&
          fields.cameraProjectionMatrix !== undefined
        )
          break;
      }
      if (
        valid &&
        fields.cameraViewMatrix !== undefined &&
        fields.cameraProjectionMatrix !== undefined
      ) {
        modules.set(result, {
          fields,
          binding: Number(binding[1]),
          group: Number(binding[2]),
        });
      }
    }
    return result;
  };
  for (const name of ['createRenderPipeline', 'createRenderPipelineAsync']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function (descriptor) {
      const result = original.call(this, descriptor),
        layout = modules.get(descriptor.vertex.module);
      if (result instanceof Promise)
        return result.then((p) => {
          pipelines.set(p, layout);
          return p;
        });
      pipelines.set(result, layout);
      return result;
    };
  }
  const bind = GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup = function (descriptor) {
    const group = bind.call(this, descriptor);
    groups.set(
      group,
      descriptor.entries.map((e) => ({
        binding: e.binding,
        resource: e.resource.buffer ? { ...e.resource } : e.resource,
      })),
    );
    return group;
  };
  const write = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function (
    buffer,
    offset,
    source,
    start = 0,
    size,
  ) {
    if (buffer.usage & GPUBufferUsage.UNIFORM) {
      const bytes =
        source instanceof ArrayBuffer
          ? new Uint8Array(source)
          : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      const stride = source.BYTES_PER_ELEMENT ?? 1;
      const copy = data.get(buffer) ?? new Uint8Array(buffer.size);
      copy.set(
        bytes.subarray(
          start * stride,
          size === undefined ? undefined : (start + size) * stride,
        ),
        offset,
      );
      data.set(buffer, copy);
    }
    return write.call(this, buffer, offset, source, start, size);
  };
  const pipeline = GPURenderPassEncoder.prototype.setPipeline;
  GPURenderPassEncoder.prototype.setPipeline = function (value) {
    const state = passes.get(this) ?? { groups: [] };
    state.layout = pipelines.get(value);
    passes.set(this, state);
    return pipeline.call(this, value);
  };
  const setGroup = GPURenderPassEncoder.prototype.setBindGroup;
  GPURenderPassEncoder.prototype.setBindGroup = function (
    index,
    value,
    ...rest
  ) {
    const state = passes.get(this) ?? { groups: [] };
    state.groups[index] = value;
    passes.set(this, state);
    return setGroup.call(this, index, value, ...rest);
  };
  for (const name of ['draw', 'drawIndexed']) {
    const draw = GPURenderPassEncoder.prototype[name];
    GPURenderPassEncoder.prototype[name] = function (...args) {
      const state = passes.get(this),
        layout = state?.layout;
      if (layout) {
        const resource = groups
          .get(state.groups[layout.group])
          ?.find((e) => e.binding === layout.binding)?.resource;
        const bytes = data.get(resource?.buffer);
        if (bytes) {
          const offset = resource.offset ?? 0;
          const projection = new Float32Array(
            bytes.buffer,
            offset + layout.fields.cameraProjectionMatrix,
            16,
          );
          // Reject orthographic shadow and fullscreen passes.
          if (projection[15] === 0 && projection[11] === -1)
            window.navigationView = [
              ...new Float32Array(
                bytes.buffer,
                offset + layout.fields.cameraViewMatrix,
                16,
              ),
            ];
        }
      }
      return draw.apply(this, args);
    };
  }
  const done = GPUQueue.prototype.onSubmittedWorkDone;
  GPUQueue.prototype.onSubmittedWorkDone = function () {
    const promise = done.call(this);
    window.navigationFrames++;
    const probe = window.walkPacingProbe,
      canvas = document.querySelector('#viewport canvas');
    if (probe && canvas) {
      probe.frames.push({
        view: window.navigationView,
        width: canvas.width,
        height: canvas.height,
      });
      if (probe.blocked) {
        probe.waits.push(0);
        return promise.then(
          () =>
            new Promise((resolve) => {
              probe.release = resolve;
            }),
        );
      }
    }
    return promise;
  };
}
