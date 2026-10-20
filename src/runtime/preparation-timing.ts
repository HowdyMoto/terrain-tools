export interface PreparationTiming {
  stage: string;
  start: number;
  milliseconds: number;
}

/** Reports elapsed stage time, including asynchronous waits. Never retains payloads. */
export async function timePreparation<T>(
  stage: string,
  prepare: () => T | Promise<T>,
  report?: (timing: PreparationTiming) => void,
): Promise<T> {
  const start = performance.now();
  try {
    return await prepare();
  } finally {
    report?.({ stage, start, milliseconds: performance.now() - start });
  }
}
