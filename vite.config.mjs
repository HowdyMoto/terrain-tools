import { defineConfig } from 'vite';
export default defineConfig({
  // Playwright downloads can be locked on Windows; generated QA artifacts are
  // not application inputs and must not terminate the development file watcher.
  server: { watch: { ignored: ['**/.qa/**', '**/test-results/**'] } },
  test: { include: ['tests/**/*.test.ts'] },
  optimizeDeps: { noDiscovery: true, include: [] },
  build: {
    rollupOptions: {
      input: {
        editor: 'index.html',
        runtime: 'runtime.html',
        foliageBenchmark: 'foliage-benchmark.html',
        persistenceBenchmark: 'persistence-benchmark.html',
      },
      output: { manualChunks: { three: ['three'] } },
    },
  },
});
