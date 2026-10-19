import { nodeGraphKey } from '../render/node-uniforms';
import * as THREE from 'three';
import type { WaterExtent, WaterSurface } from '../core/water';
import { configureWaterNodes } from './water-nodes';

const terrain = /* glsl */ `
uniform sampler2D waterHeight;
uniform sampler2D waterMask;
uniform float waterSize;
uniform float waterCells;
uniform float waterLevel;
uniform float waterOcean;
uniform float waterBounded;
uniform vec2 waterCenter;
uniform vec2 waterGridScale;
uniform vec4 waterEllipse;
uniform float waterRotation;
uniform float waterKind;
uniform vec2 waterPoints[128];
uniform int waterPointCount;
float waterGround(vec2 p) {
  vec2 uv = p / waterSize + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return waterLevel - 1000.0;
  vec2 c = min(uv * waterCells, vec2(waterCells - 0.0001));
  vec2 i = floor(c), f = fract(c);
  vec2 t = (i + 0.5) / (waterCells + 1.0);
  float d = 1.0 / (waterCells + 1.0);
  float a = texture2D(waterHeight, t).r, b = texture2D(waterHeight, t + vec2(d,0)).r;
  float c0 = texture2D(waterHeight, t + vec2(0,d)).r, e = texture2D(waterHeight, t + vec2(d,d)).r;
  return f.x + f.y <= 1.0 ? a + (b-a)*f.x + (c0-a)*f.y : e + (c0-e)*(1.0-f.x) + (b-e)*(1.0-f.y);
}
float waterInside(vec2 p) {
  vec2 uv = p / waterSize + 0.5;
  bool outside = any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)));
  if (waterOcean > 0.5) return outside ? 1.0-waterBounded : texture2D(waterMask, uv).r;
  if (waterKind < 0.5) {
    vec2 d = p - waterEllipse.xy;
    d = mat2(cos(waterRotation), -sin(waterRotation), sin(waterRotation), cos(waterRotation)) * d;
    return 1.0 - step(1.0, dot(d / waterEllipse.zw, d / waterEllipse.zw));
  }
  if (waterKind > 1.5) return outside ? 0.0 : texture2D(waterMask, uv).r;
  bool inside = false;
  vec2 b = waterPoints[waterPointCount - 1];
  for (int i = 0; i < 128; i++) {
    if (i >= waterPointCount) break;
    vec2 a = waterPoints[i];
    if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) inside = !inside;
    b = a;
  }
  return inside ? 1.0 : 0.0;
}
`;
const waves = /* glsl */ `
uniform float waterTime;
uniform vec4 waterWaves;
uniform float waterDirection;
uniform float waterRipple;
uniform vec2 waterPhaseOrigin;
vec3 waterWave(vec2 p, float detail) {
  p += waterPhaseOrigin;
  vec3 result = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float f = float(i), swell = 1.0 - step(3.0, f);
    float wavelength = mix(waterWaves.w, waterWaves.y, swell) * (1.0 - mod(f,3.0)*0.21);
    float k = 6.2831853 / wavelength;
    float amp = min(mix(waterWaves.z, waterWaves.x, swell) * 0.24 / (1.0+mod(f,3.0)), 0.18/k);
    float angle = waterDirection + sin(f*8.7)*0.65;
    vec2 dir = vec2(cos(angle),sin(angle));
    float phase = dot(p,dir)*k - sqrt(9.81*k)*waterTime + f*2.31;
    float filtered = 1.0;
    #ifdef WATER_FRAGMENT
      filtered = 1.0-smoothstep(0.5,2.0,length(fwidth(p))*k);
    #endif
    result += vec3(sin(phase)*amp, cos(phase)*amp*k*dir*filtered);
  }
  if (detail > 0.5) {
    for (int i = 0; i < 3; i++) {
      float f = float(i), k = 7.0+f*6.4;
      vec2 dir = vec2(cos(f*2.31+waterDirection),sin(f*2.31+waterDirection));
      float phase = dot(p,dir)*k + waterTime*(2.0+f);
      float fade = 1.0 - smoothstep(0.3, 1.3, length(fwidth(p))*k);
      result.yz += cos(phase)*dir*waterRipple*0.15*fade;
    }
  }
  return result;
}
`;
// Derivatives are only legal in fragment shaders; keep a separate vertex variant.
const vertexWaves =
  waves.slice(0, waves.indexOf('  if (detail > 0.5)')) +
  '  return result;\n}\n';
