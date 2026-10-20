import type { Material } from 'three';
import type { NodeMaterial, WebGPURenderer } from 'three/webgpu';
import { foliageMatrixAttribute } from './native-foliage';
import { terrainLodTarget } from './native-terrain-lod';

type ShadowMaterial = NodeMaterial & { isShadowPassMaterial?: boolean };
const installed = new WeakSet<WebGPURenderer>();

/** Three r186 changes one shadow override's node graph for every caster. Even
 * warm draws then repeatedly hash material/geometry state. Keep an override per
 * source material and light for our terrain/foliage batches, with stable nodes.
 * Three still supplies alpha rejection, shadow bias, clipping and shadow sides.
 */
export function installNativeShadows(renderer: WebGPURenderer) {
  if (installed.has(renderer)) return;
  installed.add(renderer);
  const variants = new WeakMap<Material, Map<ShadowMaterial, ShadowMaterial>>();
  const releases = new Set<() => void>();
  const shadowNodes = (
    renderer as WebGPURenderer & {
      _getShadowNodes(
        material: Material,
      ): Pick<NodeMaterial, 'colorNode' | 'depthNode' | 'positionNode'>;
    }
  )._getShadowNodes.bind(renderer);
  const renderObject = renderer.renderObject;
  renderer.renderObject = function (
    object,
    scene,
    camera,
    geometry,
    material,
    ...rest
  ) {
    const original = scene.overrideMaterial as ShadowMaterial | null;
    if (
      !original?.isShadowPassMaterial ||
      (!geometry.hasAttribute(terrainLodTarget) &&
        !geometry.hasAttribute(foliageMatrixAttribute + '0'))
    ) {
      return renderObject.call(
        this,
        object,
        scene,
        camera,
        geometry,
        material,
        ...rest,
      );
    }
    let byLight = variants.get(material);
    if (!byLight) variants.set(material, (byLight = new Map()));
    let variant = byLight.get(original);
    if (!variant) {
      variant = original.clone() as ShadowMaterial;
      variant.isShadowPassMaterial = true;
      const owned = variant;
      const sourceVariants = byLight;
      const release = (event?: { type: 'dispose' }) => {
        material.removeEventListener('dispose', release);
        original.removeEventListener('dispose', release);
        sourceVariants.delete(original);
        releases.delete(release);
        // RenderObject also listens to its source material. EventDispatcher
        // snapshots listeners, so disposing the override inside that event
        // would dispose the same RenderObject twice and undercount shared
        // uniform bindings still used by other shadow casters.
        if (event) queueMicrotask(() => owned.dispose());
        else owned.dispose();
      };
      material.addEventListener('dispose', release);
      original.addEventListener('dispose', release);
      releases.add(release);
      byLight.set(original, variant);
    }
    const nodes = shadowNodes(material);
    // Position graphs are shared across tiles; their values still belong to the
    // source draw, including when an override material evaluates wind.
    Object.assign(variant, {
      terrainWindUniforms: (
        material as Material & { terrainWindUniforms?: unknown }
      ).terrainWindUniforms,
    });
    variant.colorNode = nodes.colorNode ?? original.colorNode;
    variant.depthNode = nodes.depthNode ?? original.depthNode;
    variant.positionNode = nodes.positionNode ?? original.positionNode;
    scene.overrideMaterial = variant;
    try {
      return renderObject.call(
        this,
        object,
        scene,
        camera,
        geometry,
        material,
        ...rest,
      );
    } finally {
      scene.overrideMaterial = original;
    }
  };
  const dispose = renderer.dispose;
  renderer.dispose = function () {
    for (const release of releases) release();
    return dispose.call(this);
  };
}
