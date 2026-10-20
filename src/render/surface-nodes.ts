import { Vector3 } from 'three';
import type { IUniform, Color, Texture } from 'three';
import type { MeshStandardMaterial, Node, NodeBuilder } from 'three/webgpu';
import {
  Fn,
  If,
  attribute,
  varying,
  positionLocal,
  positionGeometry,
  normalLocal,
  modelNormalMatrix,
  vec2,
  vec3,
  vec4,
  float,
  uint,
  uvec2,
  ivec2,
  int,
  max,
  min,
  mix,
  dot,
  pow,
  abs,
  normalize,
  dFdx,
  dFdy,
  floor,
  fract,
  select,
  texture,
  smoothstep,
  sin,
  fwidth,
  uniformArray,
  uniform,
} from 'three/tsl';
import { terrainLodTarget } from './native-terrain-lod';
import {
  materialNodeTexture,
  materialNodeUniforms,
  nodeUniforms,
} from './node-uniforms';

type N2 = Node<'vec2'>;
type N3 = Node<'vec3'>;
type N4 = Node<'vec4'>;
type Frame = { uv: N2; dx: N2; dy: N2 };

/** Identical integer hash and stochastic triangle blend to the WebGL surface. */
const tileOffset = Fn(([cell]: [N2]) => {
  const key = uvec2(ivec2(cell));
  const h = key.x
    .mul(uint(1664525))
    .add(key.y.mul(uint(1013904223)))
    .add(uint(374761393))
    .toVar();
  h.assign(h.bitXor(h.shiftRight(uint(16))).mul(uint(2246822519)));
  h.assign(h.bitXor(h.shiftRight(uint(13))).mul(uint(3266489917)));
  h.bitXorAssign(h.shiftRight(uint(16)));
  const k = h.bitXor(uint(668265263)).mul(uint(2246822519)).toVar();
  k.assign(k.bitXor(k.shiftRight(uint(13))).mul(uint(3266489917)));
  k.bitXorAssign(k.shiftRight(uint(16)));
  return vec2(float(h.bitAnd(uint(65535))), float(k.bitAnd(uint(65535)))).div(
    65536,
  );
});

