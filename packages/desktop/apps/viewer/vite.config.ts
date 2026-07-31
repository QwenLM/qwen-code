import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

function devServerPort(envName: string, fallback: number): number {
  const value = process.env[envName]
  if (!value) return fallback
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: __dirname,
  // Base path for production - assets go to /s/assets/* to avoid conflict with marketing site
  base: '/s/',
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      // Ensure all React imports resolve to the hoisted root node_modules
      'react': resolve(__dirname, '../../node_modules/react'),
      'react-dom': resolve(__dirname, '../../node_modules/react-dom'),
    },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist',
    emptyDirBeforeWrite: true,
    sourcemap: true,
  },
  optimizeDeps: {
    include: ['react', 'react-dom'],
  },
  server: {
    port: devServerPort('CRAFT_VIEWER_PORT', 5174), // Different from Electron dev server
    open: true,
    proxy: {
      // Proxy API requests to production R2 during local dev
      '/s/api': {
        target: 'https://agents.craft.do',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
