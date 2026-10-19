/** File admission allows an uncompressed 4K RGBA16 image plus format metadata.
 * Decoded pixel count, rather than compression ratio, bounds image processing. */
export const MAX_TEXTURE_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_TEXTURE_PIXELS = 4096 * 4096;
export const MAX_TEXTURE_DATA_URL_CHARACTERS =
  Math.ceil(MAX_TEXTURE_FILE_BYTES / 3) * 4 + 128;

export function checkTextureFileSize(bytes: number) {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > MAX_TEXTURE_FILE_BYTES
  )
    throw new Error(
      'Texture files must be at most 256 MiB. Reduce the file size and try again.',
    );
}

export function checkTextureDimensions(width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_TEXTURE_PIXELS
  )
    throw new Error(
      `Texture ${width} × ${height} exceeds the supported dimensions. Use at most 16 megapixels (4096²).`,
    );
}
