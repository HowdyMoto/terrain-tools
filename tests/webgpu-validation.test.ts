import { describe, it, expect, vi } from 'vitest';
import type { WebGPURenderer } from 'three/webgpu';
import { validateGPU } from '../src/render/renderer';

function fixture() {
  const stack: string[] = [];
  const device = {
    pushErrorScope: vi.fn((scope: string) => stack.push(scope)),
    popErrorScope: vi.fn(async () => {
      stack.pop();
      return null as GPUError | null;
    }),
  };
  const renderer = {
    backend: { isWebGPUBackend: true, device },
  } as unknown as WebGPURenderer;
  return { device, renderer, stack };
}

describe('native GPU preparation', () => {
  it('serializes device error scopes and allows retry after rejected preparation', async () => {
    const { device, renderer, stack } = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = validateGPU(renderer, async () => {
      await held;
      throw new Error('cancelled candidate');
    });
    const failed = expect(first).rejects.toThrow('cancelled candidate');
    const prepareNext = vi.fn(() => 42);
    const next = validateGPU(renderer, prepareNext);
    await Promise.resolve();
    expect(stack).toEqual(['out-of-memory', 'validation']);
    expect(prepareNext).not.toHaveBeenCalled();
    release();
    await failed;
    expect(await next).toBe(42);
    expect(device.popErrorScope).toHaveBeenCalledTimes(4);
    expect(stack).toEqual([]);
  });
  it('rejects a GPU validation failure even when JavaScript preparation succeeded', async () => {
    const { device, renderer } = fixture();
    device.popErrorScope.mockResolvedValueOnce({
      message: 'invalid target',
    } as GPUError);
    await expect(validateGPU(renderer, () => 'candidate')).rejects.toThrow(
      'invalid target',
    );
    expect(device.popErrorScope).toHaveBeenCalledTimes(2);
    await expect(validateGPU(renderer, () => 'retry')).resolves.toBe('retry');
  });
});
