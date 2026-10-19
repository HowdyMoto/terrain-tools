import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const payloadMiB = Number(
  process.argv.find((arg) => arg.startsWith('--assets='))?.split('=')[1] ?? 48,
);
const url = 'http://127.0.0.1:5175';
let browser, server;
try {
  if (
    !(await fetch(url)
      .then((r) => r.ok)
      .catch(() => false))
  ) {
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
          .then((r) => r.ok)
          .catch(() => false)
      ) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready)
      throw new Error('Build first; the preview server did not start.');
  }
  browser = await chromium.launch({
    executablePath:
      process.platform === 'win32'
        ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
        : undefined,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url + '/persistence-benchmark.html');
  await page.waitForFunction(
    () => typeof window.runPersistenceBenchmark === 'function',
  );
  const result = await page.evaluate(
    (options) => window.runPersistenceBenchmark(options),
    { payloadMiB },
  );
  if (errors.length || !result.matchingPackages)
    throw new Error(errors.join('\n') || 'Package checksums differ.');
  await mkdir('test-results', { recursive: true });
  const path = 'test-results/persistence-benchmark-' + payloadMiB + '.json';
  await writeFile(path, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ path, ...result }, null, 2));
} finally {
  await browser?.close();
  server?.kill();
}
