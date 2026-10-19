import { erodeTerrain } from '../core/erosion';
import type {
  ErosionInput,
  ErosionSettings,
  ErosionProgress,
  ErosionResult,
} from '../core/erosion';

export type ErosionResponse =
  | { type: 'progress'; progress: ErosionProgress }
  | { type: 'result'; result: ErosionResult }
  | { type: 'error'; message: string };
export interface ErosionRequest {
  input: ErosionInput;
  settings: ErosionSettings;
}
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<ErosionRequest>) => void;
  postMessage: (message: ErosionResponse, transfer?: Transferable[]) => void;
};
scope.onmessage = (event) => {
  try {
    const job = erodeTerrain(event.data.input, event.data.settings);
    let next = job.next(),
      last = -Infinity;
    while (!next.done) {
      const now = performance.now();
      if (now - last > 60) {
        scope.postMessage({ type: 'progress', progress: next.value });
        last = now;
      }
      next = job.next();
    }
    scope.postMessage({ type: 'result', result: next.value }, [
      next.value.heights.buffer as ArrayBuffer,
    ]);
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