const optics = /* glsl */ `
uniform sampler2D waterSceneColor;
uniform sampler2D waterSceneDepth;
uniform mat4 waterInverseProjection;
uniform mat4 waterProjection;
uniform mat4 waterView;
uniform vec2 waterBufferSize;
uniform float waterCapture;
uniform float waterVisibility;
uniform float waterFoam;
uniform float waterFoamWidth;
uniform sampler2D waterFoamDetail;
uniform float waterReflections;
uniform float waterReactive;
uniform mat3 waterNormalWorld;
varying vec3 vWaterWorld;
varying vec3 vWaterLocal;
vec3 waterViewPoint(vec2 uv) {
  vec4 p = waterInverseProjection * vec4(uv*2.0-1.0,texture2D(waterSceneDepth,uv).r*2.0-1.0,1.0);
  return p.xyz/p.w;
}
vec3 waterSSR(vec3 p, vec3 n, out float valid) {
  vec3 ray = reflect(normalize(p), n), q = p;
  valid = 0.0;
  float stride = max(0.25, -p.z*0.012);
  for (int i=0; i<16; i++) {
    q += ray*stride; stride *= 1.28;
    vec4 clip = waterProjection*vec4(q,1.0);
    vec2 uv = clip.xy/clip.w*0.5+0.5;
    if (clip.w <= 0.0 || any(lessThan(uv,vec2(0.01))) || any(greaterThan(uv,vec2(0.99)))) break;
    float depth = texture2D(waterSceneDepth,uv).r;
    // The march needs only view Z, not a full inverse-projection multiply.
    float hitZ = waterProjection[3][3] > .5
      ? (depth*2.0-1.0-waterProjection[3][2])/waterProjection[2][2]
      : -waterProjection[3][2]/(depth*2.0-1.0+waterProjection[2][2]);
    float delta = hitZ-q.z;
    if (i>1 && delta>0.02 && delta<stride*.8 && depth < 0.99999) {
      valid = smoothstep(0.0,0.12,min(min(uv.x,uv.y),min(1.0-uv.x,1.0-uv.y))) * (1.0-float(i)/20.0);
      return texture2D(waterSceneColor,uv).rgb;
    }
  }
  return vec3(0.0);
}
`;

