import * as THREE from 'three';

interface Effect {
  compile: THREE.Material['onBeforeCompile'];
  key: string;
  disposed: () => void;
}
interface Binding {
  original: THREE.Material['onBeforeCompile'];
  originalKey: THREE.Material['customProgramCacheKey'];
  compile: THREE.Material['onBeforeCompile'];
  key: THREE.Material['customProgramCacheKey'];
  dispose: () => void;
  effects: Map<object, Effect>;
}
const bindings = new WeakMap<THREE.Material, Binding>();
const uniformBindings = new WeakMap<
  THREE.Material,
  Map<string, { source: THREE.IUniform; uniform: THREE.IUniform }>
>();

/** Three caches a compiled program's uniform objects on the material. Replacing
 * an environment can reuse that program without another onBeforeCompile call.
 * Stable indirection keeps cached programs attached to the current effect rig.
 */
export function materialEffectUniforms(
  material: THREE.Material,
  source: Record<string, THREE.IUniform>,
) {
  let cached = uniformBindings.get(material);
  if (!cached) uniformBindings.set(material, (cached = new Map()));
  const result: Record<string, THREE.IUniform> = {};
  for (const [name, uniform] of Object.entries(source)) {
    let binding = cached.get(name);
    if (!binding) {
      const entry = {
        source: uniform,
        uniform: {} as THREE.IUniform,
      };
      entry.uniform = {
        get value() {
          return entry.source.value;
        },
        set value(value) {
          entry.source.value = value;
        },
      };
      cached.set(name, (binding = entry));
    }
    binding.source = uniform;
    result[name] = binding.uniform;
  }
  return result;
}

/** Scene effects may be removed in any order without losing asset wind/fade hooks. */
export function bindMaterialEffect(
  material: THREE.Material,
  owner: object,
  effect: Effect,
) {
  let binding = bindings.get(material);
  if (!binding) {
    const original = material.onBeforeCompile;
    const originalKey = material.customProgramCacheKey;
    const effects = new Map<object, Effect>();
    const compile: THREE.Material['onBeforeCompile'] = (shader, renderer) => {
      original.call(material, shader, renderer);
      for (const entry of effects.values())
        entry.compile.call(material, shader, renderer);
    };
    const key = () =>
      (originalKey === THREE.Material.prototype.customProgramCacheKey
        ? original.toString()
        : originalKey.call(material)) +
      '|' +
      [...effects.values()].map((entry) => entry.key).join('|');
    const dispose = () => {
      for (const entry of [...effects.values()]) entry.disposed();
      effects.clear();
      restore();
    };
    const restore = () => {
      material.removeEventListener('dispose', dispose);
      if (material.onBeforeCompile === compile)
        material.onBeforeCompile = original;
      if (material.customProgramCacheKey === key)
        material.customProgramCacheKey = originalKey;
      bindings.delete(material);
      material.needsUpdate = true;
    };
    binding = { original, originalKey, effects, compile, key, dispose };
    bindings.set(material, binding);
    material.onBeforeCompile = compile;
    material.customProgramCacheKey = key;
    material.addEventListener('dispose', dispose);
  }
  binding.effects.set(owner, effect);
  material.needsUpdate = true;
  return () => {
    if (!binding.effects.delete(owner)) return;
    if (!binding.effects.size) {
      material.removeEventListener('dispose', binding.dispose);
      if (material.onBeforeCompile === binding.compile)
        material.onBeforeCompile = binding.original;
      if (material.customProgramCacheKey === binding.key)
        material.customProgramCacheKey = binding.originalKey;
      bindings.delete(material);
    }
    material.needsUpdate = true;
  };
}

export function isLitMaterial(material: THREE.Material) {
  return (
    material instanceof THREE.MeshStandardMaterial ||
    material instanceof THREE.MeshPhongMaterial ||
    material instanceof THREE.MeshLambertMaterial ||
    material instanceof THREE.MeshToonMaterial
  );
}
