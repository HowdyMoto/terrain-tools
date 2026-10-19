import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { TerrainWater } from './water';

/** One linear color/depth capture shared by every visible water body. */
export class WaterPass {
  private target?: THREE.WebGLRenderTarget;
  private readonly size = new THREE.Vector2();
  private readonly copy = new THREE.ShaderMaterial({
    uniforms: {
      source: { value: null },
      sourceDepth: { value: null },
      underwater: { value: 0 },
      waterColor: { value: new THREE.Color() },
      visibility: { value: 1 },
      inverseProjection: { value: new THREE.Matrix4() },
    },
    vertexShader:
      'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
    fragmentShader: `varying vec2 vUv; uniform sampler2D source; uniform sampler2D sourceDepth;
      uniform float underwater; uniform vec3 waterColor; uniform float visibility; uniform mat4 inverseProjection;
      void main(){gl_FragColor=vec4(texture2D(source,vUv).rgb,1.0);gl_FragDepth=texture2D(sourceDepth,vUv).r;
      if(underwater>0.5){vec4 p=inverseProjection*vec4(vUv*2.0-1.0,gl_FragDepth*2.0-1.0,1.0);float d=length(p.xyz/p.w);vec3 a=exp(-d/visibility*vec3(1.8,.85,.65));gl_FragColor.rgb=gl_FragColor.rgb*a+waterColor*(1.0-a);}
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.AlwaysDepth,
  });
  private readonly quad = new FullScreenQuad(this.copy);
  error?: string;
  constructor(private renderer: THREE.WebGLRenderer) {}
  prepare() {
    const renderer = this.renderer,
      target = renderer.getRenderTarget();
    const size = target
      ? new THREE.Vector2(target.width, target.height)
      : renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.target && this.size.equals(size)) return;
    const candidate = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(
        size.x,
        size.y,
        THREE.UnsignedIntType,
      ),
    });
    try {
      renderer.initRenderTarget(candidate);
      const saved = renderer.getRenderTarget();
      try {
        renderer.setRenderTarget(candidate);
        const gl = renderer.getContext();
        if (
          gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
        )
          throw new Error('Water scene capture is unavailable.');
      } finally {
        renderer.setRenderTarget(saved);
      }
      const previous = this.target;
      this.target = candidate;
      this.size.copy(size);
      previous?.dispose();
      this.copy.uniforms.source.value = candidate.texture;
      this.copy.uniforms.sourceDepth.value = candidate.depthTexture;
    } catch (error) {
      candidate.dispose();
      throw error;
    }
  }
  render(
    scene: THREE.Scene,
    camera: THREE.Camera,
    renderOpaque: () => void,
    reactive = false,
  ) {
    const waters: TerrainWater[] = [];
    scene.traverseVisible((o) => {
      if (o instanceof TerrainWater && o.surfaces.some((m) => m.visible))
        waters.push(o);
    });
    if (!waters.length) {
      renderOpaque();
      return;
    }
    this.prepare();
    const r = this.renderer;
    const saved = {
      target: r.getRenderTarget(),
      face: r.getActiveCubeFace(),
      mip: r.getActiveMipmapLevel(),
      auto: r.autoClear,
      shadow: r.shadowMap.autoUpdate,
      needsShadow: r.shadowMap.needsUpdate,
      background: scene.background,
      viewport: r.getViewport(new THREE.Vector4()),
      scissor: r.getScissor(new THREE.Vector4()),
      scissorTest: r.getScissorTest(),
    };
    const hidden: THREE.Object3D[] = [];
    const surfaces = waters.flatMap((w) => w.surfaces.filter((m) => m.visible));
    try {
      surfaces.forEach((w) => (w.visible = false));
      r.setRenderTarget(this.target!);
      renderOpaque();
      surfaces.forEach((w) => (w.visible = true));
      r.setRenderTarget(saved.target, saved.face, saved.mip);
      const volume = waters
        .map((w) => w.underwater(camera))
        .filter((v) => v !== undefined)
        .sort((a, b) => b.level - a.level)[0];
      this.copy.uniforms.underwater.value = volume ? 1 : 0;
      if (volume) {
        this.copy.uniforms.waterColor.value
          .copy(volume.color)
          .multiplyScalar(scene.environmentIntensity * 0.4);
        this.copy.uniforms.visibility.value = volume.visibility;
      }
      this.copy.uniforms.inverseProjection.value.copy(
        camera.projectionMatrixInverse,
      );
      r.autoClear = true;
      this.quad.render(r);
      scene.traverseVisible((o) => {
        if (
          (o instanceof THREE.Mesh ||
            o instanceof THREE.Line ||
            o instanceof THREE.Points ||
            o instanceof THREE.Sprite) &&
          !o.userData.waterOverlay &&
          !(
            o instanceof THREE.Mesh &&
            !Array.isArray(o.material) &&
            o.material.userData.terrainWater
          )
        )
          hidden.push(o);
      });
      hidden.forEach((o) => (o.visible = false));
      scene.background = null;
      r.autoClear = false;
      r.shadowMap.autoUpdate = r.shadowMap.needsUpdate = false;
      for (const water of waters)
        water.capture(
          this.target!.texture,
          this.target!.depthTexture!,
          this.size,
          camera,
          reactive,
        );
      r.render(scene, camera);
      this.error = undefined;
    } finally {
      hidden.forEach((o) => (o.visible = true));
      surfaces.forEach((w) => (w.visible = true));
      scene.background = saved.background;
      r.autoClear = saved.auto;
      r.shadowMap.autoUpdate = saved.shadow;
      r.shadowMap.needsUpdate = saved.needsShadow;
      r.setRenderTarget(saved.target, saved.face, saved.mip);
      r.setViewport(saved.viewport);
      r.setScissor(saved.scissor);
      r.setScissorTest(saved.scissorTest);
    }
  }
  dispose() {
    this.target?.dispose();
    this.copy.dispose();
    this.quad.dispose();
  }
}
