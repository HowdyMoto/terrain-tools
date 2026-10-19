import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { daylightState } from '../core/daylight';
import type { EnvironmentSettings } from '../core/environment';

/** Atmospheric background plus bounded, double-buffered PBR illumination.
 * Prepare before publishing: initial capture/filter allocation can fail without touching a scene. */
export class DaylightSky {
  readonly sky = new Sky();
  private readonly captureScene = new THREE.Scene();
  private cube?: THREE.WebGLCubeRenderTarget;
  private camera?: THREE.CubeCamera;
  private generator?: THREE.PMREMGenerator;
  private front?: THREE.WebGLRenderTarget;
  private back?: THREE.WebGLRenderTarget;
  private age = 0;
  private lastHour = NaN;
  error?: string;
  get texture() {
    return this.front?.texture ?? null;
  }
  constructor(
    settings: EnvironmentSettings,
    private renderer?: THREE.WebGLRenderer,
  ) {
    try {
      const material = this.sky.material;
      Object.assign(material.uniforms, {
        terrainDay: { value: 1 },
        terrainNight: { value: 0.03 },
        terrainDisc: { value: 1 },
        terrainIntensity: { value: 1 },
        terrainGround: { value: new THREE.Color(settings.groundColor) },
      });
      material.fragmentShader = material.fragmentShader
        .replace(
          'uniform float mieDirectionalG;',
          `uniform float mieDirectionalG;
          uniform float terrainDay, terrainNight, terrainDisc, terrainIntensity;
          uniform vec3 terrainGround;`,
        )
        .replace(
          'float sundisk = smoothstep(',
          'float sundisk = terrainDisc * smoothstep(',
        )
        .replace(
          'gl_FragColor = vec4( retColor, 1.0 );',
          `
          vec3 night = vec3(0.12, 0.20, 0.38) * terrainNight;
          vec3 radiance = mix(night, retColor, terrainDay);
          vec3 ground = terrainGround * (0.28 * terrainDay + terrainNight * 0.1);
          // Ground bounce belongs in the illumination probe. Keep the visible horizon continuous.
          float groundWeight = (1.0 - terrainDisc) * (1.0 - smoothstep(-0.06, 0.02, direction.y));
          radiance = mix(radiance, ground, groundWeight);
          gl_FragColor = vec4(radiance * terrainIntensity, 1.0);`,
        );
      this.sky.name = 'Dynamic atmospheric sky';
      this.sky.scale.setScalar(100000);
      this.sky.frustumCulled = false;
      this.sky.renderOrder = -1000;
      this.sky.onBeforeRender = (_renderer, _scene, camera) => {
        camera.getWorldPosition(this.sky.position);
        this.sky.updateMatrixWorld();
      };
      const capture = new THREE.Mesh(this.sky.geometry, material);
      capture.scale.setScalar(1000);
      capture.frustumCulled = false;
      this.captureScene.add(capture);
      this.set(settings, settings.timeOfDay!.hour);
      if (renderer) {
        this.cube = new THREE.WebGLCubeRenderTarget(128, {
          type: THREE.HalfFloatType,
          generateMipmaps: false,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: false,
        });
        this.camera = new THREE.CubeCamera(0.1, 2000, this.cube);
        this.generator = new THREE.PMREMGenerator(renderer);
        this.capture();
        // Allocate both outputs during preparation, then reuse them during playback.
        this.capture();
      }
      this.lastHour = settings.timeOfDay!.hour;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  set(settings: EnvironmentSettings, hour: number) {
    const cycle = settings.timeOfDay!,
      state = daylightState(cycle, hour);
    const uniforms = this.sky.material.uniforms;
    uniforms.sunPosition.value
      .set(state.x, state.y, state.z)
      .multiplyScalar(450000);
    uniforms.turbidity.value = cycle.haze;
    uniforms.rayleigh.value = cycle.rayleigh;
    uniforms.terrainDay.value = state.day;
    uniforms.terrainNight.value = cycle.nightBrightness;
    uniforms.terrainGround.value.set(settings.groundColor);
    uniforms.terrainIntensity.value =
      settings.backgroundIntensity ?? settings.environmentIntensity;
    this.sky.visible = settings.showBackground;
  }
  /** Reflections update at most twice a second and only after the solar clock moves. */
  tick(settings: EnvironmentSettings, hour: number, dt: number) {
    this.set(settings, hour);
    this.age += dt;
    if (!this.renderer || this.age < 0.5 || hour === this.lastHour) return;
    this.age = 0;
    try {
      this.capture();
      this.lastHour = hour;
      this.error = undefined;
    } catch (error) {
      // Retain the last complete front buffer. A later tick can retry the back buffer.
      this.error = 'Sky reflections could not update: ' + String(error);
    }
  }
  private capture() {
    const renderer = this.renderer!,
      uniforms = this.sky.material.uniforms;
    const target = renderer.getRenderTarget(),
      face = renderer.getActiveCubeFace(),
      mip = renderer.getActiveMipmapLevel(),
      xr = renderer.xr.enabled;
    const intensity = uniforms.terrainIntensity.value;
    const toneMapping = renderer.toneMapping,
      autoClear = renderer.autoClear;
    try {
      // Direct sunlight comes from the shadow-casting sun, not a second solar disc in IBL.
      uniforms.terrainDisc.value = 0;
      uniforms.terrainIntensity.value = 1;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.autoClear = true;
      this.camera!.update(renderer, this.captureScene);
      const next = this.generator!.fromCubemap(this.cube!.texture, this.back);
      this.back = this.front;
      this.front = next;
    } finally {
      uniforms.terrainDisc.value = 1;
      uniforms.terrainIntensity.value = intensity;
      renderer.toneMapping = toneMapping;
      renderer.autoClear = autoClear;
      renderer.xr.enabled = xr;
      renderer.setRenderTarget(target, face, mip);
    }
  }
  dispose() {
    this.sky.removeFromParent();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.front?.dispose();
    this.back?.dispose();
    this.cube?.dispose();
    this.generator?.dispose();
  }
}
