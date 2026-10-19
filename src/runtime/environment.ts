import * as THREE from 'three';
import { installTerrainLighting } from '../render/node-lighting';
import { isWebGPU, validateGPU } from '../render/renderer';
import type { TerrainRenderer } from '../render/renderer';
import { WebGPUDaylight } from './webgpu-daylight';
import { WebGPUPipeline } from './webgpu-pipeline';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { inspectEnvironmentEXR } from './environment-exr';
import {
  defaultEnvironmentSettings,
  parseEnvironmentSettings,
} from '../core/environment';
import type { EnvironmentSettings } from '../core/environment';
import type { TerrainProject } from '../core/types';
import { daylightState, wrapSolarHour } from '../core/daylight';
import { DaylightSky } from './daylight-sky';
import { CascadedSun } from './cascaded-sun';
import { WaterPass } from './water-pass';
import { AmbientOcclusion } from './ambient-occlusion';
import { TemporalAA } from './temporal-aa';

export const MAX_ENVIRONMENT_BYTES = 32_000_000;
/** Validate a supported scanline OpenEXR panorama before decoding. */
export function validateEnvironmentEXR(buffer: ArrayBuffer) {
  if (buffer.byteLength > MAX_ENVIRONMENT_BYTES)
    throw new Error('HDR/EXR environment must be under 32 MB.');
  const { width, height } = inspectEnvironmentEXR(buffer);
  return { width, height };
}
/** Validate dimensions and complete pixel/RLE payload before the HDR loader allocates. */
export function validateEnvironmentHDR(buffer: ArrayBuffer) {
  if (buffer.byteLength > MAX_ENVIRONMENT_BYTES)
    throw new Error('HDR environment must be under 32 MB.');
  const bytes = new Uint8Array(buffer);
  const header = new TextDecoder().decode(bytes.subarray(0, 65536));
  const dimensions = /^\s*-Y[ \t]+(\d+)[ \t]+\+X[ \t]+(\d+)[ \t]*\r?\n/m.exec(
    header,
  );
  if (
    !/^#\?(RADIANCE|RGBE)\r?\n/.test(header) ||
    !dimensions ||
    !/^FORMAT=32-bit_rle_rgbe\s*$/m.test(header.slice(0, dimensions.index))
  )
    throw new Error('Expected a Radiance RGBE HDR with -Y / +X orientation.');
  const width = Number(dimensions[2]),
    height = Number(dimensions[1]);
  if (
    width < 64 ||
    height < 32 ||
    width > 4096 ||
    height > 2048 ||
    width !== height * 2
  )
    throw new Error(
      'Environment must be 2:1 equirectangular, from 64 × 32 to 4096 × 2048.',
    );
  let offset = dimensions.index + dimensions[0].length;
  // Headers are ASCII, so this offset also addresses the original byte buffer.
  if (
    header
      .slice(0, offset)
      .split('')
      .some((c) => c.charCodeAt(0) > 127)
  )
    throw new Error('HDR header must be ASCII.');
  const flat =
    bytes[offset] !== 2 || bytes[offset + 1] !== 2 || bytes[offset + 2] & 128;
  if (flat) {
    if (bytes.length - offset !== width * height * 4)
      throw new Error('Truncated or unsupported flat HDR pixels.');
  } else {
    for (let y = 0; y < height; y++) {
      if (
        offset + 4 > bytes.length ||
        bytes[offset] !== 2 ||
        bytes[offset + 1] !== 2 ||
        ((bytes[offset + 2] << 8) | bytes[offset + 3]) !== width
      )
        throw new Error('Truncated or invalid HDR scanline.');
      offset += 4;
      for (let channel = 0; channel < 4; channel++) {
        let x = 0;
        while (x < width) {
          const count = bytes[offset++],
            run = count > 128,
            length = run ? count - 128 : count;
          if (
            !length ||
            x + length > width ||
            offset + (run ? 1 : length) > bytes.length
          )
            throw new Error('Truncated or invalid HDR run.');
          offset += run ? 1 : length;
          x += length;
        }
      }
    }
    if (offset !== bytes.length)
      throw new Error('Unexpected data after HDR pixels.');
  }
  return { width, height };
}
function skyTexture(settings: EnvironmentSettings) {
  const width = 512,
    height = 256,
    data = new Uint16Array(width * height * 4);
  const zenith = new THREE.Color(settings.skyColor),
    horizon = new THREE.Color(settings.horizonColor);
  const ground = new THREE.Color(settings.groundColor),
    color = new THREE.Color();
  for (let y = 0; y < height; y++) {
    const elevation = Math.cos((y / (height - 1)) * Math.PI);
    color
      .copy(horizon)
      .lerp(
        elevation >= 0 ? zenith : ground,
        Math.pow(Math.abs(elevation), 0.45),
      );
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = THREE.DataUtils.toHalfFloat(color.r);
      data[i + 1] = THREE.DataUtils.toHalfFloat(color.g);
      data[i + 2] = THREE.DataUtils.toHalfFloat(color.b);
      data[i + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  return configureTexture(
    new THREE.DataTexture(
      data,
      width,
      height,
      THREE.RGBAFormat,
      THREE.HalfFloatType,
    ),
  );
}
function configureTexture(texture: THREE.DataTexture) {
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = true;
  texture.needsUpdate = true;
  return texture;
}
function textureSourceKey(settings: EnvironmentSettings) {
  if (settings.timeOfDay?.enabled)
    return JSON.stringify([
      'daylight',
      settings.timeOfDay,
      settings.groundColor,
    ]);
  return settings.mode === 'image'
    ? settings.image!.data
    : settings.mode === 'sky'
      ? [
          settings.mode,
          settings.skyColor,
          settings.horizonColor,
          settings.groundColor,
        ].join('|')
      : 'none';
}
function sourceKey(settings: EnvironmentSettings) {
  return JSON.stringify([
    textureSourceKey(settings),
    settings.shadows,
    settings.shadowCascades ?? 1,
    settings.shadowResolution,
    settings.ambientOcclusion?.enabled ?? false,
    settings.temporalAA ?? false,
  ]);
}
/** Prepared resources remain isolated until applied; dispose unused candidates. */
export class PreparedEnvironment {
  disposed = false;
  readonly key: string;
  constructor(
    public settings: EnvironmentSettings,
    readonly texture: THREE.Texture | null,
    readonly daylight?: DaylightSky | WebGPUDaylight,
    readonly cascades?: CascadedSun,
    readonly occlusion?: AmbientOcclusion,
    readonly temporal?: TemporalAA,
  ) {
    this.key = sourceKey(settings);
  }
  dispose() {
    if (!this.disposed) {
      if (this.daylight) this.daylight.dispose();
      else this.texture?.dispose();
      this.cascades?.dispose();
      this.occlusion?.dispose();
      this.temporal?.dispose();
      this.disposed = true;
    }
  }
}
function preparedResources(
  settings: EnvironmentSettings,
  texture: THREE.Texture | null,
  daylight?: DaylightSky | WebGPUDaylight,
  renderer?: TerrainRenderer,
) {
  let cascades: CascadedSun | undefined;
  let occlusion: AmbientOcclusion | undefined;
  try {
    cascades =
      settings.shadows && settings.shadowCascades === 3
        ? new CascadedSun(settings, isWebGPU(renderer) ? undefined : renderer)
        : undefined;
    occlusion =
      settings.ambientOcclusion?.enabled && renderer && !isWebGPU(renderer)
        ? new AmbientOcclusion(renderer)
        : undefined;
    return new PreparedEnvironment(
      settings,
      texture,
      daylight,
      cascades,
      occlusion,
      settings.temporalAA && renderer && !isWebGPU(renderer)
        ? new TemporalAA(renderer)
        : undefined,
    );
  } catch (error) {
    if (daylight) daylight.dispose();
    else texture?.dispose();
    cascades?.dispose();
    occlusion?.dispose();
    throw error;
  }
}
export async function prepareEnvironment(
  value = defaultEnvironmentSettings(),
  renderer?: TerrainRenderer,
): Promise<PreparedEnvironment> {
  const settings = parseEnvironmentSettings(value);
  if (settings.timeOfDay?.enabled) {
    const daylight = isWebGPU(renderer)
      ? new WebGPUDaylight(settings, renderer)
      : new DaylightSky(settings, renderer);
    return preparedResources(settings, daylight.texture, daylight, renderer);
  }
  if (settings.mode !== 'image')
    return preparedResources(
      settings,
      settings.mode === 'sky' ? skyTexture(settings) : null,
      undefined,
      renderer,
    );
  const binary = atob(settings.image!.data.split(',')[1]);
  if (binary.length > MAX_ENVIRONMENT_BYTES)
    throw new Error('HDR/EXR environment must be under 32 MB.');
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const isEXR =
    bytes.length >= 4 &&
    new DataView(bytes.buffer).getUint32(0, true) === 20000630;
  let decoded;
  if (isEXR) {
    const inspected = inspectEnvironmentEXR(bytes.buffer);
    const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js');
    // Validate FLOAT input before conversion: HalfFloat conversion clamps infinities.
    const parsed = new EXRLoader()
      .setDataType(THREE.FloatType)
      .parse(inspected.buffer);
    if (!parsed.data) throw new Error('Incomplete EXR pixels.');
    const data = new Uint16Array(parsed.data.length);
    for (let i = 0; i < parsed.data.length; i++) {
      const value = parsed.data[i];
      if (!Number.isFinite(value))
        throw new Error('HDR/EXR environment contains non-finite radiance.');
      data[i] = THREE.DataUtils.toHalfFloat(
        Math.max(-65504, Math.min(65504, value)),
      );
    }
    decoded = { ...parsed, data };
  } else {
    validateEnvironmentHDR(bytes.buffer);
    decoded = new HDRLoader()
      .setDataType(THREE.HalfFloatType)
      .parse(bytes.buffer);
  }
  if (
    !decoded.data ||
    !decoded.width ||
    !decoded.height ||
    decoded.data.length !== decoded.width * decoded.height * 4
  )
    throw new Error('Incomplete HDR/EXR pixels.');
  for (const value of decoded.data)
    if ((value & 0x7c00) === 0x7c00)
      throw new Error('HDR/EXR environment contains non-finite radiance.');
  const texture = configureTexture(
    new THREE.DataTexture(
      decoded.data,
      decoded.width,
      decoded.height,
      THREE.RGBAFormat,
      THREE.HalfFloatType,
    ),
  );
  // EXRLoader already flips its scanlines; HDRLoader leaves them top-to-bottom.
  texture.flipY = !isEXR;
  return preparedResources(settings, texture, undefined, renderer);
}
type DisplayRenderer = Pick<
  THREE.WebGLRenderer,
  'toneMapping' | 'toneMappingExposure'
>;
/**
 * Optional authored lighting for an application's scene. It owns its lights,
 * source environment texture and scene display settings, not terrain geometry.
 * Three.js generates/caches PMREM maps and releases them when the source is disposed.
 */
export class TerrainEnvironment {
  private sunLight = new THREE.DirectionalLight();
  /** Authored sun. Native shadow layout changes replace its GPU light identity. */
  get sun() {
    return this.sunLight;
  }
  readonly ambient = new THREE.HemisphereLight();
  private readonly group = new THREE.Group();
  private prepared?: PreparedEnvironment;
  private revision = 0;
  private disposed = false;
  private waterPass?: WaterPass;
  private gpuPipeline?: WebGPUPipeline;
  private gpuCascades?: CSMShadowNode;
  private cascadeProjection = '';
  private releaseGPUCascades() {
    // CSM's lightweight lights are Object3D instances, not DirectionalLights;
    // their dispose() does not release the child ShadowNodes in Three r186.
    (
      this.gpuCascades as
        (CSMShadowNode & { _shadowNodes: { dispose(): void }[] }) | undefined
    )?._shadowNodes.forEach((node) => node.dispose());
    this.gpuCascades?.lights.forEach((light) => {
      light.shadow?.dispose();
      light.dispose();
    });
    this.gpuCascades?.dispose();
    this.gpuCascades = undefined;
    this.cascadeProjection = '';
    this.sun.shadow.shadowNode = undefined;
  }
  private replaceGPUSun() {
    const previous = this.sun;
    this.sunLight = previous.clone();
    this.sun.shadow.shadowNode = undefined;
    this.group.remove(previous, previous.target);
    previous.dispose();
    this.group.add(this.sun, this.sun.target);
  }
  private hour = 12;
  private shadowCenter = 0;
  private shadowRadius = 1;
  /** Current preview time; ticking never mutates the authored document or history. */
  get solarHour() {
    return this.hour;
  }
  get cycleState() {
    const cycle = this.prepared?.settings.timeOfDay;
    return cycle?.enabled ? daylightState(cycle, this.hour) : undefined;
  }
  get animationError() {
    return (
      this.prepared?.daylight?.error ??
      this.prepared?.occlusion?.error ??
      this.prepared?.temporal?.error ??
      this.waterPass?.error
    );
  }
  private get webGLRenderer() {
    const renderer = this.renderer as
      (THREE.WebGLRenderer & { isWebGLRenderer?: boolean }) | undefined;
    return renderer?.isWebGLRenderer ? renderer : undefined;
  }
  /** Stage atmospheric GPU resources as well as static environment textures. */
  async prepare(value?: EnvironmentSettings) {
    const renderer = isWebGPU(this.renderer)
      ? this.renderer
      : this.webGLRenderer;
    if (!isWebGPU(renderer)) return prepareEnvironment(value, renderer);
    let prepared: PreparedEnvironment | undefined;
    try {
      return await validateGPU(renderer, async () => {
        prepared = await prepareEnvironment(value, renderer);
        this.preflightNative(prepared);
        return prepared;
      });
    } catch (error) {
      prepared?.dispose();
      throw error;
    }
  }
  /** Exercise native shadow and screen targets offscreen before a document
   * transaction can adopt this look. The probe borrows the candidate texture;
   * it never edits the live scene or presents a frame to the canvas. */
  private preflightNative(prepared: PreparedEnvironment) {
    const renderer = this.renderer;
    if (!isWebGPU(renderer)) return;
    const scene = new THREE.Scene();
    const probe = new TerrainEnvironment(scene, renderer);
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const material = new THREE.MeshStandardMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const camera = new THREE.PerspectiveCamera(
      50,
      size.x / Math.max(1, size.y),
      0.1,
      100,
    );
    camera.position.set(5, 5, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const target = new THREE.RenderTarget(size.x, size.y);
    const previousTarget = renderer.getRenderTarget(),
      previousMRT = renderer.getMRT();
    try {
      probe.prepared = prepared;
      probe.scene.environment = prepared.texture;
      probe.update(prepared.settings, {
        size: 16,
        heights: new Float32Array([0]),
      });
      renderer.initRenderTarget(target);
      renderer.setRenderTarget(target);
      renderer.setMRT(null);
      probe.render(camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setMRT(previousMRT);
      probe.prepared = undefined;
      probe.dispose();
      geometry.dispose();
      material.dispose();
      mesh.dispose();
      target.dispose();
    }
  }
  private readonly previous;
  constructor(
    readonly scene: THREE.Scene,
    private renderer?: DisplayRenderer,
  ) {
    if (isWebGPU(renderer)) installTerrainLighting(renderer);
    this.previous = {
      background: scene.background,
      environment: scene.environment,
      fog: scene.fog,
      environmentIntensity: scene.environmentIntensity,
      backgroundIntensity: scene.backgroundIntensity,
      backgroundBlurriness: scene.backgroundBlurriness,
      environmentRotation: scene.environmentRotation.clone(),
      backgroundRotation: scene.backgroundRotation.clone(),
      toneMapping: renderer?.toneMapping,
      exposure: renderer?.toneMappingExposure,
    };
    this.group.name = 'Terrain environment';
    this.sun.name = 'Authored sun';
    this.ambient.name = 'Authored ambient fill';
    this.group.add(this.sun, this.sun.target, this.ambient);
    scene.add(this.group);
  }
  /** Takes ownership of the prepared resources. */
  apply(
    prepared: PreparedEnvironment,
    project: Pick<TerrainProject, 'size' | 'heights'>,
  ) {
    if (this.disposed || prepared.disposed)
      throw new Error('Environment resources have been disposed.');
    this.revision++;
    const old = this.prepared;
    if (
      isWebGPU(this.renderer) &&
      old &&
      [
        old.settings.shadows,
        old.settings.shadowCascades,
        old.settings.shadowResolution,
      ].join('|') !==
        [
          prepared.settings.shadows,
          prepared.settings.shadowCascades,
          prepared.settings.shadowResolution,
        ].join('|')
    ) {
      this.releaseGPUCascades();
      // Native LightsNode keys shadow layout by light identity/castShadow, not
      // by a changed custom shadow node. Retire the old light to rebuild bindings.
      this.replaceGPUSun();
    }
    this.gpuPipeline?.reset();
    this.prepared = prepared;
    this.sun.visible = true;
    if (prepared.daylight) this.group.add(prepared.daylight.sky);
    this.scene.environment = prepared.texture;
    this.update(prepared.settings, project);
    if (old !== prepared) old?.dispose();
  }
  matchesSource(settings: EnvironmentSettings) {
    return this.prepared?.key === sourceKey(settings);
  }
  /** Synchronous parameter/preset updates; an unprepared HDR/EXR image must use load/prepare. */
  set(
    value: EnvironmentSettings | undefined,
    project: Pick<TerrainProject, 'size' | 'heights'>,
  ) {
    const settings = parseEnvironmentSettings(
      value ?? defaultEnvironmentSettings(),
    );
    if (this.disposed) throw new Error('Environment has been disposed.');
    const key = sourceKey(settings);
    if (this.prepared?.key !== key) {
      if (settings.mode === 'image')
        throw new Error('Prepare the HDR/EXR environment before applying it.');
      const daylight = settings.timeOfDay?.enabled
        ? isWebGPU(this.renderer)
          ? new WebGPUDaylight(settings, this.renderer)
          : new DaylightSky(settings, this.webGLRenderer)
        : undefined;
      this.apply(
        preparedResources(
          settings,
          daylight
            ? daylight.texture
            : settings.mode === 'sky'
              ? skyTexture(settings)
              : null,
          daylight,
          isWebGPU(this.renderer) ? this.renderer : this.webGLRenderer,
        ),
        project,
      );
    } else {
      this.revision++;
      this.update(settings, project);
    }
  }
  /** Latest request wins; failed or superseded loads retain the previous lighting. */
  async load(
    value: EnvironmentSettings | undefined,
    project: Pick<TerrainProject, 'size' | 'heights'>,
  ) {
    const ticket = ++this.revision,
      prepared = await this.prepare(value);
    if (this.disposed || ticket !== this.revision) {
      prepared.dispose();
      return false;
    }
    this.apply(prepared, project);
    return true;
  }
  private update(
    s: EnvironmentSettings,
    project: Pick<TerrainProject, 'size' | 'heights'>,
  ) {
    this.sun.color.set(s.sunColor);
    this.sun.intensity = s.sunIntensity;
    this.sun.castShadow = s.shadows && s.sunIntensity > 0;
    this.ambient.color.set(s.skyColor);
    this.ambient.groundColor.set(s.groundColor);
    this.ambient.intensity = s.ambientIntensity;
    const azimuth = THREE.MathUtils.degToRad(s.sunAzimuth),
      elevation = THREE.MathUtils.degToRad(s.sunElevation);
    this.sun.target.position.set(0, 0, 0);
    this.sun.position.set(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    );
    if (this.sun.shadow.mapSize.x !== s.shadowResolution) {
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.sun.shadow.mapPass?.dispose();
      this.sun.shadow.mapPass = null;
    }
    this.sun.shadow.mapSize.setScalar(s.shadowResolution);
    this.sun.shadow.bias = s.shadowBias;
    this.sun.shadow.normalBias = s.shadowNormalBias;
    this.fitShadow(project, s.shadowPadding);
    this.scene.environmentIntensity = s.environmentIntensity;
    this.scene.environmentRotation.set(
      0,
      THREE.MathUtils.degToRad(s.rotation),
      0,
    );
    this.scene.background =
      s.showBackground && this.prepared?.texture
        ? this.prepared.texture
        : new THREE.Color(s.backgroundColor);
    this.scene.backgroundRotation.copy(this.scene.environmentRotation);
    this.scene.backgroundIntensity =
      s.backgroundIntensity ?? s.environmentIntensity;
    this.scene.backgroundBlurriness = s.backgroundBlur;
    this.scene.fog = s.fogEnabled
      ? new THREE.Fog(s.fogColor, s.fogNear, s.fogFar)
      : null;
    if (this.renderer) {
      this.renderer.toneMapping =
        s.toneMapping === 'neutral'
          ? THREE.NeutralToneMapping
          : s.toneMapping === 'agx'
            ? THREE.AgXToneMapping
            : THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = s.exposure;
    }
    this.prepared!.settings = s;
    this.prepared!.temporal?.reset();
    this.hour = wrapSolarHour(s.timeOfDay?.hour ?? 12);
    if (s.timeOfDay?.enabled) {
      // The atmospheric dome is drawn directly; only indirect illumination uses the filtered map.
      this.scene.background = new THREE.Color(s.backgroundColor);
      this.scene.environmentRotation.set(0, 0, 0);
      this.scene.backgroundRotation.set(0, 0, 0);
      this.prepared!.daylight!.set(s, this.hour);
      this.applyDaylight(s);
    }
  }
  /** Advance by elapsed seconds. Static or paused lighting does no animation work. */
  tick(deltaSeconds: number) {
    if (this.disposed || !Number.isFinite(deltaSeconds) || deltaSeconds < 0)
      return;
    const settings = this.prepared?.settings,
      cycle = settings?.timeOfDay;
    if (!settings || !cycle?.enabled || !cycle.playing) return;
    this.hour = wrapSolarHour(
      this.hour + (deltaSeconds * 24) / (cycle.dayLengthMinutes * 60),
    );
    this.applyDaylight(settings);
    this.prepared!.daylight!.tick(settings, this.hour, deltaSeconds);
    this.scene.environment = this.prepared!.daylight!.texture;
  }
  /** Call after moving the camera and updating terrain, immediately before rendering.
   * Enables authored cascades; hosts that omit this retain the terrain-wide sun.
   */
  updateCamera(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
    const prepared = this.prepared;
    if (isWebGPU(this.renderer) && prepared) {
      this.sun.visible = true;
      if (prepared.settings.shadows && prepared.settings.shadowCascades === 3) {
        if (this.gpuCascades?.camera && this.gpuCascades.camera !== camera) {
          this.releaseGPUCascades();
          this.replaceGPUSun();
        }
        if (!this.gpuCascades) {
          this.gpuCascades = new CSMShadowNode(this.sun, {
            cascades: 3,
            maxFar: prepared.settings.shadowDistance ?? 160,
            mode: 'practical',
            lightMargin: this.shadowRadius * 2 + 10,
          });
          this.gpuCascades.fade = true;
          this.sun.shadow.shadowNode = this.gpuCascades;
        }
        const cascades = this.gpuCascades;
        cascades.maxFar = prepared.settings.shadowDistance ?? 160;
        cascades.lightMargin = this.shadowRadius * 2 + 10;
        const projection = JSON.stringify([
          camera.projectionMatrix.elements,
          camera.near,
          camera.far,
          cascades.maxFar,
          cascades.lightMargin,
        ]);
        if (cascades.camera && projection !== this.cascadeProjection) {
          cascades.updateFrustums();
          this.cascadeProjection = projection;
        }
        cascades.lights.forEach((light, i) => {
          if (!light.shadow) return;
          light.shadow.bias = this.sun.shadow.bias * (i + 1);
          light.shadow.normalBias = this.sun.shadow.normalBias;
        });
      }
      return;
    }
    if (this.disposed || !prepared?.cascades) return;
    this.sun.visible = false;
    if (!prepared.cascades.group.parent)
      this.group.add(prepared.cascades.group);
    prepared.cascades.update(
      this.scene,
      camera,
      this.sun,
      prepared.settings,
      this.shadowRadius * 2 + 10,
    );
  }
  /** Render to the current full-size viewport with authored shadows and indirect
   * occlusion. Call terrain.update() and tick() first. Accepts native WebGPU or WebGL.
   */
  prepareWater() {
    const renderer = this.webGLRenderer;
    if (!renderer) return;
    this.waterPass ??= new WaterPass(renderer);
    this.waterPass.prepare();
  }
  invalidateHistory() {
    this.prepared?.temporal?.reset();
    this.gpuPipeline?.reset();
  }
  render(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
    if (this.disposed) return;
    if (isWebGPU(this.renderer)) {
      // Hosts may start their animation loop while the first load is pending.
      // Until a look is committed, preserve the host scene's ordinary rendering.
      if (!this.prepared) {
        this.renderer.render(this.scene, camera);
        return;
      }
      this.updateCamera(camera);
      this.gpuPipeline ??= new WebGPUPipeline(this.renderer);
      const autoReset = this.renderer.info.autoReset;
      if (autoReset) this.renderer.info.reset();
      this.renderer.info.autoReset = false;
      try {
        this.gpuPipeline.render(this.scene, camera, this.prepared!.settings);
      } finally {
        this.renderer.info.autoReset = autoReset;
      }
      return;
    }
    const renderer = this.webGLRenderer;
    if (!renderer)
      throw new Error(
        'Environment rendering requires an initialized terrain renderer.',
      );
    this.updateCamera(camera);
    const prepared = this.prepared;
    const renderOpaque = () => {
      if (prepared?.occlusion && prepared.settings.ambientOcclusion?.enabled) {
        try {
          prepared.occlusion.render(
            this.scene,
            camera,
            prepared.settings.ambientOcclusion,
          );
          return;
        } catch (error) {
          prepared.occlusion.suspend(error);
        }
      }
      renderer.render(this.scene, camera);
    };
    const renderScene = () => {
      this.waterPass ??= new WaterPass(renderer);
      try {
        this.waterPass.render(
          this.scene,
          camera,
          renderOpaque,
          !!prepared?.temporal,
        );
      } catch (error) {
        this.waterPass.error = String(error);
        renderOpaque();
      }
    };
    const autoReset = renderer.info.autoReset;
    if (autoReset) renderer.info.reset();
    renderer.info.autoReset = false;
    try {
      if (prepared?.temporal) {
        try {
          prepared.temporal.render(
            camera,
            renderScene,
            prepared.settings.temporalSharpness ?? 0.25,
          );
          return;
        } catch {
          /* The temporal pass restores camera/renderer state and records its error. */
        }
      }
      renderScene();
    } finally {
      renderer.info.autoReset = autoReset;
    }
  }
  private applyDaylight(settings: EnvironmentSettings) {
    const cycle = settings.timeOfDay!,
      state = daylightState(cycle, this.hour);
    this.sun.color
      .set(settings.sunColor)
      .multiply(new THREE.Color(...state.sunColor));
    this.sun.intensity = settings.sunIntensity * state.direct;
    this.sun.castShadow = settings.shadows && this.sun.intensity > 0.001;
    this.sun.position
      .set(state.x, state.y, state.z)
      .multiplyScalar(this.shadowRadius * 2 + 10);
    this.sun.target.position.set(0, this.shadowCenter, 0);
    this.sun.position.add(this.sun.target.position);
    this.ambient.color.setRGB(0.32, 0.5, 0.85);
    this.ambient.intensity =
      settings.ambientIntensity *
      (state.day + cycle.nightBrightness * (1 - state.day));
    if (cycle.autoFog && this.scene.fog) {
      const dayFog = new THREE.Color(0.52, 0.66, 0.8);
      dayFog.lerp(new THREE.Color(0.65, 0.3, 0.13), state.twilight * 0.65);
      this.scene.fog.color
        .setRGB(0.12, 0.2, 0.38)
        .multiplyScalar(cycle.nightBrightness)
        .lerp(dayFog, state.day);
    }
    this.group.updateMatrixWorld(true);
  }
  /** Refresh after height edits; coverage includes the terrain and authored height padding. */
  fitShadow(
    project: Pick<TerrainProject, 'size' | 'heights'>,
    padding = this.prepared?.settings.shadowPadding ?? 24,
  ) {
    let low = Infinity,
      high = -Infinity;
    for (const height of project.heights) {
      low = Math.min(low, height);
      high = Math.max(high, height);
    }
    const centerY = (low + high) / 2,
      radius = Math.hypot(
        project.size / 2,
        project.size / 2,
        (high - low) / 2 + padding,
      );
    this.shadowCenter = centerY;
    this.shadowRadius = radius;
    // Preserve the direction even when fitting again after a sculpt stroke.
    this.sun.position
      .sub(this.sun.target.position)
      .normalize()
      .multiplyScalar(radius * 2 + 10);
    this.sun.target.position.set(0, centerY, 0);
    this.sun.position.add(this.sun.target.position);
    Object.assign(this.sun.shadow.camera, {
      left: -radius,
      right: radius,
      top: radius,
      bottom: -radius,
      near: 1,
      far: radius * 3 + 20,
    });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.group.updateMatrixWorld(true);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    const s = this.scene,
      p = this.previous;
    s.background = p.background;
    s.environment = p.environment;
    s.fog = p.fog;
    s.environmentIntensity = p.environmentIntensity;
    s.backgroundIntensity = p.backgroundIntensity;
    s.backgroundBlurriness = p.backgroundBlurriness;
    s.environmentRotation.copy(p.environmentRotation);
    s.backgroundRotation.copy(p.backgroundRotation);
    if (this.renderer) {
      this.renderer.toneMapping = p.toneMapping!;
      this.renderer.toneMappingExposure = p.exposure!;
    }
    this.scene.remove(this.group);
    this.sun.dispose();
    this.waterPass?.dispose();
    this.gpuPipeline?.dispose();
    this.releaseGPUCascades();
    this.prepared?.dispose();
  }
}
