import { defineConfig } from 'vite';

export default defineConfig({
  root: 'scratch-preview',
  base: './',
  build: {
    target: 'esnext',
    outDir: '../dist-scratch',
    emptyOutDir: true,
  },
});
