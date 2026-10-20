import { validateGPU } from '../render/renderer';
import { compileInRenderContext } from '../render/prepare-geometry';
import { checkSignal } from '../render/resources';
import {
  RenderTarget,
  DepthTexture,
  HalfFloatType,
  FloatType,
  RedFormat,
  NearestFilter,
  UnsignedIntType,
  Vector2,
  Vector3,
  Matrix4,
  NodeMaterial,
  QuadMesh,
  AlwaysDepth,
  RenderPipeline,
  PassNode,
  Mesh,
  Line,
  Points,
  Sprite,
  WebGPUCoordinateSystem,
} from 'three/webgpu';
import type {
  WebGPURenderer,
  Scene,
  Camera,
  Node,
  NodeFrame,
  PerspectiveCamera,
  OrthographicCamera,
} from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  vec4,
  texture,
  uniform,
  uv,
  mix,
  exp,
  length,
  output,
  mrt,
  normalView,
  packNormalToRGB,
  nodeObject,
  convertToTexture,
  rtt,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import type { EnvironmentSettings } from '../core/environment';
import { TerrainWater } from './water';
import { terrainIndirect } from '../render/node-lighting';
import { beginFoliageMotionFrame } from '../render/foliage-motion';
import { TerrainVelocityNode } from '../render/native-velocity';
import { temporalHistoryConfidence } from '../render/temporal-history';

/** Contracts: all intermediate color is linear HDR; depth is native WebGPU
 * [0,1]. Only RenderPipeline owns display conversion. Targets own their textures;
 * materials borrow them. Resize invalidates history, and dispose releases all. */
export const terrainPassContract = {
  color: 'linear-srgb-hdr',
  depth: 'webgpu-zero-to-one',
  velocity: 'xy-ndc-motion-alpha-history-confidence',
  outputs: ['output', 'normal', 'indirect', 'velocity'],
  displayOwner: 'post-processing',
} as const;

class WaterCapture {
  callDepth = 2;
  readonly target = new RenderTarget(1, 1, {
    type: HalfFloatType,
    count: 4,
    depthTexture: new DepthTexture(1, 1, UnsignedIntType),
  });
  private material = new NodeMaterial();
  private quad = new QuadMesh(this.material);
  private underwater = uniform(0);
  private color = uniform(new Vector3());
  private visibility = uniform(1);
  private inverseProjection = uniform(new Matrix4());
  constructor(private renderer: WebGPURenderer) {
    terrainPassContract.outputs.forEach(
      (name, i) => (this.target.textures[i].name = name),
    );
    const source = texture(this.target.texture),
      depth = texture(this.target.depthTexture!);
    const p = this.inverseProjection.mul(
      vec4(uv().x.mul(2).sub(1), float(1).sub(uv().y.mul(2)), depth.r, 1),
    );
    const attenuation = exp(
      vec3(1.8, 0.85, 0.65).mul(
        length(p.xyz.div(p.w)).negate().div(this.visibility),
      ),
    );
    const resolved = mix(
      source.rgb,
      source.rgb
        .mul(attenuation)
        .add(vec3(this.color).mul(vec3(1).sub(attenuation))),
      this.underwater,
    );
    this.material.fragmentNode = mrt({
      output: vec4(resolved, source.a),
      normal: texture(this.target.textures[1]),
      indirect: texture(this.target.textures[2]),
      velocity: texture(this.target.textures[3]),
    });
    this.material.depthNode = depth.r;
    this.material.depthTest = true;
    this.material.depthWrite = true;
    this.material.depthFunc = AlwaysDepth;
  }
  render(scene: Scene, camera: Camera) {
    const waters: TerrainWater[] = [];
    scene.traverseVisible((o) => {
      if (o instanceof TerrainWater && o.surfaces.some((m) => m.visible))
        waters.push(o);
    });
    const r = this.renderer;
    this.callDepth =
      (r as WebGPURenderer & { _callDepth: number })._callDepth + 1;
    const target = r.getRenderTarget()!,
      autoClear = r.autoClear,
      background = scene.background;
    const surfaces = waters.flatMap((w) => w.surfaces.filter((m) => m.visible));
    const hidden: import('three').Object3D[] = [];
    this.target.setSize(target.width, target.height);
    try {
      surfaces.forEach((m) => (m.visible = false));
      r.setRenderTarget(this.target);
      r.autoClear = true;
      r.render(scene, camera);
      surfaces.forEach((m) => (m.visible = true));
      r.setRenderTarget(target);
      const volume = waters
        .map((w) => w.underwater(camera))
        .filter((v) => v !== undefined)
        .sort((a, b) => b.level - a.level)[0];
      this.underwater.value = volume ? 1 : 0;
      if (volume) {
        this.color.value
          .set(volume.color.r, volume.color.g, volume.color.b)
          .multiplyScalar(scene.environmentIntensity * 0.4);
        this.visibility.value = volume.visibility;
      }
      this.inverseProjection.value.copy(camera.projectionMatrixInverse);
      this.quad.render(r);
      if (!surfaces.length) return;
      scene.traverseVisible((o) => {
        if (
          (o instanceof Mesh ||
            o instanceof Line ||
            o instanceof Points ||
            o instanceof Sprite) &&
          !o.userData.waterOverlay &&
          !(
            o instanceof Mesh &&
            !Array.isArray(o.material) &&
            o.material.userData.terrainWater
          )
        )
          hidden.push(o);
      });
      hidden.forEach((o) => (o.visible = false));
      scene.background = null;
      r.autoClear = false;
      const size = new Vector2(target.width, target.height);
      for (const water of waters)
        water.capture(
          this.target.texture,
          this.target.depthTexture!,
          size,
          camera,
          true,
        );
      r.render(scene, camera);
    } finally {
      hidden.forEach((o) => (o.visible = true));
      surfaces.forEach((m) => (m.visible = true));
      scene.background = background;
      r.autoClear = autoClear;
      r.setRenderTarget(target);
    }
  }
  dispose() {
    this.target.dispose();
    this.material.dispose();
  }
}

