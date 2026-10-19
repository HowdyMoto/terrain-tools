import ChannelWorker from './orm-worker?worker&inline';
import type { OrmResponse, TextureRequest } from './orm-worker';
import { readDataUrl } from './storage';
import { needsTextureConversion } from './texture-formats';
import { checkTextureFile } from './texture-file';

/** Keep the processor with the editor that uses it. An open production tab must
 * not fetch a hashed worker file that a later local build may have removed. */
export function createOrmWorker(): Worker {
  try {
    return new ChannelWorker({ name: 'Terrain material image processor' });
  } catch (cause) {
    throw new Error(ormWorkerError(), { cause });
  }
}

export function ormWorkerError(detail?: string) {
  return (
    'Image processing could not start or was interrupted. Refresh the editor and try the preview again. Your terrain has not changed.' +
    (detail ? ' Details: ' + detail : '')
  );
}

/** Convert desktop texture formats before staging any project/history changes. */
export async function readTextureDataUrl(
  file: File,
  signal: AbortSignal,
): Promise<string> {
  await checkTextureFile(file, signal);
  if (!needsTextureConversion(file.name)) return readDataUrl(file);
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const png = await new Promise<ArrayBuffer>((resolve, reject) => {
    const worker = createOrmWorker();
    const finish = (error?: Error, result?: ArrayBuffer) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            'Image conversion timed out. Try a smaller image or export it as PNG.',
          ),
        ),
      60_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<OrmResponse>) => {
      if (data.type === 'error')
        finish(new Error(file.name + ': ' + data.message));
      else if (data.type === 'result') finish(undefined, data.png);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(new Error(ormWorkerError(event.message)));
    };
    try {
      worker.postMessage(
        { convert: bytes, name: file.name } satisfies TextureRequest,
        [bytes],
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
  signal.throwIfAborted();
  const url = await readDataUrl(
    new File([png], 'converted.png', { type: 'image/png' }),
  );
  signal.throwIfAborted();
  return url;
}
