import type {
  BufferAttribute,
  BufferGeometry,
  InterleavedBufferAttribute,
} from 'three';
import type { WebGPURenderer } from 'three/webgpu';

type Attribute = BufferAttribute | InterleavedBufferAttribute;
interface Owner {
  release: Set<() => void>;
}
const owners = new WeakMap<Attribute, Owner>();
const registered = new WeakSet<BufferGeometry>();
const installed = new WeakSet<WebGPURenderer>();

/** Immutable model buffers belong to the leased base geometry, not a batch view. */
export function registerSharedGeometry(
  base: BufferGeometry,
  owned?: Attribute[],
) {
  if (registered.has(base)) return;
  registered.add(base);
  const attributes = owned ?? [
    ...Object.values(base.attributes),
    ...(base.index ? [base.index] : []),
  ];
  const owner: Owner = { release: new Set() };
  for (const attribute of attributes) owners.set(attribute, owner);
  base.addEventListener('dispose', () => {
    for (const attribute of attributes) owners.delete(attribute);
    for (const release of owner.release) release();
    owner.release.clear();
  });
}

/** Three r186 also deletes shader-discovered attributes on geometry disposal.
 * Removing borrowed attributes from a view protects WebGL, but that native
 * cleanup finds them again. Defer their deletion to the leased base's disposal.
 * Keep this version-specific adapter local to initialized native renderers. */
export function installSharedGeometryOwnership(renderer: WebGPURenderer) {
  if (installed.has(renderer)) return;
  installed.add(renderer);
  const attributes = (
    renderer as unknown as {
      _attributes: { delete(attribute: Attribute): unknown };
    }
  )._attributes;
  const remove = attributes.delete.bind(attributes);
  const deferred = new WeakSet<Attribute>();
  attributes.delete = (attribute) => {
    const owner = owners.get(attribute);
    if (!owner) return remove(attribute);
    if (!deferred.has(attribute)) {
      deferred.add(attribute);
      owner.release.add(() => {
        deferred.delete(attribute);
        remove(attribute);
      });
    }
    return null;
  };
}
