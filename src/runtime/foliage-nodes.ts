import {
  InstancedInterleavedBuffer,
  PhysicalLightingModel,
} from 'three/webgpu';
import type {
  Material,
  Node,
  NodeBuilder,
  InstancedMesh,
  ArrayNode,
} from 'three/webgpu';
import {
  Fn,
  If,
  element,
  attribute,
  positionGeometry,
  positionPrevious,
  normalGeometry,
  normalLocal,
  tangentGeometry,
  tangentLocal,
  vec3,
  vec4,
  mat3,
  mat4,
  sin,
  cos,
  pow,
  max,
  dot,
  float,
  length,
  normalize,
  cross,
  instancedDynamicBufferAttribute,
  varying,
  screenCoordinate,
  fract,
  floor,
  vec2,
  normalView,
  diffuseColor,
  uniform,
  color,
  exp,
  abs,
  reference,
  output,
  select,
} from 'three/tsl';
import type { WindUniforms } from './wind';
import type { FoliageSubsurface } from '../core/foliage-shading';
import { materialNodeUniforms } from '../render/node-uniforms';
import {
  foliageMatrixAttribute,
  foliagePreviousAttribute,
  foliagePreviousStateAttribute,
  foliageCurrentStateAttribute,
} from '../render/native-foliage';

type N = Node<'vec3'>;
const windGraphs = new Map<string, { positionNode: Node; outputNode: Node }>();
const windMaterialUniforms = materialNodeUniforms('terrainWindUniforms');
const fadeGraphs = new WeakMap<() => boolean, Node>();
const leafGraphs = new Map<string, Record<string, unknown>>();
const matrix3 = (a: N, b: N, c: N) => mat3(a, b, c);
const matrix4 = mat4;
// Matrix indexing is supported by TSL; published declarations restrict element to arrays.
const column4 = (m: Node<'mat4'>, i: number) =>
  element(m as unknown as ArrayNode<'vec4'>, i);
const column3 = (m: Node<'mat3'>, i: number) =>
  element(m as unknown as ArrayNode<'vec3'>, i);

