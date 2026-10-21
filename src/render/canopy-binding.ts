import type { CanopyLightField } from '../runtime/canopy-lighting';

export interface CanopyBinding {
  field?: CanopyLightField;
}
// Runtime GPU resources must never enter Object3D.userData: cloning/exporting
// userData serializes it. A shared handle also keeps LOD proxies current.
const bindings = new WeakMap<object, CanopyBinding>();
export function setCanopyBinding(object: object, binding?: CanopyBinding) {
  if (binding) bindings.set(object, binding);
  else bindings.delete(object);
}
export function getCanopyBinding(object: object | null) {
  // New water/prop meshes inherit their owning terrain's handle immediately.
  // Do not cache ancestry: hosts may detach or reparent those objects.
  while (object) {
    const binding = bindings.get(object);
    if (binding) return binding;
    object = (object as { parent?: object | null }).parent ?? null;
  }
  return undefined;
}
