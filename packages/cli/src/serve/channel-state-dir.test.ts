import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  getGlobalQwenDir: vi.fn(() => '/qwen-home'),
  hashDaemonWorkspace: vi.fn(
    (workspace: string) => `hash-${workspace.replaceAll('/', '_')}`,
  ),
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  hashDaemonWorkspace: coreMocks.hashDaemonWorkspace,
  Storage: { getGlobalQwenDir: coreMocks.getGlobalQwenDir },
}));

import { daemonChannelStateDir } from './channel-state-dir.js';

describe('daemonChannelStateDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('separates same-named channels in different workspaces', () => {
    expect(daemonChannelStateDir('/a', 'bot', 'qq')).not.toBe(
      daemonChannelStateDir('/b', 'bot', 'qq'),
    );
  });

  it('uses the workspace hash, channel name, and type under global Qwen state', () => {
    expect(daemonChannelStateDir('/workspace', 'bot', 'qq')).toBe(
      path.join(
        '/qwen-home',
        'channels',
        'daemon',
        'hash-_workspace',
        'bot',
        'qq',
      ),
    );
    expect(coreMocks.hashDaemonWorkspace).toHaveBeenCalledWith('/workspace');
  });

  it.each([
    '../bot',
    'a/b',
    String.raw`a\b`,
    '',
    '.',
    '..',
    'all',
    'a\0b',
    'evil\nchannel',
    'bad:name',
    'bad*name',
    'bad?name',
    'bad"name',
    'bad<name',
    'bad>name',
    'bad|name',
    'bot.',
    'bot ',
    'CON',
    'con',
    'PrN.txt',
    'AUX.json',
    'nul.log',
    'COM1',
    'com9.txt',
    'LPT1',
    'lpt9.json',
    '界'.repeat(86),
  ])('rejects unsafe channel name %j', (channelName) => {
    expect(() => daemonChannelStateDir('/a', channelName, 'qq')).toThrow(
      'Invalid channel name',
    );
  });

  it.each([
    '../qq',
    'a/b',
    String.raw`a\b`,
    '',
    '.',
    '..',
    'a\0b',
    'qq\n',
    'q'.repeat(256),
    'qq:type',
    'qq*type',
    'qq?type',
    'qq"type',
    'qq<type',
    'qq>type',
    'qq|type',
    'qq.',
    'qq ',
    'CON',
    'prn.auth',
    'Com1.json',
    'LPT9.state',
    '界'.repeat(86),
  ])('rejects unsafe channel type %j', (channelType) => {
    expect(() => daemonChannelStateDir('/a', 'bot', channelType)).toThrow(
      'Invalid channel type',
    );
  });

  it('accepts a portable component at the 255-byte UTF-8 boundary', () => {
    const component = '界'.repeat(85);

    expect(daemonChannelStateDir('/a', component, component)).toBe(
      path.join(
        '/qwen-home',
        'channels',
        'daemon',
        'hash-_a',
        component,
        component,
      ),
    );
  });

  it.each(['COM0', 'COM10', 'LPT0', 'LPT10', 'connection.txt'])(
    'accepts non-device component %j',
    (component) => {
      expect(() =>
        daemonChannelStateDir('/a', component, component),
      ).not.toThrow();
    },
  );
});