/** Linear HDR surface evaluation, shared by the viewport and export baking. */
export function surfaceNodes(
  values: Record<string, IUniform>,
  p: N3,
  sourceNormal: N3,
  weights: N4,
  flat = false,
  perMaterial = false,
) {
  const u = perMaterial
    ? materialNodeUniforms('terrainSurfaceUniforms')
    : nodeUniforms(values);
  const maps = [
    'terrainAlbedo',
    'terrainNormal',
    'terrainOrm',
    'terrainHeight',
  ].map((name) => texture(values[name].value));
  const colors = uniformArray<'vec3'>(
    (values.layerColors.value as Color[]).map(
      (c) => new Vector3(c.r, c.g, c.b),
    ),
    'vec3',
  ).setName('terrainLayerColors');
  if (perMaterial)
    colors.onObjectUpdate(function ({ material }) {
      this.array = (
        material as MeshStandardMaterial & { terrainLayerColors: Vector3[] }
      ).terrainLayerColors;
    });
  const resultColor = vec3().toVar('terrainColor');
  const resultNormal = vec3().toVar('terrainNormal');
  const resultOrm = vec3().toVar('terrainOrm');
  const evaluate = Fn(() => {
    const n = normalize(sourceNormal).toVar();
    if (flat) {
      const face = normalize(dFdx(p).cross(dFdy(p)));
      n.assign(select(dot(face, n).lessThan(0), face.negate(), face));
    }
    const signs = vec3(
      select(n.x.lessThan(0), float(-1), float(1)),
      select(n.y.lessThan(0), float(-1), float(1)),
      select(n.z.lessThan(0), float(-1), float(1)),
    ).toVar();
    const projection = pow(abs(n), vec3(4)).toVar();
    projection.divAssign(max(dot(projection, vec3(1)), 0.00001));
    const dx = dFdx(p).toVar(),
      dy = dFdy(p).toVar();
    const albedo: N4[] = [],
      orm: N4[] = [],
      normals: N3[] = [],
      heights: Node<'float'>[] = [];
    for (let i = 0; i < 4; i++) {
      const scale = max(
        [
          u('layerScale', 'vec4').x,
          u('layerScale', 'vec4').y,
          u('layerScale', 'vec4').z,
          u('layerScale', 'vec4').w,
        ][i],
        0.01,
      ).toVar();
      const q = p.div(scale).toVar(),
        qx = dx.div(scale).toVar(),
        qy = dy.div(scale).toVar();
      const frames: Frame[] = [
        {
          uv: vec2(signs.x.negate().mul(q.z), q.y),
          dx: vec2(signs.x.negate().mul(qx.z), qx.y),
          dy: vec2(signs.x.negate().mul(qy.z), qy.y),
        },
        {
          uv: vec2(q.x, signs.y.negate().mul(q.z)),
          dx: vec2(qx.x, signs.y.negate().mul(qx.z)),
          dy: vec2(qy.x, signs.y.negate().mul(qy.z)),
        },
        {
          uv: vec2(signs.z.mul(q.x), q.y),
          dx: vec2(signs.z.mul(qx.x), qx.y),
          dy: vec2(signs.z.mul(qy.x), qy.y),
        },
      ];
      // Materialize shared coordinates before coverage/variation branches.
      // Otherwise TSL may cache a temporary first emitted inside an untaken
      // branch and reuse its zero value for the remaining maps or axes.
      for (const frame of frames) {
        frame.uv = frame.uv.toVar();
        frame.dx = frame.dx.toVar();
        frame.dy = frame.dy.toVar();
      }
      const layer = int(
        [
          u('layerIndices', 'vec4').x,
          u('layerIndices', 'vec4').y,
          u('layerIndices', 'vec4').z,
          u('layerIndices', 'vec4').w,
        ][i],
      ).toVar();
      const sample = (map: number, axis: number): N4 => {
        const { uv, dx, dy } = frames[axis];
        const lookup = (uv: N2) =>
          maps[map].sample(uv).depth(layer).grad(dx, dy);
        const result = vec4().toVar();
        If(
          [
            u('layerVariation', 'vec4').x,
            u('layerVariation', 'vec4').y,
            u('layerVariation', 'vec4').z,
            u('layerVariation', 'vec4').w,
          ][i].lessThan(0.5),
          () => {
            result.assign(lookup(uv));
          },
        ).Else(() => {
          const grid = vec2(
            uv.x.sub(uv.y.mul(0.57735026919)),
            uv.y.mul(1.15470053838),
          ).mul(0.5);
          const cell = floor(grid),
            f = fract(grid);
          const lower = f.x.add(f.y).lessThanEqual(1);
          const a = select(lower, cell, cell.add(1));
          const b = cell.add(select(lower, vec2(1, 0), vec2(0, 1)));
          const c = cell.add(select(lower, vec2(0, 1), vec2(1, 0)));
          const w = pow(
            select(
              lower,
              vec3(float(1).sub(f.x).sub(f.y), f.x, f.y),
              vec3(f.x.add(f.y).sub(1), float(1).sub(f.x), float(1).sub(f.y)),
            ),
            vec3(4),
          ).toVar();
          w.divAssign(max(dot(w, vec3(1)), 0.00001));
          result.assign(
            lookup(uv.add(tileOffset(a)))
              .mul(w.x)
              .add(lookup(uv.add(tileOffset(b))).mul(w.y))
              .add(lookup(uv.add(tileOffset(c))).mul(w.z)),
          );
        });
        return result;
      };
      const tri = (map: number) =>
        sample(map, 0)
          .mul(projection.x)
          .add(sample(map, 1).mul(projection.y))
          .add(sample(map, 2).mul(projection.z));
      albedo[i] = vec4().toVar();
      orm[i] = vec4().toVar();
      normals[i] = n.toVar();
      heights[i] = float(0).toVar();
      If(
        [weights.x, weights.y, weights.z, weights.w][i].greaterThanEqual(
          0.00001,
        ),
        () => {
          albedo[i].assign(tri(0));
          orm[i].assign(tri(2));
          heights[i].assign(
            tri(3).r.mul(
              [
                u('layerBlend', 'vec4').x,
                u('layerBlend', 'vec4').y,
                u('layerBlend', 'vec4').z,
                u('layerBlend', 'vec4').w,
              ][i],
            ),
          );
          const strength = [
            u('layerNormalStrength', 'vec4').x,
            u('layerNormalStrength', 'vec4').y,
            u('layerNormalStrength', 'vec4').z,
            u('layerNormalStrength', 'vec4').w,
          ][i];
          If(strength.greaterThan(0), () => {
            const ns = vec2(
              strength,
              strength.mul(
                [
                  u('layerNormalY', 'vec4').x,
                  u('layerNormalY', 'vec4').y,
                  u('layerNormalY', 'vec4').z,
                  u('layerNormalY', 'vec4').w,
                ][i],
              ),
            );
            const readNormal = (axis: number) => {
              const v = sample(1, axis).xyz.mul(2).sub(1);
              return normalize(vec3(v.xy.mul(ns), v.z));
            };
            const x = readNormal(0),
              y = readNormal(1),
              z = readNormal(2);
            const nx = vec3(
              x.z.mul(n.x),
              x.y.add(n.y),
              x.x.negate().mul(signs.x).add(n.z),
            );
            const ny = vec3(
              y.x.add(n.x),
              y.z.mul(n.y),
              y.y.negate().mul(signs.y).add(n.z),
            );
            const nz = vec3(
              z.x.mul(signs.z).add(n.x),
              z.y.add(n.y),
              z.z.mul(n.z),
            );
            normals[i].assign(
              normalize(
                nx
                  .mul(projection.x)
                  .add(ny.mul(projection.y))
                  .add(nz.mul(projection.z)),
              ),
            );
          });
        },
      );
    }
    const h = vec4(
      ...([0, 1, 2, 3].map((i) =>
        select(
          [weights.x, weights.y, weights.z, weights.w][i].lessThan(0.00001),
          float(-10000),
          [weights.x, weights.y, weights.z, weights.w][i].add(heights[i]),
        ),
      ) as [Node<'float'>, Node<'float'>, Node<'float'>, Node<'float'>]),
    ).toVar();
    const peak = max(max(h.x, h.y), max(h.z, h.w));
    const blend = max(h.sub(peak).add(0.22), 0).mul(weights).toVar();
    blend.divAssign(max(dot(blend, vec4(1)), 0.00001));
    resultColor.assign(vec3(0));
    resultNormal.assign(vec3(0));
    resultOrm.assign(vec3(0));
    for (let i = 0; i < 4; i++) {
      resultColor.addAssign(
        albedo[i].rgb
          .mul(colors.element(int(i)))
          .mul([blend.x, blend.y, blend.z, blend.w][i]),
      );
      resultNormal.addAssign(
        normals[i].mul([blend.x, blend.y, blend.z, blend.w][i]),
      );
      resultOrm.addAssign(
        orm[i].rgb
          .mul(
            vec3(
              1,
              [
                u('layerRoughness', 'vec4').x,
                u('layerRoughness', 'vec4').y,
                u('layerRoughness', 'vec4').z,
                u('layerRoughness', 'vec4').w,
              ][i],
              [
                u('layerMetalness', 'vec4').x,
                u('layerMetalness', 'vec4').y,
                u('layerMetalness', 'vec4').z,
                u('layerMetalness', 'vec4').w,
              ][i],
            ),
          )
          .mul([blend.x, blend.y, blend.z, blend.w][i]),
      );
    }
    return resultColor;
  })();
  return {
    color: evaluate,
    normal: Fn(() => {
      evaluate.toStack();
      return normalize(resultNormal);
    })(),
    orm: Fn(() => {
      evaluate.toStack();
      return resultOrm;
    })(),
  };
}

