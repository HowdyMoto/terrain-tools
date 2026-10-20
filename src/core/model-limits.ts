import { base64ByteLength } from './base64';

/** Embedded models remain strings in the authoring document. Keep their base64
 * representation below browser string ceilings, with room for packaging edits.
 * Decoded geometry/texture memory is separate from this source-file allowance. */
export const MAX_MODEL_BYTES = 320 * 1024 * 1024;
export const MAX_MODEL_DATA_URL_CHARACTERS =
  Math.ceil(MAX_MODEL_BYTES / 3) * 4 + 128;
export const MODEL_SIZE_LABEL = '320 MiB';

export function checkModelFileSize(bytes: number, name = 'Model') {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_MODEL_BYTES)
    throw new Error(
      `${name} exceeds the ${MODEL_SIZE_LABEL} embedded model limit.`,
    );
}

/** Validate admission without allocating another decoded copy of a large GLB. */
export function checkModelDataURL(data: unknown): asserts data is string {
  if (typeof data !== 'string' || data.length > MAX_MODEL_DATA_URL_CHARACTERS)
    throw new Error(
      `Models must be embedded GLBs of at most ${MODEL_SIZE_LABEL}.`,
    );
  const comma = data.indexOf(',');
  if (
    comma < 0 ||
    comma > 100 ||
    !/^data:(model\/gltf-binary|application\/octet-stream);base64,$/i.test(
      data.slice(0, comma + 1),
    )
  )
    throw new Error('Models must be embedded binary GLB assets.');
  const payload = data.slice(comma + 1);
  if (!/^[a-z0-9+/]+={0,2}$/i.test(payload) || payload.length % 4 === 1)
    throw new Error('Invalid embedded model encoding.');
  checkModelFileSize(base64ByteLength(payload));
}
