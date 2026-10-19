import { PackageEncodingSession } from './package-transfer';
import type { PackageRequest, PackageResponse } from './package-transfer';
const encoder = new PackageEncodingSession();
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<PackageRequest>) => void;
  postMessage: (message: PackageResponse) => void;
};
scope.onmessage = ({ data }) => {
  const started = performance.now();
  try {
    const blob = encoder.encode(data);
    scope.postMessage({
      id: data.id,
      type: 'result',
      blob,
      encodeMs: performance.now() - started,
    });
  } catch (error) {
    scope.postMessage({
      id: data.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