/** One scene pass owns depth and the water capture, with explicit HDR outputs. */
class TerrainPass extends PassNode {
  constructor(
    scene: Scene,
    camera: Camera,
    private water: WaterCapture,
    samples: number,
    outputs: ReturnType<typeof mrt>,
  ) {
    super(PassNode.COLOR, scene, camera, { type: HalfFloatType, samples });
    for (const name of terrainPassContract.outputs) this.getTexture(name);
    this.setMRT(outputs);
  }
  override updateBefore(frame: NodeFrame): undefined {
    const r = frame.renderer as WebGPURenderer;
    const target = r.getRenderTarget(),
      previousMrt = r.getMRT();
    const size = r.getDrawingBufferSize(new Vector2());
    this.setSize(size.x, size.y);
    try {
      r.setRenderTarget(this.renderTarget);
      r.setMRT(this.getMRT());
      this.water.render(this.scene as Scene, this.camera);
    } finally {
      r.setRenderTarget(target);
      r.setMRT(previousMrt);
    }
  }
}

function terrainOutputs(velocity: TerrainVelocityNode) {
  const indirect = Fn((builder) => {
    const material = builder.material as import('three').MeshStandardMaterial;
    return material.isMeshStandardMaterial ? terrainIndirect : vec3(0);
  })();
  return mrt({
    output,
    normal: packNormalToRGB(normalView),
    indirect: vec4(indirect, 1),
    velocity: vec4(
      nodeObject(velocity) as unknown as Node<'vec2'>,
      0,
      temporalHistoryConfidence,
    ),
  });
}

const outputGraphs = new WeakMap<
  WebGPURenderer,
  {
    outputs: ReturnType<typeof mrt>;
    velocity: TerrainVelocityNode;
  }
>();

