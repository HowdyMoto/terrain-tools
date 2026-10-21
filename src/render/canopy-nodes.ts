import {
  Data3DTexture,
  DataTexture,
  RedFormat,
  HalfFloatType,
  LinearFilter,
  Vector3,
  Vector2,
  Matrix4,
} from 'three';
import type { Scene, Color } from 'three';
import type { Node } from 'three/webgpu';
import {
  uniform,
  texture3D,
  texture,
  vec3,
  vec4,
  positionWorld,
  normalWorld,
  diffuseColor,
  If,
  float,
} from 'three/tsl';
import type { EnvironmentSettings } from '../core/environment';
import { getCanopyBinding } from './canopy-binding';
import type { CanopyLightField } from '../runtime/canopy-lighting';

const empty = new Data3DTexture(new Uint16Array([0, 0, 0, 15360]), 1, 1, 1);
empty.type = HalfFloatType;
empty.minFilter = empty.magFilter = LinearFilter;
empty.needsUpdate = true;
const emptyGround = new DataTexture(
  new Uint16Array([0]),
  1,
  1,
  RedFormat,
  HalfFloatType,
);
emptyGround.needsUpdate = true;
const identity = new Matrix4(),
  zero = new Vector3();
const lighting = new WeakMap<Scene, { gains: Vector2; sun: Vector3 }>();
export function setCanopySun(
  scene: Scene,
  settings: EnvironmentSettings,
  color: Color,
  intensity: number,
  elevation: number,
) {
  let state = lighting.get(scene);
  if (!state)
    lighting.set(scene, (state = { gains: new Vector2(), sun: new Vector3() }));
  const enabled = settings.canopyLighting?.enabled;
  state.gains.set(
    enabled ? settings.canopyLighting!.strength : 0,
    enabled ? settings.canopyLighting!.bounce : 0,
  );
  state.sun
    .set(color.r, color.g, color.b)
    .multiplyScalar(Math.max(0, intensity * elevation));
}
const fieldFor = (object: object | null) => getCanopyBinding(object)?.field;
const fieldTexture = texture3D(empty);
const groundTexture = texture(emptyGround);
const groundRange = uniform(new Vector2());
const worldToField = uniform(identity.clone());
let boundField: CanopyLightField | undefined;
// One callback handles field bindings. Ordinary scenes with the feature off
// must not pay for a set of per-object vector/matrix update callbacks.
// Texture3DNode.setup also resets updateType in Three r186, so binding through
// this uniform callback avoids silently sampling its empty fallback.
const active = uniform(0).onObjectUpdate(({ object }) => {
  const field = fieldFor(object);
  if (field !== boundField) {
    boundField = field;
    fieldTexture.value = field?.texture ?? empty;
    groundTexture.value = field?.groundTexture ?? emptyGround;
    groundRange.value = field?.normalizedGroundRange ?? zeroGains;
    worldToField.value = field?.worldToField ?? identity;
  }
  return field ? 1 : 0;
});
const zeroGains = new Vector2();
const gains = uniform(new Vector2()).onRenderUpdate(
  ({ scene }) => (scene ? lighting.get(scene)?.gains : undefined) ?? zeroGains,
);
const sun = uniform(new Vector3()).onRenderUpdate(
  ({ scene }) => (scene ? lighting.get(scene)?.sun : undefined) ?? zero,
);

/** Changes indirect light only. Direct sun, shadow tests and leaf transmission
 * retain their ordinary PBR paths. Ground bounce is bounded to 15% of sun input. */
export function applyCanopyLight(light: Record<string, Node<'vec3'>>) {
  If(active.mul(gains.x.add(gains.y)).greaterThan(0), () => {
    const coordinate = worldToField.mul(vec4(positionWorld, 1)).xyz;
    const ground = groundTexture
      .sample(coordinate.xz)
      .r.mul(groundRange.y)
      .add(groundRange.x);
    const uvw = vec3(coordinate.x, coordinate.y.sub(ground), coordinate.z);
    const inside = uvw.x
      .greaterThanEqual(0)
      .and(uvw.y.greaterThanEqual(0))
      .and(uvw.z.greaterThanEqual(0))
      .and(uvw.x.lessThanEqual(1))
      .and(uvw.y.lessThanEqual(1))
      .and(uvw.z.lessThanEqual(1));
    If(inside, () => {
      const field = fieldTexture.sample(uvw);
      const visibility = float(1).sub(float(1).sub(field.a).mul(gains.x));
      light.indirectDiffuse.mulAssign(visibility);
      light.indirectSpecular.mulAssign(
        float(1).sub(float(1).sub(visibility).mul(0.4)),
      );
      const upwardBounce = float(1).sub(normalWorld.y).mul(0.5).saturate();
      light.indirectDiffuse.addAssign(
        vec3(field.rgb)
          .mul(sun)
          .mul(diffuseColor.rgb)
          .mul(gains.y)
          .mul(upwardBounce)
          .mul(0.15 / Math.PI),
      );
    });
  });
}
