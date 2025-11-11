import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'media',
    emptyOutDir: false,
    sourcemap: true,
    target: 'es2019',
    assetsDir: '.',
    rollupOptions: {
      input: resolve(__dirname, 'webview/src/visualizer.ts'),
      output: {
        entryFileNames: 'visualizer.js',
        format: 'iife'
      }
    }
  }
});
