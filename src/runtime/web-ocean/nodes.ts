import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  texture,
  max,
  abs,
  mix,
  smoothstep,
  uniform,
  sqrt,
  log2,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { OceanBindings } from './simulation';
import { oceanPatchSizes } from './simulation';

/** Use the spectral fields inside Terrain Studio's water optics and lighting.
 * Filtered first/second slope moments add distant specular variance. */
export function oceanNodes(bindings: OceanBindings) {
  const map = (key: 'displacement' | 'derivatives' | 'moments' | 'foam') =>
    texture(bindings[key].value).onObjectUpdate(() => bindings[key].value);
  const displacement = map('displacement'),
    derivative = map('derivatives'),
    moments = map('moments'),
    foam = map('foam');
  const center = uniform(bindings.center.value),
    whitecaps = uniform(0).onObjectUpdate(() => bindings.whitecaps.value),
    resolution = uniform(128).onObjectUpdate(() => bindings.resolution.value);
  const position = (p: Node<'vec2'>, spacing: Node<'float'>) =>
    Fn(() => {
      const value = vec3().toVar();
      for (let i = 0; i < 4; i++)
        value.addAssign(
          displacement
            .sample(p.div(oceanPatchSizes[i]))
            .depth(float(i))
            // Suppress wavelengths the local mesh spacing cannot represent.
            .level(
              log2(max(1, spacing.mul(resolution).div(oceanPatchSizes[i]))).add(
                0.5,
              ),
            ).xyz,
        );
      return value;
    })();
  const fields = (p: Node<'vec2'>) =>
    Fn(() => {
      const d = vec4().toVar(),
        cross = float(0).toVar(),
        variance = float(0).toVar();
      for (let i = 0; i < 6; i++) {
        const uv = p.div(oceanPatchSizes[i]);
        const sample = derivative.sample(uv).depth(float(i)),
          m = moments.sample(uv).depth(float(i));
        d.addAssign(sample);
        cross.addAssign(displacement.sample(uv).depth(float(i)).w);
        variance.addAssign(
          max(0, m.x.sub(sample.x.mul(sample.x))).add(
            max(0, m.y.sub(sample.y.mul(sample.y))),
          ),
        );
      }
      const jacobian = max(
        0.2,
        float(1).add(d.z).mul(float(1).add(d.w)).sub(cross.mul(cross)),
      );
      const slope = vec2(
        d.x.mul(float(1).add(d.w)).sub(d.y.mul(cross)),
        d.y.mul(float(1).add(d.z)).sub(d.x.mul(cross)),
      ).div(jacobian);
      return vec3(slope, sqrt(variance));
    })();
  const whitecap = (p: Node<'vec2'>) => {
    const distance = max(abs(p.x.sub(center.x)), abs(p.y.sub(center.y)));
    const near = foam.sample(p.div(128)).depth(float(0)).r;
    const far = foam.sample(p.div(1024)).depth(float(1)).r;
    return mix(near, far, smoothstep(44, 60, distance))
      .mul(float(1).sub(smoothstep(440, 500, distance)))
      .mul(whitecaps)
      .clamp(0, 1);
  };
  return { position, fields, whitecap };
}
