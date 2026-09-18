import pkg from './package.json' with { type: 'json' };

export type WebShellBuildBoundary = 'package' | 'transcript';

const bundledStyleImports = new Set([
  '@xterm/xterm/css/xterm.css',
  'katex/dist/katex.min.css',
]);

const runtimePackages = new Set([
  ...Object.keys(pkg.dependencies),
  ...Object.keys(pkg.peerDependencies),
]);

// The transcript entry is an input to the versioned /export html renderer.
// Keep its established Rollup boundary exactly: widening the public-package
// externalization rules here makes the downstream document build resolve
// additional dependency source graphs and can break the renderer-size budget
// introduced by #11031. Public package entries still externalize every
// declared runtime dependency and subpath below.
const transcriptExternalExact = new Set([
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'radix-ui',
  'lucide-react',
  'class-variance-authority',
  'clsx',
  'tailwind-merge',
  'vaul',
  '@qwen-code/sdk',
  '@datafe-open/markdown-chart',
  '@datafe-open/markdown-chart-echarts',
  '@datafe-open/markdown-chart-react',
  'echarts',
  'react-markdown',
  'remark-cjk-friendly',
  'remark-gfm',
  'remark-math',
  'rehype-katex',
  'shiki',
  'mermaid',
  'katex',
  'codemirror',
]);

const transcriptExternalPrefixes = [
  '@qwen-code/sdk/',
  'echarts/',
  'remark-cjk-friendly/',
  '@codemirror/',
];

function shouldExternalizeTranscriptDependency(id: string): boolean {
  if (bundledStyleImports.has(id)) {
    return false;
  }

  if (transcriptExternalExact.has(id)) {
    return true;
  }

  if (id.startsWith('katex/')) {
    return id !== 'katex/dist/katex.min.css';
  }

  return transcriptExternalPrefixes.some((prefix) => id.startsWith(prefix));
}

export function shouldExternalizeWebShellDependency(
  id: string,
  boundary: WebShellBuildBoundary = 'package',
): boolean {
  if (boundary === 'transcript') {
    return shouldExternalizeTranscriptDependency(id);
  }

  if (bundledStyleImports.has(id)) {
    return false;
  }

  for (const packageName of runtimePackages) {
    if (id === packageName || id.startsWith(`${packageName}/`)) {
      return true;
    }
  }

  return false;
}