type DeformationInputs = {
  m: Node<'mat4'>;
  sourcePosition: N;
  sourceNormal: N;
  sourceTangent: N;
  flex: Node<'vec4'>;
  contact: Node<'float'>;
  wind: Node<'vec4'>;
  windDirection: Node<'vec2'>;
  rootAmount: Node<'vec2'>;
};
// Explicit layouts compile these pure functions once per renderer, instead of
// rebuilding their math for every spatial/LOD instanced mesh and shadow pass.
const deformationFunction = (masked: boolean) =>
  Fn(
    ({
      m,
      sourcePosition,
      sourceNormal,
      sourceTangent,
      flex,
      contact,
      wind,
      windDirection,
      rootAmount,
    }: DeformationInputs) => {
      const worldDirection = vec3(windDirection.x, 0, windDirection.y);
      const localDirection = (i: number) =>
        dot(column4(m, i).xyz, worldDirection).div(
          max(dot(column4(m, i).xyz, column4(m, i).xyz), 0.0001),
        );
      const direction = vec3(
        localDirection(0),
        localDirection(1),
        localDirection(2),
      );
      const phase = column4(m, 3).x.mul(0.12).add(column4(m, 3).z.mul(0.09));
      const amplitude = sin(wind.x.mul(wind.z).mul(1.7).add(phase))
        .mul(
          float(0.5).add(sin(wind.x.mul(0.37).add(phase)).mul(wind.w).mul(0.5)),
        )
        .mul(wind.y)
        .mul(rootAmount.y.mul(0.09));
      const scale = length(column4(m, 1).xyz);
      const result = sourcePosition.toVar(),
        jacobian = mat3(1, 0, 0, 0, 1, 0, 0, 0, 1).toVar();
      if (masked) {
        const mask = flex.x,
          gradient = flex.yzw,
          pivot = vec3(0, rootAmount.x, 0),
          p = sourcePosition.sub(pivot);
        const bend = contact.mul(mask),
          angle = bend.mul(0.9),
          scaleY = float(1).sub(bend.mul(0.75));
        const s = sin(angle),
          c = cos(angle);
        const rotation = matrix3(
          vec3(c, s, 0),
          vec3(s.negate().mul(scaleY), c.mul(scaleY), 0),
          vec3(0, 0, 1),
        );
        const q = rotation.mul(p).add(pivot).toVar();
        const derivative = vec3(
          s.negate().mul(p.x).sub(c.mul(scaleY).mul(p.y)),
          c.mul(p.x).sub(s.mul(scaleY).mul(p.y)),
          0,
        )
          .mul(contact.mul(0.9))
          .add(vec3(s.negate(), c, 0).mul(contact.mul(-0.75).mul(p.y)));
        jacobian.assign(
          rotation.add(
            matrix3(
              derivative.mul(gradient.x),
              derivative.mul(gradient.y),
              derivative.mul(gradient.z),
            ),
          ),
        );
        const height = max(q.y.sub(rootAmount.x), 0).mul(scale),
          profile = pow(height, 1.25);
        const heightGradient = vec3().toVar();
        If(q.y.greaterThan(rootAmount.x), () => {
          heightGradient.assign(
            vec3(
              column3(jacobian, 0).y,
              column3(jacobian, 1).y,
              column3(jacobian, 2).y,
            ).mul(scale),
          );
        });
        const displacement = gradient
          .mul(profile)
          .add(heightGradient.mul(mask).mul(1.25).mul(pow(height, 0.25)))
          .mul(amplitude);
        result.assign(q.add(direction.mul(amplitude).mul(profile).mul(mask)));
        jacobian.addAssign(
          matrix3(
            direction.mul(displacement.x),
            direction.mul(displacement.y),
            direction.mul(displacement.z),
          ),
        );
      } else {
        const height = max(sourcePosition.y, 0).mul(scale);
        result.addAssign(direction.mul(amplitude).mul(pow(height, 1.25)));
        const gradient = amplitude.mul(1.25).mul(pow(height, 0.25)).mul(scale);
        jacobian.assign(
          matrix3(
            vec3(1, 0, 0),
            vec3(0, 1, 0).add(direction.mul(gradient)),
            vec3(0, 0, 1),
          ),
        );
      }
      const cofactor = matrix3(
        cross(column3(jacobian, 1), column3(jacobian, 2)),
        cross(column3(jacobian, 2), column3(jacobian, 0)),
        cross(column3(jacobian, 0), column3(jacobian, 1)),
      );
      const n = cofactor.mul(sourceNormal).toVar();
      If(dot(n, n).lessThan(0.00000001), () => {
        n.assign(sourceNormal);
      });
      const basis = mat3(m);
      const inverseScale = vec3(
        dot(column4(m, 0).xyz, column4(m, 0).xyz),
        dot(column4(m, 1).xyz, column4(m, 1).xyz),
        dot(column4(m, 2).xyz, column4(m, 2).xyz),
      );
      return matrix3(
        m.mul(vec4(result, 1)).xyz,
        normalize(basis.mul(n.div(max(inverseScale, vec3(0.00000001))))),
        normalize(basis.mul(jacobian.mul(sourceTangent))),
      );
    },
  ).setLayout({
    name: masked ? 'terrainMaskedDeformation' : 'terrainWindDeformation',
    type: 'mat3',
    inputs: [
      { name: 'm', type: 'mat4' },
      { name: 'sourcePosition', type: 'vec3' },
      { name: 'sourceNormal', type: 'vec3' },
      { name: 'sourceTangent', type: 'vec3' },
      { name: 'flex', type: 'vec4' },
      { name: 'contact', type: 'float' },
      { name: 'wind', type: 'vec4' },
      { name: 'windDirection', type: 'vec2' },
      { name: 'rootAmount', type: 'vec2' },
    ],
  });
const maskedDeformation = deformationFunction(true),
  windDeformation = deformationFunction(false);

