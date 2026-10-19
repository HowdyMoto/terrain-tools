import * as THREE from 'three';
import type { TerrainProject, TerrainRegion } from '../core/types';
import { waterMasks, waterContains } from '../core/water';
import { heightAt, materialWeights } from '../core/terrain';
import type { WaterExtent } from '../core/water';
import { PreparedResource } from '../render/resources';
import { createWaterMaterial } from './water-material';
import { createWaterFoamTexture } from './water-foam';
import type { WaterMaterial } from './water-material';
import { prepareWaterShore } from './water-shore';
import type { TerrainMaterial } from '../render/material';
import type { AssetLease } from '../core/asset-registry';

export function prepareWaterTerrain(project: TerrainProject) {
  if (!project.water) return undefined;
  const masks = waterMasks(project, project.water);
  for (const body of project.water.bodies) {
    if (
      body.enabled &&
      body.extent.kind === 'basin' &&
      masks.bodies.find((b) => b.id === body.id)?.spills
    )
      throw new Error(
        `${body.name} would spill through a terrain edge or hole. Lower its water level or replace it with a drawn outline before opening the bank.`,
      );
  }
  const n = project.resolution,
    count = n * 4 * 4,
    positions = new Float32Array(count * 3),
    weights = new Float32Array(count * 4),
    indices = new Uint32Array(n * 4 * 6);
  const half = project.size / 2,
    bottom = Math.min(
      -project.size,
      project.water.seaLevel -
        Math.max(20, project.water.ocean.surface.visibility * 3),
    );
  for (let edge = 0; edge < 4; edge++)
    for (let i = 0; i < n; i++) {
      const base = (edge * n + i) * 4;
      for (let end = 0; end < 2; end++) {
        const t = ((i + end) / n) * project.size - half;
        const x = edge === 0 ? t : edge === 1 ? half : edge === 2 ? -t : -half;
        const z = edge === 0 ? -half : edge === 1 ? t : edge === 2 ? half : -t;
        const y = heightAt(project, x, z),
          blend = materialWeights(project, x, z);
        positions.set([x, y, z], (base + end) * 3);
        positions.set([x, bottom, z], (base + end + 2) * 3);
        weights.set(blend, (base + end) * 4);
        weights.set(blend, (base + end + 2) * 4);
      }
      indices.set(
        [base, base + 1, base + 2, base + 1, base + 3, base + 2],
        (edge * n + i) * 6,
      );
    }
  return {
    heights: project.heights.slice(),
    shore: prepareWaterShore(project, masks),
    ...masks,
    bank: { positions, weights, indices },
  };
}
type WaterTerrain =
  | (Omit<NonNullable<ReturnType<typeof prepareWaterTerrain>>, 'bodies'> & {
      bodies: { id: string; mask: Uint8Array }[];
    })
  | undefined;
