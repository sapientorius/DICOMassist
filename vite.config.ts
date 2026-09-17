import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { viteCommonjs } from '@originjs/vite-plugin-commonjs';

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    viteCommonjs(),
  ],
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: ['dicom-parser'],
  },
  worker: {
    format: 'es',
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    // Cornerstone's rendering and codec runtime is intentionally loaded as one lazy viewer chunk.
    chunkSizeWarningLimit: 2100,
  },
});
