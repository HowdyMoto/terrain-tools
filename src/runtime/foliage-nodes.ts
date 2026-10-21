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
  sqrt,
} from 'three/tsl';
import type { WindUniforms } from './wind';
import type { FoliageSubsurface } from '../core/foliage-shading';
import { impostorVertex } from '../render/impostor-nodes';
import { materialNodeUniforms } from '../render/node-uniforms';
import {
  foliageMatrixAttribute,
  foliagePreviousAttribute,
  foliagePreviousStateAttribute,
  foliageCurrentStateAttribute,
  foliageCapsuleAttribute,
  foliagePreviousCapsuleAttribute,
} from '../render/native-foliage';

type N = Node<'vec3'>;
const windGraphs = new Map<
  string,
  { positionNode: Node; terrainHistoryNode: Node }
>();
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
  contact: Node<'vec4'>;
  capsule: Node<'vec2'>;
  wind: Node<'vec4'>;
  windDirection: Node<'vec2'>;
  rootAmount: Node<'vec2'>;
};
/** Capsule push and droop with an analytic local-space Jacobian. The rest-pose
 * vertex test keeps high canopies and leaves beyond the body completely still. */
const capsuleDeformation = Fn(
  ({
    m,
    p,
    flex,
    contact,
    capsule,
  }: {
    m: Node<'mat4'>;
    p: N;
    flex: Node<'vec4'>;
    contact: Node<'vec4'>;
    capsule: Node<'vec2'>;
  }) => {
    const world = m.mul(vec4(p, 1)).xyz;
    const radius = max(contact.w, 0.01),
      reach = radius.add(0.2);
    const low = capsule.x.add(radius),
      high = capsule.y.sub(radius);
    const closestY = world.y.clamp(low, high);
    const delta = world.sub(vec3(contact.y, closestY, contact.z));
    const distance = max(length(delta), 0.0001);
    const falloff = float(1).sub(distance.div(reach)).max(0);
    const radial = sqrt(
      delta.x.mul(delta.x).add(delta.z.mul(delta.z)).add(0.0025),
    );
    const unit = vec3(delta.x.div(radial), 0, delta.z.div(radial));
    const height = world.y.sub(column4(m, 3).y);
    const droop = height.clamp(0, 1.4).mul(0.9);
    const push = unit.mul(0.75).sub(vec3(0, droop, 0));
    const amplitude = contact.x.negate();
    const factor = falloff.mul(amplitude).mul(flex.x);
    const inverse = (v: N) =>
      vec3(
        ...([0, 1, 2].map((i) =>
          dot(column4(m, i).xyz, v).div(
            max(dot(column4(m, i).xyz, column4(m, i).xyz), 0.0001),
          ),
        ) as [Node<'float'>, Node<'float'>, Node<'float'>]),
      );
    const position = p.add(inverse(push).mul(factor));
    const activeY = select(
      world.y.lessThan(low).or(world.y.greaterThan(high)),
      float(1),
      float(0),
    );
    const distanceGradient = delta
      .mul(vec3(1, activeY, 1))
      .div(distance.mul(reach))
      .negate();
    const columns = [0, 1, 2].map((axis) => {
      const basis = column4(m, axis).xyz;
      const dx = basis.x,
        dz = basis.z;
      const unitDerivative = vec3(dx, 0, dz)
        .div(radial)
        .sub(
          unit
            .mul(delta.x.mul(dx).add(delta.z.mul(dz)))
            .div(radial.mul(radial)),
        );
      const droopDerivative = select(
        height.greaterThan(0).and(height.lessThan(1.4)),
        basis.y.mul(0.9),
        float(0),
      );
      const pushDerivative = unitDerivative
        .mul(0.75)
        .sub(vec3(0, droopDerivative, 0));
      const maskGradient = [flex.y, flex.z, flex.w][axis];
      const derivative = select(
        falloff.greaterThan(0),
        dot(distanceGradient, basis),
        float(0),
      )
        .mul(amplitude)
        .mul(flex.x)
        .add(falloff.mul(amplitude).mul(maskGradient));
      return vec4(
        vec3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0).add(
          inverse(pushDerivative.mul(factor).add(push.mul(derivative))),
        ),
        0,
      );
    });
    return mat4(vec4(position, 1), columns[0], columns[1], columns[2]);
  },
).setLayout({
  name: 'terrainCapsuleDeformation',
  type: 'mat4',
  inputs: [
    { name: 'm', type: 'mat4' },
    { name: 'p', type: 'vec3' },
    { name: 'flex', type: 'vec4' },
    { name: 'contact', type: 'vec4' },
    { name: 'capsule', type: 'vec2' },
  ],
});
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
      capsule,
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
        const amount = max(contact.x, 0);
        const bend = amount.mul(mask),
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
          .mul(amount.mul(0.9))
          .add(vec3(s.negate(), c, 0).mul(amount.mul(-0.75).mul(p.y)));
        jacobian.assign(
          rotation.add(
            matrix3(
              derivative.mul(gradient.x),
              derivative.mul(gradient.y),
              derivative.mul(gradient.z),
            ),
          ),
        );
        If(contact.x.lessThan(0), () => {
          const capsulePose = capsuleDeformation({
            m,
            p: sourcePosition,
            flex,
            contact,
            capsule,
          }).toVar();
          q.assign(column4(capsulePose, 0).xyz);
          jacobian.assign(
            matrix3(
              column4(capsulePose, 1).xyz,
              column4(capsulePose, 2).xyz,
              column4(capsulePose, 3).xyz,
            ),
          );
        });
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
      { name: 'contact', type: 'vec4' },
      { name: 'capsule', type: 'vec2' },
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
      capsule,
      wind,
      direction,
      rootAmount,
    }: {
      m: Node<'mat4'>;
      p: N;
      flex: Node<'float'>;
      contact: Node<'vec4'>;
      capsule: Node<'vec2'>;
      wind: Node<'vec4'>;
      direction: Node<'vec2'>;
      rootAmount: Node<'vec2'>;
    }) => {
      const q = p.toVar();
      if (masked) {
        const relative = p.sub(vec3(0, rootAmount.x, 0));
        const bend = max(contact.x, 0).mul(flex),
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
        If(contact.x.lessThan(0), () => {
          q.assign(
            column4(
              capsuleDeformation({
                m,
                p,
                flex: vec4(flex, 0, 0, 0),
                contact,
                capsule,
              }),
              0,
            ).xyz,
          );
        });
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
      { name: 'contact', type: 'vec4' },
      { name: 'capsule', type: 'vec2' },
      { name: 'wind', type: 'vec4' },
      { name: 'direction', type: 'vec2' },
      { name: 'rootAmount', type: 'vec2' },
    ],
  });
