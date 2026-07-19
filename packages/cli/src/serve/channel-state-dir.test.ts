import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  getGlobalQwenDir: vi.fn(() => '/qwen-home'),
  hashDaemonWorkspace: vi.fn(
    (workspace: string) => `hash-${workspace.replaceAll('/', '_')}`,
  ),
}));
const cryptoMocks = vi.hoisted(() => ({
  createHash: vi.fn(),
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  cryptoMocks.createHash.mockImplementation(actual.createHash);
  return { ...actual, createHash: cryptoMocks.createHash };
});

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

  it('uses hashed name and type segments under the workspace hash', () => {
    const stateDir = daemonChannelStateDir('/workspace', 'bot', 'qq');
    const typeSegment = path.basename(stateDir);
    const nameSegment = path.basename(path.dirname(stateDir));

    expect(stateDir).toBe(
      path.join(
        '/qwen-home',
        'channels',
        'daemon',
        'hash-_workspace',
        nameSegment,
        typeSegment,
      ),
    );
    expect(nameSegment).toMatch(/^[0-9a-f]{64}$/u);
    expect(typeSegment).toMatch(/^[0-9a-f]{64}$/u);
    expect(nameSegment).not.toBe(typeSegment);
    expect(coreMocks.hashDaemonWorkspace).toHaveBeenCalledWith('/workspace');
  });

  it('is stable for the same exact identifiers', () => {
    expect(daemonChannelStateDir('/a', 'Bot', 'QQ')).toBe(
      daemonChannelStateDir('/a', 'Bot', 'QQ'),
    );
  });

  it.each([
    ['Bot', 'bot'],
    ['é', 'é'],
  ])('keeps channel name aliases %j and %j distinct', (left, right) => {
    const leftNameSegment = path.basename(
      path.dirname(daemonChannelStateDir('/a', left, 'qq')),
    );
    const rightNameSegment = path.basename(
      path.dirname(daemonChannelStateDir('/a', right, 'qq')),
    );

    expect(leftNameSegment).not.toBe(rightNameSegment);
  });

  it.each([
    ['QQ', 'qq'],
    ['é', 'é'],
  ])('keeps channel type aliases %j and %j distinct', (left, right) => {
    const leftTypeSegment = path.basename(
      daemonChannelStateDir('/a', 'bot', left),
    );
    const rightTypeSegment = path.basename(
      daemonChannelStateDir('/a', 'bot', right),
    );

    expect(leftTypeSegment).not.toBe(rightTypeSegment);
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
    '\ud800',
    '\udc00',
  ])('rejects unsafe channel name %j', (channelName) => {
    expect(() => daemonChannelStateDir('/a', channelName, 'qq')).toThrow(
      'Invalid channel name',
    );
    expect(cryptoMocks.createHash).not.toHaveBeenCalled();
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
    '\ud800',
    '\udc00',
  ])('rejects unsafe channel type %j', (channelType) => {
    expect(() => daemonChannelStateDir('/a', 'bot', channelType)).toThrow(
      'Invalid channel type',
    );
    expect(cryptoMocks.createHash).not.toHaveBeenCalled();
  });

  it('accepts a portable component at the 255-byte UTF-8 boundary', () => {
    const component = '界'.repeat(85);

    expect(() =>
      daemonChannelStateDir('/a', component, component),
    ).not.toThrow();
  });

  it('accepts a valid surrogate pair', () => {
    expect(() => daemonChannelStateDir('/a', '😀', '😀')).not.toThrow();
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
