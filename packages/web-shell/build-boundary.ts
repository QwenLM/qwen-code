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

// `/export html` consumes the transcript bundle and enforces a strict
// renderer-size budget. Externalizing ext-apps makes that downstream build
// pull its MCP/zod graph back into the document renderer and exceed the
// budget. Keep only this dependency bundled for transcript builds; public
// package entries still externalize every declared runtime dependency.
const transcriptBundledPackages = new Set(['@modelcontextprotocol/ext-apps']);

function packageMatches(id: string, packageName: string): boolean {
  return id === packageName || id.startsWith(`${packageName}/`);
}

export function shouldExternalizeWebShellDependency(
  id: string,
  boundary: WebShellBuildBoundary = 'package',
): boolean {
  if (bundledStyleImports.has(id)) {
    return false;
  }

  if (boundary === 'transcript') {
    for (const packageName of transcriptBundledPackages) {
      if (packageMatches(id, packageName)) {
        return false;
      }
    }
  }

  for (const packageName of runtimePackages) {
    if (packageMatches(id, packageName)) {
      return true;
    }
  }

  return false;
}
