/** One-shot staged resource ownership. Applying transfers ownership; abandoning releases it. */
export class PreparedResource<T> {
  private active = true;
  constructor(
    private owner: object,
    readonly value: T,
    private release: () => void,
  ) {}
  assert(owner: object) {
    if (!this.active || this.owner !== owner)
      throw new Error(
        'Prepared resources are unavailable or belong to another owner.',
      );
  }
  take(owner: object) {
    this.assert(owner);
    this.active = false;
    return this.value;
  }
  dispose() {
    if (!this.active) return;
    this.active = false;
    this.release();
  }
}
export class SharedResource<T> {
  private references = 1;
  constructor(
    readonly value: T,
    private cleanup: () => void,
  ) {}
  retain() {
    if (this.references === 0) throw new Error('Resource has been disposed.');
    this.references++;
    return this;
  }
  release() {
    if (this.references === 0) return;
    if (--this.references === 0) this.cleanup();
  }
}
export function cancelled() {
  return new DOMException('Preparation cancelled.', 'AbortError');
}
export function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelled();
}
/** Let a visible frame run before the next preparation slice. The timeout keeps
 * hidden/headless hosts progressing when RAF is suspended. Cancellation drains
 * both callbacks and never waits for a visible window. */
export async function yieldPreparation(signal: AbortSignal) {
  checkSignal(signal);
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    let frame = 0;
    const done = () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      signal.removeEventListener('abort', done);
      resolve();
    };
    let timer = setTimeout(done, 50);
    frame = requestAnimationFrame(() => {
      clearTimeout(timer);
      timer = setTimeout(done, 0);
    });
    signal.addEventListener('abort', done, { once: true });
  });
  checkSignal(signal);
}
/** Link a task to its owner and optional caller; unlink after settlement. */
export function linkedController(signal?: AbortSignal) {
  const controller = new AbortController(),
    abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return {
    controller,
    unlink: () => signal?.removeEventListener('abort', abort),
  };
}
