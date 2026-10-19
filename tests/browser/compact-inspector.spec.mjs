import { test, expect } from '@playwright/test';

const tools = [
  'sculpt',
  'materials',
  'foliage',
  'props',
  'light',
  'wind',
  'water',
  'project',
];

async function start(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 30000,
  });
  await expect(page.locator('.inspector-tabs')).toBeVisible();
  return errors;
}
async function rail(page, tool) {
  await page.locator(`[data-tab="${tool}"]`).click();
}
async function tab(page, name) {
  await page.getByRole('tab', { name, exact: true }).click();
}

test('all eight default tool pages fit at desktop height and every settings page stays within the sidebar', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await start(page);
  const metrics = [];
  for (const tool of tools) {
    await rail(page, tool);
    const size = await page
      .locator('#inspector-content')
      .evaluate((element) => ({
        height: element.clientHeight,
        content: element.scrollHeight,
        width: element.clientWidth,
        contentWidth: element.scrollWidth,
      }));
    metrics.push({ tool, ...size });
    expect(size.content, tool).toBeLessThanOrEqual(size.height + 1);
    expect(size.contentWidth, tool).toBeLessThanOrEqual(size.width + 1);
    if (['sculpt', 'foliage', 'light', 'water'].includes(tool))
      await page.screenshot({ path: info.outputPath(`${tool}-desktop.png`) });
    const tabs = page.getByRole('tab');
    for (let i = 0; i < (await tabs.count()); i++) {
      await tabs.nth(i).click();
      await expect(page.getByRole('tabpanel')).toBeVisible();
      const overflow = await page
        .locator('#inspector-content')
        .evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
    const ids = await page
      .locator('#inspector-content [id]')
      .evaluateAll((elements) => elements.map((element) => element.id));
    expect(new Set(ids).size).toBe(ids.length);
  }
  await info.attach('inspector-dimensions', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  expect(errors).toEqual([]);
});

test('brush controls follow the selected sculpt tool and tabs support keyboard navigation', async ({
  page,
}) => {
  const errors = await start(page);
  await expect(page.locator('#target')).toBeHidden();
  await expect(page.locator('#erode-talus')).toBeHidden();
  await page.locator('[data-tool="flatten"]').click();
  await expect(
    page.getByText('Target elevation', { exact: true }),
  ).toBeVisible();
  await page.locator('[data-tool="terrace"]').click();
  await expect(page.getByText('Terrace step', { exact: true })).toBeVisible();
  await page.locator('[data-tool="erode"]').click();
  await expect(page.locator('#target')).toBeHidden();
  await expect(page.locator('#erode-talus')).toBeVisible();
  await page.locator('[data-tool="stamp"]').click();
  await expect(page.locator('#stamp-mode')).toBeVisible();
  await expect(page.locator('#stamp-base')).toBeHidden();
  await page.locator('#stamp-mode').focus();
  await page.locator('#stamp-mode').selectOption('set');
  await expect(page.locator('#stamp-base')).toBeVisible();
  await expect(page.locator('#stamp-mode')).toBeFocused();
  const brush = page.getByRole('tab', { name: 'Brush', exact: true });
  await brush.focus();
  await brush.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: 'Terrain', exact: true }),
  ).toBeFocused();
  await expect(page.locator('#generate')).toBeVisible();
  await page.keyboard.press('End');
  await expect(
    page.getByRole('tab', { name: 'Files', exact: true }),
  ).toBeFocused();
  await expect(page.locator('#export-heightmap')).toBeVisible();
  await page.keyboard.press('Home');
  await expect(brush).toBeFocused();
  expect(errors).toEqual([]);
});

