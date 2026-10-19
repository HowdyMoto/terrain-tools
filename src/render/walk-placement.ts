import * as THREE from 'three';
import { heightAt } from '../core/terrain';
import { parseEyeHeight } from '../core/project-settings';
import type { TerrainProject } from '../core/types';

const MARKER_RADIUS = 0.4;

export interface WalkStart {
  /** Eye position in terrain metres; heading is a Y-axis rotation in radians. */
  position: THREE.Vector3;
  yaw: number;
}
export interface WalkPlacementResult {
  start: WalkStart;
}

/** Preview the exact terrain point chosen by the user, without entry restrictions. */
export class WalkPlacement {
  readonly eyeHeight: number;
  readonly marker = new THREE.Group();
  private readonly material = new THREE.MeshBasicMaterial({
    color: '#b9ef87',
    depthTest: false,
    transparent: true,
    opacity: 0.85,
  });
  constructor(private readonly project: TerrainProject) {
    this.eyeHeight = parseEyeHeight(project.view.eyeHeight);
    const foot = new THREE.Mesh(
      new THREE.RingGeometry(MARKER_RADIUS - 0.04, MARKER_RADIUS, 40),
      this.material,
    );
    foot.rotation.x = -Math.PI / 2;
    foot.position.y = 0.04;
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, this.eyeHeight, 6),
      this.material,
    );
    stem.position.y = this.eyeHeight / 2;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 12, 8),
      this.material,
    );
    head.position.y = this.eyeHeight;
    const direction = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.45, 3),
      this.material,
    );
    direction.rotation.x = -Math.PI / 2;
    direction.position.set(0, this.eyeHeight, -0.45);
    this.marker.add(foot, stem, head, direction);
    this.marker.traverse((object) => {
      object.renderOrder = 30;
    });
    this.marker.visible = false;
    this.marker.name = 'Walk starting position';
  }

  inspect(point: THREE.Vector3, yaw: number): WalkPlacementResult {
    return {
      start: {
        position: new THREE.Vector3(
          point.x,
          heightAt(this.project, point.x, point.z) + this.eyeHeight,
          point.z,
        ),
        yaw,
      },
    };
  }

  preview(point: THREE.Vector3 | null, yaw: number) {
    this.marker.visible = !!point;
    if (!point) return null;
    const result = this.inspect(point, yaw);
    this.marker.position.copy(result.start.position);
    this.marker.position.y -= this.eyeHeight;
    this.marker.rotation.y = yaw;
    return result;
  }

  dispose() {
    this.marker.removeFromParent();
    this.marker.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    this.material.dispose();
  }
}
