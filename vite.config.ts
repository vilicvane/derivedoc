import path from 'node:path';

import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

const root = import.meta.dirname;

export default defineConfig({
  root: path.join(root, 'src/web'),
  plugins: [react()],
  build: {
    outDir: path.join(root, 'bld/web'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Monaco 单独成块：应用代码保持小体积，编辑器与界面并行加载、分别缓存。
        manualChunks: (id: string) => (id.includes('monaco-editor') ? 'monaco' : undefined),
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7788',
      '/ws': {target: 'ws://127.0.0.1:7788', ws: true},
    },
  },
});
