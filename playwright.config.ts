import { defineConfig } from '@playwright/test';
import { chromeGPUArgs } from './scripts/chrome-gpu.mjs';
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5175',
    viewport: { width: 1440, height: 960 },
    launchOptions: {
      executablePath:
        process.platform === 'win32'
          ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
          : undefined,
      args: ['--enable-unsafe-swiftshader', ...chromeGPUArgs()],
    },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      'node node_modules/vite/bin/vite.js preview --configLoader native --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: !process.env.CI,
  },
});
