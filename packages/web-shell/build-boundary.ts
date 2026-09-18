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
// These packages were intentionally bundled by its existing Rollup boundary;
// externalizing them makes the downstream document build resolve their full
// source graphs again and breaks the renderer-size budget introduced by #11031.
// Keep that specialized boundary while the public package entries externalize
// every declared runtime dependency.
const transcriptBundledPackages = new Set([
  '@modelcontextprotocol/ext-apps',
  '@tanstack/react-table',
  '@tanstack/react-virtual',
  '@xterm/addon-fit',
  '@xterm/xterm',
  'fzf',
]);

export function shouldExternalizeWebShellDependency(
  id: string,
  boundary: WebShellBuildBoundary = 'package',
): boolean {
  if (bundledStyleImports.has(id)) {
    return false;
  }

  for (const packageName of runtimePackages) {
    if (id === packageName || id.startsWith(`${packageName}/`)) {
      if (
        boundary === 'transcript' &&
        transcriptBundledPackages.has(packageName)
      ) {
        return false;
      }
      return true;
    }
  }

  return false;
}