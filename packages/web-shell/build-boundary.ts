import pkg from './package.json' with { type: 'json' };

const runtimePackages = new Set([
  ...Object.keys(pkg.dependencies),
  ...Object.keys(pkg.peerDependencies),
]);

export function shouldExternalizeWebShellDependency(id: string): boolean {
  // The package publishes JavaScript entrypoints only. Styles imported by the
  // component graph must therefore stay in the library build so the scoped CSS
  // injector can carry them with the consuming entry.
  if (id.endsWith('.css')) {
    return false;
  }

  for (const packageName of runtimePackages) {
    if (id === packageName || id.startsWith(`${packageName}/`)) {
      return true;
    }
  }

  return false;
}
