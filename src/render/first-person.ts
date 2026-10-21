import { Euler, MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { effectiveHoles, heightAt, isHole } from '../core/terrain';
import type { TerrainProject } from '../core/types';
import { parseEyeHeight } from '../core/project-settings';
import type { WalkStart } from './walk-placement';
import type { GroundContact } from '../core/interaction';

/** Ground-following editor walkthrough, in metres. Props and water are not colliders. */
export class TerrainWalker {
  readonly eyeHeight: number;
  readonly walkSpeed = 6;
  readonly runSpeed = 12;
  readonly bodyRadius = 0.35;
  private readonly holes: Uint8Array;
  private readonly look = new Euler(0, 0, 0, 'YXZ');
  private readonly keys = new Set<string>();
  private readonly spawn = new Vector3();
  private readonly lastContact = new Vector3();
  private readonly heading: number;

  constructor(
    private readonly project: TerrainProject,
    start: WalkStart,
  ) {
    this.eyeHeight = parseEyeHeight(project.view.eyeHeight);
    this.holes = effectiveHoles(project);
    this.spawn.copy(start.position);
    this.heading = start.yaw;
  }

  enter(camera: PerspectiveCamera) {
    this.look.set(0, this.heading, 0);
    camera.position.copy(this.spawn);
    this.lastContact.copy(this.spawn);
    camera.quaternion.setFromEuler(this.look);
    camera.fov = 75;
    camera.updateProjectionMatrix();
    this.clearKeys();
  }

  setKey(code: string, down: boolean) {
    if (
      !['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight'].includes(
        code,
      )
    )
      return false;
    if (down) this.keys.add(code);
    else this.keys.delete(code);
    return true;
  }

  clearKeys() {
    this.keys.clear();
  }
  /** The camera is at eye level; the upright body reaches slightly above it. */
  contact(camera: PerspectiveCamera): GroundContact {
    const bottom = camera.position.y - this.eyeHeight;
    return {
      x: camera.position.x,
      z: camera.position.z,
      radius: this.bodyRadius,
      strength: 1,
      capsule: {
        bottom,
        top: bottom + Math.max(this.bodyRadius * 2, this.eyeHeight + 0.15),
      },
    };
  }
  /** Sample the swept body at 20 cm intervals, including slow frames/running.
   * Teleports start a new footprint instead of trampling across the world. */
  contacts(camera: PerspectiveCamera): GroundContact[] {
    const current = this.contact(camera);
    const distance = Math.hypot(
      camera.position.x - this.lastContact.x,
      camera.position.z - this.lastContact.z,
    );
    const steps = distance > 3 ? 1 : Math.max(1, Math.ceil(distance / 0.2));
    const result = Array.from({ length: steps }, (_, i) => {
      const t = (i + 1) / steps;
      const x =
        this.lastContact.x + (camera.position.x - this.lastContact.x) * t;
      const z =
        this.lastContact.z + (camera.position.z - this.lastContact.z) * t;
      const bottom = heightAt(this.project, x, z);
      return {
        ...current,
        x,
        z,
        capsule: {
          bottom,
          top: bottom + current.capsule!.top - current.capsule!.bottom,
        },
      };
    });
    this.lastContact.copy(camera.position);
    return result;
  }

  mouseLook(camera: PerspectiveCamera, x: number, y: number) {
    this.look.y -= x * 0.002;
    this.look.x = MathUtils.clamp(
      this.look.x - y * 0.002,
      -Math.PI / 2 + 0.01,
      Math.PI / 2 - 0.01,
    );
    camera.quaternion.setFromEuler(this.look);
  }

  update(camera: PerspectiveCamera, delta: number) {
    const forward =
      Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS'));
    const right = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
    const length = Math.hypot(forward, right);
    if (!length || !Number.isFinite(delta) || delta <= 0) return;
    const speed =
      this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
        ? this.runSpeed
        : this.walkSpeed;
    const distance = speed * Math.min(delta, 0.1);
    const dx =
      (right * Math.cos(this.look.y) - forward * Math.sin(this.look.y)) /
      length;
    const dz =
      (-forward * Math.cos(this.look.y) - right * Math.sin(this.look.y)) /
      length;
    // Small substeps prevent crossing even the smallest supported terrain holes.
    const steps = Math.ceil(
      distance /
        Math.min(0.25, this.project.size / this.project.resolution / 4),
    );
    for (let i = 0; i < steps; i++) {
      const x = camera.position.x + (dx * distance) / steps;
      if (this.canStand(x, camera.position.z)) camera.position.x = x;
      const z = camera.position.z + (dz * distance) / steps;
      if (this.canStand(camera.position.x, z)) camera.position.z = z;
    }
    camera.position.y =
      heightAt(this.project, camera.position.x, camera.position.z) +
      this.eyeHeight;
  }

  private canStand(x: number, z: number) {
    return !isHole(this.project, x, z, this.holes);
  }
}
