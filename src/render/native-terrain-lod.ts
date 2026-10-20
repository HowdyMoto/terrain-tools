import { BufferGeometry, Mesh } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { registerSharedGeometry } from './shared-geometry';

export const terrainLodTarget = 'terrainLodTarget';
const chunks = new WeakSet<Mesh>();
const installed = new WeakSet<WebGPURenderer>();

export function registerTerrainLod(mesh: Mesh) {
  chunks.add(mesh);
}

/** A terrain chunk has one position morph, so it can read a vertex attribute
 * instead of Three's general morph texture. Avoiding texture-specific programs
 * allows all chunks sharing surface arrays to reuse the same native shader.
 * Authored geometry, WebGL morphs, picking and LOD selection remain on the source.
 */
export function installNativeTerrainLod(renderer: WebGPURenderer) {
  if (installed.has(renderer)) return;
  installed.add(renderer);
  const views = new WeakMap<BufferGeometry, BufferGeometry>();
  const proxies = new WeakMap<Mesh, Mesh>();
  const renderObject = renderer.renderObject;
  renderer.renderObject = function (
    object,
    scene,
    camera,
    geometry,
    material,
    ...rest
  ) {
    const source = object as Mesh;
    if (!chunks.has(source))
      return renderObject.call(
        this,
        object,
        scene,
        camera,
        geometry,
        material,
        ...rest,
      );
    let view = views.get(geometry);
    if (!view) {
      view = new BufferGeometry();
      view.index = geometry.index;
      for (const [name, attribute] of Object.entries(geometry.attributes))
        view.setAttribute(name, attribute);
      const target = geometry.morphAttributes.position![0];
      view.setAttribute(terrainLodTarget, target);
      view.drawRange = { ...geometry.drawRange };
      view.groups = geometry.groups.map((group) => ({ ...group }));
      const ownedView = view;
      geometry.addEventListener('dispose', () => {
        ownedView.dispose();
        proxies.get(source)?.dispatchEvent({ type: 'dispose' } as never);
        views.delete(geometry);
      });
      // Only the level's index and target belong to it; base vertices belong
      // to TerrainScene and must survive changes or disposal of another level.
      registerSharedGeometry(geometry, [geometry.index!, target]);
      views.set(geometry, view);
    }
    let proxy = proxies.get(source);
    if (!proxy) {
      proxy = new Mesh(view, material);
      proxy.matrixAutoUpdate = false;
      proxy.matrixWorld = source.matrixWorld;
      proxies.set(source, proxy);
    }
    proxy.geometry = view;
    proxy.material = material;
    proxy.morphTargetInfluences = source.morphTargetInfluences;
    proxy.castShadow = source.castShadow;
    proxy.receiveShadow = source.receiveShadow;
    return renderObject.call(
      this,
      proxy,
      scene,
      camera,
      view,
      material,
      ...rest,
    );
  };
}