interface Resources {
  project: TerrainProject;
  group: THREE.Group;
  height?: THREE.DataTexture;
  foam?: THREE.DataTexture;
  foamLease?: AssetLease<THREE.DataTexture>;
  shore?: THREE.DataTexture;
  bank?: THREE.Mesh;
  entries: {
    id: string;
    mesh: THREE.Mesh;
    shading: WaterMaterial;
    mask: THREE.DataTexture;
  }[];
}
export type PreparedWater = PreparedResource<Resources>;
function heightTexture(data: Float32Array, width: number) {
  const texture = new THREE.DataTexture(
    data,
    width,
    width,
    THREE.RedFormat,
    THREE.FloatType,
  );
  texture.needsUpdate = true;
  return texture;
}
function grid(width: number, depth: number, ocean: boolean) {
  const geometry = new THREE.PlaneGeometry(width, depth, 128, 128);
  geometry.rotateX(-Math.PI / 2);
  if (ocean) {
    const pos = geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const warp = (v: number) =>
        (Math.sign(v) * (Math.pow(1 + Math.abs(v) * 7, 3) - 1)) / 511;
      pos.setXYZ(
        i,
        warp((pos.getX(i) * 2) / width),
        0,
        warp((pos.getZ(i) * 2) / depth),
      );
    }
  }
  return geometry;
}
function bounds(extent: WaterExtent, size: number) {
  if (extent.kind === 'basin') return { x: 0, z: 0, width: size, depth: size };
  if (extent.kind === 'ellipse') {
    const a = (extent.rotation * Math.PI) / 180;
    return {
      x: extent.x,
      z: extent.z,
      width:
        2 *
        Math.hypot(extent.radiusX * Math.cos(a), extent.radiusZ * Math.sin(a)),
      depth:
        2 *
        Math.hypot(extent.radiusX * Math.sin(a), extent.radiusZ * Math.cos(a)),
    };
  }
  const xs = extent.points.map((p) => p.x),
    zs = extent.points.map((p) => p.z);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minZ = Math.min(...zs),
    maxZ = Math.max(...zs);
  return {
    x: (minX + maxX) / 2,
    z: (minZ + maxZ) / 2,
    width: maxX - minX,
    depth: maxZ - minZ,
  };
}
/** Water geometry and CPU-prepared bathymetry. The environment owns shared screen captures. */
export class TerrainWater extends THREE.Group {
  private readonly bankMaterial: THREE.Material;
  private readonly ownsBankMaterial: boolean;
  constructor(
    bankMaterial?: THREE.Material,
    private readonly shoreUniforms?: TerrainMaterial['shoreUniforms'],
  ) {
    super();
    this.ownsBankMaterial = !bankMaterial;
    this.bankMaterial =
      bankMaterial ??
      new THREE.MeshStandardMaterial({ color: '#605646', roughness: 1 });
  }
  private state?: Resources;
  private time = 0;
  private bounded = false;
  /** A streamed cell owns a finite ocean patch; waves use manifest coordinates. */
  setWorldTile(x: number, z: number) {
    if (!Number.isFinite(x) || !Number.isFinite(z))
      throw new Error('Invalid water tile origin.');
    if (!this.state) return;
    this.bounded = true;
    if (this.state.bank) this.state.bank.visible = false;
    for (const entry of this.state.entries) {
      entry.shading.uniforms.waterPhaseOrigin.value.set(x, z);
      entry.shading.uniforms.waterBounded.value = 1;
      if (entry.id === 'ocean') {
        const geometry = grid(
          this.state.project.size,
          this.state.project.size,
          false,
        );
        entry.mesh.geometry.dispose();
        entry.mesh.geometry = geometry;
        entry.mesh.position.x = entry.mesh.position.z = 0;
        entry.mesh.scale.set(1, 1, 1);
      }
    }
  }
  /** Synchronize late-loaded cells to the host simulation clock, in seconds. */
  setTime(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0)
      throw new Error('Invalid water clock.');
    this.time = seconds;
  }
  private readonly cameraPosition = new THREE.Vector3();
  private disposed = false;
  canUpdateSettings(project: TerrainProject) {
    const before = this.state?.project,
      a = before?.water,
      b = project.water;
    return !!(
      a &&
      b &&
      before!.size === project.size &&
      before!.resolution === project.resolution &&
      before!.heights === project.heights &&
      before!.holes === project.holes &&
      a.seaLevel === b.seaLevel &&
      a.ocean.enabled === b.ocean.enabled &&
      this.sameShore(a.ocean.surface, b.ocean.surface) &&
      a.bodies.length === b.bodies.length &&
      a.bodies.every(
        (body, i) =>
          body.id === b.bodies[i].id &&
          body.elevation === b.bodies[i].elevation &&
          body.enabled === b.bodies[i].enabled &&
          this.sameShore(body.surface, b.bodies[i].surface) &&
          !(
            body.extent.kind === 'basin' &&
            !body.enabled &&
            b.bodies[i].enabled
          ) &&
          JSON.stringify(body.extent) === JSON.stringify(b.bodies[i].extent),
      )
    );
  }
  private sameShore(
    a: import('../core/water').WaterSurface,
    b: import('../core/water').WaterSurface,
  ) {
    return (
      a.wetness === b.wetness &&
      a.wetBand === b.wetBand &&
      a.caustics === b.caustics &&
      a.visibility === b.visibility &&
      a.speed === b.speed
    );
  }
  /** Commit validated appearance/visibility changes without replacing geometry or textures. */
  updateSettings(project: TerrainProject) {
    const state = this.state!,
      w = project.water!;
    state.project = project;
    if (state.bank) state.bank.visible = w.ocean.enabled;
    for (const e of state.entries) {
      const body = w.bodies.find((b) => b.id === e.id),
        s = body?.surface ?? w.ocean.surface,
        u = e.shading.uniforms;
      e.mesh.visible = body?.enabled ?? w.ocean.enabled;
      e.mesh.name = body?.name ?? 'Ocean';
      e.shading.material.color.set(s.color);
      e.shading.material.roughness = s.roughness;
      u.waterVisibility.value = s.visibility;
      u.waterRipple.value = s.ripple;
      u.waterFoam.value = s.foam;
      u.waterFoamWidth.value = s.foamWidth;
      u.waterWaves.value.set(
        s.swellHeight,
        s.swellLength,
        s.waveHeight,
        s.waveLength,
      );
    }
  }
  /** Upload and link detached candidates before history/document changes. */
  prepareGPU(
    prepared: PreparedWater,
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    scene: THREE.Scene,
  ) {
    prepared.assert(this);
    const state = prepared.value;
    if (!state.height) return;
    renderer.initTexture(state.height);
    if (state.foam) renderer.initTexture(state.foam);
    if (state.shore) renderer.initTexture(state.shore);
    for (const e of state.entries) renderer.initTexture(e.mask);
    const gl = renderer.getContext();
    // Three logs some upload failures instead of throwing. Verify actual storage
    // before the candidate can replace the committed water.
    const framebuffer = gl.createFramebuffer(),
      saved = gl.getParameter(
        gl.FRAMEBUFFER_BINDING,
      ) as WebGLFramebuffer | null;
    if (!framebuffer) throw new Error('Could not validate water textures.');
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      for (const texture of [
        state.height,
        ...(state.foam ? [state.foam] : []),
        ...(state.shore ? [state.shore] : []),
        ...state.entries.map((e) => e.mask),
      ]) {
        const gpu = renderer.properties.get(texture) as {
          __webglTexture?: WebGLTexture;
        };
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          gpu.__webglTexture ?? null,
          0,
        );
        if (
          gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
        )
          throw new Error('Water texture allocation failed.');
      }
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, saved);
      gl.deleteFramebuffer(framebuffer);
    }
    renderer.compile(state.group, camera, scene);
    for (const e of state.entries) {
      const properties = renderer.properties.get(e.shading.material) as {
        currentProgram?: { program: WebGLProgram };
      };
      const program = properties.currentProgram?.program;
      if (program && !gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(
          'Water shader could not compile: ' + gl.getProgramInfoLog(program),
        );
    }
  }
  prepare(
    project: TerrainProject,
    foamLease?: AssetLease<THREE.DataTexture>,
  ): PreparedWater {
    if (this.disposed) {
      foamLease?.release();
      throw new Error('Water has been disposed.');
    }
    const state: Resources = {
      project,
      group: new THREE.Group(),
      entries: [],
      foamLease,
    };
    const release = () => this.release(state);
    try {
      const settings = project.water,
        data = prepareWaterTerrain(project);
      if (settings && data) {
        state.height = heightTexture(data.heights, project.resolution + 1);
        state.foam = foamLease?.value ?? createWaterFoamTexture();
        state.shore = new THREE.DataTexture(
          data.shore,
          project.resolution + 1,
          project.resolution + 1,
          THREE.RGBAFormat,
          THREE.FloatType,
        );
        state.shore.needsUpdate = true;
        const bankGeometry = new THREE.BufferGeometry();
        state.bank = new THREE.Mesh(bankGeometry, this.bankMaterial);
        bankGeometry.setAttribute(
          'position',
          new THREE.BufferAttribute(data.bank.positions, 3),
        );
        bankGeometry.setAttribute(
          'layerWeights',
          new THREE.BufferAttribute(data.bank.weights, 4),
        );
        bankGeometry.setIndex(new THREE.BufferAttribute(data.bank.indices, 1));
        bankGeometry.computeVertexNormals();
        bankGeometry.computeBoundingSphere();
        state.bank.name = 'Submerged terrain boundary';
        state.bank.visible = settings.ocean.enabled;
        state.bank.receiveShadow = true;
        state.group.add(state.bank);
        const surfaces = [
          {
            id: 'ocean',
            name: 'Ocean',
            enabled: settings.ocean.enabled,
            elevation: settings.seaLevel,
            surface: settings.ocean.surface,
            extent: undefined as WaterExtent | undefined,
            data: data.ocean,
          },
          ...settings.bodies.map((body, i) => ({
            ...body,
            data: data.bodies[i].mask,
          })),
        ];
        for (const body of surfaces) {
          const mask = new THREE.DataTexture(
            body.data,
            project.resolution,
            project.resolution,
            THREE.RedFormat,
          );
          mask.needsUpdate = true;
          let geometry: THREE.BufferGeometry | undefined,
            shading: WaterMaterial | undefined;
          try {
            shading = createWaterMaterial(
              body.surface,
              state.height,
              mask,
              project.size,
              project.resolution,
              body.elevation,
              state.foam,
              body.extent,
            );
            const b = body.extent
              ? bounds(body.extent, project.size)
              : { x: 0, z: 0, width: 2, depth: 2 };
            geometry = grid(b.width, b.depth, !body.extent);
            const mesh = new THREE.Mesh(geometry, shading.material);
            mesh.name = body.name;
            mesh.position.set(b.x, body.elevation, b.z);
            mesh.visible = body.enabled;
            mesh.frustumCulled = false;
            mesh.receiveShadow = true;
            mesh.renderOrder = 10 - body.elevation / 10000;
            mesh.userData.waterBody = body.id;
            // Highest surfaces establish depth first, rejecting overlapping lower water.
            state.group.add(mesh);
            state.entries.push({ id: body.id, mesh, shading, mask });
          } catch (error) {
            geometry?.dispose();
            shading?.material.dispose();
            mask.dispose();
            throw error;
          }
        }
      }
      return new PreparedResource(this, state, release);
    } catch (error) {
      release();
      throw error;
    }
  }
  apply(prepared: PreparedWater) {
    const state = prepared.take(this),
      previous = this.state;
    this.clear();
    this.add(state.group);
    this.state = state;
    this.visible = !!state.project.water;
    if (this.shoreUniforms) {
      this.shoreUniforms.terrainShore.value = state.shore ?? null;
      this.shoreUniforms.terrainShoreSize.value = state.project.size;
      this.shoreUniforms.terrainShoreCells.value = state.project.resolution;
      this.shoreUniforms.terrainShoreEnabled.value = state.shore ? 1 : 0;
    }
    if (previous) this.release(previous);
  }
  /** Retain the displayed fields for exact preview rollback without rerunning flooding. */
  snapshotTerrain(): WaterTerrain {
    const state = this.state;
    if (!state?.height || !state.shore || !state.bank) return undefined;
    const geometry = state.bank.geometry;
    return {
      heights: (state.height.image.data as Float32Array).slice(),
      shore: (state.shore.image.data as Float32Array).slice(),
      ocean:
        (
          state.entries.find((entry) => entry.id === 'ocean')?.mask.image
            .data as Uint8Array | undefined
        )?.slice() ?? new Uint8Array(),
      bodies: state.entries
        .filter((entry) => entry.id !== 'ocean')
        .map((entry) => ({
          id: entry.id,
          mask: (entry.mask.image.data as Uint8Array).slice(),
        })),
      bank: {
        positions: new Float32Array(geometry.getAttribute('position').array),
        weights: new Float32Array(geometry.getAttribute('layerWeights').array),
        indices: new Uint32Array(geometry.index!.array),
      },
    };
  }
  /** Cheap sculpt preview: retain connectivity/wet banks until validated at stroke end.
   * Copies only touched height rows on the CPU; Three currently uploads the full height texture.
   */
  previewTerrainHeights(project: TerrainProject, region?: TerrainRegion) {
    const state = this.state,
      data = state?.height?.image.data as Float32Array | undefined;
    if (!data || data.length !== project.heights.length) return;
    const n = project.resolution,
      side = n + 1,
      cell = (value: number) => (value / project.size + 0.5) * n,
      minX = region ? Math.max(0, Math.floor(cell(region.minX))) : 0,
      maxX = region ? Math.min(n, Math.ceil(cell(region.maxX))) : n,
      minZ = region ? Math.max(0, Math.floor(cell(region.minZ))) : 0,
      maxZ = region ? Math.min(n, Math.ceil(cell(region.maxZ))) : n;
    if (maxX < minX || maxZ < minZ) return;
    for (let z = minZ; z <= maxZ; z++) {
      const start = z * side + minX;
      data.set(project.heights.subarray(start, z * side + maxX + 1), start);
    }
    state!.height!.needsUpdate = true;
  }
  /** All arrays were allocated before the terrain commit. Updating storage is infallible. */
  applyTerrain(data: WaterTerrain) {
    const state = this.state;
    if (
      !data ||
      !state?.height ||
      data.heights.length !== (state.height.image.data as Float32Array).length
    )
      return;
    (state.height.image.data as Float32Array).set(data.heights);
    state.height.needsUpdate = true;
    if (state.shore) {
      (state.shore.image.data as Float32Array).set(data.shore);
      state.shore.needsUpdate = true;
    }
    if (state.bank) {
      const geometry = state.bank.geometry;
      const positions = geometry.getAttribute(
          'position',
        ) as THREE.BufferAttribute,
        weights = geometry.getAttribute(
          'layerWeights',
        ) as THREE.BufferAttribute;
      if (positions.array.length === data.bank.positions.length) {
        positions.array.set(data.bank.positions);
        weights.array.set(data.bank.weights);
        positions.needsUpdate = true;
        weights.needsUpdate = true;
        geometry.computeBoundingSphere();
      }
    }
    for (const entry of state.entries) {
      const mask =
        entry.id === 'ocean'
          ? data.ocean
          : data.bodies.find((b) => b.id === entry.id)?.mask;
      if (
        mask &&
        mask.length === (entry.mask.image.data as Uint8Array).length
      ) {
        (entry.mask.image.data as Uint8Array).set(mask);
        entry.mask.needsUpdate = true;
      }
    }
  }
  update(dt: number, camera?: THREE.Camera, project = this.state?.project) {
    this.time += Math.min(dt, 0.1);
    const state = this.state,
      settings = project?.water;
    if (!state || !settings) return;
    if (this.shoreUniforms) {
      this.shoreUniforms.terrainShoreTime.value = this.time;
      this.shoreUniforms.terrainShoreEnabled.value = this.visible ? 1 : 0;
    }
    state.project = project!;
    for (const entry of state.entries) {
      const surface =
        entry.id === 'ocean'
          ? settings.ocean.surface
          : settings.bodies.find((b) => b.id === entry.id)!.surface;
      entry.shading.uniforms.waterTime.value = this.time * surface.speed;
      entry.shading.uniforms.waterDirection.value =
        ((surface.windLinked ? project!.wind.direction : surface.direction) *
          Math.PI) /
        180;
      entry.shading.uniforms.waterReflections.value = settings.reflections
        ? 1
        : 0;
      if (entry.id === 'ocean' && camera && !this.bounded) {
        const p = this.worldToLocal(
          camera.getWorldPosition(this.cameraPosition),
        );
        entry.mesh.position.x = Math.round(p.x / 2) * 2;
        entry.mesh.position.z = Math.round(p.z / 2) * 2;
        const reach = (camera as THREE.PerspectiveCamera).far || 3000;
        // Geometry is warped in the vertex shader; no CPU buffer uploads per frame.
        entry.mesh.scale.set(reach * 1.5, 1, reach * 1.5);
      }
      entry.shading.uniforms.waterCenter.value.set(
        entry.mesh.position.x,
        entry.mesh.position.z,
      );
      entry.shading.uniforms.waterGridScale.value.set(
        entry.mesh.scale.x,
        entry.mesh.scale.z,
      );
      entry.shading.uniforms.waterNormalWorld.value.getNormalMatrix(
        this.matrixWorld,
      );
    }
  }
  capture(
    color: THREE.Texture,
    depth: THREE.Texture,
    size: THREE.Vector2,
    camera: THREE.Camera,
    reactive = false,
  ) {
    for (const entry of this.state?.entries ?? []) {
      const u = entry.shading.uniforms;
      u.waterSceneColor.value = color;
      u.waterSceneDepth.value = depth;
      u.waterCapture.value = 1;
      u.waterReactive.value = reactive ? 1 : 0;
      u.waterBufferSize.value.copy(size);
      u.waterProjection.value.copy(camera.projectionMatrix);
      u.waterInverseProjection.value.copy(camera.projectionMatrixInverse);
      u.waterView.value.copy(camera.matrixWorldInverse);
    }
  }
  get surfaces() {
    return this.state?.entries.map((e) => e.mesh) ?? [];
  }
  /** Highest containing volume at the camera, for underwater attenuation. */
  underwater(camera: THREE.Camera) {
    const state = this.state,
      w = state?.project.water;
    if (!state || !w) return undefined;
    const p = this.worldToLocal(camera.getWorldPosition(this.cameraPosition));
    let best:
      { level: number; color: THREE.Color; visibility: number } | undefined;
    const n = state.project.resolution,
      x = Math.floor((p.x / state.project.size + 0.5) * n),
      z = Math.floor((p.z / state.project.size + 0.5) * n);
    const outside = x < 0 || z < 0 || x >= n || z >= n;
    for (const e of state.entries) {
      const body = w.bodies.find((b) => b.id === e.id),
        level = body?.elevation ?? w.seaLevel;
      if (!e.mesh.visible || p.y >= level || (best && best.level > level))
        continue;
      const inMask = outside
        ? e.id === 'ocean' && !this.bounded
        : (e.mask.image.data as Uint8Array)[z * n + x] > 0;
      const inside =
        body && body.extent.kind !== 'basin'
          ? waterContains(body.extent, p.x, p.z)
          : inMask;
      if (inside && (outside || p.y >= heightAt(state.project, p.x, p.z)))
        best = {
          level,
          color: e.shading.material.color,
          visibility: e.shading.uniforms.waterVisibility.value,
        };
    }
    return best;
  }
  /** Export a finite static PBR approximation; native authoring data retains full settings. */
  forExport() {
    const result: THREE.Mesh[] = [];
    for (const entry of this.state?.entries ?? []) {
      if (!entry.mesh.visible) continue;
      const ocean = entry.id === 'ocean';
      const geometry = ocean
        ? grid(this.state!.project.size, this.state!.project.size, false)
        : entry.mesh.geometry.clone();
      const project = this.state!.project,
        body = project.water!.bodies.find((b) => b.id === entry.id);
      const positions = geometry.getAttribute('position'),
        source = geometry.index!,
        indices: number[] = [];
      for (let i = 0; i < source.count; i += 3) {
        const ids = [source.getX(i), source.getX(i + 1), source.getX(i + 2)];
        const x =
          ids.reduce((sum, id) => sum + positions.getX(id), 0) / 3 +
          (ocean ? 0 : entry.mesh.position.x);
        const z =
          ids.reduce((sum, id) => sum + positions.getZ(id), 0) / 3 +
          (ocean ? 0 : entry.mesh.position.z);
        const cx = Math.floor((x / project.size + 0.5) * project.resolution),
          cz = Math.floor((z / project.size + 0.5) * project.resolution);
        const inside =
          cx >= 0 &&
          cz >= 0 &&
          cx < project.resolution &&
          cz < project.resolution;
        const mask = inside
          ? (entry.mask.image.data as Uint8Array)[
              cz * project.resolution + cx
            ] > 0
          : ocean;
        const contains =
          body && body.extent.kind !== 'basin'
            ? waterContains(body.extent, x, z)
            : mask;
        if (
          contains &&
          (!inside || heightAt(project, x, z) < entry.mesh.position.y)
        )
          indices.push(...ids);
      }
      geometry.setIndex(indices);
      if (!indices.length) {
        geometry.dispose();
        continue;
      }
      const m = entry.shading.material;
      const material = new THREE.MeshStandardMaterial({
        color: m.color,
        roughness: m.roughness,
        metalness: 0,
        transparent: true,
        opacity: 0.65,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = entry.mesh.name;
      mesh.position.copy(entry.mesh.position);
      if (ocean) {
        mesh.position.x = 0;
        mesh.position.z = 0;
      }
      result.push(mesh);
    }
    return result;
  }
  private release(state: Resources) {
    state.height?.dispose();
    if (state.foamLease) state.foamLease.release();
    else state.foam?.dispose();
    state.shore?.dispose();
    state.bank?.geometry.dispose();
    for (const e of state.entries) {
      e.mesh.geometry.dispose();
      e.shading.material.dispose();
      e.mask.dispose();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.state) this.release(this.state);
    this.state = undefined;
    if (this.shoreUniforms) {
      this.shoreUniforms.terrainShoreEnabled.value = 0;
      this.shoreUniforms.terrainShore.value = null;
    }
    if (this.ownsBankMaterial) this.bankMaterial.dispose();
    this.clear();
  }
}
