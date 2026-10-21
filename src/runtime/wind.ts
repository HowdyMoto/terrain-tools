import { nodeGraphKey } from '../render/node-uniforms';
import * as THREE from 'three';
import { configureWindNodes } from './foliage-nodes';
import { foliageContactPadding } from '../core/interaction';
export type WindUniforms = Record<string, THREE.IUniform>;
export function windUniforms(): WindUniforms {
  return {
    uTime: { value: 0 },
    uStrength: { value: 0 },
    uDirection: { value: new THREE.Vector2() },
    uGust: { value: 0 },
    uSpeed: { value: 1 },
  };
}
/** Apply identical deformation to lit, directional-depth, and point-shadow passes. */
export function configureWind(
  material: THREE.Material,
  amount: number,
  uniforms: WindUniforms,
  root?: number,
) {
  configureWindNodes(material, amount, uniforms, root);
  const declarations = `
    uniform float uTime; uniform float uStrength; uniform vec2 uDirection; uniform float uGust; uniform float uSpeed;
    vec3 windLocalDirection(){
      vec3 direction=vec3(uDirection.x,0.0,uDirection.y);
      return vec3(dot(instanceMatrix[0].xyz,direction)/max(dot(instanceMatrix[0].xyz,instanceMatrix[0].xyz),0.0001),dot(instanceMatrix[1].xyz,direction)/max(dot(instanceMatrix[1].xyz,instanceMatrix[1].xyz),0.0001),dot(instanceMatrix[2].xyz,direction)/max(dot(instanceMatrix[2].xyz,instanceMatrix[2].xyz),0.0001));
    }
    float windAmplitude(){float phase=instanceMatrix[3].x*0.12+instanceMatrix[3].z*0.09;return sin(uTime*uSpeed*1.7+phase)*(0.5+0.5*sin(uTime*0.37+phase)*uGust)*uStrength*${amount.toFixed(5)}*0.09;}
    float windHeight(float y){return max(y,0.0)*length(instanceMatrix[1].xyz);}
  `;
  const masked = root !== undefined;
  const deformation = masked
    ? `
    attribute vec4 terrainFlexibility;
    attribute vec4 terrainContact;
    attribute vec2 terrainCapsule;
    vec3 contactLocal(vec3 v) {
      return vec3(dot(instanceMatrix[0].xyz,v)/max(dot(instanceMatrix[0].xyz,instanceMatrix[0].xyz),0.0001),dot(instanceMatrix[1].xyz,v)/max(dot(instanceMatrix[1].xyz,instanceMatrix[1].xyz),0.0001),dot(instanceMatrix[2].xyz,v)/max(dot(instanceMatrix[2].xyz,instanceMatrix[2].xyz),0.0001));
    }
    void capsuleDeformation(vec3 p, out vec3 q, out mat3 jacobian) {
      vec3 world = (instanceMatrix * vec4(p,1.0)).xyz;
      float radius = max(terrainContact.w,0.01), reach = radius+${foliageContactPadding.toFixed(5)};
      float low = terrainCapsule.x+radius, high = max(low,terrainCapsule.y-radius);
      vec3 delta = world-vec3(terrainContact.y,clamp(world.y,low,high),terrainContact.z);
      float distance = max(length(delta),0.0001);
      float t = clamp((reach-distance)/${foliageContactPadding.toFixed(5)},0.0,1.0), falloff = t*t*(3.0-2.0*t);
      float radial = sqrt(dot(delta.xz,delta.xz)+0.0025);
      vec3 unit = vec3(delta.x,0.0,delta.z)/radial;
      float height = world.y-instanceMatrix[3].y;
      vec3 push = unit*0.75-vec3(0.0,clamp(height,0.0,1.4)*0.9,0.0);
      float amplitude = -terrainContact.x, factor = falloff*amplitude*terrainFlexibility.x;
      q = p+contactLocal(push)*factor;
      vec3 distanceGradient = -delta*vec3(1.0,(world.y<low||world.y>high)?1.0:0.0,1.0)/(distance*${foliageContactPadding.toFixed(5)})*(6.0*t*(1.0-t));
      for(int axis=0;axis<3;axis++) {
        vec3 basis = instanceMatrix[axis].xyz;
        vec3 unitDerivative = vec3(basis.x,0.0,basis.z)/radial-unit*dot(delta.xz,basis.xz)/(radial*radial);
        vec3 pushDerivative = unitDerivative*0.75-vec3(0.0,(height>0.0&&height<1.4)?basis.y*0.9:0.0,0.0);
        float derivative = (falloff>0.0?dot(distanceGradient,basis):0.0)*amplitude*terrainFlexibility.x + falloff*amplitude*terrainFlexibility[axis+1];
        jacobian[axis] = vec3(axis==0?1.0:0.0,axis==1?1.0:0.0,axis==2?1.0:0.0)+contactLocal(pushDerivative*factor+push*derivative);
      }
    }
    void foliageDeformation(vec3 position, out vec3 result, out mat3 jacobian) {
      float mask = terrainFlexibility.x;
      vec3 gradient = terrainFlexibility.yzw;
      vec3 pivot = vec3(0.0, ${root!.toFixed(8)}, 0.0);
      vec3 p = position - pivot;
      float amount = max(terrainContact.x,0.0);
      float bend = amount * mask;
      float angle = 0.9 * bend, scaleY = 1.0 - 0.75 * bend;
      float s = sin(angle), c = cos(angle);
      mat3 contact = mat3(vec3(c,s,0.0),vec3(-s*scaleY,c*scaleY,0.0),vec3(0.0,0.0,1.0));
      vec3 q = contact * p + pivot;
      vec3 derivative = vec3(-s*p.x-c*scaleY*p.y,c*p.x-s*scaleY*p.y,0.0) * (0.9*amount)
        + vec3(-s,c,0.0) * (-0.75*amount*p.y);
      jacobian = contact + mat3(derivative*gradient.x,derivative*gradient.y,derivative*gradient.z);
      if(terrainContact.x<0.0) capsuleDeformation(position,q,jacobian);
      float instanceScale = length(instanceMatrix[1].xyz);
      float height = max(q.y-pivot.y,0.0)*instanceScale;
      float amplitude = windAmplitude();
      float profile = pow(height,1.25);
      vec3 heightGradient = q.y > pivot.y ? vec3(jacobian[0].y,jacobian[1].y,jacobian[2].y)*instanceScale : vec3(0.0);
      vec3 displacementGradient = amplitude * (profile*gradient + mask*1.25*pow(height,0.25)*heightGradient);
      vec3 direction = windLocalDirection();
      result = q + direction*amplitude*profile*mask;
      jacobian += mat3(direction*displacementGradient.x,direction*displacementGradient.y,direction*displacementGradient.z);
    }
  `
    : '';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = declarations + deformation + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      masked
        ? '#include <begin_vertex>\nmat3 foliageJacobian; foliageDeformation(position, transformed, foliageJacobian);'
        : '#include <begin_vertex>\ntransformed += windLocalDirection()*windAmplitude()*pow(windHeight(position.y),1.25);',
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      masked
        ? `#include <beginnormal_vertex>
      vec3 foliagePosition; mat3 foliageNormalJacobian;
      foliageDeformation(position, foliagePosition, foliageNormalJacobian);
      mat3 cofactor = mat3(cross(foliageNormalJacobian[1],foliageNormalJacobian[2]),cross(foliageNormalJacobian[2],foliageNormalJacobian[0]),cross(foliageNormalJacobian[0],foliageNormalJacobian[1]));
      vec3 bentNormal = cofactor*objectNormal;
      if(dot(bentNormal,bentNormal)>0.00000001) objectNormal = normalize(bentNormal);
      #ifdef USE_TANGENT
        objectTangent = normalize(foliageNormalJacobian*objectTangent);
      #endif
      `
        : `#include <beginnormal_vertex>
      vec3 windDirection=windLocalDirection();float windGradient=windAmplitude()*1.25*pow(windHeight(position.y),0.25)*length(instanceMatrix[1].xyz);
      objectNormal.y -= dot(windDirection,objectNormal)*windGradient/max(0.2,1.0+windDirection.y*windGradient);
      `,
    );
  };
  material.customProgramCacheKey = () =>
    (masked
      ? 'terrain-flexibility-v1-' + root + '-' + amount
      : 'terrain-wind-v2-' + amount) +
    '|' +
    nodeGraphKey(material);
}
export function shadowMaterials(
  source: THREE.Material,
  amount: number,
  uniforms: WindUniforms,
  root?: number,
  own: (material: THREE.Material) => void = () => {},
) {
  const s = source as THREE.MeshStandardMaterial;
  const parameters = {
    map: s.map ?? null,
    alphaMap: s.alphaMap ?? null,
    alphaTest: s.alphaTest,
    side: s.side,
  };
  const depth = new THREE.MeshDepthMaterial({
    ...parameters,
    depthPacking: THREE.RGBADepthPacking,
  });
  own(depth);
  const distance = new THREE.MeshDistanceMaterial(parameters);
  own(distance);
  configureWind(depth, amount, uniforms, root);
  configureWind(distance, amount, uniforms, root);
  return { depth, distance };
}
