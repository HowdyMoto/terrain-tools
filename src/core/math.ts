export const clamp = (x: number, lo = 0, hi = 1) =>
  Math.max(lo, Math.min(hi, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / Math.max(1e-6, b - a));
  return t * t * (3 - 2 * t);
};
export function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(x: number, z: number, seed: number) {
  let h =
    Math.imul(x, 374761393) +
    Math.imul(z, 668265263) +
    Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function noise(x: number, z: number, seed: number) {
  const ix = Math.floor(x),
    iz = Math.floor(z);
  const u = smoothstep(0, 1, x - ix),
    v = smoothstep(0, 1, z - iz);
  return lerp(
    lerp(hash(ix, iz, seed), hash(ix + 1, iz, seed), u),
    lerp(hash(ix, iz + 1, seed), hash(ix + 1, iz + 1, seed), u),
    v,
  );
}
export function fbm(x: number, z: number, seed: number, octaves = 5) {
  let result = 0,
    amplitude = 0.5,
    sum = 0;
  for (let i = 0; i < octaves; i++) {
    result += noise(x, z, seed + i * 39) * amplitude;
    sum += amplitude;
    x *= 2.03;
    z *= 2.03;
    amplitude *= 0.5;
  }
  return result / sum;
}
