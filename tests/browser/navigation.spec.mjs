import { installNavigationProbe } from './webgpu-navigation-probe.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createProject, serializeProject } from 'terrain-tools';
import { decodeDocument } from './fixtures.mjs';
import { Euler, Matrix4, Quaternion } from 'three';

test.setTimeout(180000);

async function setup(page) {
  await page.addInitScript(installNavigationProbe);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 90000,
  });
  const project = createProject(32, 64);
  project.view.water = false;
  project.foliage = [];
  await page.locator('#file-open').setInputFiles({
    name: 'Walkthrough.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.', {
    timeout: 60000,
  });
  await page.locator('#frame').click();
  return errors;
}

async function pixels(page) {
  const data = await page
    .locator('#viewport canvas')
    .evaluate(async (canvas) => {
      const first = window.navigationFrames;
      do {
        await new Promise(requestAnimationFrame);
      } while (window.navigationFrames < first + 2);
      return canvas.toDataURL();
    });
  return createHash('sha256').update(data).digest('hex');
}

async function save(page, info, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = info.outputPath(name + '.terrain');
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}

async function chooseStart(page, confirm = true) {
  await expect(page.locator('.stage')).toHaveClass(/walk-placing/);
  const box = await page.locator('#viewport canvas').boundingBox();
  const x = box.x + box.width * 0.5,
    y = box.y + box.height * 0.55;
  await page.mouse.move(x, y);
  await expect(page.locator('#walk-hint')).toHaveAttribute(
    'data-state',
    'ready',
  );
  await expect(page.locator('#walk-placement-label')).toHaveText('Walk here');
  if (confirm) await page.mouse.click(x, y);
  return { x, y };
}

async function locked(page, value) {
  await expect
    .poll(() => page.evaluate(() => !!document.pointerLockElement))
    .toBe(value);
  await expect(page.locator('#walk')).toHaveAttribute(
    'aria-pressed',
    String(value),
  );
}

test('starts on the unmodified default terrain and cancels without changing the document or history', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 30000,
  });
  await page.locator('#frame').click();
  await page.mouse.move(20, 20);
  const hash = (data) =>
    createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const before = hash(await save(page, info, 'placement-before'));
  const history = await page.locator('#undo').getAttribute('title');
  await page.keyboard.press('v');
  // A late fullscreen release event must not cancel a new placement.
  await page.evaluate(() =>
    document.dispatchEvent(new Event('pointerlockchange')),
  );
  await chooseStart(page, false);
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  await page.screenshot({ path: info.outputPath('default-walk-start.png') });
  await page.keyboard.press('Escape');
  await locked(page, false);
  await expect(page.locator('#walk-placement-label')).toBeHidden();
  await page.mouse.move(20, 20);
  // Default foliage animates; exact camera restoration is checked below in a static scene.
  expect(await page.locator('#undo').getAttribute('title')).toBe(history);

  await page.keyboard.press('v');
  await chooseStart(page, false);
  await page.keyboard.press('Enter');
  await locked(page, true);
  await page.screenshot({ path: info.outputPath('default-terrain-walk.png') });
  await page.keyboard.press('v');
  await locked(page, false);
  expect(hash(await save(page, info, 'placement-after'))).toBe(before);
  expect(errors).toEqual([]);
});

test('walks with native mouse capture, restores the orbit view, and preserves the document and history', async ({
  page,
}, info) => {
  const errors = await setup(page);
  const original = await save(page, info, 'before');
  const undo = await page.locator('#undo').getAttribute('title');
  const redo = await page.locator('#redo').getAttribute('title');
  await page.mouse.move(20, 20);
  const orbit = await pixels(page);
  await page.keyboard.down('v');
  await expect(page.locator('.stage')).toHaveClass(/walk-placing/);
  await page.keyboard.down('v');
  await expect(page.locator('.stage')).toHaveClass(/walk-placing/);
  await page.keyboard.up('v');
  await chooseStart(page);
  await locked(page, true);
  await page.evaluate(() =>
    document.dispatchEvent(new Event('pointerlockchange')),
  );
  await locked(page, true);
  await expect(page.locator('#walk-hint')).toContainText('WASD');
  await expect(page.locator('#frame')).toBeDisabled();
  const start = await pixels(page);
  expect(start).not.toBe(orbit);
  await page.keyboard.down('w');
  await page.waitForTimeout(350);
  await page.keyboard.up('w');
  const moved = await pixels(page);
  expect(moved).not.toBe(start);
  await page.mouse.move(450, 350);
  const looked = await pixels(page);
  expect(looked).not.toBe(moved);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.keyboard.press('Control+z');
  await page.keyboard.press(']');
  await page.keyboard.press('f');
  await page.keyboard.press('v');
  await locked(page, false);
  await page.mouse.move(20, 20);
  expect(await pixels(page)).toBe(orbit);
  expect(await page.locator('#undo').getAttribute('title')).toBe(undo);
  expect(await page.locator('#redo').getAttribute('title')).toBe(redo);
  expect(await save(page, info, 'after')).toEqual(original);

  // Visible control, Escape, lost focus, and re-entry with no held movement.
  await page.locator('#walk').click();
  await chooseStart(page);
  await locked(page, true);
  await page.keyboard.press('Escape');
  await locked(page, false);
  await page.locator('#walk').click();
  await chooseStart(page);
  await locked(page, true);
  await page.keyboard.down('w');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await locked(page, false);
  await page.keyboard.up('w');
  await page.locator('#walk').click();
  await chooseStart(page);
  await locked(page, true);
  await pixels(page);
  // Check the actual rendered camera: independent of antialiasing/noise pixels.
  const beforeStill = await page.evaluate(() => window.navigationView);
  expect(beforeStill).toHaveLength(16);
  await page.waitForTimeout(150);
  await pixels(page);
  expect(await page.evaluate(() => window.navigationView)).toEqual(beforeStill);
  await page.screenshot({ path: info.outputPath('first-person.png') });
  await page.keyboard.press('v');
  await locked(page, false);
  await expect(page.locator('.inspector')).not.toHaveAttribute('inert');
  // Authoring still works after returning.
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.55);
  await expect(page.locator('#redo')).toBeDisabled();
  expect(await save(page, info, 'edited')).not.toEqual(original);
  expect(errors).toEqual([]);
});

