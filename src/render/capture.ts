import type { WebGPURenderer } from 'three/webgpu';
import { gpuDevice } from './renderer';

/** Read the displayed RGBA8/BGRA8 frame directly, without a browser compositor
 * copy between WebGPU and Canvas. The draw and copy must precede presentation. */
export async function captureNativePNG(
  renderer: WebGPURenderer,
  draw: () => void,
): Promise<Blob> {
  const device = gpuDevice(renderer);
  await device.queue.onSubmittedWorkDone();
  draw();
  const context = renderer.domElement.getContext('webgpu') as GPUCanvasContext;
  const texture = context.getCurrentTexture();
  const { width, height, format } = texture;
  if (format !== 'rgba8unorm' && format !== 'bgra8unorm')
    throw new Error('Viewport PNG capture requires an 8-bit display canvas.');
  const rowBytes = width * 4,
    bytesPerRow = Math.ceil(rowBytes / 256) * 256;
  const buffer = device.createBuffer({
    label: 'Terrain viewport PNG readback',
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const pixels = new Uint8ClampedArray(rowBytes * height);
  try {
    const commands = device.createCommandEncoder();
    commands.copyTextureToBuffer(
      { texture },
      { buffer, bytesPerRow, rowsPerImage: height },
      { width, height },
    );
    device.queue.submit([commands.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange());
    for (let y = 0; y < height; y++)
      pixels.set(
        mapped.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes),
        y * rowBytes,
      );
  } finally {
    buffer.destroy();
  }
  const opaque = context.getConfiguration()?.alphaMode === 'opaque';
  for (let i = 0; i < pixels.length; i += 4) {
    if (format === 'bgra8unorm')
      [pixels[i], pixels[i + 2]] = [pixels[i + 2], pixels[i]];
    if (opaque) pixels[i + 3] = 255;
  }
  const canvas = new OffscreenCanvas(width, height);
  const image = canvas.getContext('2d', { willReadFrequently: true });
  if (!image) throw new Error('Could not encode the viewport image.');
  image.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}
