import { describe, it, expect, vi } from 'vitest';
import { bytesToBase64, base64ToBytes } from '../src/core/base64';

describe('bounded binary asset codecs', () => {
  it('preserves bytes across chunk boundaries and partial final groups', () => {
    for (const size of [0, 1, 2, 3, 32765, 32766, 32767, 98305]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
      const expected = Buffer.from(bytes).toString('base64');
      expect(bytesToBase64(bytes)).toBe(expected);
      expect(base64ToBytes(expected)).toEqual(bytes);
      expect(base64ToBytes(expected.replace(/=+$/, ''))).toEqual(bytes);
    }
  });

  it('uses bounded fallbacks on hosts without native typed-array codecs', () => {
    vi.stubGlobal(
      'Uint8Array',
      class extends Uint8Array {
        static fromBase64 = undefined;
        toBase64 = undefined;
      },
    );
    try {
      const bytes = Uint8Array.from({ length: 98305 }, (_, i) => i % 251);
      const expected = Buffer.from(bytes).toString('base64');
      expect(bytesToBase64(bytes)).toBe(expected);
      expect(Array.from(base64ToBytes(expected))).toEqual(Array.from(bytes));
      expect(() => base64ToBytes('AA!A')).toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