// Previous-frame velocity needs only position: avoid a second normal/tangent
// Jacobian evaluation for every leaf vertex, and omit this in shadow shaders.
const previousDeformation = (masked: boolean) =>
  Fn(
    ({
      m,
      p,
      flex,
      contact,
      wind,
      direction,
      rootAmount,
    }: {
      m: Node<'mat4'>;
      p: N;
      flex: Node<'float'>;
      contact: Node<'float'>;
      wind: Node<'vec4'>;
      direction: Node<'vec2'>;
      rootAmount: Node<'vec2'>;
    }) => {
      const q = p.toVar();
      if (masked) {
        const relative = p.sub(vec3(0, rootAmount.x, 0));
        const bend = contact.mul(flex),
          angle = bend.mul(0.9);
        const s = sin(angle),
          c = cos(angle),
          sy = float(1).sub(bend.mul(0.75));
        q.assign(
          vec3(
            c.mul(relative.x).sub(s.mul(sy).mul(relative.y)),
            s.mul(relative.x).add(c.mul(sy).mul(relative.y)).add(rootAmount.x),
            relative.z,
          ),
        );
      }
      const worldDirection = vec3(direction.x, 0, direction.y);
      const localDirection = (i: number) =>
        dot(column4(m, i).xyz, worldDirection).div(
          max(dot(column4(m, i).xyz, column4(m, i).xyz), 0.0001),
        );
      const phase = column4(m, 3).x.mul(0.12).add(column4(m, 3).z.mul(0.09));
      const amplitude = sin(wind.x.mul(wind.z).mul(1.7).add(phase))
        .mul(
          float(0.5).add(sin(wind.x.mul(0.37).add(phase)).mul(wind.w).mul(0.5)),
        )
        .mul(wind.y)
        .mul(rootAmount.y.mul(0.09));
      const height = max(masked ? q.y.sub(rootAmount.x) : q.y, 0).mul(
        length(column4(m, 1).xyz),
      );
      q.addAssign(
        vec3(localDirection(0), localDirection(1), localDirection(2))
          .mul(amplitude)
          .mul(pow(height, 1.25))
          .mul(masked ? flex : float(1)),
      );
      return m.mul(vec4(q, 1)).xyz;
    },
  ).setLayout({
    name: masked
      ? 'terrainPreviousMaskedPosition'
      : 'terrainPreviousWindPosition',
    type: 'vec3',
    inputs: [
      { name: 'm', type: 'mat4' },
      { name: 'p', type: 'vec3' },
      { name: 'flex', type: 'float' },
      { name: 'contact', type: 'float' },
      { name: 'wind', type: 'vec4' },
      { name: 'direction', type: 'vec2' },
      { name: 'rootAmount', type: 'vec2' },
    ],
  });
const previousMaskedPosition = previousDeformation(true),
  previousWindPosition = previousDeformation(false);

/** Position nodes run after built-in instancing. Work from geometry attributes,
 * then apply the instance matrix once, including the analytic normal Jacobian.
 * The same positionNode is consumed by native WebGPU shadow passes. */
export function configureWindNodes(
  material: Material,
  amount: number,
  uniforms: WindUniforms,
  root?: number,
) {
  Object.assign(material, { terrainWindUniforms: uniforms });
  const graphKey = amount + '|' + root;
  const cached = windGraphs.get(graphKey);
  if (cached) {
    Object.assign(material, cached);
    return;
  }
  const u = windMaterialUniforms;
  const matrices = new WeakMap<InstancedMesh, Node<'mat4'>>();
  const positionNode = Fn((builder: NodeBuilder) => {
    const mesh = builder.object as InstancedMesh;
    const nativeBatch = builder.geometry.hasAttribute(
      foliageMatrixAttribute + '0',
    );
    const motion =
      nativeBatch &&
      (
        builder as NodeBuilder & { needsPreviousData(): boolean }
      ).needsPreviousData();
    const attributeMatrix = (prefix: string) =>
      matrix4(
        attribute(prefix + '0', 'vec4'),
        attribute(prefix + '1', 'vec4'),
        attribute(prefix + '2', 'vec4'),
        attribute(prefix + '3', 'vec4'),
      );
    let matrix = nativeBatch
      ? attributeMatrix(foliageMatrixAttribute)
      : matrices.get(mesh);
    if (!matrix) {
      const data = new InstancedInterleavedBuffer(
        mesh.instanceMatrix.array,
        16,
        1,
      );
      const columns = [0, 4, 8, 12].map((offset) =>
        instancedDynamicBufferAttribute<'vec4'>(data, 'vec4', 16, offset),
      );
      // Three updates dynamic attributes every render, including compacted LOD batches.
      matrix = matrix4(columns[0], columns[1], columns[2], columns[3]);
      matrices.set(mesh, matrix);
    }
    const tangent = builder.geometry.hasAttribute('tangent');
    const deformed = (root === undefined ? windDeformation : maskedDeformation)(
      {
        m: matrix,
        sourcePosition: positionGeometry,
        sourceNormal: normalGeometry,
        sourceTangent: tangent ? tangentGeometry.xyz : vec3(1, 0, 0),
        flex:
          root === undefined
            ? vec4(0)
            : attribute('terrainFlexibility', 'vec4'),
        contact:
          root === undefined
            ? float(0)
            : nativeBatch
              ? attribute(foliageCurrentStateAttribute, 'vec4').x
              : attribute('terrainContact', 'float'),
        wind: vec4(u('uTime'), u('uStrength'), u('uSpeed'), u('uGust')),
        windDirection: u('uDirection', 'vec2'),
        rootAmount: vec2(root ?? 0, amount),
      },
    ).toVar();
    if (motion) {
      const state = attribute(foliagePreviousStateAttribute, 'vec2');
      const previous = (
        root === undefined ? previousWindPosition : previousMaskedPosition
      )({
        m: attributeMatrix(foliagePreviousAttribute),
        p: positionGeometry,
        flex:
          root === undefined
            ? float(0)
            : attribute('terrainFlexibility', 'vec4').x,
        contact: state.x,
        wind: reference('userData.terrainPreviousWind', 'vec4', null),
        direction: reference('userData.terrainPreviousDirection', 'vec2', null),
        rootAmount: vec2(root ?? 0, amount),
      });
      positionPrevious.assign(
        select(state.y.greaterThan(0.5), previous, column3(deformed, 0)),
      );
    }
    normalLocal.assign(column3(deformed, 1));
    if (tangent) tangentLocal.assign(column3(deformed, 2));
    return column3(deformed, 0);
  })();
  const graph = {
    positionNode,
    outputNode: Fn((builder: NodeBuilder) => {
      if (
        !builder.geometry.hasAttribute(foliagePreviousStateAttribute) ||
        !(
          builder as NodeBuilder & { needsPreviousData(): boolean }
        ).needsPreviousData() ||
        builder.material.transparent
      )
        return output;
      let history: Node<'float'> = varying(
        attribute(foliagePreviousStateAttribute, 'vec2').y,
      );
      if (builder.geometry.hasAttribute('terrainFade')) {
        const fade = varying(
          attribute(foliageCurrentStateAttribute, 'vec4').yzw,
        );
        history = history.mul(
          select(
            fade.x.greaterThan(0).or(fade.y.lessThan(1)),
            float(0.25),
            float(1),
          ),
        );
      }
      // The native compositor already uses HDR alpha as temporal history weight.
      // Fresh/cross-fading cutouts should not inherit unrelated old coverage.
      return vec4(output.rgb, output.a.mul(history));
    })(),
  };
  windGraphs.set(graphKey, graph);
  if (windGraphs.size > 32) windGraphs.delete(windGraphs.keys().next().value!);
  Object.assign(material, graph);
}

