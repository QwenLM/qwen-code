/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trustedSystemSettingsDirs } from '../test-utils/trusted-system-settings.js';
import {
  assertExecutionSandboxSupported,
  parseExecutionSandboxSettings,
  readOperatorSandboxSettings,
  selectOperatorExecutionSandbox,
  validateExecutionSandboxSelection,
} from './execution-sandbox-settings.js';
import { createMinimalSettings, loadSettings } from './settings.js';
import { loadServeFastPathSettings } from '../serve/fast-path-settings.js';

// The system settings overrides are only honored for a root-owned file,
// which a non-root test host cannot arrange for its temp fixtures; the
// fixtures stand in for administrator-created system files. Paths the tests
// want the gate to count as existing, where the real check cannot reach them
// (the platform default on a host that has no such file).
const { mockExistingSystemPaths } = vi.hoisted(() => ({
  mockExistingSystemPaths: new Set<string>(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { trustedSystemSettingsLstat, trustedSystemSettingsStat } =
    await import('../test-utils/trusted-system-settings.js');
  return {
    ...actual,
    lstatSync: trustedSystemSettingsLstat(actual.lstatSync.bind(actual)),
    statSync: trustedSystemSettingsStat(actual.statSync.bind(actual)),
    existsSync: (location: fs.PathLike) =>
      mockExistingSystemPaths.has(String(location)) ||
      actual.existsSync(location),
  };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const { trustedSystemSettingsLstat, trustedSystemSettingsStat } =
    await import('../test-utils/trusted-system-settings.js');
  return {
    ...actual,
    lstatSync: trustedSystemSettingsLstat(actual.lstatSync.bind(actual)),
    statSync: trustedSystemSettingsStat(actual.statSync.bind(actual)),
    existsSync: (location: fs.PathLike) =>
      mockExistingSystemPaths.has(String(location)) ||
      actual.existsSync(location),
  };
});

const restricted = { filesystem: 'read-only', network: 'closed' } as const;
const writable = { filesystem: 'workspace-write', network: 'open' } as const;
let fixture: string;
let workspace: string;
let user: string;
let system: string;
let defaults: string;
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ $version: 4, ...(value as object) }));
};
/** The two readers that carry the privacy choice: a normal load and `--bare`. */
const normalAndBareMerged = () => [
  loadSettings(workspace, { skipLoadEnvironment: true }).merged,
  createMinimalSettings().merged,
];
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'public-sandbox-policy-'));
  trustedSystemSettingsDirs.add(fixture);
  workspace = path.join(fixture, 'workspace');
  fs.mkdirSync(workspace);
  user = path.join(fixture, 'global', 'settings.json');
  system = path.join(fixture, 'system', 'settings.json');
  defaults = path.join(fixture, 'system', 'defaults.json');
  vi.stubEnv('QWEN_HOME', path.dirname(user));
  vi.stubEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', system);
  vi.stubEnv('QWEN_CODE_SYSTEM_DEFAULTS_PATH', defaults);
  // Pin the system layers in place: the trust gate rejects an override whose
  // file does not exist, and the operator readers fail loudly for a rejected
  // layer while the platform default is also absent.
  write(system, {});
  write(defaults, {});
  for (const key of [
    'SANDBOX',
    'QWEN_SANDBOX',
    'QWEN_SANDBOX_NET',
    'QWEN_SANDBOX_PROXY_COMMAND',
    'PROXY_COMMAND',
  ])
    vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  trustedSystemSettingsDirs.delete(fixture);
  mockExistingSystemPaths.clear();
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe('operator execution sandbox policy', () => {
  it.each([
    null,
    false,
    [],
    {},
    { ...restricted, backend: ['auto'] },
    { ...restricted, network: '${MODE}' },
    { ...restricted, workspace: '/' },
  ])('rejects invalid policy %j', (value) => {
    expect(() => parseExecutionSandboxSettings(value)).toThrow(
      'tools.executionSandbox',
    );
  });
  it('accepts an explicit Landlock backend for capability validation at startup', () => {
    expect(
      parseExecutionSandboxSettings({
        ...writable,
        backend: 'landlock',
      }),
    ).toEqual({ ...writable, backend: 'landlock' });
  });
  it('requires complete objects even in a higher priority scope', () => {
    expect(() =>
      selectOperatorExecutionSandbox(
        { tools: { executionSandbox: restricted } },
        { tools: { executionSandbox: { network: 'open' } } },
      ),
    ).toThrow();
  });
  it.each([null, false, 'replace', [], { executionSandbox: writable }])(
    'project tools=%j cannot weaken operator policy',
    (tools) => {
      write(user, { tools: { executionSandbox: restricted } });
      write(path.join(workspace, '.qwen', 'settings.json'), { tools });
      expect(
        loadSettings(workspace, {
          skipLoadEnvironment: true,
          workspaceTrusted: true,
        }).merged.tools?.executionSandbox,
      ).toEqual(restricted);
    },
  );
  it('workspace cannot enable the mode', () => {
    write(path.join(workspace, '.qwen', 'settings.json'), {
      tools: { executionSandbox: writable },
    });
    expect(
      loadSettings(workspace, {
        skipLoadEnvironment: true,
        workspaceTrusted: true,
      }).merged.tools?.executionSandbox,
    ).toBeUndefined();
    expect(
      loadServeFastPathSettings(workspace).tools?.executionSandbox,
    ).toBeUndefined();
  });
  it('system replaces the whole user object, including backend', () => {
    write(defaults, { tools: { executionSandbox: writable } });
    write(user, {
      tools: { executionSandbox: { ...writable, backend: 'bwrap' } },
    });
    write(system, { tools: { executionSandbox: restricted } });
    for (const settings of [
      readOperatorSandboxSettings(),
      createMinimalSettings().merged,
      loadSettings(workspace, { skipLoadEnvironment: true }).merged,
      loadServeFastPathSettings(workspace),
    ]) {
      expect(settings.tools?.executionSandbox).toEqual(restricted);
    }
  });
  it('bare mode retains confinement while ignoring ordinary settings', () => {
    write(user, {
      tools: { executionSandbox: restricted, discoveryCommand: 'malicious' },
      hooks: { stop: 'malicious' },
    });
    const minimal = createMinimalSettings().merged;
    expect(minimal.tools?.executionSandbox).toEqual(restricted);
    expect(minimal.tools?.discoveryCommand).toBeUndefined();
    expect(minimal.hooks).toBeUndefined();
  });
  it.each([
    [
      'privacy.usageStatisticsEnabled',
      { privacy: { usageStatisticsEnabled: false } },
    ],
    [
      'a pre-v2 top-level usageStatisticsEnabled',
      { $version: 1, usageStatisticsEnabled: false },
    ],
  ])('bare mode keeps a usage-statistics opt-out from %s', (_shape, value) => {
    write(user, value);
    const minimal = createMinimalSettings().merged;
    expect(minimal.privacy?.usageStatisticsEnabled).toBe(false);
    // Only the privacy choice survives; confinement stays unset.
    expect(minimal.tools?.executionSandbox).toBeUndefined();
  });
  it('bare mode prefers privacy.* over a stale pre-v2 key in the same file', () => {
    write(user, {
      $version: 1,
      privacy: { usageStatisticsEnabled: false },
      usageStatisticsEnabled: true,
    });
    expect(createMinimalSettings().merged.privacy?.usageStatisticsEnabled).toBe(
      false,
    );
  });
  it('bare mode ignores a stray legacy key in a current-version file', () => {
    write(defaults, { privacy: { usageStatisticsEnabled: false } });
    write(user, { usageStatisticsEnabled: true });
    for (const merged of normalAndBareMerged()) {
      // `?? true` is the coercion config.ts applies before sending a beacon.
      expect(merged.privacy?.usageStatisticsEnabled ?? true).toBe(false);
    }
  });
  it.each([0, ''])(
    'bare mode keeps a falsy %j usage-statistics value as an opt-out',
    (value) => {
      write(user, { privacy: { usageStatisticsEnabled: value } });
      for (const merged of normalAndBareMerged()) {
        expect(merged.privacy?.usageStatisticsEnabled ?? true).toBeFalsy();
      }
    },
  );
  it('bare mode resolves usage statistics with normal scope precedence', () => {
    write(defaults, { privacy: { usageStatisticsEnabled: false } });
    write(user, { privacy: { usageStatisticsEnabled: true } });
    write(system, { privacy: { usageStatisticsEnabled: false } });
    for (const merged of normalAndBareMerged()) {
      expect(merged.privacy?.usageStatisticsEnabled).toBe(false);
    }
    write(system, {});
    for (const merged of normalAndBareMerged()) {
      expect(merged.privacy?.usageStatisticsEnabled).toBe(true);
    }
  });
  it('bare mode leaves usage statistics unset when no scope configures it', () => {
    // Pin the system layers to empty files: the trust gate only honors an
    // override whose file exists, so a bare expectation of "no system layer"
    // needs the pinned files in place.
    write(system, {});
    write(defaults, {});
    write(user, { privacy: { usageStatisticsEnabled: 'no' } });
    expect(
      createMinimalSettings().merged.privacy?.usageStatisticsEnabled,
    ).toBeUndefined();
  });
  it('does not migrate or repair project files on the host under confinement', () => {
    write(user, { tools: { executionSandbox: restricted } });
    const project = path.join(workspace, '.qwen', 'settings.json');
    write(project, {});
    fs.writeFileSync(project, '{"tools": {"approvalMode": "yolo"}}');
    const original = fs.readFileSync(project, 'utf8');
    loadSettings(workspace, {
      skipLoadEnvironment: true,
      workspaceTrusted: true,
    });
    expect(fs.readFileSync(project, 'utf8')).toBe(original);
    fs.writeFileSync(project, '{broken');
    expect(() =>
      loadSettings(workspace, { skipLoadEnvironment: true }),
    ).toThrow();
    expect(fs.readFileSync(project, 'utf8')).toBe('{broken');
    expect(fs.existsSync(project + '.corrupted')).toBe(false);
  });
  it('does not resolve policy values from environment', () => {
    vi.stubEnv('POLICY_NETWORK', 'open');
    write(user, {
      tools: {
        executionSandbox: { ...restricted, network: '${POLICY_NETWORK}' },
      },
    });
    expect(() => loadSettings(workspace)).toThrow('literal');
    expect(() => createMinimalSettings()).toThrow('literal');
    expect(() => loadServeFastPathSettings(workspace)).toThrow('literal');
  });
  it.each(['user', 'system', 'defaults'] as const)(
    'uses the fatal configuration contract for malformed %s settings',
    (scope) => {
      const file = { user, system, defaults }[scope]!;
      write(file, {});
      fs.writeFileSync(file, '{broken');
      try {
        readOperatorSandboxSettings();
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toMatchObject({ exitCode: 52 });
        expect(String(error)).toContain(`Repair the JSON object in ${file}`);
      }
      expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    },
  );

  it('does not reset malformed operator settings to an unconfined runtime', () => {
    write(user, {});
    fs.writeFileSync(user, '{"tools":{"executionSandbox":');
    expect(() => loadSettings(workspace)).toThrow(
      'Cannot read operator sandbox policy',
    );
    expect(fs.readFileSync(user, 'utf8')).toBe('{"tools":{"executionSandbox":');
    expect(fs.readFileSync(`${user}.corrupted`, 'utf8')).toBe(
      '{"tools":{"executionSandbox":',
    );
  });
  // The rejection guard checks the real platform default; only a Unix host
  // can prove the ownership facts for the fixtures below.
  const itOnUnix = os.platform() === 'win32' ? it.skip : it;
  const euid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const platformSystemSettingsPath = () =>
    process.platform === 'win32'
      ? 'C:\\ProgramData\\qwen-code\\settings.json'
      : process.platform === 'darwin'
        ? '/Library/Application Support/QwenCode/settings.json'
        : '/etc/qwen-code/settings.json';

  itOnUnix(
    'fails loud when a rejected override is the only available system layer',
    () => {
      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), 'qwen-sandbox-rejected-'),
      );
      const rejected = path.join(outside, 'settings.json');
      write(rejected, { tools: { executionSandbox: restricted } });
      if (euid === 0) fs.chownSync(rejected, 12345, 12345);
      vi.stubEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', rejected);
      try {
        expect(() => readOperatorSandboxSettings()).toThrow(
          'not administrator-controlled',
        );
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  itOnUnix(
    'reads the platform layer instead of failing when it is present',
    () => {
      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), 'qwen-sandbox-rejected-'),
      );
      const rejected = path.join(outside, 'settings.json');
      write(rejected, { tools: { executionSandbox: restricted } });
      if (euid === 0) fs.chownSync(rejected, 12345, 12345);
      mockExistingSystemPaths.add(platformSystemSettingsPath());
      vi.stubEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', rejected);
      try {
        const read = () => readOperatorSandboxSettings();
        expect(read).not.toThrow();
        // The rejected override is not honored; the present platform file is
        // the system layer instead (an empty stand-in here).
        expect(read().tools?.executionSandbox).toBeUndefined();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );
  it.each([
    ['system defaults', () => defaults],
    ['user', () => user],
    ['system', () => system],
  ])('accepts UTF-8 BOM in %s settings', (_scope, getFile) => {
    const file = getFile();
    const content = `\uFEFF${JSON.stringify({
      $version: 4,
      tools: { executionSandbox: restricted },
    })}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    for (const settings of [
      readOperatorSandboxSettings(),
      createMinimalSettings().merged,
      loadSettings(workspace, { skipLoadEnvironment: true }).merged,
      loadServeFastPathSettings(workspace),
    ]) {
      expect(settings.tools?.executionSandbox).toEqual(restricted);
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect(fs.existsSync(`${file}.corrupted`)).toBe(false);
  });
  it('fails closed when truncation removes the policy key', () => {
    const truncated =
      '{"$version":4,"general":{"previewFeatures":true},"tools":{';
    fs.mkdirSync(path.dirname(user), { recursive: true });
    fs.writeFileSync(user, truncated);
    const loaders: Array<[() => unknown, RegExp]> = [
      [readOperatorSandboxSettings, /Cannot read operator sandbox policy/],
      [() => createMinimalSettings(), /Cannot read operator sandbox policy/],
      [
        () => loadSettings(workspace, { skipLoadEnvironment: true }),
        /Cannot read operator sandbox policy/,
      ],
      [
        () => loadServeFastPathSettings(workspace),
        /Cannot read operator sandbox policy/,
      ],
    ];
    for (const [load, error] of loaders) {
      expect(load).toThrow(error);
    }
    expect(fs.readFileSync(user, 'utf8')).toBe(truncated);
    expect(fs.readFileSync(`${user}.corrupted`, 'utf8')).toBe(truncated);
  });
  it.each([
    ['system defaults', () => defaults],
    ['system', () => system],
  ])('fails closed on malformed %s settings', (_scope, getFile) => {
    const file = getFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken');
    expect(() => readOperatorSandboxSettings()).toThrow(
      'Cannot read operator sandbox policy',
    );
    expect(() => loadServeFastPathSettings(workspace)).toThrow(
      'Cannot read operator sandbox policy',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    expect(fs.existsSync(`${file}.corrupted`)).toBe(false);
  });
  it.each([undefined, false])(
    'ignores a workspace legacy sandbox when operator selects %j',
    (operatorSandbox) => {
      write(user, {
        tools: { executionSandbox: restricted, sandbox: operatorSandbox },
      });
      write(path.join(workspace, '.qwen', 'settings.json'), {
        tools: { sandbox: 'docker' },
      });
      const settings = loadSettings(workspace, {
        skipLoadEnvironment: true,
        workspaceTrusted: true,
      }).merged;
      expect(settings.tools?.sandbox).toBe(operatorSandbox);
      expect(validateExecutionSandboxSelection(settings)).toEqual(restricted);
    },
  );
  it.each(['SANDBOX', 'QWEN_SANDBOX'])(
    'rejects legacy %s=bwrap before entry',
    (key) => {
      vi.stubEnv(key, 'bwrap');
      expect(() => validateExecutionSandboxSelection({})).toThrow(
        'Whole-CLI bwrap has been removed',
      );
    },
  );
  it('rejects the legacy user setting even in bare mode', () => {
    write(user, { tools: { sandbox: 'bwrap' } });
    expect(() =>
      validateExecutionSandboxSelection(createMinimalSettings().merged),
    ).toThrow('tools.executionSandbox');
  });
  it.each(['SANDBOX', 'QWEN_SANDBOX_NET', 'QWEN_SANDBOX_PROXY_COMMAND'])(
    'rejects a mixed boundary through %s',
    (key) => {
      vi.stubEnv(key, 'fixture');
      expect(() =>
        validateExecutionSandboxSelection({
          tools: { executionSandbox: restricted },
        }),
      ).toThrow('cannot be combined');
    },
  );
  it.each(['SANDBOX', 'QWEN_SANDBOX_NET', 'QWEN_SANDBOX_PROXY_COMMAND'])(
    'ignores an empty legacy %s export',
    (key) => {
      vi.stubEnv(key, '   ');
      expect(
        validateExecutionSandboxSelection({
          tools: { executionSandbox: restricted },
        }),
      ).toEqual(restricted);
    },
  );
  it('does not treat unrelated PROXY_COMMAND as sandbox selection', () => {
    vi.stubEnv('PROXY_COMMAND', '/workspace/proxy');
    expect(
      validateExecutionSandboxSelection({
        tools: { executionSandbox: restricted },
      }),
    ).toEqual(restricted);
  });
  it('rejects unsupported frontends with the actual policy', () => {
    expect(() =>
      assertExecutionSandboxSupported(
        { tools: { executionSandbox: restricted } },
        'serve',
      ),
    ).toThrow('does not yet support serve');
    expect(() => assertExecutionSandboxSupported({}, 'serve')).not.toThrow();
  });
});
