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

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [
          'jotai/babel/plugin-debug-label',
          ['jotai/babel/plugin-react-refresh', { customAtomNames: ['atomFamily'] }],
        ],
      },
    }),
    tailwindcss(),
  ],
  root: resolve(__dirname, 'src'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyDirBeforeWrite: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
        login: resolve(__dirname, 'src/login.html'),
      },
      // Suppress warnings for Node.js externalized modules — these are
      // referenced by shared code but only used in server/Electron codepaths.
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return
        warn(warning)
      },
    },
  },
  resolve: {
    alias: {
      // Reuse the Electron renderer's components, hooks, pages, etc.
      '@': resolve(__dirname, '../electron/src/renderer'),
      // Web-specific overrides
      '@webui': resolve(__dirname, 'src'),
      // Config alias (same as Electron)
      '@config': resolve(__dirname, '../../packages/shared/src/config'),
      // Force single React copy from root node_modules
      'react': resolve(__dirname, '../../node_modules/react'),
      'react-dom': resolve(__dirname, '../../node_modules/react-dom'),
      // Electron-specific modules → empty shims for browser builds
      'electron-log/renderer': resolve(__dirname, 'src/shims/electron-log.ts'),
      'electron-log': resolve(__dirname, 'src/shims/electron-log.ts'),
      '@sentry/electron/renderer': resolve(__dirname, 'src/shims/sentry-electron.ts'),
      '@sentry/electron': resolve(__dirname, 'src/shims/sentry-electron.ts'),
      // Node.js 'ws' library → browser uses native WebSocket
      'ws': resolve(__dirname, 'src/shims/ws.ts'),
      // Node.js builtins → browser-safe shims (shared code imports these
      // but the codepaths aren't reached in browser — web API adapter intercepts)
      // Node.js builtins → browser-safe shims (shared code imports these
      // but the codepaths aren't reached in browser — web API adapter intercepts)
      ...Object.fromEntries([
        'fs', 'node:fs', 'path', 'node:path', 'child_process', 'node:child_process',
        'os', 'node:os', 'node:crypto', 'node:util', 'node:process', 'node:buffer',
        'node:https', 'node:http', 'node:net', 'node:url', 'node:events',
        'crypto', 'https', 'http', 'net', 'events', 'util', 'buffer', 'stream',
        'node:stream', 'tls', 'node:tls', 'url', 'zlib', 'node:zlib',
        'string_decoder', 'node:string_decoder', 'assert', 'node:assert',
      ].map(m => [m, resolve(__dirname, 'src/shims/node-builtins.ts')])),
      // fs/promises and node:fs/promises need a separate shim file to avoid path confusion
      'fs/promises': resolve(__dirname, 'src/shims/fs-promises.ts'),
      'node:fs/promises': resolve(__dirname, 'src/shims/fs-promises.ts'),
      // 'open' npm package (Node.js shell utility) — no-op in browser
      'open': resolve(__dirname, 'src/shims/open.ts'),
    },
    dedupe: ['react', 'react-dom'],
  },
  define: {
    // Flag to detect web UI context in shared code
    'import.meta.env.IS_WEBUI': 'true',
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'jotai'],
    exclude: ['@craft-agent/ui'],
    esbuildOptions: {
      supported: { 'top-level-await': true },
      target: 'esnext',
    },
  },
  server: {
    port: devServerPort('CRAFT_WEBUI_DEV_PORT', 5175),
    open: false,
  },
})
