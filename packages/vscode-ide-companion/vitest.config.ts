import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    // 使用 jsdom 环境以支持 DOM 测试（WebView 组件测试需要）
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // 全局测试 setup 文件
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'clover'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/*.d.ts',
        'src/test-setup.ts',
        'src/**/test-utils/**',
      ],
    },
    // 测试超时时间（集成测试可能需要更长时间）
    testTimeout: 10000,
    // 依赖处理配置
    deps: {
      // 确保 vscode 模块可以被正确 mock
      interopDefault: true,
    },
  },
  // resolve 配置，使 vscode 模块能被正确识别为虚拟模块并被 mock
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'src/__mocks__/vscode.ts'),
    },
  },
});
