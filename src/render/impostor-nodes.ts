import type { Node, ArrayNode } from 'three/webgpu';
import {
  Fn,
  attribute,
  varyingProperty,
  vec2,
  vec3,
  vec4,
  float,
  mat3,
  modelWorldMatrix,
  cameraPosition,
  cameraWorldMatrix,
  cameraProjectionMatrix,
  normalize,
  dot,
  element,
  sin,
  cos,
  floor,
  mod,
} from 'three/tsl';

export const impostorUV = varyingProperty('vec2', 'terrainImpostorUV');
export const impostorFacing = varyingProperty('vec3', 'terrainImpostorFacing');
export const impostorBlend = varyingProperty('vec2', 'terrainImpostorBlend');

/** Only two cards are submitted. Capture selection/orientation happens in the
 * vertex shader, avoiding rasterization and discard of every unused view. */
export function impostorVertex(matrix: Node<'mat4'>, azimuths: number) {
  const sphere = attribute('terrainImpostorSphere', 'vec4');
  const world = modelWorldMatrix.mul(matrix);
  const ortho = element(
    cameraProjectionMatrix as unknown as ArrayNode<'vec4'>,
    3,
  ).w;
  const direction = normalize(
    ortho
      .greaterThan(0.5)
      .select(
        element(cameraWorldMatrix as unknown as ArrayNode<'vec4'>, 2).xyz,
        cameraPosition.sub(world.mul(vec4(sphere.xyz, 1)).xyz),
      ),
  );
  const local = normalize(
    vec3(
      dot(element(world as unknown as ArrayNode<'vec4'>, 0).xyz, direction),
      dot(element(world as unknown as ArrayNode<'vec4'>, 1).xyz, direction),
      dot(element(world as unknown as ArrayNode<'vec4'>, 2).xyz, direction),
    ),
  );
  const selection = Fn(() => {
    const best = float(-2).toVar(),
      second = float(-2).toVar();
    const firstIndex = float(0).toVar(),
      secondIndex = float(0).toVar();
    for (let row = 0; row < 5; row++)
      for (let column = 0; column < azimuths; column++) {
        const yaw = (column * Math.PI * 2) / azimuths,
          pitch = ((row * 30 - 30) * Math.PI) / 180;
        const score = dot(
          local,
          vec3(
            Math.sin(yaw) * Math.cos(pitch),
            Math.sin(pitch),
            Math.cos(yaw) * Math.cos(pitch),
          ),
        );
        const first = score.greaterThan(best).toVar(),
          runner = score.greaterThan(second).toVar();
        secondIndex.assign(
          first.select(
            firstIndex,
            runner.select(float(row * azimuths + column), secondIndex),
          ),
        );
        second.assign(first.select(best, second.max(score)));
        firstIndex.assign(
          first.select(float(row * azimuths + column), firstIndex),
        );
        best.assign(best.max(score));
      }
    return vec3(
      firstIndex,
      secondIndex,
      float(1)
        .sub(second)
        .div(float(2).sub(best).sub(second).max(0.00001))
        .clamp(0, 1),
    );
  })();
  const card = attribute('terrainImpostorCorner', 'vec4');
  const corner = card.xy,
    layer = card.z;
  const index = layer.lessThan(0.5).select(selection.x, selection.y);
  const column = mod(index, azimuths),
    row = floor(index.div(azimuths));
  const yaw = column.mul((Math.PI * 2) / azimuths),
    pitch = row
      .mul(30)
      .sub(30)
      .mul(Math.PI / 180);
  const right = vec3(cos(yaw), 0, sin(yaw).negate());
  const up = vec3(
    sin(yaw).negate().mul(sin(pitch)),
    cos(pitch),
    cos(yaw).negate().mul(sin(pitch)),
  );
  const facing = vec3(
    sin(yaw).mul(cos(pitch)),
    sin(pitch),
    cos(yaw).mul(cos(pitch)),
  );
  const resolution = card.w;
  const cellUV = vec2(corner.x.add(1), float(1).sub(corner.y))
    .mul(0.5)
    .mul(resolution.sub(1))
    .add(0.5)
    .div(resolution);
  impostorUV.assign(cellUV.add(vec2(column, row)).div(vec2(azimuths, 5)));
  impostorFacing.assign(facing);
  impostorBlend.assign(vec2(layer, selection.z));
  return {
    position: sphere.xyz.add(
      right.mul(corner.x).add(up.mul(corner.y)).mul(sphere.w),
    ),
    normal: facing,
    tangent: mat3(matrix).mul(right),
  };
}
