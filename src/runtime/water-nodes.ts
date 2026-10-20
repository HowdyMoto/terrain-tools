import { DepthTexture, RenderTarget } from 'three';
import type { IUniform } from 'three';
import type { MeshPhysicalMaterial, Node } from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  Break,
  int,
  float,
  vec2,
  vec3,
  vec4,
  mat2,
  positionGeometry,
  varying,
  normalize,
  normalView,
  positionView,
  positionViewDirection,
  cameraViewMatrix,
  screenUV,
  frontFacing,
  materialColor,
  materialRoughness,
  property,
  mix,
  min,
  max,
  dot,
  abs,
  floor,
  fract,
  sin,
  cos,
  sqrt,
  exp,
  pow,
  length,
  smoothstep,
  step,
  fwidth,
  dFdx,
  dFdy,
  reflect,
  select,
  uniformArray,
  attribute,
} from 'three/tsl';
import { terrainDirectSpecular } from '../render/node-lighting';
import {
  nodeTexture,
  nodeUniforms,
  materialNodeUniforms,
  materialNodeTexture,
} from '../render/node-uniforms';
import { oceanNodes } from './web-ocean/nodes';
import type { OceanBindings } from './web-ocean/simulation';

type N2 = Node<'vec2'>;
/** Native water shading. All distances, wave phases and foam remain in metres. */
const sharedWaterUniforms = materialNodeUniforms('terrainWaterUniforms');
let sharedWaterGraph:
  | { graph: Record<string, unknown>; users: number; release(): void }
  | undefined;

function releaseSharedWater(
  material: MeshPhysicalMaterial,
  shared: NonNullable<typeof sharedWaterGraph>,
) {
  let released = false;
  material.addEventListener('dispose', () => {
    if (released) return;
    released = true;
    if (--shared.users === 0) shared.release();
  });
}