export function configureFadeNodes(material: Material, enabled: () => boolean) {
  let maskNode = fadeGraphs.get(enabled);
  if (!maskNode) {
    maskNode = Fn((builder: NodeBuilder) => {
      if (!enabled()) return float(1);
      const fade = varying(
        builder.geometry.hasAttribute(foliageCurrentStateAttribute)
          ? attribute(foliageCurrentStateAttribute, 'vec4').yzw
          : attribute('terrainFade', 'vec3'),
      );
      const noise = fract(
        fract(
          dot(floor(screenCoordinate.xy), vec2(0.06711056, 0.00583715)).add(
            fade.z,
          ),
        ).mul(52.9829189),
      );
      return noise.greaterThanEqual(fade.x).and(noise.lessThan(fade.y));
    })();
    fadeGraphs.set(enabled, maskNode);
  }
  Object.assign(material, { maskNode });
}

export function configureLeafNodes(
  material: Material,
  settings: FoliageSubsurface,
  strengthMask?: Node<'float'>,
) {
  const key = JSON.stringify([
    settings.strength,
    settings.thickness,
    settings.tint,
    settings.wrap,
    strengthMask?.getCacheKey(),
  ]);
  const cached = leafGraphs.get(key);
  if (cached) {
    Object.assign(material, cached);
    return;
  }
  const strength = uniform(settings.strength),
    thickness = uniform(settings.thickness),
    tint = color(settings.tint),
    wrap = uniform(settings.wrap);
  class LeafLighting extends PhysicalLightingModel {
    override direct(
      input: Parameters<PhysicalLightingModel['direct']>[0],
      builder: NodeBuilder,
    ) {
      super.direct(input, builder);
      const nDotL = dot(normalView, input.lightDirection as Node<'vec3'>);
      const through = nDotL.negate().add(wrap).div(wrap.add(1)).saturate();
      const absorption = exp(thickness.negate().div(max(abs(nDotL), 0.2)));
      (input.reflectedLight.directDiffuse as Node<'vec3'>).addAssign(
        (input.lightColor as Node<'vec3'>)
          .mul(diffuseColor.rgb)
          .mul(tint)
          .mul(strength)
          .mul(strengthMask ?? float(1))
          .mul(through)
          .mul(absorption)
          .mul(1 / Math.PI),
      );
    }
  }
  const graph = {
    // Include the custom lighting inputs in NodeMaterial's graph cache key.
    terrainLeafStrengthNode: strength,
    terrainLeafThicknessNode: thickness,
    terrainLeafTintNode: tint,
    terrainLeafWrapNode: wrap,
    setupLightingModel: () => new LeafLighting(),
  };
  leafGraphs.set(key, graph);
  if (leafGraphs.size > 32) leafGraphs.delete(leafGraphs.keys().next().value!);
  Object.assign(material, graph);
}
