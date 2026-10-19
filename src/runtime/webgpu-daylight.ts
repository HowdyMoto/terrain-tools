import {
  Color,
  Scene,
  Mesh,
  PMREMGenerator,
  RenderTarget,
  WebGPURenderer,
} from 'three/webgpu';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import {
  uniform,
  vec3,
  vec4,
  mix,
  positionWorld,
  cameraPosition,
  normalize,
  smoothstep,
  float,
} from 'three/tsl';
import type { EnvironmentSettings } from '../core/environment';
import { daylightState } from '../core/daylight';

/** Native node atmosphere and double-buffered linear HDR environment probe. */
export class WebGPUDaylight {
  readonly sky = new SkyMesh();
  private readonly captureScene = new Scene();
  private generator: PMREMGenerator;
  private front?: RenderTarget;
  private back?: RenderTarget;
  private age = 0;
  private lastHour = NaN;
  private day = uniform(1);
  private night = uniform(0.03);
  private intensity = uniform(1);
  private capturing = uniform(0);
  private ground = uniform(new Color());
  error?: string;
  get texture() {
    return this.front?.texture ?? null;
  }
  constructor(
    settings: EnvironmentSettings,
    private renderer: WebGPURenderer,
  ) {
    this.generator = new PMREMGenerator(renderer);
    this.sky.cloudDensity.value = 0;
    this.sky.cloudCoverage.value = 0;
    this.sky.cloudSpeed.value = 0;
    const radiance = this.sky.material
      .colorNode! as import('three/webgpu').Node<'vec4'>;
    const direction = normalize(positionWorld.sub(cameraPosition));
    const skyColor = mix(
      vec3(0.12, 0.2, 0.38).mul(this.night),
      radiance.rgb,
      this.day,
    );
    const groundColor = this.ground.mul(
      this.day.mul(0.28).add(this.night.mul(0.1)),
    );
    this.sky.material.colorNode = vec4(
      mix(
        skyColor,
        groundColor,
        float(1)
          .sub(smoothstep(-0.06, 0.02, direction.y))
          .mul(this.capturing),
      ).mul(this.intensity),
      1,
    );
    this.sky.name = 'Dynamic atmospheric sky (WebGPU)';
    this.sky.scale.setScalar(100000);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    this.sky.onBeforeRender = (_renderer, _scene, camera) => {
      camera.getWorldPosition(this.sky.position);
      this.sky.updateMatrixWorld();
    };
    const capture = new Mesh(this.sky.geometry, this.sky.material);
    capture.scale.setScalar(1000);
    capture.frustumCulled = false;
    this.captureScene.add(capture);
    try {
      this.set(settings, settings.timeOfDay!.hour);
      this.capture();
      this.capture();
      this.lastHour = settings.timeOfDay!.hour;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  set(settings: EnvironmentSettings, hour: number) {
    const cycle = settings.timeOfDay!,
      state = daylightState(cycle, hour);
    this.sky.sunPosition.value
      .set(state.x, state.y, state.z)
      .multiplyScalar(450000);
    this.sky.turbidity.value = cycle.haze;
    this.sky.rayleigh.value = cycle.rayleigh;
    this.day.value = state.day;
    this.night.value = cycle.nightBrightness;
    this.ground.value.set(settings.groundColor);
    this.intensity.value =
      settings.backgroundIntensity ?? settings.environmentIntensity;
    this.sky.visible = settings.showBackground;
  }
  tick(settings: EnvironmentSettings, hour: number, dt: number) {
    this.set(settings, hour);
    this.age += dt;
    if (this.age < 0.5 || hour === this.lastHour) return;
    this.age = 0;
    try {
      this.capture();
      this.lastHour = hour;
      this.error = undefined;
    } catch (error) {
      this.error = 'Sky reflections could not update: ' + String(error);
    }
  }
  private capture() {
    const target = this.renderer.getRenderTarget(),
      intensity = this.intensity.value;
    try {
      this.capturing.value = 1;
      this.intensity.value = 1;
      this.sky.showSunDisc.value = 0;
      const next = this.generator.fromScene(this.captureScene, 0, 0.1, 2000, {
        size: 128,
        renderTarget: this.back,
      });
      this.back = this.front;
      this.front = next;
    } finally {
      this.capturing.value = 0;
      this.intensity.value = intensity;
      this.sky.showSunDisc.value = 1;
      this.renderer.setRenderTarget(target);
    }
  }
  dispose() {
    this.sky.removeFromParent();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.front?.dispose();
    this.back?.dispose();
    this.generator.dispose();
  }
}
