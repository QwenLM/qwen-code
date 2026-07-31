import { afterEach, describe, expect, it } from 'bun:test';

import {
  shouldRunElectronAsNode,
  withElectronRunAsNodeEnv,
} from '../electron-run-as-node.ts';

const originalElectronVersion = process.versions.electron;

function setElectronVersion(value: string | undefined): void {
  if (value === undefined) {
    const versions = process.versions as Partial<NodeJS.ProcessVersions> & {
      electron?: string;
    };
    delete versions.electron;
    return;
  }
  Object.defineProperty(process.versions, 'electron', {
    configurable: true,
    enumerable: true,
    value,
  });
}

describe('electron run-as-node env', () => {
  afterEach(() => {
    setElectronVersion(originalElectronVersion);
  });

  it('enables ELECTRON_RUN_AS_NODE when Electron runs a JavaScript CLI', () => {
    setElectronVersion('39.2.7');

    const env = withElectronRunAsNodeEnv({}, process.execPath, [
      '/app/vendor/qwen-code/cli.js',
      '--acp',
    ]);

    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('does not mark non-Electron node runtimes', () => {
    setElectronVersion(undefined);

    expect(
      shouldRunElectronAsNode(process.execPath, [
        '/app/vendor/qwen-code/cli.js',
        '--acp',
      ]),
    ).toBe(false);
  });

  it('does not mark executable CLI paths', () => {
    setElectronVersion('39.2.7');

    expect(shouldRunElectronAsNode(process.execPath, ['--acp'])).toBe(false);
  });
});
