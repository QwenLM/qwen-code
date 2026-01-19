import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const testingLibraryRoot = path.dirname(
  require.resolve('@testing-library/react/package.json'),
);
const resolvePeer = (pkg: string) => {
  const resolveFrom = (base: string) => {
    try {
      return require.resolve(`${pkg}/package.json`, { paths: [base] });
    } catch {
      try {
        return require.resolve(pkg, { paths: [base] });
      } catch {
        return null;
      }
    }
  };

  const resolved = resolveFrom(testingLibraryRoot) ?? resolveFrom(__dirname);
  if (!resolved) {
    return path.resolve(__dirname, 'node_modules', pkg);
  }
  return path.dirname(resolved);
};
const reactRoot = resolvePeer('react');
const reactDomRoot = resolvePeer('react-dom');
const reactIsRoot = resolvePeer('react-is');
const schedulerRoot = resolvePeer('scheduler');

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
    environmentOptions: {
      jsdom: {
        url: 'http://localhost',
        pretendToBeVisual: true,
        resources: 'usable',
      },
    },
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
    testTimeout: 10000,
    deps: {
      interopDefault: true,
    },
  },
  resolve: {
    alias: {
      // 保持原有的别名
      vscode: path.resolve(__dirname, 'src/__mocks__/vscode.ts'),
      // 强制统一 React 模块解析（与 testing-library 解析来源保持一致）
      react: reactRoot,
      'react-dom': reactDomRoot,
      'react/jsx-runtime': path.resolve(reactRoot, 'jsx-runtime'),
      'react/jsx-dev-runtime': path.resolve(reactRoot, 'jsx-dev-runtime'),
      'react-dom/client': path.resolve(reactDomRoot, 'client'),
      'react-is': reactIsRoot,
      scheduler: schedulerRoot,
    },
    // 确保这些包都被 dedupe
    dedupe: [
      'react',
      'react-dom',
      'react-is',
      'scheduler',
      '@testing-library/react',
    ],
  },
  define: {
    // 确保 React 环境变量设置正确
    'process.env.NODE_ENV': JSON.stringify('test'),
  },
});
