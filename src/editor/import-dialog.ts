/** Shared modal chrome: keyboard/file drop access, local errors and cancellable work. */
export function importDialog(
  title: string,
  description: string,
  contents: string,
) {
  const opener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  const dialog = document.createElement('dialog');
  dialog.className = 'asset-import';
  dialog.setAttribute('aria-labelledby', 'asset-import-title');
  dialog.innerHTML = `<header class="import-header"><div><span class="eyebrow">ASSET WORKSPACE</span><h1 id="asset-import-title"></h1><p></p></div><button class="import-close" aria-label="Close import">×</button></header>${contents}<footer class="import-footer"><p class="import-status" role="status" aria-live="polite">Your project stays unchanged until you apply.</p><div><button class="import-cancel">Cancel</button><button class="import-apply primary" disabled>Apply</button></div></footer>`;
  dialog.querySelector('h1')!.textContent = title;
  dialog.querySelector('header p')!.textContent = description;
  const query = <T extends HTMLElement = HTMLElement>(selector: string) =>
    dialog.querySelector<T>(selector)!;
  const controller = new AbortController();
  const cleanup: (() => void)[] = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    cleanup.forEach((fn) => fn());
    dialog.close();
    dialog.remove();
    const focusTarget = opener?.id
      ? document.getElementById(opener.id)
      : opener;
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
  };
  query('.import-close').onclick = close;
  query('.import-cancel').onclick = close;
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return {
    dialog,
    query,
    close,
    cleanup,
    signal: controller.signal,
    status(message: string, error = false) {
      query('.import-status').textContent = message;
      query('.import-status').classList.toggle('is-error', error);
    },
    busy(value: boolean) {
      dialog.querySelectorAll<HTMLFieldSetElement>('fieldset').forEach((el) => {
        el.disabled = value;
      });
      dialog
        .querySelectorAll<HTMLButtonElement>('[data-import-edit]')
        .forEach((el) => {
          el.disabled = value;
        });
      query<HTMLButtonElement>('.import-apply').disabled = value;
    },
  };
}

export const escapeImportText = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
export const fileSize = (bytes: number) =>
  bytes < 1_000_000
    ? `${Math.ceil(bytes / 1000)} KB`
    : `${(bytes / 1_000_000).toFixed(1)} MB`;

export function bindFileDrop(
  element: HTMLElement,
  input: HTMLInputElement,
  receive: (files: File[]) => void,
) {
  input.onchange = () => {
    receive(Array.from(input.files ?? []));
    input.value = '';
  };
  element.ondragover = (e) => {
    e.preventDefault();
    element.classList.add('is-dragging');
  };
  element.ondragleave = () => element.classList.remove('is-dragging');
  element.ondrop = (e) => {
    e.preventDefault();
    element.classList.remove('is-dragging');
    if (!input.disabled && !input.closest('fieldset')?.disabled)
      receive(Array.from(e.dataTransfer?.files ?? []));
  };
}
