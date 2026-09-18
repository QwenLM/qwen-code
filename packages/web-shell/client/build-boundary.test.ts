import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { shouldExternalizeWebShellDependency } from '../build-boundary';

const transcriptBundledPackages = [
  '@modelcontextprotocol/ext-apps',
  '@tanstack/react-table',
  '@tanstack/react-virtual',
  '@xterm/addon-fit',
  '@xterm/xterm',
  'fzf',
];

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

  it('preserves the transcript bundle boundary used by document export', () => {
    for (const packageName of transcriptBundledPackages) {
      expect(
        shouldExternalizeWebShellDependency(packageName, 'transcript'),
      ).toBe(false);
      expect(shouldExternalizeWebShellDependency(packageName)).toBe(true);
    }

    expect(
      shouldExternalizeWebShellDependency('lucide-react', 'transcript'),
    ).toBe(true);
    expect(
      shouldExternalizeWebShellDependency(
        'lucide-react/internal',
        'transcript',
      ),
    ).toBe(false);

    expect(
      shouldExternalizeWebShellDependency('react/jsx-runtime', 'transcript'),
    ).toBe(true);
    expect(
      shouldExternalizeWebShellDependency('@qwen-code/sdk/browser', 'transcript'),
    ).toBe(true);
    expect(
      shouldExternalizeWebShellDependency('echarts/core', 'transcript'),
    ).toBe(true);
    expect(
      shouldExternalizeWebShellDependency(
        'remark-cjk-friendly/internal',
        'transcript',
      ),
    ).toBe(true);
    expect(
      shouldExternalizeWebShellDependency('@codemirror/view/internal', 'transcript'),
    ).toBe(true);
    expect(
      shouldExternalizeWebShellDependency('katex/dist/katex.js', 'transcript'),
    ).toBe(true);
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