export function createWaterMaterial(
  surface: WaterSurface,
  height: THREE.DataTexture,
  mask: THREE.DataTexture,
  size: number,
  cells: number,
  elevation: number,
  foam: THREE.DataTexture,
  extent?: WaterExtent,
) {
  const uniforms = {
    waterHeight: { value: height },
    waterMask: { value: mask },
    waterSize: { value: size },
    waterCells: { value: cells },
    waterLevel: { value: elevation },
    waterOcean: { value: extent ? 0 : 1 },
    waterBounded: { value: 0 },
    waterPhaseOrigin: { value: new THREE.Vector2() },
    waterCenter: { value: new THREE.Vector2() },
    waterGridScale: { value: new THREE.Vector2(1, 1) },
    waterNormalWorld: { value: new THREE.Matrix3() },
    waterEllipse: { value: new THREE.Vector4() },
    waterRotation: { value: 0 },
    waterKind: {
      value: extent?.kind === 'polygon' ? 1 : extent?.kind === 'basin' ? 2 : 0,
    },
    waterPoints: {
      value: Array.from(
        { length: 128 },
        (_, i) =>
          new THREE.Vector2(
            extent?.kind === 'polygon' ? (extent.points[i]?.x ?? 0) : 0,
            extent?.kind === 'polygon' ? (extent.points[i]?.z ?? 0) : 0,
          ),
      ),
    },
    waterPointCount: {
      value: extent?.kind === 'polygon' ? extent.points.length : 0,
    },
    waterTime: { value: 0 },
    waterWaves: {
      value: new THREE.Vector4(
        surface.swellHeight,
        surface.swellLength,
        surface.waveHeight,
        surface.waveLength,
      ),
    },
    waterDirection: { value: (surface.direction * Math.PI) / 180 },
    waterRipple: { value: surface.ripple },
    waterSceneColor: { value: null as THREE.Texture | null },
    waterSceneDepth: { value: null as THREE.Texture | null },
    waterInverseProjection: { value: new THREE.Matrix4() },
    waterProjection: { value: new THREE.Matrix4() },
    waterView: { value: new THREE.Matrix4() },
    waterBufferSize: { value: new THREE.Vector2(1, 1) },
    waterCapture: { value: 0 },
    waterVisibility: { value: surface.visibility },
    waterFoam: { value: surface.foam },
    waterFoamWidth: { value: surface.foamWidth },
    waterFoamDetail: { value: foam },
    waterReflections: { value: 1 },
    waterReactive: { value: 0 },
  };
  if (extent?.kind === 'ellipse') {
    uniforms.waterEllipse.value.set(
      extent.x,
      extent.z,
      extent.radiusX,
      extent.radiusZ,
    );
    uniforms.waterRotation.value = (extent.rotation * Math.PI) / 180;
  }
  const material = new THREE.MeshPhysicalMaterial({
    color: surface.color,
    roughness: surface.roughness,
    metalness: 0,
    ior: 1.333,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
    blending: THREE.NoBlending,
  });
  material.name = 'Terrain water';
  material.forceSinglePass = true;
  material.userData.terrainWater = true;
  material.customProgramCacheKey = () =>
    'terrain-water-v3|' + nodeGraphKey(material);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${terrain}\n${vertexWaves}\nvarying vec3 vWaterWorld;\nvarying vec3 vWaterLocal;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 waterPosition = vec3(position.x*waterGridScale.x+waterCenter.x,0.0,position.z*waterGridScale.y+waterCenter.y);\nvec3 waterMotion = waterWave(waterPosition.xz,0.0);\nfloat waterShallow = smoothstep(0.0,2.0,max(0.0,waterLevel-waterGround(waterPosition.xz)));\nvec3 objectNormal = normalize(vec3(-waterMotion.y*waterShallow*waterGridScale.x,1.0,-waterMotion.z*waterShallow*waterGridScale.y));`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = position;\ntransformed.y += waterMotion.x*waterShallow;\nvWaterLocal = vec3(waterPosition.x,waterLevel+transformed.y,waterPosition.z);\nvWaterWorld = (modelMatrix*vec4(transformed,1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n#define WATER_FRAGMENT\n${terrain}\n${waves}\n${optics}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (waterInside(vWaterLocal.xz)<0.5) discard;
        float waterDepth = vWaterLocal.y-waterGround(vWaterLocal.xz);
        if (waterDepth < 0.0) discard;
        vec2 waterDx = dFdx(vWaterLocal.xz), waterDz = dFdy(vWaterLocal.xz);
        float waterDet=waterDx.x*waterDz.y-waterDx.y*waterDz.x;
        float waterJacobian = (waterDet < 0.0 ? -1.0 : 1.0)*max(abs(waterDet),0.00000001);
        vec2 waterGradient=vec2(dFdx(waterDepth)*waterDz.y-dFdy(waterDepth)*waterDx.y,dFdy(waterDepth)*waterDx.x-dFdx(waterDepth)*waterDz.x)/waterJacobian;
        float waterSlope = max(0.08, length(waterGradient));
        float waterShore = 1.0-smoothstep(0.0,waterFoamWidth,waterDepth/waterSlope);
        // Physical-sized, mip-filtered pores and fine froth stay independent
        // of terrain cell size. Two slowly drifting layers break up repetition.
        vec2 foamDrift = vec2(cos(waterDirection),sin(waterDirection))*waterTime*.035;
        vec2 foamUv = (vWaterLocal.xz+waterPhaseOrigin-foamDrift)*.25;
        vec3 foamA = texture2D(waterFoamDetail,foamUv).rgb;
        vec3 foamB = texture2D(waterFoamDetail,mat2(.8,.6,-.6,.8)*foamUv*1.37+vec2(.31,.73)+waterTime*.004).rgb;
        float foamRafts = foamA.b*.8+foamB.b*.2;
        float foamPulse = .5+.5*sin(waterDepth/waterSlope*4.0-waterTime*1.4+foamRafts*4.0);
        float foamDensity = waterShore*(.65+.35*foamPulse);
        float foamPatches = smoothstep(.46,.66,foamRafts+foamDensity*.12);
        float foamLace = min(foamA.r,foamB.r+.2);
        float foamFine = foamA.g*.65+foamB.g*.35;
        float foamFill = smoothstep(.55,.95,foamDensity)*.2;
        float foamCoverage = mix(foamLace*(.25+.75*foamFine),foamFine,foamFill);
        float waterFoamAmount = clamp(waterFoam*waterShore*foamPatches*foamCoverage*1.55,0.0,1.0);
        // An unknown bottom beyond the heightfield is not a physical bank.
        waterFoamAmount *= smoothstep(0.0,waterSize/waterCells*1.5,waterSize*.5-max(abs(vWaterLocal.x),abs(vWaterLocal.z)));
        diffuseColor.rgb = mix(diffuseColor.rgb,vec3(0.86,0.89,0.88),waterFoamAmount);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor,.55+.3*foamFine,waterFoamAmount);',
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        vec3 waterDetail = waterWave(vWaterLocal.xz,1.0);
        float shallowNormal = smoothstep(0.0,2.0,max(0.0,waterLevel-waterGround(vWaterLocal.xz)));
        // Millimetre relief gives the froth its own light response, instead
        // of painting a flat white stencil onto the water.
        float foamRelief = (foamA.g*.002+foamB.g*.001)*waterFoamAmount;
        vec2 foamSlope = vec2(dFdx(foamRelief)*waterDz.y-dFdy(foamRelief)*waterDx.y,dFdy(foamRelief)*waterDx.x-dFdx(foamRelief)*waterDz.x)/waterJacobian;
        foamSlope = clamp(foamSlope,vec2(-.35),vec2(.35));
        vec2 waterNormalSlope = waterDetail.yz*shallowNormal+foamSlope;
        vec3 waterNormal = normalize(waterNormalWorld*vec3(-waterNormalSlope.x,1.0,-waterNormalSlope.y));
        normal = normalize((viewMatrix*vec4(waterNormal,0.0)).xyz) * (gl_FrontFacing ? 1.0 : -1.0);`,
      )
      .replace(
        '#include <transmission_fragment>',
        `
        if (waterCapture>0.5) {
          vec2 waterUv = gl_FragCoord.xy/waterBufferSize;
          vec3 waterP = -vViewPosition;
          vec3 waterBehind = waterViewPoint(waterUv);
          float waterPath = max(0.0,length(waterBehind-waterP));
          vec2 refractedUv = clamp(waterUv+normal.xy*min(0.015,waterPath*.0015),vec2(0.001),vec2(0.999));
          vec3 refractedP = waterViewPoint(refractedUv);
          if (refractedP.z > waterP.z-0.02) refractedUv = waterUv;
          waterPath = min(waterPath, waterVisibility*6.0);
          vec3 attenuation = exp(-waterPath / waterVisibility * vec3(1.8,0.85,0.65));
          vec3 transmitted = texture2D(waterSceneColor,refractedUv).rgb*attenuation;
          float fresnel = 0.02037+0.97963*pow(1.0-max(dot(normal,normalize(vViewPosition)),0.0),5.0);
          totalDiffuse = mix((transmitted + totalDiffuse*(1.0-attenuation))*(1.0-fresnel), totalDiffuse, waterFoamAmount);
          // Weak reflections contribute little at a steep viewing angle. Keep
          // environment reflection there and spend traces on reflective angles.
          if (waterReflections>0.5 && roughnessFactor<0.6 && fresnel>.04 && waterFoamAmount<.8) {
            float valid; vec3 reflected = waterSSR(waterP,normal,valid);
            totalSpecular = mix(totalSpecular,reflected*fresnel+reflectedLight.directSpecular,valid*(1.0-waterFoamAmount)*(1.0-roughnessFactor)*smoothstep(.04,.1,fresnel));
          }
        }
      `,
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        // Only the HDR temporal pipeline consumes this alpha as history weight.
        // Ordinary renderers retain normal opaque output.
        if(waterReactive>.5) gl_FragColor.a=.28;
      `,
      );
  };
  configureWaterNodes(material, uniforms);
  return { material, uniforms };
}
export type WaterMaterial = ReturnType<typeof createWaterMaterial>;
