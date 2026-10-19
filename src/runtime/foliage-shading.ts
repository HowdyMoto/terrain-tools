import * as THREE from 'three';
import type { FoliageSubsurface } from '../core/foliage-shading';

/** Add shadowed, albedo-tinted transmission to the existing PBR direct-light loop. */
export function configureFoliageSubsurface(
  material: THREE.Material,
  settings?: FoliageSubsurface,
) {
  if (
    !settings ||
    !(material instanceof THREE.MeshStandardMaterial) ||
    (settings.materials && !settings.materials.includes(material.name)) ||
    (settings.mode === 'cutout' && material.alphaTest <= 0)
  )
    return;
  material.side = THREE.DoubleSide;
  material.alphaToCoverage =
    settings.smoothEdges && material.alphaTest > 0 && !material.transparent;
  const previous = material.onBeforeCompile;
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, {
      terrainLeafStrength: { value: settings.strength },
      terrainLeafThickness: { value: settings.thickness },
      terrainLeafTint: { value: new THREE.Color(settings.tint) },
      terrainLeafWrap: { value: settings.wrap },
    });
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_pars_fragment>',
      `#include <lights_physical_pars_fragment>
      uniform float terrainLeafStrength;
      uniform float terrainLeafThickness;
      uniform vec3 terrainLeafTint;
      uniform float terrainLeafWrap;
      void RE_Direct_TerrainLeaf(const in IncidentLight directLight,
        const in vec3 geometryPosition, const in vec3 geometryNormal,
        const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal,
        const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
        RE_Direct_Physical(directLight, geometryPosition, geometryNormal,
          geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
        float NdotL = dot(geometryNormal, directLight.direction);
        float through = saturate((-NdotL + terrainLeafWrap) / (1.0 + terrainLeafWrap));
        float absorption = exp(-terrainLeafThickness / max(abs(NdotL), 0.2));
        // directLight.color already includes distance falloff and the shadow test.
        // PBR diffuseColor carries albedo, instance tint and the non-metal fraction.
        reflectedLight.directDiffuse += directLight.color *
          BRDF_Lambert(material.diffuseColor * terrainLeafTint) *
          (terrainLeafStrength * through * absorption);
      }
      #undef RE_Direct
      #define RE_Direct RE_Direct_TerrainLeaf`,
    );
  };
  material.customProgramCacheKey = () => 'terrain-leaf-v1|' + key();
}