export class WebGPUPipeline {
  private motionFrame = 0;
  private historyReset = true;
  private compilation = Promise.resolve();
  private motionEpoch = {};
  private velocity: TerrainVelocityNode;
  private pass?: TerrainPass;
  private post?: RenderPipeline;
  private effects: { dispose(): void }[] = [];
  // Render contexts are keyed by MRT node identity in Three. Reuse this graph
  // across settings/history rebuilds instead of retaining one context per edit.
  private outputs: ReturnType<typeof mrt>;
  private occlusion?: ReturnType<typeof ao>;
  private sharpness = uniform(0);
  private key = '';
  private camera?: Camera;
  private size = new Vector2();
  private water: WaterCapture;
  constructor(private renderer: WebGPURenderer) {
    // Water materials retain these bindings across post-processing rebuilds.
    // Keep the capture alive until the entire environment is retired.
    this.water = new WaterCapture(renderer);
    let graph = outputGraphs.get(renderer);
    if (!graph) {
      const velocity = new TerrainVelocityNode();
      graph = { outputs: terrainOutputs(velocity), velocity };
      outputGraphs.set(renderer, graph);
    }
    this.outputs = graph.outputs;
    this.velocity = graph.velocity;
  }
  /** Prepares expensive water programs in the actual overlay MRT before tile
   * admission. Existing scene frames continue while native pipelines compile. */
  prepareWater(
    scene: Scene,
    camera: Camera,
    water: TerrainWater,
    signal: AbortSignal,
  ) {
    const operation = this.compilation
      .catch(() => {})
      .then(async () => {
        checkSignal(signal);
        if (!this.pass || !water.surfaces.length) return;
        const target = this.pass.renderTarget;
        const size = this.renderer.getDrawingBufferSize(new Vector2());
        water.capture(
          this.water.target.texture,
          this.water.target.depthTexture!,
          size,
          camera,
          true,
        );
        for (const mesh of water.surfaces) {
          checkSignal(signal);
          await validateGPU(this.renderer, () => {
            const visible = mesh.visible,
              culling = mesh.frustumCulled;
            try {
              mesh.visible = true;
              mesh.frustumCulled = false;
              return compileInRenderContext(
                this.renderer,
                mesh,
                camera,
                scene,
                target,
                this.outputs,
                signal,
                this.water.callDepth,
              );
            } finally {
              mesh.visible = visible;
              mesh.frustumCulled = culling;
            }
          });
        }
      });
    this.compilation = operation;
    return operation;
  }
  reset() {
    // Teleports invalidate history, not the render graph or compiled scene programs.
    this.historyReset = true;
    this.motionEpoch = {};
  }
  render(
    scene: Scene,
    camera: PerspectiveCamera | OrthographicCamera,
    settings: EnvironmentSettings,
  ) {
    // Normalize the camera before saving its unjittered projection. Otherwise a
    // first render restores a WebGL projection onto a now-WebGPU camera.
    if (camera.coordinateSystem !== WebGPUCoordinateSystem) {
      camera.coordinateSystem = WebGPUCoordinateSystem;
      camera.updateProjectionMatrix();
    }
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    const key = JSON.stringify([
      settings.ambientOcclusion?.enabled,
      settings.temporalAA,
    ]);
    if (!this.post || this.camera !== camera || key !== this.key) {
      this.releasePasses();
      this.key = key;
      this.camera = camera;
      this.size.copy(size);
      this.pass = new TerrainPass(
        scene,
        camera,
        this.water,
        settings.temporalAA ? 0 : this.renderer.samples,
        this.outputs,
      );
      this.pass.setSize(size.x, size.y);
      const color = this.pass.getTextureNode(),
        depth = this.pass.getTextureNode('depth');
      let result: Node<'vec4'> = color;
      if (settings.ambientOcclusion?.enabled) {
        // GTAO gathers neighboring depth samples, which WGSL does not support
        // on multisampled depth textures. Resolve sample zero to full-precision
        // R32F for this input while retaining MSAA on the scene color.
        const aoDepth =
          settings.temporalAA || !this.renderer.samples
            ? depth
            : rtt(vec4(depth.r), null, null, {
                type: FloatType,
                format: RedFormat,
                minFilter: NearestFilter,
                magFilter: NearestFilter,
                depthBuffer: false,
              });
        if (aoDepth !== depth)
          this.effects.push(aoDepth as ReturnType<typeof rtt>);
        const occlusion = ao(
          aoDepth,
          this.pass.getTextureNode('normal'),
          camera,
        );
        occlusion.radius.value = settings.ambientOcclusion.radius;
        occlusion.scale.value = settings.ambientOcclusion.strength;
        this.effects.push(occlusion);
        this.occlusion = occlusion;
        // Subtract only occluded indirect illumination: direct sun and leaf
        // transmission keep their original shadowed energy.
        result = vec4(
          color.rgb
            .sub(
              this.pass
                .getTextureNode('indirect')
                .rgb.mul(float(1).sub(occlusion.r)),
            )
            .max(0),
          color.a,
        );
      }
      if (settings.temporalAA) {
        const temporalInput = convertToTexture(result);
        if (temporalInput.isRTTNode) this.effects.push(temporalInput);
        const temporal = traa(
          temporalInput,
          depth,
          this.pass.getTextureNode('velocity'),
          camera,
        );
        // r186 has no public history reset. Seed its existing resolve/history
        // after the scene input updates instead of destroying the scene pass.
        // Keep this small version-specific adapter beside our other TRAA ownership fixes.
        const updateTemporal = temporal.updateBefore.bind(temporal);
        temporal.updateBefore = (frame) => {
          updateTemporal(frame);
          if (this.historyReset) {
            const targets = temporal as typeof temporal & {
              _historyRenderTarget: RenderTarget;
              _resolveRenderTarget: RenderTarget;
              setSize(width: number, height: number): void;
            };
            const input = temporal.beautyNode as typeof temporal.beautyNode & {
              isRTTNode?: boolean;
              renderTarget: RenderTarget;
              passNode: { renderTarget: RenderTarget };
            };
            const source = input.isRTTNode
              ? input.renderTarget
              : input.passNode.renderTarget;
            // An RTT input can acquire its actual size during the first resolve draw.
            // TRAA inspected its 1x1 bootstrap before that draw; seed at the now-current size.
            targets.setSize(source.width, source.height);
            const beauty = source.texture;
            this.renderer.initRenderTarget(targets._historyRenderTarget);
            this.renderer.initRenderTarget(targets._resolveRenderTarget);
            this.renderer.copyTextureToTexture(
              beauty,
              targets._historyRenderTarget.texture,
            );
            this.renderer.copyTextureToTexture(
              beauty,
              targets._resolveRenderTarget.texture,
            );
            this.historyReset = false;
          }
          return undefined;
        };
        // Three r186's TRAANode replaces its initial depth texture after the
        // first frame, but does not release it in dispose(). Retain ownership
        // here, separately from the history target that replaces its value.
        const initialDepth = (
          temporal as typeof temporal & {
            _previousDepthNode: { value: DepthTexture };
          }
        )._previousDepthNode.value;
        this.effects.push(temporal, initialDepth);
        // Binding setup can upload the 1×1 bootstrap history before its first
        // render. Register target ownership now so the first resize disposes
        // that upload as well (Three otherwise retains one texture per rebuild).
        const history = (
          temporal as typeof temporal & {
            _historyRenderTarget: RenderTarget;
          }
        )._historyRenderTarget;
        this.renderer.initRenderTarget(history);
        result = mix(
          nodeObject(result),
          temporal,
          this.pass.getTextureNode('velocity').a,
        );
        {
          const sharpenInput = convertToTexture(result);
          if (sharpenInput.isRTTNode) this.effects.push(sharpenInput);
          const sharpened = sharpen(
            sharpenInput,
            float(2).sub(this.sharpness.mul(2)),
            true,
          );
          this.effects.push(sharpened);
          result = mix(
            sharpenInput,
            sharpened,
            this.sharpness.greaterThan(0).select(1, 0),
          );
        }
      }
      this.post = new RenderPipeline(
        this.renderer,
        nodeObject(result).context({ velocity: this.velocity }),
      );
    }
    if (!size.equals(this.size)) {
      this.size.copy(size);
      this.pass?.setSize(size.x, size.y);
      this.reset();
    }
    if (this.occlusion && settings.ambientOcclusion) {
      this.occlusion.radius.value = settings.ambientOcclusion.radius;
      this.occlusion.scale.value = settings.ambientOcclusion.strength;
    }
    this.sharpness.value = settings.temporalSharpness ?? 0.25;
    const toneMapping = this.renderer.toneMapping,
      colorSpace = this.renderer.outputColorSpace,
      xrEnabled = this.renderer.xr.enabled;
    const projection = camera.projectionMatrix.clone(),
      inverse = camera.projectionMatrixInverse.clone();
    const view = camera.view ? { ...camera.view } : null;
    // PerspectiveCamera.setViewOffset also mutates aspect. TRAA can use its
    // 1x1 bootstrap target before the first resize; restoring only the matrix
    // leaves later unjittered projections built with the wrong aspect ratio.
    const perspective = camera as PerspectiveCamera;
    const aspect = perspective.isPerspectiveCamera
      ? perspective.aspect
      : undefined;
    const matrixWorldAutoUpdate = scene.matrixWorldAutoUpdate;
    const endMotionFrame = beginFoliageMotionFrame(this.renderer, {
      serial: ++this.motionFrame,
      epoch: this.motionEpoch,
    });
    try {
      // Opaque capture, water and cascades render the same scene repeatedly.
      // Update transforms once per composed frame, respecting host ownership.
      if (matrixWorldAutoUpdate) scene.updateMatrixWorld();
      scene.matrixWorldAutoUpdate = false;
      this.post.render();
    } catch (error) {
      // A partial composition must not become valid deformation history.
      this.motionEpoch = {};
      throw error;
    } finally {
      endMotionFrame();
      scene.matrixWorldAutoUpdate = matrixWorldAutoUpdate;
      this.renderer.toneMapping = toneMapping;
      this.renderer.outputColorSpace = colorSpace;
      this.renderer.xr.enabled = xrEnabled;
      this.velocity.setProjectionMatrix(null);
      camera.view = view;
      if (aspect !== undefined) perspective.aspect = aspect;
      camera.projectionMatrix.copy(projection);
      camera.projectionMatrixInverse.copy(inverse);
    }
  }
  private releasePasses() {
    this.motionEpoch = {};
    this.historyReset = true;
    this.effects.forEach((effect) => effect.dispose());
    this.effects = [];
    this.occlusion = undefined;
    this.pass?.dispose();
    this.post?.dispose();
    this.pass = undefined;
    this.post = undefined;
  }
  dispose() {
    this.releasePasses();
    this.water.dispose();
  }
}
