import type { IUniform, Texture } from 'three';
import type { Node } from 'three/webgpu';
import { DataTexture } from 'three';
import { materialReference, reference, texture } from 'three/tsl';

/** Per-draw material values let streamed tiles reuse one compiled node graph. */
export function materialNodeUniforms(property: string) {
  const references = new Map<string, Node>();
  function get(name: string): Node<'float'>;
  function get<const T extends string>(name: string, type: T): Node<T>;
  function get(name: string, type = 'float'): Node {
    const key = name + ':' + type;
    let node = references.get(key);
    if (!node) {
      node = materialReference(`${property}.${name}.value`, type);
      references.set(key, node);
    }
    return node;
  }
  return get;
}

export function materialNodeTexture(property: string, initial: Texture | null) {
  return texture(initial ?? emptyTexture).onObjectUpdate(({ material }) => {
    const value = (
      material as unknown as Record<string, IUniform<Texture | null>>
    )[property];
    return value.value ?? emptyTexture;
  });
}

/** Bind a node to the same stable, caller-owned values used by authoring. */
export function nodeUniforms(values: Record<string, IUniform>) {
  // NodeFrame deduplicates updates by referenced object. Repeated references
  // must share the same node, or only one of their uniforms gets updated.
  const references = new Map<string, Node>();
  function get(name: string): Node<'float'>;
  function get<const T extends string>(name: string, type: T): Node<T>;
  function get(name: string, type = 'float'): Node {
    const key = name + ':' + type;
    let node = references.get(key);
    if (!node) {
      node = reference('value', type, values[name]);
      references.set(key, node);
    }
    return node;
  }
  return get;
}

/** TextureNode retains the binding while transactions replace its texture. */
export function nodeTexture(
  value: IUniform<Texture | null>,
  fallback: Texture = emptyTexture,
) {
  return texture(value.value ?? fallback).onRenderUpdate(
    () => value.value ?? fallback,
  );
}

const emptyTexture = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
emptyTexture.needsUpdate = true;

/** Standard materials carry TSL graphs as well as GLSL hooks. The native renderer
 * keys the original material before conversion, so include each graph here. */
export function nodeGraphKey(material: object): string {
  return Object.entries(material)
    .filter(([, value]) => value?.isNode === true)
    .map(([name, value]) => name + ':' + (value as Node).getCacheKey())
    .join('|');
}
