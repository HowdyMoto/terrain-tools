/** Keep interactive views from queuing old camera poses behind unfinished GPU work.
 * Poll with a zero timeout from the animation loop; never block the input thread.
 */
export class FramePacing {
  private pending?: WebGLSync;

  constructor(private readonly gl: WebGL2RenderingContext) {}

  ready() {
    if (!this.pending) return true;
    const status = this.gl.clientWaitSync(this.pending, 0, 0);
    if (status === this.gl.TIMEOUT_EXPIRED) return false;
    // A failed/lost sync must not leave the editor permanently frozen.
    this.reset();
    return true;
  }

  submitted() {
    this.reset();
    this.pending =
      this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE, 0) ?? undefined;
    // Submit the fence too, even when subsequent animation frames skip drawing.
    this.gl.flush();
  }

  reset() {
    if (this.pending) this.gl.deleteSync(this.pending);
    this.pending = undefined;
  }
}

/** First-person rendering uses at most the agreed 1080p pixel budget. CSS size
 * and camera aspect stay unchanged; orbit editing retains its device resolution.
 */
export function viewportPixelRatio(
  width: number,
  height: number,
  deviceRatio: number,
  walking: boolean,
) {
  const ratio = Math.min(deviceRatio, 2);
  return walking
    ? Math.min(ratio, Math.sqrt((1920 * 1080) / Math.max(1, width * height)))
    : ratio;
}
