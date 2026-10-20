import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { TransformControlsMode } from 'three/addons/controls/TransformControls.js';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PropInstance, TerrainProject } from '../core/types';
import { heightAt } from '../core/terrain';
import { propFootprint } from '../core/props';
import { clamp } from '../core/math';

/** Translate along ground-relative X/Z, rotate around Y, and preserve uniform positive scale. */
export function propFromHandle(
  project: TerrainProject,
  before: PropInstance,
  mode: TransformControlsMode,
  axis: string | null,
  handle: Pick<THREE.Object3D, 'position' | 'quaternion' | 'scale'>,
): PropInstance {
  const next = { ...before };
  if (mode === 'translate') {
    next.x = clamp(handle.position.x, -project.size / 2, project.size / 2);
    next.z = clamp(handle.position.z, -project.size / 2, project.size / 2);
    if (axis?.includes('Y'))
      next.yOffset = clamp(
        handle.position.y - heightAt(project, next.x, next.z),
        -10000,
        10000,
      );
  } else if (mode === 'rotate') {
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(
      handle.quaternion,
    );
    next.rotation = Math.atan2(forward.x, forward.z);
  } else {
    const dimension = axis?.includes('X')
      ? 'x'
      : axis?.includes('Y')
        ? 'y'
        : 'z';
    next.scale = clamp(handle.scale[dimension], 0.01, 1000);
  }
  return ['x', 'z', 'yOffset', 'rotation', 'scale'].every((key) =>
    Number.isFinite(next[key as keyof PropInstance]),
  )
    ? next
    : { ...before };
}
const changed = (a: PropInstance, b: PropInstance) =>
  (['x', 'z', 'yOffset', 'rotation', 'scale'] as const).some(
    (key) => Math.abs(a[key] - b[key]) > 1e-7,
  );

/** Editor-only preview; the project and colliders change once, on a completed drag. */
export class PropTools {
  readonly controls: TransformControls;
  private proxy = new THREE.Object3D();
  private outline = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color: '#e4cc8b',
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    }),
  );
  private box = new THREE.Box3Helper(new THREE.Box3(), '#d1e5b0');
  private project?: TerrainProject;
  private prop?: PropInstance;
  private object?: THREE.Object3D;
  private before?: PropInstance;
  private draft?: PropInstance;
  onBegin?: () => void;
  onPreview?: (active: boolean) => void;
  onCommit?: (before: PropInstance, after: PropInstance) => void;
  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
    orbit: OrbitControls,
  ) {
    this.controls = new TransformControls(camera, canvas);
    this.controls.setSize(0.85);
    this.controls.setColors('#e0806a', '#bdd39a', '#81b4d8', '#ffe1a2');
    this.controls.enabled = false;
    this.proxy.name = 'Prop transform handle';
    this.outline.name = 'Selected cutout footprint';
    this.outline.renderOrder = 20;
    this.outline.frustumCulled = false;
    this.outline.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(97 * 3), 3),
    );
    this.box.name = 'Selected prop bounds';
    this.box.renderOrder = 19;
    (this.box.material as THREE.LineBasicMaterial).depthTest = false;
    this.outline.visible = this.box.visible = false;
    scene.add(this.proxy, this.controls.getHelper(), this.outline, this.box);
    this.controls.addEventListener('dragging-changed', (event) => {
      orbit.enabled = !event.value;
    });
    this.controls.addEventListener('mouseDown', () => {
      if (!this.prop || !this.project || !this.object) return;
      this.onBegin?.();
      this.before = { ...this.prop };
      this.draft = { ...this.prop };
      this.onPreview?.(true);
    });
    this.controls.addEventListener('objectChange', () => {
      if (!this.before || !this.project || !this.object) return;
      this.draft = propFromHandle(
        this.project,
        this.before,
        this.controls.mode,
        this.controls.axis,
        this.proxy,
      );
      this.pose(this.object, this.draft);
      this.pose(this.proxy, this.draft);
      this.draw(this.draft);
    });
    this.controls.addEventListener('mouseUp', () => {
      const before = this.before,
        draft = this.draft;
      this.before = this.draft = undefined;
      this.onPreview?.(false);
      if (before && draft && changed(before, draft)) {
        // Restore the temporary pose before the host prepares an independent edit.
        // If preparation fails, the retained objects already represent committed data.
        this.pose(this.proxy, before);
        if (this.object) this.pose(this.object, before);
        this.draw(before);
        this.onCommit?.(before, draft);
      } else if (this.prop) {
        this.pose(this.proxy, this.prop);
        if (this.object) this.pose(this.object, this.prop);
        this.draw(this.prop);
      }
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.dragging) {
        this.cancel();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    });
    window.addEventListener('blur', () => this.cancel());
    canvas.addEventListener('pointercancel', () => this.cancel());
    canvas.addEventListener('lostpointercapture', () => {
      queueMicrotask(() => {
        if (this.dragging) this.cancel();
      });
    });
  }
  get dragging() {
    return this.before !== undefined;
  }
  setMode(mode: TransformControlsMode) {
    this.cancel();
    this.controls.setMode(mode);
    this.controls.showX = this.controls.showZ = mode !== 'rotate';
    this.controls.showY = true;
    this.controls.setSpace(mode === 'translate' ? 'world' : 'local');
  }
  setSnapping(enabled: boolean) {
    this.controls.setTranslationSnap(enabled ? 0.5 : null);
    this.controls.setRotationSnap(enabled ? Math.PI / 12 : null);
    this.controls.setScaleSnap(enabled ? 0.1 : null);
  }
  select(
    project: TerrainProject,
    prop: PropInstance | undefined,
    object: THREE.Object3D | undefined,
    enabled: boolean,
  ) {
    this.cancel();
    this.project = project;
    this.prop = prop;
    this.object = object;
    const visible = !!prop && !!object && enabled;
    this.controls.enabled = visible;
    if (visible) {
      this.pose(this.proxy, prop!);
      this.controls.attach(this.proxy);
      this.draw(prop!);
    } else {
      this.controls.detach();
      this.outline.visible = this.box.visible = false;
    }
  }
  cancel() {
    if (!this.before) return;
    const before = this.before;
    this.before = this.draft = undefined;
    this.pose(this.proxy, before);
    if (this.object) this.pose(this.object, before);
    this.draw(before);
    this.controls.pointerUp(null);
    this.onPreview?.(false);
  }
  private pose(object: THREE.Object3D, prop: PropInstance) {
    object.position.set(
      prop.x,
      heightAt(this.project!, prop.x, prop.z) + prop.yOffset,
      prop.z,
    );
    object.rotation.set(0, prop.rotation, 0);
    object.scale.setScalar(prop.scale);
    object.updateMatrixWorld(true);
  }
  private draw(prop: PropInstance) {
    if (this.object) {
      this.box.box.setFromObject(this.object);
      this.box.visible = !this.box.box.isEmpty();
    }
    this.outline.visible = prop.cutHole;
    if (!prop.cutHole) return;
    const points = propFootprint(prop).outline(96),
      attribute = this.outline.geometry.getAttribute(
        'position',
      ) as THREE.BufferAttribute;
    points.forEach((point, i) =>
      attribute.setXYZ(
        i,
        point.x,
        heightAt(this.project!, point.x, point.z) + 0.18,
        point.z,
      ),
    );
    attribute.setXYZ(
      96,
      attribute.getX(0),
      attribute.getY(0),
      attribute.getZ(0),
    );
    attribute.needsUpdate = true;
  }
}