const previousMaskedPosition = previousDeformation(true),
  previousWindPosition = previousDeformation(false);

const nativeFade = () => {
  const state = attribute(foliageCurrentStateAttribute, 'vec4');
  const start = state.z.sub(
    select(state.z.greaterThan(1.5), float(2), float(0)),
  );
  const origin = vec2(
    attribute(foliageMatrixAttribute + '0', 'vec4').w,
    attribute(foliageMatrixAttribute + '2', 'vec4').w,
  );
  const seed = fract(sin(dot(origin, vec2(12.9898, 78.233))).mul(43758.5453));
  return vec3(start, state.w, seed);
};

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
    const attributeMatrix = (prefix: string) => {
      const a = attribute(prefix + '0', 'vec4'),
        b = attribute(prefix + '1', 'vec4'),
        c = attribute(prefix + '2', 'vec4');
      return matrix4(
        vec4(a.x, b.x, c.x, 0),
        vec4(a.y, b.y, c.y, 0),
        vec4(a.z, b.z, c.z, 0),
        vec4(a.w, b.w, c.w, 1),
      );
    };
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
    const impostor = builder.geometry.hasAttribute('terrainImpostorCorner')
      ? impostorVertex(
          matrix,
          builder.geometry.getAttribute('terrainImpostorAzimuths').getX(0),
        )
      : undefined;
    const tangent = builder.geometry.hasAttribute('tangent');
    const deformed = (root === undefined ? windDeformation : maskedDeformation)(
      {
        m: matrix,
        sourcePosition: impostor?.position ?? positionGeometry,
        sourceNormal: impostor?.normal ?? normalGeometry,
        sourceTangent: tangent ? tangentGeometry.xyz : vec3(1, 0, 0),
        flex:
          root === undefined
            ? vec4(0)
            : attribute('terrainFlexibility', 'vec4'),
        contact:
          root === undefined
            ? vec4(0)
            : nativeBatch
              ? vec4(
                  attribute(foliageCurrentStateAttribute, 'vec4').x,
                  attribute(foliageCapsuleAttribute, 'vec4').xy,
                  attribute(foliageCurrentStateAttribute, 'vec4').y,
                )
              : attribute('terrainContact', 'vec4'),
        capsule:
          root === undefined
            ? vec2(0)
            : nativeBatch
              ? attribute(foliageCapsuleAttribute, 'vec4').zw
              : attribute('terrainCapsule', 'vec2'),
        wind: vec4(u('uTime'), u('uStrength'), u('uSpeed'), u('uGust')),
        windDirection: u('uDirection', 'vec2'),
        rootAmount: vec2(root ?? 0, amount),
      },
    ).toVar();
    if (motion) {
      const state = attribute(foliagePreviousStateAttribute, 'vec4');
      const previous = (
        root === undefined ? previousWindPosition : previousMaskedPosition
      )({
        m: attributeMatrix(foliagePreviousAttribute),
        p: impostor?.position ?? positionGeometry,
        flex:
          root === undefined
            ? float(0)
            : attribute('terrainFlexibility', 'vec4').x,
        contact: state,
        capsule: attribute(foliagePreviousCapsuleAttribute, 'vec2'),
        wind: reference('userData.terrainPreviousWind', 'vec4', null),
        direction: reference('userData.terrainPreviousDirection', 'vec2', null),
        rootAmount: vec2(root ?? 0, amount),
      });
      positionPrevious.assign(
        select(
          attribute(foliageCurrentStateAttribute, 'vec4').z.greaterThan(1.5),
          previous,
          column3(deformed, 0),
        ),
      );
    }
    normalLocal.assign(column3(deformed, 1));
    if (tangent) tangentLocal.assign(column3(deformed, 2));
    return column3(deformed, 0);
  })();
  const graph = {
    positionNode,
    terrainHistoryNode: Fn((builder: NodeBuilder) => {
      if (
        !builder.geometry.hasAttribute(foliagePreviousStateAttribute) ||
        !(
          builder as NodeBuilder & { needsPreviousData(): boolean }
        ).needsPreviousData() ||
        builder.material.transparent
      )
        return output.a;
      let history: Node<'float'> = varying(
        select(
          attribute(foliageCurrentStateAttribute, 'vec4').z.greaterThan(1.5),
          float(1),
          float(0),
        ),
      ).setInterpolation('flat');
      if (builder.geometry.hasAttribute('terrainFade')) {
        // These bounds belong to an instance, not the leaf surface. Perspective
        // interpolation can turn a settled 1 into <1 and reject history forever.
        const fade = varying(nativeFade()).setInterpolation('flat');
        history = history.mul(
          select(
            fade.x.greaterThan(0).or(fade.y.lessThan(1)),
            float(0.25),
            float(1),
          ),
        );
      }
      // Fresh/cross-fading cutouts should not inherit unrelated old coverage.
      // Keep this separate from the alpha used for smooth leaf coverage.
      return history;
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
          ? nativeFade()
          : attribute('terrainFade', 'vec3'),
      ).setInterpolation('flat');
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
