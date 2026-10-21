import * as THREE from 'three';
import { foliageModel } from '../core/foliage';
import { heightAt } from '../core/terrain';
import type { GroundContact } from '../core/interaction';
import type { TerrainProject } from '../core/types';
import type { ModelLibrary } from './models';
import { TerrainFoliage } from '../runtime/foliage';

/** Temporary side-on inspection of a real placed plant; never edits the document. */
export class FoliageContactPreview {
  readonly marker = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.25, 4, 12),
    new THREE.MeshBasicMaterial({
      color: 0x71e4df,
      wireframe: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  private time = 0;
  private readonly origin: THREE.Vector3;
  private readonly reach: number;
  readonly focus: THREE.Vector3;
  readonly cameraDistance: number;
  readonly instanceId: number;
  readonly foliage?: TerrainFoliage;

  constructor(
    readonly project: TerrainProject,
    library: ModelLibrary,
    brushId: string,
    modelId: string,
    target: THREE.Vector3,
  ) {
    const brush = project.brushes.find((b) => b.id === brushId);
    const candidates = project.foliage.filter(
      (f) =>
        f.brushId === brushId &&
        !!brush &&
        foliageModel(brush, f)?.id === modelId,
    );
    const instance = candidates.reduce<(typeof candidates)[number] | undefined>(
      (best, f) =>
        !best ||
        Math.hypot(f.x - target.x, f.z - target.z) <
          Math.hypot(best.x - target.x, best.z - target.z)
          ? f
          : best,
      undefined,
    );
    if (!instance || !brush) {
      this.dispose();
      throw new Error(
        'Paint at least one instance of this model before previewing bending.',
      );
    }
    const model = foliageModel(brush, instance)!;
    if (
      !(model.interaction?.enabled ?? project.interaction.enabled) ||
      model.crush <= 0
    ) {
      this.dispose();
      throw new Error(
        'Choose Grass, Soft plant or Woody leaves to enable contact first.',
      );
    }
    const bounds = library.bounds(model.model);
    this.instanceId = instance.id;
    this.origin = new THREE.Vector3(
      instance.x,
      heightAt(project, instance.x, instance.z),
      instance.z,
    );
    const rotation = new THREE.Matrix4().makeRotationY(instance.rotation);
    bounds.applyMatrix4(rotation).min.multiplyScalar(instance.scale);
    bounds.max.multiplyScalar(instance.scale);
    this.focus = bounds.getCenter(new THREE.Vector3()).add(this.origin);
    this.focus.y =
      this.origin.y +
      Math.min(1.2, Math.max(0.5, this.focus.y - this.origin.y));
    this.reach = Math.max(
      1,
      Math.min(3, (bounds.max.x - bounds.min.x) * 0.5 + 0.6),
    );
    this.cameraDistance = Math.max(
      3.5,
      Math.min(12, bounds.getSize(new THREE.Vector3()).length() * 1.2),
    );
    this.marker.name = 'Foliage bending preview';
    // Share decoded art, but own temporary draw buffers and recovery. Dense
    // neighboring plants must not obscure the plant being inspected.
    const isolated: TerrainProject = {
      ...project,
      wind: { ...project.wind, enabled: false },
      brushes: [
        {
          ...brush,
          models: [
            {
              ...model,
              lods: undefined,
              cullDistance: undefined,
              lodFadeDuration: 0,
            },
          ],
        },
      ],
      foliage: [{ ...instance, modelId: model.id }],
      props: [],
    };
    this.foliage = new TerrainFoliage(isolated, library);
    try {
      this.foliage.rebuild(isolated);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get done() {
    return this.time >= 9;
  }

  update(dt: number, camera?: THREE.Camera): GroundContact[] {
    this.time += Math.max(0, dt);
    this.marker.visible = this.time < 6;
    if (this.time >= 6) {
      this.foliage?.update(dt, [], camera);
      return []; // Leave time to see recovery from the same view.
    }
    const x = this.focus.x - Math.cos((this.time / 3) * Math.PI) * this.reach;
    const z = this.focus.z;
    const bottom = heightAt(this.project, x, z);
    this.marker.position.set(x, bottom + 0.975, z);
    const contacts = [
      {
        x,
        z,
        radius: 0.35,
        strength: 1,
        capsule: { bottom, top: bottom + 1.95 },
      },
    ];
    this.foliage?.update(dt, contacts, camera);
    return contacts;
  }

  dispose() {
    this.marker.removeFromParent();
    this.marker.geometry.dispose();
    this.marker.material.dispose();
    this.foliage?.removeFromParent();
    this.foliage?.dispose();
  }
}
