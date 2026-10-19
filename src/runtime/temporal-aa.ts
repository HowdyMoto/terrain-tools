import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

type Camera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
const vertexShader = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const fragmentShader = /* glsl */ `
varying vec2 vUv;
uniform sampler2D currentColor;
uniform sampler2D currentDepth;
uniform sampler2D history;
uniform vec2 size;
uniform vec2 jitter;
uniform mat4 inverseViewProjection;
uniform mat4 previousViewProjection;
uniform mat4 currentView;
uniform mat4 previousView;
uniform float historyValid;
vec3 toYCoCg(vec3 c) { return vec3(dot(c, vec3(0.25, 0.5, 0.25)), c.r * 0.5 - c.b * 0.5, -c.r * 0.25 + c.g * 0.5 - c.b * 0.25); }
vec3 fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
void main() {
  // Resolve into an unjittered image. Dilate foreground depth by one pixel so
  // subpixel leaves use their motion instead of alternating with sky depth.
  vec2 sampleUV = vUv + jitter;
  vec3 color = texture2D(currentColor, sampleUV).rgb;
  float depth = 1.0;
  vec2 closest = sampleUV;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 uv = sampleUV + vec2(float(x), float(y)) / size;
    float candidate = texture2D(currentDepth, uv).r;
    if (candidate < depth) { depth = candidate; closest = uv; }
  }
  vec4 world = inverseViewProjection * vec4(closest * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  world /= world.w;
  float viewDepth = -(currentView * world).z;
  vec4 previous = previousViewProjection * world;
  vec2 uv = vUv + (previous.xy / previous.w * 0.5 + 0.5) - (closest - jitter);
  float valid = historyValid;
  if (previous.w <= 0.0 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) valid = 0.0;
  vec4 old = texture2D(history, clamp(uv, vec2(0.0), vec2(1.0)));
  float expectedDepth = -(previousView * world).z;
  if (abs(old.a - expectedDepth) > max(0.08, expectedDepth * 0.01)) valid = 0.0;
  vec3 minimum = vec3(1e10), maximum = vec3(-1e10);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 sampleColor = toYCoCg(texture2D(currentColor, sampleUV + vec2(float(x), float(y)) / size).rgb);
    minimum = min(minimum, sampleColor); maximum = max(maximum, sampleColor);
  }
  // A current-frame neighborhood bounds old color at disocclusions and moving
  // leaves. Camera reprojection is exact; animated plants do not have motion vectors.
  vec3 clipped = fromYCoCg(clamp(toYCoCg(old.rgb), minimum, maximum));
  float motionPixels = length((uv - vUv) * size);
  float blend = mix(0.82, 0.55, smoothstep(1.0, 12.0, motionPixels)) * valid;
  // Water's reflection/refraction moves independently of its geometric depth.
  // Its alpha caps history reuse; opaque scene capture writes one. No extra pass.
  blend = min(blend, texture2D(currentColor,sampleUV).a);
  gl_FragColor = vec4(mix(color, max(clipped, vec3(0.0)), blend), min(viewDepth, 60000.0));
}`;

function halton(index: number, base: number) {
  let result = 0,
    fraction = 1;
  while (index > 0) {
    fraction /= base;
    result += fraction * (index % base);
    index = Math.floor(index / base);
  }
  return result;
}

/** Optional camera-reprojected temporal resolve for opaque full-viewport terrain
 * scenes. Accumulates linear HDR before one display transform, rejects disoccluded
 * history and clamps it to the current neighborhood. Wind has no motion vectors.
 */