test('material pages and expanded options survive edits, undo and tool changes without adding history', async ({
  page,
}) => {
  const errors = await start(page);
  await rail(page, 'materials');
  const originalHistory = await page.locator('#undo').getAttribute('title');
  await tab(page, 'Maps');
  await page.getByText('Surface preset', { exact: true }).click();
  await expect(page.locator('#save-surface-preset')).toBeVisible();
  await rail(page, 'wind');
  await rail(page, 'materials');
  await expect(
    page.getByRole('tab', { name: 'Maps', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#save-surface-preset')).toBeVisible();
  expect(await page.locator('#undo').getAttribute('title')).toBe(
    originalHistory,
  );
  await tab(page, 'Surface');
  const original = await page.locator('#mat-name').inputValue();
  await page.locator('#mat-name').fill('Compact test surface');
  await page.locator('#mat-name').press('Tab');
  await expect(page.locator('[data-material="0"]')).toContainText(
    'Compact test surface',
  );
  await expect(
    page.getByRole('tab', { name: 'Surface', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.locator('#undo').click();
  await expect(page.locator('#mat-name')).toHaveValue(original);
  await page.locator('#redo').click();
  await expect(page.locator('#mat-name')).toHaveValue('Compact test surface');
  expect(errors).toEqual([]);
});

test('foliage paint actions are immediately reachable and model disclosures retain context after a refresh', async ({
  page,
}) => {
  const errors = await start(page);
  await rail(page, 'foliage');
  await expect(page.locator('#radius')).toBeInViewport();
  await expect(page.locator('#populate')).toBeInViewport();
  await expect(page.locator('#model-entry')).toBeHidden();
  await tab(page, 'Effects');
  await expect(page.locator('#model-entry')).toBeVisible();
  await page.getByText('Plant flexibility', { exact: true }).click();
  await page.locator('#flexibility-source').selectOption('height');
  await expect(page.locator('#flexibility-start')).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Effects', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await rail(page, 'water');
  await rail(page, 'foliage');
  await expect(page.locator('#flexibility-start')).toBeVisible();
  await tab(page, 'Detail');
  await expect(page.locator('#foliage-cull-distance')).toBeVisible();
  await tab(page, 'Library');
  await expect(page.locator('#import-foliage')).toBeVisible();
  await expect(page.locator('#add-default-foliage')).toBeVisible();
  expect(errors).toEqual([]);
});

test('lighting controls remain reachable at laptop sizes and retain the active page after editing', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const errors = await start(page);
  await rail(page, 'light');
  await page.locator('#daylight-enabled').check();
  await expect(page.locator('#daylight-time')).toBeVisible();
  await page.getByText('Sun path & atmosphere', { exact: true }).click();
  await page.locator('#daylight-latitude').fill('45');
  await page.locator('#daylight-latitude').press('Tab');
  await expect(page.locator('#daylight-latitude')).toHaveAttribute(
    'value',
    '45',
  );
  await expect(
    page.getByRole('tab', { name: 'Sun', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await tab(page, 'Shadows');
  await expect(page.locator('#env-shadowResolution')).toBeVisible();
  await page.getByText('Contact shading', { exact: true }).click();
  await expect(page.locator('#env-ao-radius')).toBeVisible();
  await tab(page, 'View');
  await expect(page.locator('#env-temporalAA')).toBeVisible();
  await expect(page.locator('#low-poly')).toBeVisible();
  await page.screenshot({ path: info.outputPath('light-laptop.png') });
  await page.setViewportSize({ width: 900, height: 700 });
  for (const tool of tools) {
    await rail(page, tool);
    expect(
      await page
        .locator('#inspector-content')
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});

test('long settings pages remember scroll independently and keep navigation available', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 650 });
  const errors = await start(page);
  await rail(page, 'foliage');
  await tab(page, 'Detail');
  const lods = page.locator('.inspector-lod');
  for (let i = 0; i < (await lods.count()); i++) {
    if (!(await lods.nth(i).evaluate((element) => element.open)))
      await lods.nth(i).locator('summary').click();
  }
  const scroll = page.locator('#inspector-content');
  await scroll.evaluate((element) => {
    element.scrollTop = 240;
  });
  const before = await scroll.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(100);
  await expect(
    page.getByRole('tab', { name: 'Paint', exact: true }),
  ).toBeInViewport();
  await tab(page, 'Paint');
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0);
  await tab(page, 'Detail');
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(before);
  await rail(page, 'water');
  await rail(page, 'foliage');
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(before);
  expect(errors).toEqual([]);
});
