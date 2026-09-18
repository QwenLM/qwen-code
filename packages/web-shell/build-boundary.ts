import pkg from './package.json' with { type: 'json' };

const bundledStyleImports = new Set([
  '@xterm/xterm/css/xterm.css',
  'katex/dist/katex.min.css',
]);

const runtimePackages = new Set([
  ...Object.keys(pkg.dependencies),
  ...Object.keys(pkg.peerDependencies),
]);

export function shouldExternalizeWebShellDependency(id: string): boolean {
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
