import * as THREE from 'three';
export const FOLIAGE_FADE_ATTRIBUTE = 'terrainFade';
/** Complementary per-instance coverage in every camera/shadow pass. */
export function configureFoliageFade(
  material: THREE.Material,
  enabled: () => boolean = () => true,
) {
  const previous = material.onBeforeCompile;
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    if (!enabled()) return;
    shader.vertexShader =
      'attribute vec3 terrainFade;\nflat varying vec3 vTerrainFade;\n' +
      shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvTerrainFade = terrainFade;',
    );
    shader.fragmentShader =
      'flat varying vec3 vTerrainFade;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <alphatest_fragment>',
      `#include <alphatest_fragment>
      if (vTerrainFade.y <= vTerrainFade.x) discard;
      if (vTerrainFade.x > 0.0 || vTerrainFade.y < 1.0) {
        float terrainNoise = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715)) + vTerrainFade.z));
        if (terrainNoise < vTerrainFade.x || terrainNoise >= vTerrainFade.y) discard;
      }`,
    );
  };
  material.customProgramCacheKey = () =>
    enabled() ? 'terrain-lod-fade-v1|' + key() : key();
}
