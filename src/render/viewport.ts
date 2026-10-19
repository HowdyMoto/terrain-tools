import { PropTools } from './prop-tools';
import type { TerrainWalker } from './first-person';
import { FramePacing, viewportPixelRatio } from './frame-pacing';
import { WalkPlacement } from './walk-placement';
import type { WalkPlacementResult } from './walk-placement';
import { EditTransaction } from './edit-transaction';
import { TerrainEnvironment } from '../runtime/environment';
import type { PreparedEnvironment } from '../runtime/environment';
import type {
  PreparedTerrain,
  PreparedTerrainGeometry,
} from '../runtime/terrain-scene';
import type { PreparedMaterial } from './material';
export type PreparedSurface = PreparedResource<{
  source: TerrainProject;
  project: TerrainProject;
  material: PreparedMaterial;
  terrain?: PreparedTerrainGeometry;
  picking?: PreparedPicking;
}>;
import {
  PreparedResource,
  checkSignal,
  linkedController,
  cancelled,
} from './resources';
export type PreparedViewport = PreparedResource<{
  terrain: PreparedTerrain;
  environment: PreparedEnvironment;
  picking: PreparedPicking;
  physics?: TerrainPhysics;
  colliders?: PreparedColliders;
}>;
import { StrokeSampler } from '../core/stroke';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { exportTerrainGLB } from '../runtime/export';
import type { TerrainExportOptions } from '../runtime/export';
import { heightAt } from '../core/terrain';
import type { TerrainProject } from '../core/types';
import type { TerrainPhysics, PreparedColliders } from '../physics/rapier';
type PreparedPicking = PreparedResource<{
  meshes: Map<string, THREE.Mesh>;
  retired: THREE.Mesh[];
}>;
import { TerrainScene } from '../runtime/terrain-scene';
import type { TerrainRegion } from '../runtime/terrain-scene';
import type { RigidBody } from '@dimforge/rapier3d-compat';
export class Viewport {
  renderer: THREE.WebGLRenderer;
  readonly gpuRenderer: string;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 3000);
  controls: OrbitControls;
  navigationActive = false;
  walker?: TerrainWalker;
  walkPlacement?: WalkPlacement;
  onWalkPlacementChange?: (result: WalkPlacementResult | null) => void;
  onWalkPlacementConfirm?: (result: WalkPlacementResult | null) => void;
  readonly content: TerrainScene;
  readonly lighting: TerrainEnvironment;
  readonly propTools: PropTools;
  selectionEnabled = false;
  onSelectProp?: (id: number | null) => void;
  /** Return true to consume a terrain click without starting a paint stroke. */
  onTerrainClick?: (point: THREE.Vector3 | null) => boolean;
  private loading?: AbortController;
  get terrain() {
    return this.content.terrain;
  }
  get foliage() {
    return this.content.foliage;
  }
  get props() {
    return this.content.props;
  }
  get library() {
    return this.content.library;
  }
  get terrainMaterial() {
    return this.content.terrainMaterial;
  }
  physics?: TerrainPhysics;
  private cursor: THREE.LineLoop;
  private readonly waterGuide = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color: 0x71e4df,
      depthTest: false,
      depthWrite: false,
    }),
  );
  private pickMeshes = new Map<string, THREE.Mesh>();
  private retainedPicks?: Set<THREE.Mesh>;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerInside = false;
  private pressed = false;
  private strokeSampler = new StrokeSampler();
  private pointerPressure = 1;
  private activePointer: number | null = null;
  private strokeEnd?: (event?: Event) => void;
  private spheres: { mesh: THREE.Mesh; body: RigidBody; radius: number }[] = [];
  private clock = new THREE.Clock();
  private elapsed = 0;
  private frames = 0;
  private statsAt = 0;
  private readonly framePacing: FramePacing;
  private walkingResolution = false;
  private readonly resize: () => void;
  get project() {
    return this.content.project;
  }
  set project(value: TerrainProject) {
    this.content.project = value;
  }
  brushRadius = 10;
  brushRotation = 0;
  brushSquare = false;
  stampOnce = false;
  pressureEnabled = true;
  showBrush = true;
  onStamp?: (point: THREE.Vector3, first: boolean, dose: number) => void;
  onStrokeEnd?: () => void;
  onStrokeCancel?: () => void;
  onHover?: (point: THREE.Vector3 | null) => void;
  onStats?: (fps: number, triangles: number) => void;
  setWaterGuide(points: { x: number; y: number; z: number }[]) {
    const position = this.waterGuide.geometry.getAttribute(
      'position',
    ) as THREE.BufferAttribute;
    points
      .slice(0, 129)
      .forEach((p, i) => position.setXYZ(i, p.x, p.y + 0.18, p.z));
    position.needsUpdate = true;
    this.waterGuide.geometry.setDrawRange(0, Math.min(129, points.length));
    this.waterGuide.visible = points.length > 1 && !this.navigationActive;
  }
  constructor(container: HTMLElement, project: TerrainProject) {
    this.waterGuide.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(129 * 3), 3),
    );
    this.waterGuide.visible = false;
    this.waterGuide.frustumCulled = false;
    this.waterGuide.renderOrder = 10000;
    this.waterGuide.userData.waterOverlay = true;
    this.scene.add(this.waterGuide);
    this.content = new TerrainScene(project);
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    const gl = this.renderer.getContext();
    this.framePacing = new FramePacing(gl as WebGL2RenderingContext);
    const debugRenderer = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuRenderer = String(
      gl.getParameter(debugRenderer?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
    );
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor('#aebbb6');
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    container.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute(
      'aria-label',
      'Interactive terrain viewport',
    );
    this.renderer.domElement.tabIndex = 0;

    this.camera.position.set(150, 130, 150);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 8, 0);
    this.controls.enableDamping = true;
    this.controls.maxDistance = Math.max(800, project.size * 5);
    this.camera.far = Math.max(3000, project.size * 15);
    this.camera.updateProjectionMatrix();
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.controls.touches.ONE = null;
    this.lighting = new TerrainEnvironment(this.scene, this.renderer);
    this.lighting.set(project.environment, project);
    this.scene.add(this.content);
    this.propTools = new PropTools(
      this.scene,
      this.camera,
      this.renderer.domElement,
      this.controls,
    );
    this.cursor = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: '#e0ffd0',
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.cursor.renderOrder = 10;
    this.cursor.frustumCulled = false;
    this.scene.add(this.cursor);
    const grid = new THREE.GridHelper(600, 60, '#7b8c84', '#96a59d');
    grid.position.y = -18;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.2;
    this.scene.add(grid);
    this.resize = () => {
      const { width, height } = container.getBoundingClientRect();
      this.renderer.setPixelRatio(
        viewportPixelRatio(width, height, devicePixelRatio, !!this.walker),
      );
      this.renderer.setSize(width, height);
      this.camera.aspect = width / Math.max(1, height);
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(this.resize).observe(container);
    this.resize();
    this.renderer.domElement.addEventListener('webglcontextlost', () =>
      this.framePacing.reset(),
    );
    const canvas = this.renderer.domElement;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    const locate = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      this.pointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      this.pointerInside =
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom;
      this.pointerPressure =
        e.pointerType === 'pen' && this.pressureEnabled ? e.pressure : 1;
    };
    canvas.addEventListener('pointermove', (e) => {
      if (this.navigationActive && !this.walkPlacement) return;
      if (this.pressed && e.pointerId !== this.activePointer) return;
      locate(e);
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointerInside = false;
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (this.walkPlacement && e.button === 0 && e.isPrimary) {
        canvas.focus();
        locate(e);
        this.onWalkPlacementConfirm?.(this.updateWalkPlacement());
        return;
      }
      if (this.navigationActive) return;
      if (e.button !== 0) return;
      if (this.pressed) {
        if (e.pointerType === 'touch') this.strokeEnd?.();
        return;
      }
      if (!e.isPrimary) return;
      canvas.focus();
      locate(e);
      if (this.propTools.dragging) return;
      if (this.onTerrainClick?.(this.pick())) return;
      if (this.selectionEnabled) {
        this.onSelectProp?.(this.pickProp());
        return;
      }
      this.pressed = true;
      this.activePointer = e.pointerId;
      this.strokeSampler.reset();
      canvas.setPointerCapture(e.pointerId);
      this.emitStroke(this.pick());
    });
    this.strokeEnd = (event) => {
      if (
        event instanceof PointerEvent &&
        event.pointerId !== this.activePointer
      )
        return;
      if (!this.pressed) return;
      if (event?.type === 'pointerup') {
        locate(event as PointerEvent);
        this.emitStroke(this.pointerInside ? this.pick() : null);
      }
      if (
        event?.type === 'pointercancel' ||
        event?.type === 'lostpointercapture'
      )
        this.cancelStroke();
      else this.finishStroke();
    };
    canvas.addEventListener('pointerup', this.strokeEnd);
    canvas.addEventListener('pointercancel', this.strokeEnd);
    canvas.addEventListener('lostpointercapture', this.strokeEnd);
    window.addEventListener('blur', this.strokeEnd);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  async prepareLoad(
    p: TerrainProject,
    materials = true,
    signal?: AbortSignal,
  ): Promise<PreparedViewport> {
    let environment: PreparedEnvironment | undefined,
      terrain: PreparedTerrain | undefined,
      picking: PreparedPicking | undefined,
      colliders: PreparedColliders | undefined;
    try {
      checkSignal(signal);
      environment = await this.lighting.prepare(p.environment);
      checkSignal(signal);
      terrain = await this.content.prepareLoad(p, materials, signal);
      if (p.water) {
        this.lighting.prepareWater();
        this.content.waterSystem.prepareGPU(
          terrain.value.water,
          this.renderer,
          this.camera,
          this.scene,
        );
      }
      checkSignal(signal);
      picking = this.preparePicking(terrain.value.geometry.value.meshes, true);
      const physics = this.physics;
      colliders = physics?.prepare(
        p,
        undefined,
        this.content.preparedPropCollision(terrain),
      );
      const ownedEnvironment = environment,
        ownedTerrain = terrain,
        ownedPicking = picking,
        ownedColliders = colliders;
      return new PreparedResource(
        this,
        { terrain, environment, picking, physics, colliders },
        () => {
          ownedPicking.dispose();
          ownedColliders?.dispose();
          ownedTerrain.dispose();
          ownedEnvironment.dispose();
        },
      );
    } catch (error) {
      picking?.dispose();
      colliders?.dispose();
      terrain?.dispose();
      environment?.dispose();
      throw error;
    }
  }
  assertPrepared(prepared: PreparedViewport) {
    prepared.assert(this);
    if (prepared.value.environment.disposed)
      throw new Error('Environment resources have been disposed.');
    this.content.assertPrepared(prepared.value.terrain);
    if (prepared.value.physics !== this.physics)
      throw new Error(
        'Physics changed while preparing the project. Try again.',
      );
    if (prepared.value.colliders)
      this.physics!.assertPrepared(prepared.value.colliders);
    prepared.value.picking.assert(this);
  }
  applyPrepared(prepared: PreparedViewport) {
    this.assertPrepared(prepared);
    this.propTools.cancel();
    this.cancelLoad();
    const state = prepared.take(this),
      project = state.terrain.value.project;
    this.content.applyPrepared(state.terrain);
    this.controls.maxDistance = Math.max(800, project.size * 5);
    this.camera.far = Math.max(3000, project.size * 15);
    this.camera.updateProjectionMatrix();
    this.lighting.apply(state.environment, project);
    this.clearBalls();
    if (state.colliders) this.physics!.apply(state.colliders);
    this.applyPicking(state.picking);
  }
  cancelLoad() {
    this.loading?.abort();
    this.loading = undefined;
  }
  async load(p: TerrainProject, materials = true, signal?: AbortSignal) {
    this.cancelLoad();
    const { controller, unlink } = linkedController(signal);
    this.loading = controller;
    let prepared: PreparedViewport | undefined;
    try {
      prepared = await this.prepareLoad(p, materials, controller.signal);
      checkSignal(controller.signal);
      if (this.loading !== controller) throw cancelled();
      this.loading = undefined;
      this.applyPrepared(prepared);
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      throw error;
    } finally {
      prepared?.dispose();
      if (this.loading === controller) this.loading = undefined;
      unlink();
    }
  }
  /** Stage surface-only changes. Terrain dimensions, heights, holes and assets must stay unchanged. */
  async prepareSurface(
    project: TerrainProject,
    placementRules = false,
    signal?: AbortSignal,
  ): Promise<PreparedSurface> {
    const source = this.project;
    let material: PreparedMaterial | undefined,
      terrain: PreparedTerrainGeometry | undefined,
      picking: PreparedPicking | undefined;
    const release = () => {
      picking?.dispose();
      terrain?.dispose();
      material?.dispose();
    };
    try {
      material = await this.terrainMaterial.prepare(project, signal);
      checkSignal(signal);
      if (placementRules) {
        terrain = this.content.prepareTerrain(undefined, project);
        picking = this.preparePicking(terrain.value.meshes, true);
      }
      checkSignal(signal);
      return new PreparedResource(
        this,
        { source, project, material, terrain, picking },
        release,
      );
    } catch (error) {
      release();
      throw error;
    }
  }
  assertSurface(prepared: PreparedSurface) {
    prepared.assert(this);
    const state = prepared.value;
    if (state.source !== this.project)
      throw new Error(
        'The terrain changed while preparing its surface. Try again.',
      );
    this.terrainMaterial.assertPrepared(state.material);
    if (state.terrain) this.content.assertTerrain(state.terrain);
    state.picking?.assert(this);
  }
  applySurface(prepared: PreparedSurface) {
    this.assertSurface(prepared);
    const state = prepared.take(this);
    this.terrainMaterial.apply(state.material);
    if (state.terrain) this.content.applyTerrain(state.terrain);
    if (state.picking) this.applyPicking(state.picking);
    // Keep the root shared with foliage and physics; their spatial data did not change.
    this.project.materials = state.project.materials;
    this.project.paint = state.project.paint;
    this.project.view.textureResolution = state.project.view.textureResolution;
  }
  rebuildTerrain(region?: TerrainRegion, waterPreview = false) {
    const terrain = this.content.prepareTerrain(region, this.project, {
      waterPreview,
    });
    let picking: PreparedPicking | undefined;
    try {
      picking = this.preparePicking(terrain.value.meshes, !region);
      this.content.applyTerrain(terrain);
      this.applyPicking(picking);
      if (!region) this.lighting.fitShadow(this.project);
    } finally {
      picking?.dispose();
      terrain.dispose();
    }
  }
  rebuildFoliage() {
    this.content.rebuildFoliage();
  }
  rebuildProps() {
    this.content.rebuildProps();
    this.physics?.setPropMeshes(this.content.collisionMeshes(true, false));
  }
  reanchorProps(region: TerrainRegion) {
    if (this.content.reanchorProps(region))
      this.physics?.setPropMeshes(this.content.collisionMeshes(true, false));
  }
  private preparePicking(chunks: THREE.Mesh[], clear = false): PreparedPicking {
    const meshes = clear
        ? new Map<string, THREE.Mesh>()
        : new Map(this.pickMeshes),
      retired = clear ? [...this.pickMeshes.values()] : [],
      owned = new Set<{ dispose(): void }>();
    const release = () => {
      for (const resource of owned) resource.dispose();
      owned.clear();
    };
    try {
      for (const mesh of chunks) {
        const key = mesh.name,
          old = this.pickMeshes.get(key);
        if (old && !clear) retired.push(old);
        const { cellsX: nx, cellsZ: nz } = mesh.userData,
          indices = new Uint32Array(nx * nz * 6);
        let offset = 0;
        for (let z = 0; z < nz; z++)
          for (let x = 0; x < nx; x++) {
            const a = z * (nx + 1) + x,
              b = a + 1,
              c = a + nx + 1,
              d = c + 1;
            indices.set([a, c, b, b, c, d], offset);
            offset += 6;
          }
        const geometry = new THREE.BufferGeometry();
        owned.add(geometry);
        geometry.setAttribute(
          'position',
          mesh.geometry.getAttribute('position'),
        );
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        const material = new THREE.MeshBasicMaterial();
        owned.add(material);
        const pick = new THREE.Mesh(geometry, material);
        pick.updateMatrixWorld(true);
        meshes.set(key, pick);
      }
      return new PreparedResource(this, { meshes, retired }, release);
    } catch (error) {
      release();
      throw error;
    }
  }
  private applyPicking(prepared: PreparedPicking) {
    const { meshes, retired } = prepared.take(this);
    this.pickMeshes = meshes;
    for (const mesh of retired) {
      if (this.retainedPicks?.has(mesh)) continue;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
  /** Retain picking buffers alongside the scene until an editor preview succeeds. */
  beginEdit(candidate: TerrainProject): EditTransaction {
    if (this.retainedPicks) throw new Error('An edit is already active.');
    const picks = this.pickMeshes,
      retained = new Set(picks.values()),
      content = this.content.beginEdit(candidate);
    this.retainedPicks = retained;
    const release = (mesh: THREE.Mesh) => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    };
    return new EditTransaction(
      () => {
        this.retainedPicks = undefined;
        for (const [key, mesh] of picks)
          if (this.pickMeshes.get(key) !== mesh) release(mesh);
        content.commit();
      },
      () => {
        this.retainedPicks = undefined;
        for (const mesh of this.pickMeshes.values())
          if (!retained.has(mesh)) release(mesh);
        this.pickMeshes = picks;
        content.rollback();
        this.lighting.fitShadow(this.project);
      },
    );
  }
  private releasePointer() {
    const pointer = this.activePointer;
    this.pressed = false;
    this.activePointer = null;
    this.strokeSampler.reset();
    if (pointer !== null && this.renderer.domElement.hasPointerCapture(pointer))
      this.renderer.domElement.releasePointerCapture(pointer);
  }
  finishStroke() {
    if (!this.pressed) return;
    this.releasePointer();
    this.onStrokeEnd?.();
  }
  cancelStroke() {
    if (!this.pressed) return false;
    this.releasePointer();
    this.onStrokeCancel?.();
    return true;
  }
  private pickProp() {
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.props.updateWorldMatrix(true, true);
    for (const hit of this.raycaster.intersectObjects(
      this.props.children,
      true,
    )) {
      let object: THREE.Object3D | null = hit.object;
      while (object && object !== this.props) {
        if (typeof object.userData.propId === 'number')
          return object.userData.propId as number;
        object = object.parent;
      }
    }
    return null;
  }
  private pick() {
    // Entry/exit can move the camera between animation frames and the next click.
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return (
      this.raycaster.intersectObjects([...this.pickMeshes.values()], false)[0]
        ?.point ?? null
    );
  }
  async enablePhysics() {
    if (this.physics) return;
    const { TerrainPhysics } = await import('../physics/rapier');
    const physics = new TerrainPhysics();
    try {
      await physics.init();
      const prepared = physics.prepare(
        this.project,
        undefined,
        this.content.collisionMeshes(true, false),
      );
      try {
        physics.apply(prepared);
      } finally {
        prepared.dispose();
      }
      this.physics = physics;
    } catch (error) {
      physics.dispose();
      throw error;
    }
  }
  dropBall(point = new THREE.Vector3(0, heightAt(this.project, 0, 0), 0)) {
    if (!this.physics) return;
    const radius = 1.4;
    const body = this.physics.drop(point.x, point.y + 15, point.z, radius);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 24, 16),
      new THREE.MeshStandardMaterial({
        color: '#e4ab6e',
        metalness: 0.6,
        roughness: 0.25,
      }),
    );
    mesh.castShadow = true;
    mesh.position.set(point.x, point.y + 15, point.z);
    this.scene.add(mesh);
    this.spheres.push({ mesh, body, radius });
  }
  clearBalls() {
    for (const s of this.spheres) {
      this.physics?.remove(s.body);
      this.scene.remove(s.mesh);
      s.mesh.geometry.dispose();
      (s.mesh.material as THREE.Material).dispose();
    }
    this.spheres = [];
    this.content.clearInteractions();
  }
  frameTerrain() {
    if (this.navigationActive) return;
    const s = this.project.size;
    const halfV = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const halfH = Math.atan(Math.tan(halfV) * this.camera.aspect);
    const distance = (s * 0.72) / Math.sin(Math.min(halfV, halfH));
    this.controls.target.set(0, 8, 0);
    this.camera.position.copy(
      new THREE.Vector3(1, 0.87, 1)
        .normalize()
        .multiplyScalar(distance)
        .add(this.controls.target),
    );
  }
  beginWalkPlacement() {
    const placement = new WalkPlacement(this.project);
    this.walkPlacement = placement;
    this.scene.add(placement.marker);
    if (!this.pointerInside) this.pointer.set(0, 0);
    this.pointerInside = true;
    this.updateWalkPlacement();
  }
  endWalkPlacement() {
    this.walkPlacement?.dispose();
    this.walkPlacement = undefined;
  }
  updateWalkPlacement() {
    if (!this.walkPlacement) return null;
    this.camera.updateMatrixWorld();
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const yaw = Math.atan2(-direction.x, -direction.z);
    const result = this.walkPlacement.preview(
      this.pointerInside ? this.pick() : null,
      yaw,
    );
    this.onWalkPlacementChange?.(result);
    return result;
  }
  async exportGLB(options: TerrainExportOptions = {}) {
    return exportTerrainGLB(this.content, {
      ...options,
      renderer: this.renderer,
    });
  }
  private emitStroke(point: THREE.Vector3 | null) {
    const dabs = this.strokeSampler.sample(
      point,
      performance.now() / 1000,
      this.pointerPressure,
      Math.max(0.25, this.brushRadius * 0.25),
      this.stampOnce,
    );
    for (const dab of dabs) {
      if (!this.pressed) break;
      this.onStamp?.(
        new THREE.Vector3(dab.point.x, dab.point.y, dab.point.z),
        dab.first,
        dab.dose,
      );
    }
  }
  private frame() {
    // While the GPU is busy, return to the event loop so mouse input can update
    // the camera. The next submitted frame uses that latest pose, not a backlog.
    if (this.walker && !this.framePacing.ready()) return;
    if (this.walkingResolution !== !!this.walker) {
      this.walkingResolution = !!this.walker;
      this.resize();
    }
    const elapsed = this.clock.getDelta();
    const dt = Math.min(elapsed, 0.1);
    this.elapsed += elapsed;
    if (this.walker) this.walker.update(this.camera, dt);
    else if (!this.navigationActive || this.walkPlacement)
      this.controls.update();
    if (this.walkPlacement) this.updateWalkPlacement();
    const point =
      this.pointerInside && !this.navigationActive ? this.pick() : null;
    this.cursor.visible = !!point && this.showBrush && !this.propTools.dragging;
    this.onHover?.(point);
    if (point && this.cursor.visible) {
      const vertices = new Float32Array(96 * 3);
      for (let i = 0; i < 96; i++) {
        const a = (i / 96) * Math.PI * 2,
          divisor = this.brushSquare
            ? Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)))
            : 1,
          lx = (Math.cos(a) / divisor) * this.brushRadius,
          lz = (Math.sin(a) / divisor) * this.brushRadius,
          x =
            point.x +
            Math.cos(this.brushRotation) * lx +
            Math.sin(this.brushRotation) * lz,
          z =
            point.z -
            Math.sin(this.brushRotation) * lx +
            Math.cos(this.brushRotation) * lz;
        vertices.set([x, heightAt(this.project, x, z) + 0.2, z], i * 3);
      }
      this.cursor.geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(vertices, 3),
      );
    }
    if (this.pressed) this.emitStroke(point);
    if (this.physics) {
      this.physics.step(dt);
      for (const s of [...this.spheres]) {
        const pos = s.body.translation();
        s.mesh.position.copy(pos);
        s.mesh.quaternion.copy(s.body.rotation());
        if (pos.y < -this.project.size * 2) {
          this.physics.remove(s.body);
          this.scene.remove(s.mesh);
          s.mesh.geometry.dispose();
          (s.mesh.material as THREE.Material).dispose();
          this.spheres.splice(this.spheres.indexOf(s), 1);
        }
      }
    }
    const contacts = this.spheres
      .filter((s) => this.physics?.touchesTerrain(s.body))
      .map((s) => ({
        x: s.mesh.position.x,
        z: s.mesh.position.z,
        radius: this.project.interaction.radius,
        strength: 1,
      }));
    this.content.update(dt, contacts, this.camera);
    this.lighting.tick(dt);
    this.lighting.render(this.camera);
    this.framePacing.submitted();
    this.frames++;
    if (this.elapsed - this.statsAt >= 0.5) {
      this.onStats?.(
        Math.round(this.frames / (this.elapsed - this.statsAt)),
        this.renderer.info.render.triangles,
      );
      this.frames = 0;
      this.statsAt = this.elapsed;
    }
  }
}
