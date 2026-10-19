import { defineConfig } from '@playwright/test';
import { chromeGPUArgs } from './scripts/chrome-gpu.mjs';
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 60000,
  workers: 1,
  use: {
    // The full Chromium build exposes Vulkan; Linux headless-shell does not
    // provide the same software WebGPU setup. CI supplies an Xvfb display.
    headless: !(process.env.CI && process.platform === 'linux'),
    baseURL: 'http://127.0.0.1:5175',
    viewport: { width: 1440, height: 960 },
    launchOptions: {
      executablePath:
        process.platform === 'win32'
          ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
          : undefined,
      args: [
        '--enable-unsafe-swiftshader',
        ...(process.env.CI && process.platform === 'linux'
          ? [
              '--enable-unsafe-webgpu',
              '--use-webgpu-adapter=swiftshader',
              '--enable-features=Vulkan',
              '--use-angle=vulkan',
              '--disable-vulkan-surface',
              '--ignore-gpu-blocklist',
              '--disable-gpu-driver-bug-workarounds',
              '--disable-gpu-watchdog',
            ]
          : chromeGPUArgs()),
      ],
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
