import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync, mkdirSync } from 'fs'

export default defineConfig({
  // Set root to src/ so HTML files resolve relative to it and output flat
  root: resolve(__dirname, 'src'),
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        renderer: resolve(__dirname, 'src/renderer.html'),
        popup: resolve(__dirname, 'src/popup.html'),
        settings: resolve(__dirname, 'src/settings.html'),
        background: resolve(__dirname, 'src/background.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  plugins: [
    {
      name: 'copy-manifest',
      closeBundle() {
        mkdirSync(resolve(__dirname, 'dist/icons'), { recursive: true })
        copyFileSync(
          resolve(__dirname, 'public/manifest.json'),
          resolve(__dirname, 'dist/manifest.json'),
        )
        try { copyFileSync(resolve(__dirname, 'public/icons/16.png'), resolve(__dirname, 'dist/icons/16.png')) } catch {}
        try { copyFileSync(resolve(__dirname, 'public/icons/48.png'), resolve(__dirname, 'dist/icons/48.png')) } catch {}
        try { copyFileSync(resolve(__dirname, 'public/icons/128.png'), resolve(__dirname, 'dist/icons/128.png')) } catch {}
      },
    },
  ],
})
