import type { MeshStandardMaterial, Node, WebGPURenderer } from 'three/webgpu';
import { NodeMaterial } from 'three/webgpu';
import { property } from 'three/tsl';
import { installSharedGeometryOwnership } from './shared-geometry';
import { installNativeFoliage } from './native-foliage';
import { installNativeTerrainLod } from './native-terrain-lod';
import { installNativeShadows } from './native-shadows';

export const terrainIndirect = property('vec3', 'terrainIndirect');
export const terrainDirectSpecular = property('vec3', 'terrainDirectSpecular');

const installed = new WeakSet<WebGPURenderer>();

/** Capture lighting while its actual accumulator nodes are in scope. Looking up
 * their debug names creates unrelated variables and silently loses illumination. */
export function installTerrainLighting(renderer: WebGPURenderer) {
  installSharedGeometryOwnership(renderer);
  // Shadow handling runs inside the geometry proxies so it sees their native
  // attributes. Install it before wrapping foliage/terrain renderObject calls.
  installNativeShadows(renderer);
  installNativeFoliage(renderer);
  installNativeTerrainLod(renderer);
  if (installed.has(renderer)) return;
  installed.add(renderer);
  const configured = new WeakSet<NodeMaterial>();
  const convert = renderer.library.fromMaterial.bind(renderer.library);
  renderer.library.fromMaterial = (material) => {
    const node = convert(material);
    if (
      !node ||
      !(material as MeshStandardMaterial).isMeshStandardMaterial ||
      configured.has(node)
    )
      return node;
    configured.add(node);
    // NodeLibrary copies own properties, including legacy GLSL cache callbacks.
    // Retain the native node graph hash so different wind/leaf graphs cannot
    // accidentally share shader bindings.
    if (node !== material) {
      const legacyKey = material.customProgramCacheKey.bind(material);
      node.customProgramCacheKey = () =>
        NodeMaterial.prototype.customProgramCacheKey.call(node) +
        '|' +
        legacyKey();
    }
    const setup = node.setupLightingModel;
    node.setupLightingModel = function () {
      const model = setup.call(this);
      const indirect = model.indirect;
      model.indirect = function (builder) {
        indirect.call(this, builder);
        const light = (
          builder.context as { reflectedLight: Record<string, Node<'vec3'>> }
        ).reflectedLight;
        const caustic = (
          material as MeshStandardMaterial & {
            terrainCausticNode?: Node<'float'>;
          }
        ).terrainCausticNode;
        if (caustic) light.directDiffuse.mulAssign(caustic);
        terrainIndirect.assign(
          light.indirectDiffuse.add(light.indirectSpecular),
        );
        terrainDirectSpecular.assign(light.directSpecular);
      };
      return model;
    };
    return node;
  };
}
