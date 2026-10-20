import type { Camera, Object3D, Scene, RenderTarget } from 'three';
import type { WebGPURenderer, MRTNode } from 'three/webgpu';
import { checkSignal } from './resources';

/** Three r186's asynchronous builder reads renderer target/MRT state after
 * yielding. Give builders a stable view while the live renderer keeps drawing.
 * Only classification state is shadowed; the backend, scene, library and resource
 * managers remain shared. No second device/canvas is created. */
export async function compileInRenderContext(
  renderer: WebGPURenderer,
  object: Object3D,
  camera: Camera,
  scene: Scene,
  target: RenderTarget,
  outputs: MRTNode,
  signal: AbortSignal,
  callDepth = 0,
) {
  checkSignal(signal);
  const previousTarget = renderer.getRenderTarget(),
    previousMRT = renderer.getMRT();
  const previousHook = renderer.debug.onNodeBuilderCreated;
  const view = Object.create(renderer) as WebGPURenderer;
  Object.assign(view, { _renderTarget: target, _mrt: outputs });
  const hook: NonNullable<typeof previousHook> = (builder, record) => {
    previousHook?.(builder, record);
    const context = record as { context?: { textures?: unknown[] } };
    if (context.context?.textures?.[0] === target.texture)
      builder.renderer = view;
  };
  renderer.debug.onNodeBuilderCreated = hook;
  // compileAsync hardcodes nesting depth zero; composed scene passes render
  // inside the output quad. Route only that initial lookup to the real context.
  const contexts = (
    renderer as unknown as {
      _renderContexts: {
        get(
          target: RenderTarget | null,
          mrt?: MRTNode | null,
          depth?: number,
        ): unknown;
      };
    }
  )._renderContexts;
  const getContext = contexts.get;
  contexts.get = function (rt, mrt, depth) {
    return getContext.call(
      this,
      rt,
      mrt,
      depth ?? (rt === target && mrt === outputs ? callDepth : 0),
    );
  };
  let operation: Promise<unknown>;
  try {
    try {
      renderer.setRenderTarget(target);
      renderer.setMRT(outputs);
      operation = renderer.compileAsync(object, camera, scene);
    } finally {
      contexts.get = getContext;
      renderer.setRenderTarget(previousTarget);
      renderer.setMRT(previousMRT);
    }
    await operation;
    checkSignal(signal);
  } finally {
    if (renderer.debug.onNodeBuilderCreated === hook)
      renderer.debug.onNodeBuilderCreated = previousHook;
  }
}
