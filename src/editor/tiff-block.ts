/** Validate complete compressed strips/tiles before UTIF decodes into its
 * preallocated buffer (UTIF otherwise silently zero-fills some corrupt inputs). */
export async function validateTiffBlock(
  bytes: Uint8Array<ArrayBuffer>,
  compression: number,
  expected: number,
) {
  const invalid = () => {
    throw new Error(
      'Invalid or truncated TIFF pixel data. Export it again as TIFF or PNG.',
    );
  };
  if (compression === 1) {
    if (bytes.length < expected) invalid();
    return;
  }
  let output = 0;
  if (compression === 8 || compression === 32946) {
    const reader = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'))
      .getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        output += value.byteLength;
        if (output > expected) invalid();
      }
    } catch {
      invalid();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else if (compression === 32773) {
    for (let cursor = 0; cursor < bytes.length;) {
      const packet = bytes[cursor++];
      if (packet === 128) continue;
      output += packet < 128 ? packet + 1 : 257 - packet;
      cursor += packet < 128 ? packet + 1 : 1;
      if (cursor > bytes.length || output > expected) invalid();
    }
  } else if (compression === 5) {
    const lengths = new Uint32Array(4096);
    lengths.fill(1, 0, 256);
    let bit = 0,
      width = 9,
      next = 258,
      previous = 0,
      ended = false;
    while (bit + width <= bytes.length * 8) {
      let code = 0;
      for (let i = 0; i < width; i++, bit++)
        code = code * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
      if (bit === width && code !== 256) invalid();
      if (code === 256 && bit !== width && !previous) invalid();
      if (code === 256) {
        width = 9;
        next = 258;
        previous = 0;
        continue;
      }
      if (code === 257) {
        ended = true;
        break;
      }
      if (
        code >= 4096 ||
        code > next ||
        (code === next && !previous) ||
        (!previous && code >= 256)
      )
        invalid();
      const length = code === next ? previous + 1 : lengths[code];
      output += length;
      if (output > expected) invalid();
      if (previous && next < 4096) {
        lengths[next++] = previous + 1;
        // TIFF uses early code-width changes, unlike GIF LZW.
        if (next === (1 << width) - 1 && width < 12) width++;
      }
      previous = length;
    }
    if (!ended) invalid();
  }
  if (output !== expected) invalid();
}