test('fullscreen contains only the view, resizes rendering, and combines with first person', async ({
  page,
}, info) => {
  const errors = await setup(page);
  const canvas = page.locator('#viewport canvas');
  const normal = await canvas.boundingBox();
  await page.locator('#fullscreen').click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.className))
    .toBe('stage');
  await expect(page.locator('#fullscreen')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect.poll(async () => (await canvas.boundingBox()).width).toBe(1440);
  expect((await canvas.boundingBox()).height).toBe(960);
  const sizes = await canvas.evaluate((element) => ({
    width: element.width,
    height: element.height,
  }));
  expect(sizes).toEqual({ width: 1440, height: 960 });
  await page.keyboard.press('v');
  await chooseStart(page);
  await locked(page, true);
  await page.keyboard.press('Shift+f');
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
  await expect(page.locator('#fullscreen')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect
    .poll(async () => (await canvas.boundingBox()).width)
    .toBe(normal.width);
  if (await page.evaluate(() => !!document.pointerLockElement)) {
    await page.keyboard.press('v');
    await locked(page, false);
  }
  await page.keyboard.press('Shift+f');
  await expect(page.locator('#fullscreen')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('v');
  await chooseStart(page);
  await locked(page, true);
  await page.screenshot({ path: info.outputPath('fullscreen-walk.png') });
  await page.keyboard.press('v');
  await locked(page, false);
  // Browser-initiated fullscreen exit must also update the button state.
  await page.evaluate(() => document.exitFullscreen());
  await expect(page.locator('#fullscreen')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(errors).toEqual([]);
});

test('suspends selected prop handles and restores selection after walking', async ({
  page,
}, info) => {
  const errors = await setup(page);
  await page.locator('[data-tab="props"]').click();
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.55);
  await expect(page.locator('[data-prop]')).toHaveCount(1);
  await expect(page.locator('#prop-transform-tools')).toBeVisible();
  const before = await save(page, info, 'selected-prop-before');
  await page.locator('#walk').click();
  await chooseStart(page);
  await locked(page, true);
  await expect(page.locator('#prop-transform-tools')).toBeHidden();
  await page.mouse.down();
  await page.mouse.move(600, 500, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Tab');
  await page.keyboard.press('v');
  await locked(page, false);
  await expect(page.locator('#prop-transform-tools')).toBeVisible();
  expect(await save(page, info, 'selected-prop-after')).toEqual(before);
  expect(errors).toEqual([]);
});

test('ignores typing and dialogs, recovers from browser refusals, and cancels delayed capture', async ({
  page,
}) => {
  const errors = await setup(page);
  const name = page.locator('#project-name');
  await name.focus();
  await page.keyboard.press('v');
  await page.keyboard.press('Shift+f');
  await locked(page, false);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  await name.press('Tab');
  await page.locator('#help').click();
  await expect(page.locator('#guide')).toBeVisible();
  await page.keyboard.press('v');
  await page.keyboard.press('Shift+f');
  await locked(page, false);
  await page.locator('#close-guide').click();
  await page.evaluate(() => {
    const canvas = document.querySelector('#viewport canvas');
    const stage = document.querySelector('.stage');
    window.originalLock = canvas.requestPointerLock;
    window.originalFullscreen = stage.requestFullscreen;
    canvas.requestPointerLock = () =>
      Promise.reject(new Error('Injected capture refusal'));
    stage.requestFullscreen = () =>
      Promise.reject(new Error('Injected fullscreen refusal'));
  });
  await page.locator('#walk').click();
  await chooseStart(page);
  await expect(page.locator('#toast')).toContainText(
    'Could not capture the mouse',
  );
  await locked(page, false);
  await expect(page.locator('.inspector')).not.toHaveAttribute('inert');
  await page.locator('#fullscreen').click();
  await expect(page.locator('#toast')).toContainText(
    'Could not change fullscreen',
  );
  await expect(page.locator('#fullscreen')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.evaluate(() => {
    const canvas = document.querySelector('#viewport canvas');
    document.querySelector('.stage').requestFullscreen =
      window.originalFullscreen;
    canvas.requestPointerLock = () =>
      new Promise((resolve, reject) => {
        window.finishLock = () =>
          window.originalLock.call(canvas).then(resolve, reject);
      });
  });
  await page.keyboard.press('v');
  await chooseStart(page);
  await expect(page.locator('#walk')).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() =>
    document.dispatchEvent(new Event('pointerlockchange')),
  );
  await expect(page.locator('#walk')).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('v');
  await locked(page, false);
  await page.evaluate(() => window.finishLock());
  await locked(page, false);
  await page.evaluate(() => {
    document.querySelector('#viewport canvas').requestPointerLock =
      window.originalLock;
  });
  await page.locator('#walk').click();
  await chooseStart(page);
  await locked(page, true);
  await page.keyboard.press('v');
  await locked(page, false);
  await page.locator('#fullscreen').click();
  await expect(page.locator('#fullscreen')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Shift+f');
  await expect(page.locator('#fullscreen')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(errors).toEqual([]);
});

test.describe('responsive first-person rendering', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1920, height: 1080 } });

  test('yields to mouse input under GPU pressure and renders the latest pose without a frame backlog', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.addInitScript(() => {
      window.walkPacingProbe = {
        blocked: false,
        frames: [],
        view: null,
        waits: [],
      };
    });
    const errors = await setup(page);
    // Native queue completion must bound orbit frames as well: otherwise an
    // editor startup/import can leave walking behind a backlog of old draws.
    await page.evaluate(() => {
      walkPacingProbe.blocked = true;
    });
    await page.waitForFunction(() => !!walkPacingProbe.release);
    const orbitSubmissions = await page.evaluate(() => navigationSubmissions);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => navigationSubmissions)).toBe(
      orbitSubmissions,
    );
    await page.evaluate(() => {
      walkPacingProbe.blocked = false;
      walkPacingProbe.release();
      delete walkPacingProbe.release;
    });
    await page.locator('#fullscreen').click();
    const canvas = page.locator('#viewport canvas');
    await expect.poll(() => canvas.evaluate((c) => c.width)).toBe(3840);
    await page.keyboard.press('v');
    await chooseStart(page);
    await locked(page, true);
    await expect
      .poll(() => canvas.evaluate((c) => [c.width, c.height]))
      .toEqual([1920, 1080]);
    await page.evaluate(() => {
      walkPacingProbe.blocked = true;
    });
    await page.waitForFunction(() => !!walkPacingProbe.release);
    const before = await page.evaluate(() => {
      return {
        count: walkPacingProbe.frames.length,
        view: walkPacingProbe.frames.at(-1).view,
      };
    });
    // Deliver several mouse reports while rendering is held up. All movement
    // must reach the very next rendered camera, with no queued catch-up frames.
    await page.evaluate(() => {
      for (let i = 0; i < 10; i++)
        document.dispatchEvent(
          new MouseEvent('mousemove', { movementX: 8, movementY: -3 }),
        );
    });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => walkPacingProbe.frames.length)).toBe(
      before.count,
    );
    expect(
      await page.evaluate(() =>
        walkPacingProbe.waits.every((timeout) => timeout === 0),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => walkPacingProbe.waits.length),
    ).toBeGreaterThan(0);
    await page.evaluate(() => {
      walkPacingProbe.blocked = false;
      walkPacingProbe.release();
    });
    await expect
      .poll(() => page.evaluate(() => walkPacingProbe.frames.length))
      .toBeGreaterThan(before.count + 3);
    const views = await page.evaluate(
      (count) =>
        walkPacingProbe.frames
          .slice(count, count + 4)
          .map((frame) => frame.view),
      before.count,
    );
    const orientation = (values) =>
      new Quaternion().setFromRotationMatrix(
        new Matrix4().fromArray(values).invert(),
      );
    const angles = new Euler().setFromQuaternion(
      orientation(before.view),
      'YXZ',
    );
    angles.y -= 80 * 0.002;
    angles.x += 30 * 0.002;
    const expected = new Quaternion().setFromEuler(angles);
    for (const view of views)
      expect(orientation(view).angleTo(expected)).toBeLessThan(0.001);
    await page.keyboard.press('v');
    await locked(page, false);
    await expect
      .poll(() => canvas.evaluate((c) => [c.width, c.height]))
      .toEqual([3840, 2160]);
    expect(errors).toEqual([]);
  });
});
