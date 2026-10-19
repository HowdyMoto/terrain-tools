import { describe, expect, it, vi } from 'vitest';
import {
  FramePacing,
  WebGPUFramePacing,
  viewportPixelRatio,
} from '../src/render/frame-pacing';

function setup() {
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 1,
    TIMEOUT_EXPIRED: 2,
    ALREADY_SIGNALED: 3,
    CONDITION_SATISFIED: 4,
    WAIT_FAILED: 5,
    fenceSync: vi.fn(() => ({}) as WebGLSync),
    clientWaitSync: vi.fn(() => 2),
    deleteSync: vi.fn(),
    flush: vi.fn(),
  };
  return {
    gl,
    pacing: new FramePacing(gl as unknown as WebGL2RenderingContext),
  };
}

describe('interactive frame pacing', () => {
  it('bounds WebGPU submissions and ignores stale completions after reset', async () => {
    const pending: { resolve(): void; reject(error: Error): void }[] = [];
    const queue = {
      onSubmittedWorkDone: vi.fn(
        () =>
          new Promise<void>((resolve, reject) =>
            pending.push({ resolve, reject }),
          ),
      ),
    };
    const pacing = new WebGPUFramePacing(queue);
    expect(pacing.ready()).toBe(true);
    pacing.submitted();
    pacing.submitted();
    expect(queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    expect(pacing.ready()).toBe(false);
    pacing.reset();
    pacing.submitted();
    pending[0].resolve();
    await Promise.resolve();
    expect(pacing.ready()).toBe(false);
    pending[1].reject(new Error('Device lost'));
    await Promise.resolve();
    expect(pacing.ready()).toBe(true);
    pacing.submitted();
    pending[2].resolve();
    await Promise.resolve();
    expect(pacing.ready()).toBe(true);
  });
  it('admits the first frame, yields while busy and resumes without blocking', () => {
    const { gl, pacing } = setup();
    expect(pacing.ready()).toBe(true);
    pacing.submitted();
    const fence = gl.fenceSync.mock.results[0].value;
    expect(gl.flush).toHaveBeenCalledOnce();
    for (let i = 0; i < 5; i++) expect(pacing.ready()).toBe(false);
    expect(gl.clientWaitSync).toHaveBeenLastCalledWith(fence, 0, 0);
    expect(gl.fenceSync).toHaveBeenCalledOnce();
    expect(gl.deleteSync).not.toHaveBeenCalled();
    gl.clientWaitSync.mockReturnValue(gl.CONDITION_SATISFIED);
    expect(pacing.ready()).toBe(true);
    expect(gl.deleteSync).toHaveBeenCalledExactlyOnceWith(fence);
    pacing.submitted();
    expect(gl.fenceSync).toHaveBeenCalledTimes(2);
  });

  it('tracks the latest orbit frame before walk entry and releases syncs on reset', () => {
    const { gl, pacing } = setup();
    pacing.submitted();
    const first = gl.fenceSync.mock.results[0].value;
    pacing.submitted();
    expect(gl.deleteSync).toHaveBeenCalledWith(first);
    expect(pacing.ready()).toBe(false);
    pacing.reset();
    pacing.reset();
    expect(gl.deleteSync).toHaveBeenCalledTimes(2);
    expect(pacing.ready()).toBe(true);
  });

  it('recovers from failed fences and context loss instead of freezing navigation', () => {
    const { gl, pacing } = setup();
    pacing.submitted();
    gl.clientWaitSync.mockReturnValue(gl.WAIT_FAILED);
    expect(pacing.ready()).toBe(true);
    gl.fenceSync.mockReturnValueOnce(null as unknown as WebGLSync);
    pacing.submitted();
    expect(pacing.ready()).toBe(true);
    pacing.submitted();
    gl.clientWaitSync.mockReturnValue(gl.ALREADY_SIGNALED);
    expect(pacing.ready()).toBe(true);
  });

  it('bounds walk rendering at 1080p without changing aspect or oversampling small views', () => {
    expect(viewportPixelRatio(1920, 1080, 1, true)).toBe(1);
    expect(viewportPixelRatio(1920, 1080, 2, true)).toBe(1);
    expect(viewportPixelRatio(3840, 2160, 2, true)).toBe(0.5);
    expect(viewportPixelRatio(1280, 720, 1, true)).toBe(1);
    expect(viewportPixelRatio(1280, 720, 2, true)).toBe(1.5);
    expect(viewportPixelRatio(0, 0, 2, true)).toBe(2);
    expect(viewportPixelRatio(1920, 1080, 2, false)).toBe(2);
    expect(viewportPixelRatio(1920, 1080, 3, false)).toBe(2);
  });
});
