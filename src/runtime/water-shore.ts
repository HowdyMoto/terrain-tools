import type { TerrainProject } from '../core/types';
import { effectiveHoles } from '../core/terrain';
import { waterContains, waterMasks } from '../core/water';

/** Vertex-grid RGBA field: wetness, caustic visibility, depth, animation speed.
 * Expand only from actual submerged cells so isolated dry depressions stay dry.
 * Preparation is detached; the committed texture is never edited here.
 */
export function prepareWaterShore(
  project: TerrainProject,
  masks: ReturnType<typeof waterMasks>,
) {
  const n = project.resolution,
    side = n + 1,
    h = project.heights;
  const result = new Float32Array(side * side * 4);
  const settings = project.water;
  if (!settings) return result;
  const holes = effectiveHoles(project),
    step = project.size / n;
  const bodies = [
    {
      enabled: settings.ocean.enabled,
      elevation: settings.seaLevel,
      surface: settings.ocean.surface,
      extent: undefined,
      mask: masks.ocean,
    },
    ...settings.bodies.map((b, i) => ({ ...b, mask: masks.bodies[i].mask })),
  ]
    .filter((b) => b.enabled)
    .sort((a, b) => a.elevation - b.elevation);
  const smooth = (x: number) => {
    x = Math.max(0, Math.min(1, x));
    return x * x * (3 - 2 * x);
  };
  for (const body of bodies) {
    const s = body.surface;
    if (!(s.wetness || s.caustics)) continue;
    const mask = new Uint8Array(n * n),
      queue = new Int32Array(n * n);
    let head = 0,
      tail = 0;
    const contains = (x: number, z: number) =>
      !body.extent ||
      waterContains(
        body.extent,
        x * step - project.size / 2,
        z * step - project.size / 2,
      );
    const visit = (x: number, z: number, seed: boolean) => {
      const i = z * n + x,
        v = z * side + x;
      if (mask[i] || holes[i] || (!seed && !contains(x + 0.5, z + 0.5))) return;
      const minimum = Math.min(h[v], h[v + 1], h[v + side], h[v + side + 1]);
      if (minimum >= body.elevation + (seed ? 0 : s.wetBand)) return;
      mask[i] = 255;
      queue[tail++] = i;
    };
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) if (body.mask[z * n + x]) visit(x, z, true);
    const level = body.elevation + s.wetBand;
    while (head < tail) {
      const i = queue[head++],
        x = i % n,
        z = Math.floor(i / n),
        v = z * side + x;
      if (x > 0 && Math.min(h[v], h[v + side]) < level) visit(x - 1, z, false);
      if (x < n - 1 && Math.min(h[v + 1], h[v + side + 1]) < level)
        visit(x + 1, z, false);
      if (z > 0 && Math.min(h[v], h[v + 1]) < level) visit(x, z - 1, false);
      if (z < n - 1 && Math.min(h[v + side], h[v + side + 1]) < level)
        visit(x, z + 1, false);
    }
    for (let z = 0; z <= n; z++)
      for (let x = 0; x <= n; x++) {
        if (!contains(x, z)) continue;
        let covered = false;
        for (let dz = -1; dz <= 0; dz++)
          for (let dx = -1; dx <= 0; dx++) {
            const cx = x + dx,
              cz = z + dz;
            if (cx >= 0 && cz >= 0 && cx < n && cz < n && mask[cz * n + cx])
              covered = true;
          }
        if (!covered) continue;
        const v = z * side + x,
          depth = body.elevation - h[v],
          at = v * 4;
        const wet =
          s.wetness * (1 - smooth(-depth / Math.max(0.001, s.wetBand)));
        result[at] = Math.max(result[at], wet);
        if (depth > 0) {
          // Higher overlapping water replaces the lower body's optical field.
          result[at + 1] =
            s.caustics *
            smooth(depth / 0.15) *
            Math.exp(-depth / Math.min(12, s.visibility));
          result[at + 2] = depth;
          result[at + 3] = s.speed;
        }
      }
  }
  return result;
}

export const shoreDeclarations = /* glsl */ `
uniform sampler2D terrainShore;
uniform float terrainShoreSize;
uniform float terrainShoreCells;
uniform float terrainShoreTime;
uniform float terrainShoreEnabled;
vec4 terrainShoreAt(vec2 p) {
  vec2 uv=p/terrainShoreSize+.5;
  if(terrainShoreEnabled<.5 || any(lessThan(uv,vec2(0))) || any(greaterThan(uv,vec2(1)))) return vec4(0);
  // Explicit bilinear filtering also works without OES_texture_float_linear.
  vec2 cell=uv*terrainShoreCells, base=floor(cell), f=fract(cell);
  vec2 texel=vec2(1.0/(terrainShoreCells+1.0)), t=(base+.5)*texel;
  return mix(mix(texture2D(terrainShore,t),texture2D(terrainShore,t+vec2(texel.x,0)),f.x),
    mix(texture2D(terrainShore,t+vec2(0,texel.y)),texture2D(terrainShore,t+texel),f.x),f.y);
}
float terrainCaustic(vec2 p,float depth,float speed) {
  float t=terrainShoreTime*speed*.45;
  p*=2.4/(1.0+depth*.06);
  p+=vec2(sin(p.y*.73+t),sin(p.x*.61-t*.8))*.65;
  float web=sin(p.x+t)+sin(p.y-t*.7)+sin((p.x+p.y)*.73+t*.4)*.65;
  float aa=max(.04,fwidth(web));
  return (1.0-smoothstep(.08,.18+aa,abs(web)))*2.2-.18;
}
`;
