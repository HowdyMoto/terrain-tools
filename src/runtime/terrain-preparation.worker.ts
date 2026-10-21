/// <reference lib="webworker" />
import {
  prepareTerrainData,
  terrainPreparationTransfers,
} from '../core/terrain-preparation';
import { bakeCanopyLight } from '../core/canopy-lighting';
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event) => {
  const { id, project, lod } = event.data;
  try {
    if (event.data.kind === 'canopy') {
      const data = bakeCanopyLight(event.data.input);
      scope.postMessage({ id, data }, [data.pixels.buffer, data.ground.buffer]);
      return;
    }
    const data = prepareTerrainData(project, lod);
    scope.postMessage({ id, data }, terrainPreparationTransfers(data));
  } catch (error) {
    scope.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
