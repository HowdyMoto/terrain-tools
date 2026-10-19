import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  publicDir: false,
  build: {
    outDir: 'lib',
    lib: {
      entry: {
        core: 'src/index.ts',
        runtime: 'src/runtime/index.ts',
        rapier: 'src/physics/rapier.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: (id) =>
        id === 'three' ||
        id.startsWith('three/') ||
        id.startsWith('@dimforge/rapier3d'),
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
