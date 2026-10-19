import { TerrainWalker } from '../render/first-person';
import type { Viewport } from '../render/viewport';
import type { WalkPlacementResult } from '../render/walk-placement';

/** Pointer lock and fullscreen are independent, temporary editor view states. */
export function bindViewportNavigation(
  viewport: Viewport,
  options: {
    unavailable: () => boolean;
    onChange: () => void;
    notify: (message: string, error?: boolean) => void;
  },
) {
  const canvas = viewport.renderer.domElement;
  const stage = canvas.closest<HTMLElement>('.stage')!;
  const walk = stage.querySelector<HTMLButtonElement>('#walk')!;
  const fullscreen = stage.querySelector<HTMLButtonElement>('#fullscreen')!;
  const frame = stage.querySelector<HTMLButtonElement>('#frame')!;
  const hint = stage.querySelector<HTMLElement>('#walk-hint')!;
  const markerLabel = stage.querySelector<HTMLElement>(
    '#walk-placement-label',
  )!;
  const mode = stage.querySelector<HTMLElement>('#view-mode')!;
  const panels = [
    ...document.querySelectorAll<HTMLElement>(
      '.topbar, .rail, .inspector, .scene-panel',
    ),
  ];
  let panelStates: boolean[] = [];
  let request: { cancelled: boolean; walker: TerrainWalker } | undefined;
  let saved:
    | {
        position: typeof viewport.camera.position;
        quaternion: typeof viewport.camera.quaternion;
        target: typeof viewport.controls.target;
        fov: number;
        enabled: boolean;
      }
    | undefined;
  let fullscreenPending = false;
  let releasingPointer = false;

  function sync() {
    const active = viewport.navigationActive;
    const placing = !!viewport.walkPlacement;
    markerLabel.hidden = true;
    stage.classList.toggle('walking', active && !placing);
    stage.classList.toggle('walk-placing', placing);
    walk.setAttribute('aria-pressed', String(active));
    walk.title = placing
      ? 'Cancel walk placement · V / Esc'
      : active
        ? 'Exit first person · V / Esc'
        : 'Choose where to walk · V';
    walk.setAttribute(
      'aria-label',
      placing
        ? 'Cancel walk placement'
        : active
          ? 'Exit first person'
          : 'Walk in first person',
    );
    walk.setAttribute(
      'aria-busy',
      String(active && !placing && !viewport.walker),
    );
    frame.disabled = active;
    mode.textContent = placing
      ? 'Choose walk start'
      : active
        ? 'First person'
        : 'Perspective';
    hint.hidden = !active;
    hint.textContent = placing
      ? 'Choose where to stand · Point at the terrain · V / Esc cancel'
      : viewport.walker
        ? 'WASD move · Mouse look · Shift run · V / Esc exit · Shift+F fullscreen'
        : 'Capturing mouse… · V / Esc cancel';
    delete hint.dataset.state;
    options.onChange();
  }

  function exit() {
    if (request) request.cancelled = true;
    viewport.walker?.clearKeys();
    const wasWalking = !!viewport.walker;
    viewport.walker = undefined;
    viewport.endWalkPlacement();
    viewport.navigationActive = false;
    if (saved) {
      if (wasWalking) {
        viewport.camera.position.copy(saved.position);
        viewport.camera.quaternion.copy(saved.quaternion);
        viewport.camera.fov = saved.fov;
        viewport.camera.updateProjectionMatrix();
        viewport.controls.target.copy(saved.target);
      }
      panels.forEach((panel, i) => {
        panel.inert = panelStates[i];
      });
      sync();
      viewport.controls.enabled = saved.enabled;
      saved = undefined;
    }
    if (document.pointerLockElement === canvas) {
      releasingPointer = true;
      document.exitPointerLock();
    }
  }

  function failed(error: unknown) {
    if (!request || request.cancelled) {
      request = undefined;
      return;
    }
    exit();
    request = undefined;
    options.notify(
      'Could not capture the mouse. Click Walk to retry. ' + String(error),
      true,
    );
  }

  function toggleWalk() {
    // Fullscreen can release capture before its queued change event reaches us.
    if (viewport.walker && document.pointerLockElement !== canvas) exit();
    if (viewport.navigationActive) {
      exit();
      return;
    }
    if (
      request ||
      (releasingPointer && document.pointerLockElement === canvas) ||
      options.unavailable()
    )
      return;
    try {
      viewport.finishStroke();
      viewport.propTools.cancel();
      if (!canvas.requestPointerLock)
        throw new Error('Pointer lock is unavailable in this browser.');
      viewport.beginWalkPlacement();
      saved = {
        position: viewport.camera.position.clone(),
        quaternion: viewport.camera.quaternion.clone(),
        target: viewport.controls.target.clone(),
        fov: viewport.camera.fov,
        enabled: viewport.controls.enabled,
      };
      panelStates = panels.map((panel) => panel.inert);
      panels.forEach((panel) => {
        panel.inert = true;
      });
      viewport.navigationActive = true;
      sync();
      canvas.focus({ preventScroll: true });
    } catch (error) {
      exit();
      options.notify('Could not choose a walk start. ' + String(error), true);
    }
  }

  viewport.onWalkPlacementChange = (result) => {
    markerLabel.hidden = !result || !viewport.walkPlacement;
    if (result) {
      const point = result.start.position.clone().project(viewport.camera);
      markerLabel.style.left =
        Math.max(
          85,
          Math.min(
            canvas.clientWidth - 85,
            ((point.x + 1) * canvas.clientWidth) / 2,
          ),
        ) + 'px';
      markerLabel.style.top =
        Math.max(85, ((1 - point.y) * canvas.clientHeight) / 2) + 'px';
      markerLabel.textContent = 'Walk here';
    }
    const message = result
      ? 'Click to walk here · Enter also starts · Right drag to change direction'
      : 'Point at the terrain to choose where to stand.';
    const text = 'Choose where to stand · ' + message + ' · V / Esc cancel';
    if (hint.textContent !== text) hint.textContent = text;
    hint.dataset.state = result ? 'ready' : 'aim';
  };
  function confirmPlacement(result: WalkPlacementResult | null) {
    if (!result || !saved || !viewport.walkPlacement || options.unavailable())
      return;
    try {
      const walker = new TerrainWalker(viewport.project, result.start);
      // Restore the editor view the user composed while choosing their start.
      saved.position.copy(viewport.camera.position);
      saved.quaternion.copy(viewport.camera.quaternion);
      saved.target.copy(viewport.controls.target);
      viewport.endWalkPlacement();
      viewport.controls.enabled = false;
      const pending = (request = { cancelled: false, walker });
      sync();
      canvas.focus({ preventScroll: true });
      // Older browsers return void and report errors only through pointerlockerror.
      Promise.resolve(canvas.requestPointerLock()).catch((error: unknown) => {
        if (request === pending) failed(error);
      });
    } catch (error) {
      if (request) failed(error);
      else {
        exit();
        options.notify('Could not start walking. ' + String(error), true);
      }
    }
  }
  viewport.onWalkPlacementConfirm = confirmPlacement;

  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) {
      if (viewport.walker && !request) return;
      if (!request || request.cancelled || options.unavailable()) {
        exit();
        return;
      }
      // Drain orbit damping so it cannot move the restored editor camera later.
      const damping = viewport.controls.enableDamping;
      viewport.controls.enableDamping = false;
      viewport.controls.update();
      viewport.controls.enableDamping = damping;
      viewport.walker = request.walker;
      request = undefined;
      viewport.walker.enter(viewport.camera);
      sync();
    } else {
      const released = releasingPointer;
      releasingPointer = false;
      if (viewport.walker) exit();
      // A late release event must not cancel a new placement or capture request.
      if (released && request?.cancelled) request = undefined;
    }
  });
  document.addEventListener('pointerlockerror', () =>
    failed('The browser denied pointer lock.'),
  );
  document.addEventListener('mousemove', (event) => {
    if (document.pointerLockElement === canvas)
      viewport.walker?.mouseLook(
        viewport.camera,
        event.movementX,
        event.movementY,
      );
  });
  window.addEventListener('blur', exit);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) exit();
  });

  function syncFullscreen() {
    const active = document.fullscreenElement === stage;
    fullscreen.setAttribute('aria-pressed', String(active));
    fullscreen.setAttribute(
      'aria-label',
      active ? 'Exit fullscreen' : 'Fullscreen 3D view',
    );
    fullscreen.title =
      (active ? 'Exit fullscreen' : 'Fullscreen 3D view') + ' · Shift+F';
  }
  async function toggleFullscreen() {
    if (fullscreenPending || options.unavailable()) return;
    fullscreenPending = true;
    try {
      if (document.fullscreenElement === stage) await document.exitFullscreen();
      else {
        if (!stage.requestFullscreen)
          throw new Error('Fullscreen is unavailable in this browser.');
        viewport.finishStroke();
        viewport.propTools.cancel();
        await stage.requestFullscreen();
      }
    } catch (error) {
      options.notify('Could not change fullscreen. ' + String(error), true);
    } finally {
      fullscreenPending = false;
      syncFullscreen();
      canvas.focus({ preventScroll: true });
    }
  }
  document.addEventListener('fullscreenchange', syncFullscreen);
  walk.onclick = toggleWalk;
  fullscreen.onclick = () => {
    void toggleFullscreen();
  };

  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const active = viewport.navigationActive;
    const typing =
      event.target instanceof HTMLElement &&
      (event.target.isContentEditable ||
        !!event.target.closest('input, select, textarea, [role="textbox"]'));
    if (!active && (typing || options.unavailable())) return;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    const toggle = plain && event.code === 'KeyV' && !event.shiftKey;
    const screen = plain && event.code === 'KeyF' && event.shiftKey;
    if (toggle || screen || (active && event.key === 'Escape')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (screen) void toggleFullscreen();
      else if (event.key === 'Escape') exit();
      else toggleWalk();
      return;
    }
    if (viewport.walkPlacement && event.key === 'Enter') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) confirmPlacement(viewport.updateWalkPlacement());
      return;
    }
    if (active) {
      if (plain) viewport.walker?.setKey(event.code, true);
      else viewport.walker?.clearKeys();
      // Keep editing shortcuts and focus navigation out of captured mouse mode.
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });
  window.addEventListener('keyup', (event) => {
    viewport.walker?.setKey(event.code, false);
  });
  syncFullscreen();
}
