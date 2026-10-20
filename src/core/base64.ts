/** Native typed-array codecs avoid a second full-size binary string. The fallback
 * bounds temporary strings, including on hosts without the newer codecs. */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  const chunks: string[] = [];
  const size = 32766; // Multiple of three: only the final piece has padding.
  for (let at = 0; at < bytes.length; at += size) {
    let binary = '';
    const end = Math.min(bytes.length, at + size);
    for (let i = at; i < end; i++) binary += String.fromCharCode(bytes[i]);
    chunks.push(btoa(binary));
  }
  return chunks.join('');
}

/** Standard base64, including the unpadded spelling accepted by legacy saves. */
export function base64ByteLength(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - padding;
}

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const native = (
    Uint8Array as typeof Uint8Array & {
      fromBase64?: (value: string) => Uint8Array<ArrayBuffer>;
    }
  ).fromBase64;
  if (native) return native.call(Uint8Array, text);
  const bytes = new Uint8Array(base64ByteLength(text));
  const size = 65536; // Multiple of four: decode complete groups per chunk.
  let offset = 0;
  for (let at = 0; at < text.length; at += size) {
    const binary = atob(text.slice(at, at + size));
    for (let i = 0; i < binary.length; i++)
      bytes[offset++] = binary.charCodeAt(i);
  }
  if (offset !== bytes.length) throw new Error('Invalid base64 length.');
  return bytes;
}
