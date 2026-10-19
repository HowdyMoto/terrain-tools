import { decodeDocument } from './fixtures.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createProject, serializeProject } from 'terrain-tools';

async function saved(page, info, name) {
  const event = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = info.outputPath(name);
  await (await event).saveAs(path);
  return decodeDocument(await readFile(path));
}

test('expires distant history while preserving recent undo, branching, and autosave', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  const project = createProject(32, 64);
  project.name = 'Long editing session';
  project.view.textureResolution = 256;
  project.foliage = [];
  project.holes[15] = 1;
  project.paint[40] = 0.7;
  const original = decodeDocument(serializeProject(project));
  await page.locator('#file-open').setInputFiles({
    name: 'session.terrain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(original)),
  });
  const name = page.locator('#project-name');
  await expect(name).toHaveValue(project.name);
  for (let i = 0; i < 70; i++) {
    await name.fill('Session edit ' + i);
    await name.press('Tab');
  }
  await expect(page.locator('#undo')).toHaveAttribute(
    'title',
    /64 undo steps · 0 redo steps/,
  );
  await expect(page.locator('#undo')).toHaveAttribute(
    'title',
    /Older steps have expired/,
  );
  expect(await saved(page, info, 'latest.json')).toEqual({
    ...original,
    name: 'Session edit 69',
  });
  await page.locator('#undo').click();
  await expect(name).toHaveValue('Session edit 68');
  expect(await saved(page, info, 'undo.json')).toEqual({
    ...original,
    name: 'Session edit 68',
  });
  await expect(page.locator('#undo')).toHaveAttribute(
    'title',
    /63 undo steps · 1 redo steps/,
  );
  await page.locator('#redo').click();
  await expect(name).toHaveValue('Session edit 69');
  await page.locator('#undo').click();
  await expect(name).toHaveValue('Session edit 68');
  await name.fill('New branch');
  await name.press('Tab');
  await expect(page.locator('#redo')).toBeDisabled();
  await page.locator('#undo').click();
  await expect(name).toHaveValue('Session edit 68');
  await page.locator('#redo').click();
  await expect(name).toHaveValue('New branch');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(name).toHaveValue('New branch', { timeout: 30000 });
  expect(await saved(page, info, 'recovered.json')).toEqual({
    ...original,
    name: 'New branch',
  });
  expect(errors).toEqual([]);
});
