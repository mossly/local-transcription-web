import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true
  },
  preview: {
    port: 27027,
    host: true
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks: {
          'transformers': ['@huggingface/transformers'],
          'react-vendor': ['react', 'react-dom'],
        }
      }
    }
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers']
  }
});