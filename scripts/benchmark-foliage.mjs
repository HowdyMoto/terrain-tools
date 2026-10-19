import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const count = Number(
  process.argv.find((arg) => arg.startsWith('--count='))?.split('=')[1] ??
    10000,
);
const shadows = process.argv.includes('--shadows');
const fadeDuration = Number(
  process.argv.find((arg) => arg.startsWith('--fade='))?.split('=')[1] ?? 0,
);
const url = 'http://127.0.0.1:5175';
let server, browser;
try {
  const available = await fetch(url)
    .then((response) => response.ok)
    .catch(() => false);
  if (!available) {
    server = spawn(
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        'preview',
        '--configLoader',
        'native',
        '--host',
        '127.0.0.1',
        '--port',
        '5175',
        '--strictPort',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (
        await fetch(url)
          .then((response) => response.ok)
          .catch(() => false)
      ) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready)
      throw new Error('Preview server did not start. Build the project first.');
  }
  browser = await chromium.launch({
    executablePath:
      process.platform === 'win32'
        ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
        : undefined,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /THREE|Shader|WebGL/.test(message.text()))
      errors.push(message.text());
  });
  await page.goto(url + '/foliage-benchmark.html');
  await page.waitForFunction(
    () => typeof window.runFoliageBenchmark === 'function',
  );
  const result = await page.evaluate(
    (options) => window.runFoliageBenchmark(options),
    { count, shadows, fadeDuration, samples: 30 },
  );
  if (errors.length) throw new Error(errors.join('\n'));
  await mkdir('test-results', { recursive: true });
  const path =
    'test-results/foliage-benchmark-' +
    count +
    (shadows ? '-shadows' : '') +
    (fadeDuration ? '-fade-' + fadeDuration : '') +
    '.json';
  await writeFile(path, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ path, ...result }, null, 2));
} finally {
  await browser?.close();
  server?.kill();
}
