import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/ui',
  plugins: [react()],
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 3001,
    proxy: {
      '/ws': {
        target: 'ws://localhost:4242',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:4242',
      },
    },
  },
});
