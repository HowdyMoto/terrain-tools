import * as THREE from 'three';
import type { ModelPart } from '../render/models';

/** Retained typed data and estimated texture storage. Does not include driver/program overhead. */
export function modelMemory(parts: ModelPart[]) {
  const buffers = new Set<ArrayBufferLike>(),
    textures = new Set<THREE.Texture>();
  for (const part of parts) {
    for (const attribute of Object.values(part.geometry.attributes))
      buffers.add(
        attribute instanceof THREE.InterleavedBufferAttribute
          ? attribute.data.array.buffer
          : attribute.array.buffer,
      );
    if (part.geometry.index) buffers.add(part.geometry.index.array.buffer);
    for (const material of Array.isArray(part.material)
      ? part.material
      : [part.material])
      for (const value of Object.values(material))
        if (value instanceof THREE.Texture) textures.add(value);
  }
  let cpuBytes = [...buffers].reduce(
      (sum, buffer) => sum + buffer.byteLength,
      0,
    ),
    gpuBytes = cpuBytes;
  for (const texture of textures) {
    const data = texture.image;
    const mipBytes =
      texture.mipmaps?.reduce(
        (sum, mip) =>
          sum + ((mip as { data?: ArrayBufferView }).data?.byteLength ?? 0),
        0,
      ) ?? 0;
    const base =
      data?.data?.byteLength ??
      (data?.width ?? 1) * (data?.height ?? 1) * (data?.depth ?? 1) * 4;
    cpuBytes += mipBytes || base;
    gpuBytes +=
      mipBytes || Math.ceil(base * (texture.generateMipmaps ? 4 / 3 : 1));
  }
  return { cpuBytes, gpuBytes };
}
