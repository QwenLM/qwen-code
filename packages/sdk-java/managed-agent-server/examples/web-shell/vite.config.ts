import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const repositoryRoot = resolve(__dirname, '../../../../..');

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@qwen-code/web-shell/daemon-react-sdk': resolve(
        repositoryRoot,
        'packages/web-shell/client/daemon-react-sdk.ts',
      ),
      '@qwen-code/web-shell/transcript': resolve(
        repositoryRoot,
        'packages/web-shell/client/transcript.ts',
      ),
      '@qwen-code/sdk/daemon': resolve(
        repositoryRoot,
        'packages/sdk-typescript/src/daemon/index.ts',
      ),
      '@qwen-code/sdk': resolve(
        repositoryRoot,
        'packages/sdk-typescript/src/index.ts',
      ),
      '@': resolve(repositoryRoot, 'packages/web-shell/client'),
    },
    dedupe: ['react', 'react-dom', '@qwen-code/sdk'],
  },
  define: {
    __WEB_SHELL_VERSION__: JSON.stringify('managed-agent-development'),
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/api/agent/web-shell/v1': {
        target:
          process.env['QWEN_MANAGED_AGENT_JAVA_URL'] ?? 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
});
