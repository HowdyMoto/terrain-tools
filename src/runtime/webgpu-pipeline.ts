import {
  RenderTarget,
  DepthTexture,
  HalfFloatType,
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
  velocity,
  nodeObject,
  convertToTexture,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import type { EnvironmentSettings } from '../core/environment';
import { TerrainWater } from './water';
import { terrainIndirect } from '../render/node-lighting';

/** Contracts: all intermediate color is linear HDR; depth is native WebGPU
 * [0,1]. Only RenderPipeline owns display conversion. Targets own their textures;
 * materials borrow them. Resize invalidates history, and dispose releases all. */
export const terrainPassContract = {
  color: 'linear-srgb-hdr',
  depth: 'webgpu-zero-to-one',
  outputs: ['output', 'normal', 'indirect', 'velocity'],
  displayOwner: 'post-processing',
} as const;

class WaterCapture {
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
      output: vec4(resolved, 1),
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
    if (!waters.length) {
      r.render(scene, camera);
      return;
    }
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

function terrainOutputs() {
  const indirect = Fn((builder) => {
    const material = builder.material as import('three').MeshStandardMaterial;
    return material.isMeshStandardMaterial ? terrainIndirect : vec3(0);
  })();
  return mrt({
    output,
    normal: packNormalToRGB(normalView),
    indirect: vec4(indirect, 1),
    velocity,
  });
}

const outputGraphs = new WeakMap<WebGPURenderer, ReturnType<typeof mrt>>();

export class WebGPUPipeline {
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
    let outputs = outputGraphs.get(renderer);
    if (!outputs) outputGraphs.set(renderer, (outputs = terrainOutputs()));
    this.outputs = outputs;
  }
  reset() {
    this.key = '';
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
    if (
      !this.post ||
      this.camera !== camera ||
      key !== this.key ||
      !size.equals(this.size)
    ) {
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
        const occlusion = ao(depth, this.pass.getTextureNode('normal'), camera);
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
        result = mix(nodeObject(result), temporal, color.a);
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
      this.post = new RenderPipeline(this.renderer, nodeObject(result));
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
    try {
      this.post.render();
    } finally {
      this.renderer.toneMapping = toneMapping;
      this.renderer.outputColorSpace = colorSpace;
      this.renderer.xr.enabled = xrEnabled;
      velocity.setProjectionMatrix(null);
      camera.view = view;
      camera.projectionMatrix.copy(projection);
      camera.projectionMatrixInverse.copy(inverse);
    }
  }
  private releasePasses() {
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
