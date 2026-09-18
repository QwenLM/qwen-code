import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { shouldExternalizeWebShellDependency } from '../build-boundary';

const runtimePackages = [
  ...Object.keys(pkg.dependencies),
  ...Object.keys(pkg.peerDependencies),
];
const transcriptBundledPackages = new Set(['@modelcontextprotocol/ext-apps']);

describe('web-shell package build boundary', () => {
  it('externalizes every declared runtime package and its JavaScript subpaths', () => {
    for (const packageName of runtimePackages) {
      expect(shouldExternalizeWebShellDependency(packageName)).toBe(true);
      expect(
        shouldExternalizeWebShellDependency(`${packageName}/internal`),
      ).toBe(true);
    }
  });

  it('keeps only the export-budget-sensitive runtime package bundled in the transcript', () => {
    for (const packageName of runtimePackages) {
      const expected = !transcriptBundledPackages.has(packageName);
      expect(
        shouldExternalizeWebShellDependency(packageName, 'transcript'),
      ).toBe(expected);
      expect(
        shouldExternalizeWebShellDependency(
          `${packageName}/internal`,
          'transcript',
        ),
      ).toBe(expected);
    }
  });

  it('keeps stylesheet entrypoints bundled', () => {
    expect(
      shouldExternalizeWebShellDependency('@xterm/xterm/css/xterm.css'),
    ).toBe(false);
    expect(
      shouldExternalizeWebShellDependency(
        '@xterm/xterm/css/xterm.css',
        'transcript',
      ),
    ).toBe(false);
    expect(
      shouldExternalizeWebShellDependency('katex/dist/katex.min.css'),
    ).toBe(false);
    expect(
      shouldExternalizeWebShellDependency(
        'katex/dist/katex.min.css',
        'transcript',
      ),
    ).toBe(false);
  });

  it('does not externalize local or undeclared modules', () => {
    expect(shouldExternalizeWebShellDependency('./client/index')).toBe(false);
    expect(shouldExternalizeWebShellDependency('not-a-web-shell-dependency')).toBe(
      false,
    );
    expect(
      shouldExternalizeWebShellDependency('./client/transcript', 'transcript'),
    ).toBe(false);
  });
});