export class TemporalAA {
  private readonly color: THREE.WebGLRenderTarget;
  private readonly history: THREE.WebGLRenderTarget[];
  private readonly size = new THREE.Vector2();
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly output = new OutputPass();
  private readonly outputUniforms = {
    terrainDetail: { value: 0.25 },
    terrainTexel: { value: new THREE.Vector2() },
  };
  private readonly previousViewProjection = new THREE.Matrix4();
  private readonly previousView = new THREE.Matrix4();
  private frame = 0;
  private read = 0;
  private valid = false;
  private disposed = false;
  error?: string;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.color = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: Math.min(4, renderer.capabilities.maxSamples),
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    this.history = [0, 1].map(
      () =>
        new THREE.WebGLRenderTarget(1, 1, {
          type: THREE.HalfFloatType,
          depthBuffer: false,
        }),
    );
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: {
        currentColor: { value: this.color.texture },
        currentDepth: { value: this.color.depthTexture },
        history: { value: this.history[0].texture },
        size: { value: this.size },
        jitter: { value: new THREE.Vector2() },
        inverseViewProjection: { value: new THREE.Matrix4() },
        previousViewProjection: { value: this.previousViewProjection },
        currentView: { value: new THREE.Matrix4() },
        previousView: { value: this.previousView },
        historyValid: { value: 0 },
      },
    });
    this.quad = new FullScreenQuad(this.material);
    Object.assign(this.output.uniforms, this.outputUniforms);
    // History alpha stores view depth. The authored environment is opaque.
    this.output.material.fragmentShader = this.output.material.fragmentShader
      .replace(
        'uniform sampler2D tDiffuse;',
        `uniform sampler2D tDiffuse;
        uniform float terrainDetail;
        uniform vec2 terrainTexel;
        vec3 terrainResolvedDetail(vec2 uv) {
          vec3 c = texture2D(tDiffuse, uv).rgb;
          if (terrainDetail <= 0.0) return c;
          vec3 n = texture2D(tDiffuse, uv + vec2(0.0, terrainTexel.y)).rgb;
          vec3 s = texture2D(tDiffuse, uv - vec2(0.0, terrainTexel.y)).rgb;
          vec3 e = texture2D(tDiffuse, uv + vec2(terrainTexel.x, 0.0)).rgb;
          vec3 w = texture2D(tDiffuse, uv - vec2(terrainTexel.x, 0.0)).rgb;
          vec3 lo = min(c, min(min(n, s), min(e, w)));
          vec3 hi = max(c, max(max(n, s), max(e, w)));
          // A small contrast envelope recovers thin details while limiting ringing.
          // Flat areas stay exact; sharpening never feeds back into history.
          vec3 limit = (hi - lo) * 0.1 * terrainDetail;
          return clamp(c + terrainDetail * 0.5 * (c - (n + s + e + w) * 0.25), max(lo - limit, vec3(0.0)), hi + limit);
        }`,
      )
      .replace(
        'gl_FragColor = texture2D( tDiffuse, vUv );',
        'gl_FragColor = vec4(terrainResolvedDetail(vUv), 1.0);',
      );
    try {
      this.resize();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  reset() {
    this.valid = false;
    this.frame = 0;
  }

  private resize() {
    const target = this.renderer.getRenderTarget();
    const size = target
      ? new THREE.Vector2(target.width, target.height)
      : this.renderer.getDrawingBufferSize(new THREE.Vector2());
    size.max(new THREE.Vector2(1, 1));
    if (this.size.equals(size)) return;
    for (const target of [this.color, ...this.history]) {
      target.setSize(size.x, size.y);
      this.renderer.initRenderTarget(target);
    }
    this.size.copy(size);
    this.outputUniforms.terrainTexel.value.set(1 / size.x, 1 / size.y);
    this.reset();
  }

  render(camera: Camera, renderScene: () => void, sharpness = 0.25) {
    this.resize();
    this.outputUniforms.terrainDetail.value = sharpness;
    const renderer = this.renderer;
    const saved = {
      target: renderer.getRenderTarget(),
      face: renderer.getActiveCubeFace(),
      mip: renderer.getActiveMipmapLevel(),
      projection: camera.projectionMatrix.clone(),
      inverse: camera.projectionMatrixInverse.clone(),
      toneMapping: renderer.toneMapping,
      colorSpace: renderer.outputColorSpace,
      xr: renderer.xr.enabled,
    };
    try {
      const index = (this.frame++ % 8) + 1;
      const x = ((halton(index, 2) - 0.5) * 2) / this.size.x;
      const y = ((halton(index, 3) - 0.5) * 2) / this.size.y;
      this.material.uniforms.jitter.value
        .set(x, y)
        .multiplyScalar(camera instanceof THREE.PerspectiveCamera ? -0.5 : 0.5);
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.projectionMatrix.elements[8] += x;
        camera.projectionMatrix.elements[9] += y;
      } else {
        camera.projectionMatrix.elements[12] += x;
        camera.projectionMatrix.elements[13] += y;
      }
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      camera.updateWorldMatrix(true, false);
      const viewProjection = new THREE.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      this.material.uniforms.inverseViewProjection.value
        .copy(viewProjection)
        .invert();
      this.material.uniforms.currentView.value.copy(camera.matrixWorldInverse);
      this.material.uniforms.historyValid.value = this.valid ? 1 : 0;
      this.material.uniforms.history.value = this.history[this.read].texture;
      renderer.xr.enabled = false;
      renderer.setRenderTarget(this.color);
      renderScene();
      const write = 1 - this.read;
      renderer.setRenderTarget(this.history[write]);
      this.quad.render(renderer);
      this.output.renderToScreen = saved.target === null;
      // Match WebGLRenderer's direct-render contract for offscreen targets.
      if (saved.target) {
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.outputColorSpace =
          saved.target.texture.colorSpace || THREE.LinearSRGBColorSpace;
      }
      this.output.render(
        renderer,
        saved.target ?? this.history[write],
        this.history[write],
        0,
        false,
      );
      this.read = write;
      this.valid = true;
      this.previousViewProjection.multiplyMatrices(
        saved.projection,
        camera.matrixWorldInverse,
      );
      this.previousView.copy(camera.matrixWorldInverse);
      this.error = undefined;
    } catch (error) {
      this.reset();
      this.error = String(error);
      throw error;
    } finally {
      camera.projectionMatrix.copy(saved.projection);
      camera.projectionMatrixInverse.copy(saved.inverse);
      renderer.toneMapping = saved.toneMapping;
      renderer.outputColorSpace = saved.colorSpace;
      renderer.xr.enabled = saved.xr;
      renderer.setRenderTarget(saved.target, saved.face, saved.mip);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.color.dispose();
    for (const target of this.history) target.dispose();
    this.material.dispose();
    this.quad.dispose();
    this.output.dispose();
  }
}
