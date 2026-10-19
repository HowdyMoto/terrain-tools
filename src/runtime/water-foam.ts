import * as THREE from 'three';

const resolution = 1024;
let pixels: Uint8Array | undefined;
const wrap = (n: number, period: number) => ((n % period) + period) % period;
const hash = (x: number, y: number, seed: number) => {
  let h = Math.imul(x + seed, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Periodic round pores with varying sizes, surrounded by dense froth. */
function cells(period: number, seed: number) {
  const points = new Float32Array(period * period * 3);
  for (let y = 0; y < period; y++)
    for (let x = 0; x < period; x++) {
      const i = (y * period + x) * 3;
      points[i] = 0.05 + hash(x, y, seed) * 0.9;
      points[i + 1] = 0.05 + hash(x, y, seed + 73) * 0.9;
      // Many small pores and occasional larger openings, rather than a
      // uniform polka-dot pattern. Overlapping openings form ragged clusters.
      points[i + 2] = 0.08 + hash(x, y, seed + 149) ** 2 * 0.7;
    }
  return (u: number, v: number) => {
    const x = u * period,
      y = v * period;
    const ix = Math.floor(x),
      iy = Math.floor(y);
    let first = Infinity;
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        const px = ix + ox,
          py = iy + oy;
        const i = (wrap(py, period) * period + wrap(px, period)) * 3;
        const dx = px + points[i] - x,
          dy = py + points[i + 1] - y;
        const d = (dx * dx + dy * dy) / (points[i + 2] * points[i + 2]);
        first = Math.min(first, d);
      }
    return smooth(0.74, 1.05, Math.sqrt(first));
  };
}

function noise(period: number, seed: number) {
  const values = new Float32Array(period * period);
  for (let y = 0; y < period; y++)
    for (let x = 0; x < period; x++) values[y * period + x] = hash(x, y, seed);
  return (u: number, v: number) => {
    const x = u * period,
      y = v * period;
    const ix = Math.floor(x),
      iy = Math.floor(y);
    const fx = smooth(0, 1, x - ix),
      fy = smooth(0, 1, y - iy);
    const at = (dx: number, dy: number) =>
      values[wrap(iy + dy, period) * period + wrap(ix + dx, period)];
    const a = at(0, 0),
      b = at(1, 0),
      c = at(0, 1),
      d = at(1, 1);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };
}

/** Shared immutable CPU data; each prepared water state owns its GPU texture.
 * Four metres per tile gives ~4 mm texels, centimetre pores and microfroth.
 * Mips average coverage, avoiding an aliased threshold on distant bubbles.
 */
export function createWaterFoamTexture(prepared?: Uint8Array) {
  if (prepared) {
    if (prepared.length !== resolution * resolution * 4)
      throw new Error('Invalid prepared water foam.');
    pixels = prepared;
  }
  if (!pixels) {
    const data = new Uint8Array(resolution * resolution * 4);
    const pores = cells(64, 17),
      froth = cells(160, 103);
    const broad = noise(5, 29),
      medium = noise(13, 79),
      fine = noise(37, 131);
    for (let y = 0; y < resolution; y++)
      for (let x = 0; x < resolution; x++) {
        const u = (x + 0.5) / resolution,
          v = (y + 0.5) / resolution;
        const i = (y * resolution + x) * 4;
        data[i] = Math.round(pores(u, v) * 255);
        data[i + 1] = Math.round(froth(u, v) * 255);
        data[i + 2] = Math.round(
          (broad(u, v) * 0.55 + medium(u, v) * 0.3 + fine(u, v) * 0.15) * 255,
        );
        data[i + 3] = 255;
      }
    pixels = data;
  }
  const texture = new THREE.DataTexture(
    pixels,
    resolution,
    resolution,
    THREE.RGBAFormat,
  );
  texture.name = 'Water foam pores and froth';
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}
