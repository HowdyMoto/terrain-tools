import { inspectorControl } from './inspector-controls.mjs';
import { decodeDocument } from './fixtures.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
function png(r, g, b) {
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) {
      c ^= byte;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const header = Buffer.from(name),
      out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    header.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([header, data])), data.length + 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pixels = Buffer.alloc(4 * 17);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) pixels.set([r, g, b, 255], y * 17 + 1 + x * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => {
    if (errors.length < 10) errors.push(e.message);
  });
  page.on('console', (m) => {
    if (
      m.type() === 'error' &&
      /THREE|Shader|WebGL|initialization/i.test(m.text()) &&
      errors.length < 10
    )
      errors.push(m.text());
  });
  return errors;
}
async function save(page, name) {
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  await (await pending).saveAs(name);
  return decodeDocument(await readFile(name));
}

test('PBR textures and full scene GLB survive export, editor reload, and the public runtime', async ({
  page,
  context,
}) => {
  test.setTimeout(240000);
  const errors = watchErrors(page);
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 90000,
  });
  await page.locator('#project-name').fill('Runtime round trip');
  await page.locator('#project-name').press('Tab');
  await (await inspectorControl(page, '[data-tool="hole"]')).click();
  const box = await page
    .getByLabel('Interactive terrain viewport')
    .boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.58);
  await page.locator('[data-tab="materials"]').click();
  await (
    await inspectorControl(page, '#texture-resolution')
  ).selectOption('1024');
  await expect(page.locator('#preparation-status')).toBeHidden();
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const albedo = png(185, 130, 75);
  await page
    .locator('#texture-open')
    .setInputFiles({ name: 'soil.png', mimeType: 'image/png', buffer: albedo });
  await expect(page.locator('#toast')).toHaveText('Texture imported.');
  const chooser = page.waitForEvent('filechooser');
  await (await inspectorControl(page, '[data-texture="normal"]')).click();
  await (
    await chooser
  ).setFiles({
    name: 'normal.png',
    mimeType: 'image/png',
    buffer: png(150, 115, 250),
  });
  await expect(page.locator('#toast')).toHaveText('Texture imported.');
  await (await inspectorControl(page, '#normal-strength')).focus();
  await (await inspectorControl(page, '#normal-strength')).press('End');
  await expect(page.locator('#preparation-status')).toBeHidden();
  await (await inspectorControl(page, '#normal-strength')).press('Tab');
  // Decode failures must not replace the last valid texture or poison autosave.
  await page.locator('#texture-open').setInputFiles({
    name: 'broken.png',
    mimeType: 'image/png',
    buffer: Buffer.from('invalid image'),
  });
  await expect(page.locator('#toast')).toContainText(/could not decode/i);
  const before = await save(page, 'test-results/material-project.json');
  expect(before.view.textureResolution).toBe(1024);
  expect(before.materials[0].normalStrength).toBe(4);
  expect(before.materials[0].textures.albedo).toBe(
    'data:image/png;base64,' + albedo.toString('base64'),
  );
  expect(before.holes.some((v) => v === 1)).toBe(true);
  const pending = page.waitForEvent('download');
  await page.locator('#export').click();
  const exported = await pending;
  await exported.saveAs('test-results/runtime-scene.glb');
  const bytes = await readFile('test-results/runtime-scene.glb');
  expect(bytes.subarray(0, 4).toString()).toBe('glTF');
  const json = decodeDocument(
    bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString(),
  );
  const author = decodeDocument(bytes);
  expect(json.extensions.TERRAIN_tools_project.version).toBe(2);
  expect(author).toEqual(before);
  expect(json.nodes.some((n) => n.extensions?.EXT_mesh_gpu_instancing)).toBe(
    true,
  );
  await page
    .locator('#file-open')
    .setInputFiles('test-results/runtime-scene.glb');
  await expect(page.locator('#toast')).toHaveText('Project loaded.', {
    timeout: 60000,
  });
  const after = await save(page, 'test-results/material-project-after.json');
  expect(after).toEqual(before);
  await page.screenshot({ path: 'test-results/materials-runtime.png' });
  expect(errors).toEqual([]);
  const runtime = await context.newPage();
  const runtimeErrors = watchErrors(runtime);
  await runtime.goto('/runtime.html');
  await expect(runtime.locator('#status')).toContainText('foliage instances', {
    timeout: 30000,
  });
  await runtime
    .locator('#open-project')
    .setInputFiles('test-results/runtime-scene.glb');
  await expect(runtime.locator('#status')).toContainText('Runtime round trip', {
    timeout: 60000,
  });
  await runtime.locator('#wind').click();
  await expect(runtime.locator('#wind')).toHaveText('Wind off');
  await runtime.locator('#contact').click();
  await runtime.locator('#physics').click();
  await expect(runtime.locator('#physics')).toHaveText('Physics active', {
    timeout: 30000,
  });
  await runtime.locator('#drop').click();
  await runtime.screenshot({ path: 'test-results/standalone-runtime.png' });
  expect(runtimeErrors).toEqual([]);
  await runtime.close();
});
