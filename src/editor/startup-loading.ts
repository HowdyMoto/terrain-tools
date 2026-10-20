/** Startup progress counts completed stages, not estimated time remaining. */
export class StartupLoading {
  private readonly dialog = document.createElement('dialog');
  private readonly status: HTMLElement;
  private readonly steps: HTMLElement;
  private readonly progress: HTMLProgressElement;

  constructor() {
    this.dialog.id = 'startup-loading';
    this.dialog.setAttribute('aria-labelledby', 'startup-title');
    this.dialog.setAttribute('aria-describedby', 'startup-note');
    this.dialog.innerHTML = `
      <span class="eyebrow">TERRAIN STUDIO</span>
      <h1 id="startup-title">Opening your world</h1>
      <div class="startup-status" role="status" aria-live="polite">
        <span class="startup-spinner" aria-hidden="true"></span>
        <span id="startup-stage">Starting graphics…</span>
      </div>
      <progress max="8" value="0" aria-label="Terrain loading progress" aria-describedby="startup-stage"></progress>
      <div class="startup-meta"><span id="startup-steps">Step 1 of 8</span><span>Preparing your workspace</span></div>
      <p id="startup-note">Large scenes can take a little longer to open.</p>`;
    this.status = this.dialog.querySelector('#startup-stage')!;
    this.steps = this.dialog.querySelector('#startup-steps')!;
    this.progress = this.dialog.querySelector('progress')!;
    // Closing this modal would expose controls before the project is ready.
    this.dialog.addEventListener('cancel', (event) => event.preventDefault());
    document.body.append(this.dialog);
    this.dialog.showModal();
  }

  update(completed: number, message: string, fraction = 0) {
    this.progress.value = completed + fraction;
    this.status.textContent = message;
    this.steps.textContent =
      completed === 8 ? 'Ready' : `Step ${completed + 1} of 8`;
  }

  async stage(completed: number, message: string) {
    this.update(completed, message);
    // Paint the new status before synchronous geometry or shader preparation.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }

  close() {
    this.dialog.close();
    this.dialog.remove();
  }

  fail(message: string, recover: () => Promise<void>) {
    this.dialog.classList.add('startup-failed');
    this.dialog.querySelector('h1')!.textContent = 'Could not open this world';
    this.status.textContent = message;
    this.dialog.querySelector('#startup-note')!.textContent =
      'You can download your locally saved project before trying again.';
    const actions = document.createElement('div');
    actions.className = 'startup-actions';
    const save = document.createElement('button');
    save.textContent = 'Download locally saved project';
    save.onclick = async () => {
      save.disabled = true;
      try {
        await recover();
      } catch (error) {
        this.status.textContent = String(error);
      } finally {
        save.disabled = false;
      }
    };
    const retry = document.createElement('button');
    retry.textContent = 'Reload';
    retry.onclick = () => location.reload();
    actions.append(save, retry);
    this.dialog.append(actions);
  }
}
