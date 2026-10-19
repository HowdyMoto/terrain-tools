import * as THREE from 'three';
import { EXRExporter } from 'three/addons/exporters/EXRExporter.js';

/** Linear radiance, with distinct rows to detect an upside-down panorama. */
export async function exrFixture(
  compression: 0 | 2 | 3 = 3,
  type:
    typeof THREE.HalfFloatType | typeof THREE.FloatType = THREE.HalfFloatType,
) {
  const pixels = new Float32Array(64 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 64; x++)
      pixels.set([2 + y / 16, 0.25 + x / 64, 0.125, 1], (y * 64 + x) * 4);
  const texture = new THREE.DataTexture(
    pixels,
    64,
    32,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  try {
    return await new EXRExporter().parse(texture, { compression, type });
  } finally {
    texture.dispose();
  }
}

export function exrAttributes(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const attributes = new Map<string, number>();
  let offset = 8;
  const string = () => {
    const start = offset;
    while (bytes[offset++]) {
      /* fixture header */
    }
    return new TextDecoder().decode(bytes.subarray(start, offset - 1));
  };
  while (bytes[offset]) {
    const name = string();
    string();
    const size = view.getUint32(offset, true);
    offset += 4;
    attributes.set(name, offset);
    offset += size;
  }
  return { attributes, table: offset + 1 };
}