export function configureWaterNodes(
  material: MeshPhysicalMaterial,
  values: Record<string, IUniform>,
  spectral?: OceanBindings,
) {
  Object.assign(material, { terrainWaterUniforms: values });
  for (const name of [
    'waterHeight',
    'waterMask',
    'waterFoamDetail',
    'waterSceneColor',
    'waterSceneDepth',
  ])
    Object.assign(material, { ['terrainWater' + name]: values[name] });
  if (!spectral && sharedWaterGraph) {
    const shared = sharedWaterGraph;
    shared.users++;
    Object.assign(material, shared.graph);
    releaseSharedWater(material, shared);
    return;
  }
  const u = spectral ? nodeUniforms(values) : sharedWaterUniforms;
  const map = (name: string, fallback?: import('three').Texture) =>
    spectral
      ? nodeTexture(values[name], fallback)
      : materialNodeTexture(
          'terrainWater' + name,
          values[name].value ?? fallback,
          fallback,
        );

  const ocean = spectral ? oceanNodes(spectral) : undefined;
  const height = map('waterHeight'),
    mask = map('waterMask'),
    foam = map('waterFoamDetail');
  const emptyDepth = new DepthTexture(1, 1);
  // Declare the eventual capture's single-sample layout before shader preflight.
  // An unattached depth texture otherwise inherits the current MSAA setting,
  // leaving cached shaders incompatible when the real capture is bound.
  const emptyCapture = new RenderTarget(1, 1, { depthTexture: emptyDepth });
  const release = () => {
    emptyDepth.dispose();
    emptyCapture.dispose();
  };
  if (spectral) material.addEventListener('dispose', release);
  const sceneColor = map('waterSceneColor'),
    sceneDepth = map('waterSceneDepth', emptyDepth);
  const ground = Fn(([p]: [N2]) => {
    const uv = p.div(u('waterSize')).add(0.5).toVar();
    const result = u('waterLevel').sub(1000).toVar();
    If(
      uv
        .greaterThanEqual(vec2(0))
        .all()
        .and(uv.lessThanEqual(vec2(1)).all()),
      () => {
        const c = min(
            uv.mul(u('waterCells')),
            vec2(u('waterCells').sub(0.0001)),
          ).toVar(),
          i = floor(c).toVar(),
          f = fract(c).toVar();
        const d = float(1).div(u('waterCells').add(1)).toVar(),
          t = i.add(0.5).mul(d).toVar();
        const a = height.sample(t).r.toVar(),
          b = height.sample(t.add(vec2(d, 0))).r.toVar(),
          c0 = height.sample(t.add(vec2(0, d))).r.toVar(),
          e = height.sample(t.add(d)).r.toVar();
        result.assign(
          select(
            f.x.add(f.y).lessThanEqual(1),
            a.add(b.sub(a).mul(f.x)).add(c0.sub(a).mul(f.y)),
            e
              .add(c0.sub(e).mul(float(1).sub(f.x)))
              .add(b.sub(e).mul(float(1).sub(f.y))),
          ),
        );
      },
    );
    return result;
  });
  const inside = Fn(([p]: [N2]) => {
    const uv = p.div(u('waterSize')).add(0.5),
      outside = uv
        .lessThan(vec2(0))
        .any()
        .or(uv.greaterThan(vec2(1)).any());
    const result = float(0).toVar();
    If(u('waterOcean').greaterThan(0.5), () => {
      result.assign(
        select(outside, float(1).sub(u('waterBounded')), mask.sample(uv).r),
      );
    })
      .ElseIf(u('waterKind').lessThan(0.5), () => {
        const d = p.sub(u('waterEllipse', 'vec4').xy),
          c = cos(u('waterRotation')),
          s = sin(u('waterRotation'));
        const q = vec2(
          c.mul(d.x).add(s.mul(d.y)),
          s.negate().mul(d.x).add(c.mul(d.y)),
        ).div(u('waterEllipse', 'vec4').zw);
        result.assign(float(1).sub(step(1, dot(q, q))));
      })
      .ElseIf(u('waterKind').greaterThan(1.5), () => {
        result.assign(select(outside, float(0), mask.sample(uv).r));
      })
      .Else(() => {
        const points = uniformArray<'vec2'>(
            values.waterPoints.value,
            'vec2',
          ).onObjectUpdate(function ({ material: current }) {
            if (!spectral)
              this.array = (
                current as unknown as { terrainWaterUniforms: typeof values }
              ).terrainWaterUniforms.waterPoints.value;
          }),
          count = u('waterPointCount', 'int');
        const b = points.element(count.sub(1)).toVar();
        Loop({ start: int(0), end: int(128), type: 'int' }, ({ i: index }) => {
          const i = int(index);
          If(i.greaterThanEqual(count), () => {
            Break();
          });
          const a = points.element(i);
          If(
            a.y
              .greaterThan(p.y)
              .xor(b.y.greaterThan(p.y))
              .and(
                p.x.lessThan(
                  b.x.sub(a.x).mul(p.y.sub(a.y)).div(b.y.sub(a.y)).add(a.x),
                ),
              ),
            () => {
              result.assign(float(1).sub(result));
            },
          );
          b.assign(a);
        });
      });
    return result;
  });
  const wave = (point: N2, detail: boolean) =>
    Fn(() => {
      const p = point.add(u('waterPhaseOrigin', 'vec2')),
        waves = u('waterWaves', 'vec4');
      const result = vec3().toVar();
      for (let i = 0; i < 6; i++) {
        const wavelength = (i < 3 ? waves.y : waves.w).mul(1 - (i % 3) * 0.21),
          k = float(6.2831853).div(wavelength);
        const amp = min(
          (i < 3 ? waves.x : waves.z).mul(0.24 / (1 + (i % 3))),
          float(0.18).div(k),
        );
        const angle = u('waterDirection').add(Math.sin(i * 8.7) * 0.65),
          dir = vec2(cos(angle), sin(angle));
        const phase = dot(p, dir)
          .mul(k)
          .sub(sqrt(k.mul(9.81)).mul(u('waterTime')))
          .add(i * 2.31);
        const filtered = detail
          ? float(1).sub(smoothstep(0.5, 2, length(fwidth(p)).mul(k)))
          : float(1);
        result.addAssign(
          vec3(
            sin(phase).mul(amp),
            dir.mul(cos(phase).mul(amp).mul(k).mul(filtered)),
          ),
        );
      }
      if (detail)
        for (let i = 0; i < 3; i++) {
          const k = 7 + i * 6.4,
            angle = u('waterDirection').add(i * 2.31),
            dir = vec2(cos(angle), sin(angle));
          const phase = dot(p, dir)
            .mul(k)
            .add(u('waterTime').mul(2 + i));
          const fade = float(1).sub(
            smoothstep(0.3, 1.3, length(fwidth(p)).mul(k)),
          );
          result.yz.addAssign(
            dir.mul(cos(phase)).mul(u('waterRipple')).mul(0.15).mul(fade),
          );
        }
      return result;
    })();
  const horizontal = positionGeometry.xz
    .mul(u('waterGridScale', 'vec2'))
    .add(u('waterCenter', 'vec2'));
  const spacing = ocean
    ? attribute('waterSpacing', 'vec2').mul(u('waterGridScale', 'vec2'))
    : undefined;
  const spectralMotion = ocean?.position(
    horizontal.add(u('waterPhaseOrigin', 'vec2')),
    max(spacing!.x, spacing!.y),
  );
  // FFT derivatives describe the original Lagrangian coordinate, before the
  // horizontal choppy displacement. Terrain contact still uses displaced local.
  const oceanCoordinate = ocean
    ? varying(horizontal.add(u('waterPhaseOrigin', 'vec2')))
    : undefined;
  const motion = spectralMotion
    ? vec3(spectralMotion.y, 0, 0)
    : wave(horizontal, false);
  const shallow = smoothstep(
    0,
    2,
    max(0, u('waterLevel').sub(ground(horizontal))),
  );
  const local = varying(
    vec3(
      spectralMotion
        ? horizontal.x.add(spectralMotion.x.mul(shallow))
        : horizontal.x,
      u('waterLevel').add(positionGeometry.y).add(motion.x.mul(shallow)),
      spectralMotion
        ? horizontal.y.add(spectralMotion.z.mul(shallow))
        : horizontal.y,
    ),
  );
  const depth = local.y.sub(ground(local.xz));
  const dx = dFdx(local.xz),
    dy = dFdy(local.xz),
    determinant = dx.x.mul(dy.y).sub(dx.y.mul(dy.x));
  const jacobian = select(determinant.lessThan(0), float(-1), float(1)).mul(
    max(abs(determinant), 0.00000001),
  );
  const gradient = (v: Node<'float'>) =>
    vec2(
      dFdx(v).mul(dy.y).sub(dFdy(v).mul(dx.y)),
      dFdy(v).mul(dx.x).sub(dFdx(v).mul(dy.x)),
    ).div(jacobian);
  const slope = max(0.08, length(gradient(depth)));
  const shore = float(1).sub(
    smoothstep(0, u('waterFoamWidth'), depth.div(slope)),
  );
  const drift = vec2(cos(u('waterDirection')), sin(u('waterDirection')))
    .mul(u('waterTime'))
    .mul(0.035);
  const foamUv = local.xz
    .add(u('waterPhaseOrigin', 'vec2'))
    .sub(drift)
    .mul(0.25);
  const foamA = foam.sample(foamUv).rgb;
  const foamB = foam.sample(
    mat2(0.8, 0.6, -0.6, 0.8)
      .mul(foamUv)
      .mul(1.37)
      .add(vec2(0.31, 0.73))
      .add(u('waterTime').mul(0.004)),
  ).rgb;
  const rafts = foamA.b.mul(0.8).add(foamB.b.mul(0.2));
  const pulse = sin(
    depth.div(slope).mul(4).sub(u('waterTime').mul(1.4)).add(rafts.mul(4)),
  )
    .mul(0.5)
    .add(0.5);
  const density = shore.mul(pulse.mul(0.35).add(0.65)),
    patches = smoothstep(0.46, 0.66, rafts.add(density.mul(0.12)));
  const lace = min(foamA.r, foamB.r.add(0.2)),
    fine = foamA.g.mul(0.65).add(foamB.g.mul(0.35));
  const fill = smoothstep(0.55, 0.95, density).mul(0.2);
  const coverage = mix(lace.mul(fine.mul(0.75).add(0.25)), fine, fill);
  const shoreFoam = u('waterFoam')
    .mul(shore)
    .mul(patches)
    .mul(coverage)
    .mul(1.55)
    .clamp(0, 1)
    .mul(
      smoothstep(
        0,
        u('waterSize').div(u('waterCells')).mul(1.5),
        u('waterSize')
          .mul(0.5)
          .sub(max(abs(local.x), abs(local.z))),
      ),
    );
  const oceanFields = ocean?.fields(oceanCoordinate!);
  const foamAmount = ocean
    ? max(
        shoreFoam,
        ocean
          .whitecap(local.xz.add(u('waterPhaseOrigin', 'vec2')))
          .mul(smoothstep(0, 2, max(0, u('waterLevel').sub(ground(local.xz)))))
          .mul(coverage.mul(0.8).add(0.2)),
      )
    : shoreFoam;
  const relief = foamA.g.mul(0.002).add(foamB.g.mul(0.001)).mul(foamAmount);
  const detail = (oceanFields ? oceanFields.xy : wave(local.xz, true).yz)
    .mul(smoothstep(0, 2, max(0, u('waterLevel').sub(ground(local.xz)))))
    .add(gradient(relief).clamp(-0.35, 0.35));
  const normal = normalize(
    u('waterNormalWorld', 'mat3').mul(
      vec3(detail.x.negate(), 1, detail.y.negate()),
    ),
  );
  const viewPoint = (uv: N2) => {
    const p = u('waterInverseProjection', 'mat4').mul(
      vec4(
        uv.x.mul(2).sub(1),
        float(1).sub(uv.y.mul(2)),
        sceneDepth.sample(uv).r,
        1,
      ),
    );
    return p.xyz.div(p.w);
  };
  const outputNode = Fn(() => {
    const diffuse = property('vec3', 'totalDiffuse').toVar(),
      specular = property('vec3', 'totalSpecular').toVar();
    If(u('waterCapture').greaterThan(0.5), () => {
      const p = positionView,
        n = normalView,
        uv = screenUV;
      const behind = viewPoint(uv),
        path = max(0, length(behind.sub(p))).toVar();
      const refracted = uv
        .add(vec2(n.x, n.y.negate()).mul(min(0.015, path.mul(0.0015))))
        .clamp(0.001, 0.999)
        .toVar();
      If(viewPoint(refracted).z.greaterThan(p.z.sub(0.02)), () => {
        refracted.assign(uv);
      });
      path.assign(min(path, u('waterVisibility').mul(6)));
      const attenuation = exp(
        vec3(1.8, 0.85, 0.65).mul(path.negate().div(u('waterVisibility'))),
      );
      const transmitted = sceneColor.sample(refracted).rgb.mul(attenuation);
      const fresnel = pow(
        float(1).sub(max(dot(n, normalize(positionViewDirection)), 0)),
        5,
      )
        .mul(0.97963)
        .add(0.02037);
      diffuse.assign(
        mix(
          transmitted
            .add(diffuse.mul(vec3(1).sub(attenuation)))
            .mul(float(1).sub(fresnel)),
          diffuse,
          foamAmount,
        ),
      );
      If(
        u('waterReflections')
          .greaterThan(0.5)
          .and(materialRoughness.lessThan(0.6))
          .and(fresnel.greaterThan(0.04))
          .and(foamAmount.lessThan(0.8)),
        () => {
          const ray = reflect(normalize(p), n),
            q = p.toVar(),
            stride = max(0.25, p.z.negate().mul(0.012)).toVar();
          Loop({ start: int(0), end: int(16), type: 'int' }, ({ i: index }) => {
            const i = int(index);
            q.addAssign(ray.mul(stride));
            stride.mulAssign(1.28);
            const clip = u('waterProjection', 'mat4').mul(vec4(q, 1));
            const hitUv = vec2(
              clip.x.div(clip.w).mul(0.5).add(0.5),
              float(0.5).sub(clip.y.div(clip.w).mul(0.5)),
            );
            If(
              clip.w
                .lessThanEqual(0)
                .or(hitUv.lessThan(vec2(0.01)).any())
                .or(hitUv.greaterThan(vec2(0.99)).any()),
              () => {
                Break();
              },
            );
            const delta = viewPoint(hitUv).z.sub(q.z);
            If(
              i
                .greaterThan(1)
                .and(delta.greaterThan(0.02))
                .and(delta.lessThan(stride.mul(0.8)))
                .and(sceneDepth.sample(hitUv).r.lessThan(0.99999)),
              () => {
                const valid = smoothstep(
                  0,
                  0.12,
                  min(
                    min(hitUv.x, hitUv.y),
                    min(float(1).sub(hitUv.x), float(1).sub(hitUv.y)),
                  ),
                ).mul(float(1).sub(float(i).div(20)));
                const reflected = sceneColor
                  .sample(hitUv)
                  .rgb.mul(fresnel)
                  .add(terrainDirectSpecular);
                specular.assign(
                  mix(
                    specular,
                    reflected,
                    valid
                      .mul(float(1).sub(foamAmount))
                      .mul(float(1).sub(materialRoughness))
                      .mul(smoothstep(0.04, 0.1, fresnel)),
                  ),
                );
                Break();
              },
            );
          });
        },
      );
    });
    return vec4(
      diffuse.add(specular),
      select(u('waterReactive').greaterThan(0.5), float(0.28), float(1)),
    );
  })();
  const graph = {
    positionNode: vec3(
      spectralMotion
        ? positionGeometry.x.add(
            spectralMotion.x.mul(shallow).div(u('waterGridScale', 'vec2').x),
          )
        : positionGeometry.x,
      positionGeometry.y.add(motion.x.mul(shallow)),
      spectralMotion
        ? positionGeometry.z.add(
            spectralMotion.z.mul(shallow).div(u('waterGridScale', 'vec2').y),
          )
        : positionGeometry.z,
    ),
    maskNode: inside(local.xz)
      .greaterThanEqual(0.5)
      .and(depth.greaterThanEqual(0)),
    colorNode: mix(materialColor.rgb, vec3(0.86, 0.89, 0.88), foamAmount),
    roughnessNode: mix(
      oceanFields
        ? max(
            materialRoughness,
            // PhysicalMaterial squares perceptual roughness into GGX alpha.
            // The filtered field stores RMS slope, so convert it accordingly.
            sqrt(oceanFields.z).add(u('waterRipple').mul(0.02)),
          ).clamp(0.02, 1)
        : materialRoughness,
      fine.mul(0.3).add(0.55),
      foamAmount,
    ),
    normalNode: normalize(cameraViewMatrix.mul(vec4(normal, 0)).xyz).mul(
      select(frontFacing, float(1), float(-1)),
    ),
    outputNode,
  };
  Object.assign(material, graph);
  if (!spectral) {
    const shared = {
      graph,
      users: 1,
      release() {
        if (sharedWaterGraph === shared) sharedWaterGraph = undefined;
        release();
      },
    };
    sharedWaterGraph = shared;
    releaseSharedWater(material, shared);
  }
}