function terrainGraph(
  values: Record<string, IUniform>,
  shoreValues: Record<string, IUniform>,
  flat: boolean,
) {
  const p = varying(positionLocal),
    n = varying(normalLocal);
  const surface = surfaceNodes(
    values,
    p,
    n,
    varying(attribute('layerWeights', 'vec4')),
    flat,
    true,
  );
  const u = materialNodeUniforms('terrainShoreUniforms'),
    map = materialNodeTexture(
      'terrainShoreTexture',
      shoreValues.terrainShore.value,
    );
  const shore = Fn(() => {
    const uv = p.xz.div(u('terrainShoreSize')).add(0.5);
    const result = vec4().toVar();
    If(
      u('terrainShoreEnabled')
        .greaterThan(0.5)
        .and(uv.greaterThanEqual(vec2(0)).all())
        .and(uv.lessThanEqual(vec2(1)).all()),
      () => {
        const cell = uv.mul(u('terrainShoreCells')),
          base = floor(cell),
          f = fract(cell);
        const d = float(1).div(u('terrainShoreCells').add(1)),
          t = base.add(0.5).mul(d);
        result.assign(
          mix(
            mix(map.sample(t), map.sample(t.add(vec2(d, 0))), f.x),
            mix(map.sample(t.add(vec2(0, d))), map.sample(t.add(d)), f.x),
            f.y,
          ),
        );
      },
    );
    return result;
  })();
  const caustic = Fn(() => {
    const t = u('terrainShoreTime').mul(shore.a).mul(0.45),
      q = p.xz.mul(float(2.4).div(shore.b.mul(0.06).add(1))).toVar();
    q.addAssign(
      vec2(sin(q.y.mul(0.73).add(t)), sin(q.x.mul(0.61).sub(t.mul(0.8)))).mul(
        0.65,
      ),
    );
    const web = sin(q.x.add(t))
      .add(sin(q.y.sub(t.mul(0.7))))
      .add(sin(q.x.add(q.y).mul(0.73).add(t.mul(0.4))).mul(0.65));
    return float(1)
      .sub(smoothstep(0.08, max(0.04, fwidth(web)).add(0.18), abs(web)))
      .mul(2.2)
      .sub(0.18)
      .mul(shore.g)
      .mul(max(n.y, 0));
  })();
  const morph = uniform(0).onObjectUpdate(
    ({ object }) =>
      (object as { morphTargetInfluences?: number[] })
        .morphTargetInfluences?.[0] ?? 0,
  );
  return {
    positionNode: Fn((builder: NodeBuilder) =>
      builder.geometry.hasAttribute(terrainLodTarget)
        ? mix(positionGeometry, attribute(terrainLodTarget, 'vec3'), morph)
        : positionLocal,
    )(),
    // Native shadows ask colorNode for alpha, even for opaque vec3 surfaces.
    // Do not build the entire triplanar PBR graph just to obtain constant 1.
    colorNode: Fn((builder: NodeBuilder) =>
      (builder.material as { isShadowPassMaterial?: boolean })
        .isShadowPassMaterial
        ? vec3(1)
        : surface.color.mul(float(1).sub(shore.r.mul(0.45))),
    )(),
    roughnessNode: mix(surface.orm.g, min(surface.orm.g, 0.22), shore.r).clamp(
      0.04,
      1,
    ),
    metalnessNode: surface.orm.b.clamp(0, 1),
    normalNode: normalize(modelNormalMatrix.mul(surface.normal)),
    aoNode: surface.orm.r,
    // Caustic visibility is supplied by the connected-water field.
    terrainCausticNode: max(0, caustic.add(1)),
  };
}

