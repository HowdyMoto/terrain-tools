import { createWaterFoamTexture } from './water-foam';
self.onmessage = () => {
  try {
    const texture = createWaterFoamTexture(),
      pixels = texture.image.data as Uint8Array;
    self.postMessage({ pixels }, { transfer: [pixels.buffer] });
    texture.dispose();
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
