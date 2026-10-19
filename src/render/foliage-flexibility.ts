import * as THREE from 'three';
import type { FoliageFlexibility } from '../core/types';

/** GLTFLoader lowercases application-specific attribute semantics. */
export const FLEXIBILITY_ATTRIBUTE = '_terrain_flexibility';
export const FLEXIBILITY_SHADER_ATTRIBUTE = 'terrainFlexibility';
export const CONTACT_SHADER_ATTRIBUTE = 'terrainContact';
const channels = { red: 0, green: 1, blue: 2, alpha: 3 } as const;

export function validateFlexibilityAttribute(geometry: THREE.BufferGeometry) {
  const attribute = geometry.getAttribute(FLEXIBILITY_ATTRIBUTE);
  if (!attribute) return;
  if (
    attribute.itemSize !== 1 ||
    attribute.count !== geometry.getAttribute('position')?.count
  )
    throw new Error('_TERRAIN_FLEXIBILITY must contain one scalar per vertex.');
  for (let i = 0; i < attribute.count; i++) {
    const value = attribute.getX(i);
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new Error(
        '_TERRAIN_FLEXIBILITY values must be finite and between 0 and 1.',
      );
  }
}

export function hasFlexibilitySource(
  geometry: THREE.BufferGeometry,
  source: FoliageFlexibility['source'],
) {
  if (source === 'height') return true;
  const attribute = geometry.getAttribute(
    source === 'attribute' ? FLEXIBILITY_ATTRIBUTE : 'color',
  );
  const channel = source === 'attribute' ? 0 : channels[source];
  return !!attribute && attribute.itemSize > channel;
}

/** Mutates an owned, model-space geometry only. xyz gradients follow the final mask. */
export function prepareFlexibility(
  geometry: THREE.BufferGeometry,
  settings: FoliageFlexibility,
  bounds: THREE.Box3,
) {
  const positions = geometry.getAttribute('position');
  const output = new Float32Array(positions.count * 4);
  const source = settings.source;
  if (!hasFlexibilitySource(geometry, source)) {
    geometry.setAttribute(
      FLEXIBILITY_SHADER_ATTRIBUTE,
      new THREE.BufferAttribute(output, 4),
    );
    return;
  }
  const height = Math.max(bounds.max.y - bounds.min.y, 1e-6);
  const attribute = geometry.getAttribute(
    source === 'attribute' ? FLEXIBILITY_ATTRIBUTE : 'color',
  );
  const channel =
    source === 'height' || source === 'attribute' ? 0 : channels[source];
  const span = settings.end - settings.start;
  for (let i = 0; i < positions.count; i++) {
    const raw =
      source === 'height'
        ? (positions.getY(i) - bounds.min.y) / height
        : attribute.getComponent(i, channel);
    const t = THREE.MathUtils.clamp((raw - settings.start) / span, 0, 1);
    output[i * 4] = Math.pow(t, settings.exponent);
    if (source === 'height' && t > 0 && t < 1)
      output[i * 4 + 2] =
        (settings.exponent * Math.pow(t, settings.exponent - 1)) /
        (span * height);
  }
  if (source !== 'height') {
    // The least-length tangent gradient on each triangle, area weighted at its vertices.
    const weight = new Float64Array(positions.count);
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3();
    const normal = new THREE.Vector3(),
      gradient = new THREE.Vector3(),
      other = new THREE.Vector3();
    const index = geometry.index,
      count = index?.count ?? positions.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const ia = index ? index.getX(i) : i,
        ib = index ? index.getX(i + 1) : i + 1,
        ic = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(positions, ia);
      b.fromBufferAttribute(positions, ib).sub(a);
      c.fromBufferAttribute(positions, ic).sub(a);
      normal.crossVectors(b, c);
      const area = normal.length();
      if (area < 1e-12) continue;
      gradient
        .crossVectors(c, normal)
        .multiplyScalar(output[ib * 4] - output[ia * 4]);
      other
        .crossVectors(normal, b)
        .multiplyScalar(output[ic * 4] - output[ia * 4]);
      gradient.add(other).divideScalar(area);
      for (const vertex of [ia, ib, ic]) {
        output[vertex * 4 + 1] += gradient.x;
        output[vertex * 4 + 2] += gradient.y;
        output[vertex * 4 + 3] += gradient.z;
        weight[vertex] += area;
      }
    }
    for (let i = 0; i < positions.count; i++)
      if (weight[i])
        for (let axis = 1; axis < 4; axis++) output[i * 4 + axis] /= weight[i];
  }
  geometry.setAttribute(
    FLEXIBILITY_SHADER_ATTRIBUTE,
    new THREE.BufferAttribute(output, 4),
  );
}

/** Separate per-batch instance attributes, sharing immutable model vertex/index storage. */
export function foliageGeometryView(
  base: THREE.BufferGeometry,
  attributes: Record<string, THREE.InstancedBufferAttribute>,
) {
  const geometry = new THREE.BufferGeometry();
  geometry.index = base.index;
  for (const [name, attribute] of Object.entries(base.attributes))
    geometry.setAttribute(name, attribute);
  geometry.morphAttributes = base.morphAttributes;
  geometry.morphTargetsRelative = base.morphTargetsRelative;
  geometry.groups = base.groups.map((group) => ({ ...group }));
  geometry.drawRange = { ...base.drawRange };
  geometry.boundingBox = base.boundingBox;
  geometry.boundingSphere = base.boundingSphere;
  for (const [name, attribute] of Object.entries(attributes))
    geometry.setAttribute(name, attribute);
  return geometry;
}
