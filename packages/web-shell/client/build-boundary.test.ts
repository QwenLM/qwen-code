import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { shouldExternalizeWebShellDependency } from '../build-boundary';

describe('web-shell package build boundary', () => {
  it('externalizes every declared runtime package and its JavaScript subpaths', () => {
    const runtimePackages = [
      ...Object.keys(pkg.dependencies),
      ...Object.keys(pkg.peerDependencies),
    ];

    for (const packageName of runtimePackages) {
      expect(shouldExternalizeWebShellDependency(packageName)).toBe(true);
      expect(
        shouldExternalizeWebShellDependency(`${packageName}/internal`),
      ).toBe(true);
    }
  });

  it('keeps stylesheet entrypoints bundled', () => {
    expect(
      shouldExternalizeWebShellDependency('@xterm/xterm/css/xterm.css'),
    ).toBe(false);
    expect(
      shouldExternalizeWebShellDependency('katex/dist/katex.min.css'),
    ).toBe(false);
  });

  it('does not externalize local or undeclared modules', () => {
    expect(shouldExternalizeWebShellDependency('./client/index')).toBe(false);
    expect(shouldExternalizeWebShellDependency('not-a-web-shell-dependency')).toBe(
      false,
    );
  });
});