// Texture identity includes array layout, sampling and color-space semantics.
// Weak ownership lets retired world libraries and their graphs be collected.
const terrainGraphs = new WeakMap<
  Texture,
  {
    maps: Texture[];
    variants: Map<boolean, ReturnType<typeof terrainGraph>>;
  }
>();

export function configureTerrainNodes(
  material: MeshStandardMaterial,
  values: Record<string, IUniform>,
  shoreValues: Record<string, IUniform>,
) {
  const maps = [
    'terrainAlbedo',
    'terrainNormal',
    'terrainOrm',
    'terrainHeight',
  ].map((name) => values[name].value as Texture);
  let cached = terrainGraphs.get(maps[0]);
  if (!cached || maps.some((map, i) => map !== cached!.maps[i])) {
    cached = { maps, variants: new Map() };
    terrainGraphs.set(maps[0], cached);
  }
  let graph = cached.variants.get(material.flatShading);
  if (!graph) {
    graph = terrainGraph(values, shoreValues, material.flatShading);
    cached.variants.set(material.flatShading, graph);
  }
  // Own properties are copied by the native material adapter. Keep runtime
  // bindings out of userData, which is serialized by GLTFExporter.
  Object.assign(material, graph, {
    terrainSurfaceUniforms: values,
    terrainShoreUniforms: shoreValues,
    terrainShoreTexture: shoreValues.terrainShore,
    terrainLayerColors: (values.layerColors.value as Color[]).map(
      (c) => new Vector3(c.r, c.g, c.b),
    ),
  });
  material.needsUpdate = true;
}
