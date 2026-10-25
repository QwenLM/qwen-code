/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectNpmBunHandoff } from './npm-runtime.js';
import { isInteractiveInvocation } from './interactive-mode.js';
import { NPM_RUNTIME_CONTEXT } from './env-provenance.js';
import { selectTuiRenderer } from '../ui/opentui/renderer-selection.js';

const roots: string[] = [];
const originalVersions = Object.getOwnPropertyDescriptor(process, 'versions')!;
const originalExecPath = process.execPath;
const originalArgv = process.argv;

afterEach(() => {
  process.execPath = originalExecPath;
  process.argv = originalArgv;
  Object.defineProperty(process, 'versions', originalVersions);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function file(path: string, content = '#!/bin/sh\nexit 0\n'): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o755 });
  return path;
}

function fixture({ nested = false, platform = 'darwin', arch = 'arm64' } = {}) {
  const outer = mkdtempSync(join(tmpdir(), 'qwen-npm-runtime-'));
  roots.push(outer);
  const root = join(outer, 'node_modules', '@qwen-code', 'qwen-code');
  const name = `@oven/bun-${platform}-${arch === 'arm64' ? 'aarch64' : 'x64'}`;
  const manifest = {
    name: '@qwen-code/qwen-code',
    bin: { qwen: 'cli-entry.js' },
    optionalDependencies: { [name]: '1.3.14' },
  };
  file(join(root, 'package.json'), JSON.stringify(manifest));
  const script = file(join(root, 'cli.js'));
  file(join(root, 'cli-entry.js'));
  const dependency = join(nested ? root : outer, 'node_modules', name);
  file(
    join(dependency, 'package.json'),
    JSON.stringify({ name, version: '1.3.14' }),
  );
  const bun = file(join(dependency, 'bin', 'bun'));
  const options = {
    interactive: true,
    screenReader: false,
    protocolMode: false,
    sandbox: false,
    env: { QWEN_TUI_RENDERER: 'opentui' },
    versions: { node: '24.19.0' },
    execArgv: [],
    platform,
    arch,
    script,
    glibc: true,
  };
  return { outer, root, script, name, bun, dependency, manifest, options };
}

describe('npm Bun runtime admission', () => {
  it.each([
    ['darwin', 'arm64', false],
    ['darwin', 'x64', true],
    ['linux', 'arm64', true],
    ['linux', 'x64', false],
  ] as const)(
    'uses only the installed %s-%s runtime (nested=%s)',
    (platform, arch, nested) => {
      const f = fixture({ platform, arch, nested });
      const result = selectNpmBunHandoff(f.options);
      expect(result?.interpreter).toEqual({
        command: realpathSync(f.bun),
        runtime: 'bun',
      });
      expect(JSON.parse(result!.childEnv[NPM_RUNTIME_CONTEXT]!)).toEqual({
        node: realpathSync(process.execPath),
        bun: realpathSync(f.bun),
        cli: realpathSync(f.script),
      });
    },
  );

  it.each(['26.4.0', '27.0.0'])(
    'hands Node %s npm OpenTUI to its installed private Bun',
    (node) => {
      const f = fixture();
      const result = selectNpmBunHandoff({
        ...f.options,
        versions: { node },
      });
      expect(result?.interpreter).toEqual({
        command: realpathSync(f.bun),
        runtime: 'bun',
      });
      expect(JSON.parse(result!.childEnv[NPM_RUNTIME_CONTEXT]!)).toEqual({
        node: realpathSync(process.execPath),
        bun: realpathSync(f.bun),
        cli: realpathSync(f.script),
      });
    },
  );

  const unavailableCases: Array<
    [string, Partial<Parameters<typeof selectNpmBunHandoff>[0]>]
  > = [
    ['Windows', { platform: 'win32' }],
    ['unknown architecture', { arch: 'riscv64' }],
    ['musl report', { platform: 'linux', glibc: false }],
    ['musl override', { env: { OPENTUI_LIBC: 'musl' } }],
    ['disabled relaunch', { env: { QWEN_CODE_NO_RELAUNCH: 'true' } }],
    ['Node loader', { execArgv: ['--import', 'loader.js'] }],
    ['Node FFI flag', { execArgv: ['--experimental-ffi'] }],
    ['Node memory flag', { execArgv: ['--max-old-space-size=4096'] }],
    ['NODE_OPTIONS', { env: { NODE_OPTIONS: '--trace-warnings' } }],
    ['BUN_OPTIONS', { env: { BUN_OPTIONS: '--preload ./payload.mjs' } }],
  ];
  it.each([
    ['default renderer', { env: {} }],
    ['Ink', { env: { QWEN_TUI_RENDERER: 'ink' } }],
    ['unknown renderer', { env: { QWEN_TUI_RENDERER: 'other' } }],
    ['headless or pipe', { interactive: false }],
    ['screen reader', { screenReader: true }],
    ['ACP/SDK/IDE or dual-output protocol', { protocolMode: true }],
    ['whole-CLI sandbox', { sandbox: true }],
    ['inside sandbox', { env: { QWEN_TUI_RENDERER: 'opentui', SANDBOX: '1' } }],
    ['already Bun', { versions: { bun: '1.3.14', node: '24.3.0' } }],
  ])('does not hand off %s', (_name, override) => {
    const f = fixture();
    expect(selectNpmBunHandoff({ ...f.options, ...override })).toBeUndefined();
  });

  it.each(unavailableCases)(
    'falls back or fails strict for %s',
    (_name, override) => {
      const f = fixture();
      const options = {
        ...f.options,
        ...override,
        env: { ...f.options.env, ...override.env },
      };
      expect(selectNpmBunHandoff(options)).toBeUndefined();
      expect(() =>
        selectNpmBunHandoff({
          ...options,
          env: { ...options.env, QWEN_TUI_RENDERER_STRICT: 'true' },
        }),
      ).toThrow('OpenTUI npm Bun handoff unavailable');
    },
  );

  for (const node of ['26.4.0', '27.0.0']) {
    it.each(unavailableCases)(
      `keeps Node ${node} out of OpenTUI when handoff is unavailable: %s`,
      (_name, override) => {
        const f = fixture();
        const options = {
          ...f.options,
          ...override,
          versions: { node },
          env: { ...f.options.env, ...override.env },
        };
        expect(selectNpmBunHandoff(options)).toBeUndefined();
        expect(
          selectTuiRenderer('opentui', options.versions, options.env).renderer,
        ).toBe('ink');
        const strictEnv = { ...options.env, QWEN_TUI_RENDERER_STRICT: 'true' };
        expect(() =>
          selectNpmBunHandoff({ ...options, env: strictEnv }),
        ).toThrow('OpenTUI npm Bun handoff unavailable');
        expect(() =>
          selectTuiRenderer('opentui', options.versions, strictEnv),
        ).toThrow('QWEN_TUI_RENDERER_STRICT');
      },
    );
  }

  it.each(['26.4.0', '27.0.0'])(
    'keeps Node %s out of OpenTUI when its private Bun is missing',
    (node) => {
      const f = fixture();
      rmSync(f.dependency, { recursive: true });
      const options = { ...f.options, versions: { node } };
      expect(selectNpmBunHandoff(options)).toBeUndefined();
      expect(
        selectTuiRenderer('opentui', options.versions, options.env).renderer,
      ).toBe('ink');
      const strictEnv = { ...options.env, QWEN_TUI_RENDERER_STRICT: '1' };
      expect(() => selectNpmBunHandoff({ ...options, env: strictEnv })).toThrow(
        'install the published optional dependency',
      );
      expect(() =>
        selectTuiRenderer('opentui', options.versions, strictEnv),
      ).toThrow('QWEN_TUI_RENDERER_STRICT');
    },
  );

  it('does not probe the host report for an ordinary startup', () => {
    const report = vi.spyOn(process.report, 'getReport');
    const f = fixture();
    expect(
      selectNpmBunHandoff({
        ...f.options,
        glibc: undefined,
        platform: 'linux',
        env: {},
      }),
    ).toBeUndefined();
    expect(report).not.toHaveBeenCalled();
  });

  it('accepts expose-gc without forwarding arbitrary Node flags', () => {
    const f = fixture();
    expect(
      selectNpmBunHandoff({ ...f.options, execArgv: ['--expose-gc'] })
        ?.interpreter.runtime,
    ).toBe('bun');
  });

  it.each(['missing', 'wrong version', 'wrong name', 'unpinned'])(
    'rejects an optional runtime that is %s',
    (problem) => {
      const f = fixture();
      if (problem === 'missing') rmSync(f.dependency, { recursive: true });
      if (problem === 'wrong version' || problem === 'wrong name') {
        file(
          join(f.dependency, 'package.json'),
          JSON.stringify({
            name: problem === 'wrong name' ? '@other/bun' : f.name,
            version: problem === 'wrong version' ? '1.4.0' : '1.3.14',
          }),
        );
      }
      if (problem === 'unpinned') {
        file(
          join(f.root, 'package.json'),
          JSON.stringify({
            ...f.manifest,
            optionalDependencies: { [f.name]: '^1.3.14' },
          }),
        );
      }
      expect(selectNpmBunHandoff(f.options)).toBeUndefined();
      expect(() =>
        selectNpmBunHandoff({
          ...f.options,
          env: { ...f.options.env, QWEN_TUI_RENDERER_STRICT: '1' },
        }),
      ).toThrow('install the published optional dependency');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a non-executable private runtime',
    () => {
      const f = fixture();
      chmodSync(f.bun, 0o644);
      expect(selectNpmBunHandoff(f.options)).toBeUndefined();
    },
  );

  it('does not use a dependency found above this installation', () => {
    const f = fixture();
    const nestedRoot = join(
      f.outer,
      'project',
      'node_modules',
      '@qwen-code',
      'qwen-code',
    );
    file(join(nestedRoot, 'package.json'), JSON.stringify(f.manifest));
    const script = file(join(nestedRoot, 'cli.js'));
    expect(selectNpmBunHandoff({ ...f.options, script })).toBeUndefined();
  });

  it('does not turn source or standalone layouts into npm installs', () => {
    const f = fixture();
    for (const suffix of ['dist', 'standalone/lib']) {
      const root = join(f.outer, suffix);
      file(join(root, 'package.json'), JSON.stringify(f.manifest));
      const script = file(join(root, 'cli.js'));
      expect(
        selectNpmBunHandoff({
          ...f.options,
          script,
          env: { ...f.options.env, QWEN_TUI_RENDERER_STRICT: '1' },
        }),
      ).toBeUndefined();
    }
  });
});

describe('npm interpreter identity', () => {
  async function bootBun(context: string, f: ReturnType<typeof fixture>) {
    process.execPath = f.bun;
    process.argv = [f.bun, f.script];
    Object.defineProperty(process, 'versions', {
      value: { ...process.versions, bun: '1.3.14' },
      configurable: true,
    });
    vi.stubEnv(NPM_RUNTIME_CONTEXT, context);
    vi.resetModules();
    return import('./npm-runtime.js');
  }

  it('captures original Node before env changes and keeps application identity intact', async () => {
    const f = fixture();
    const childEnv = selectNpmBunHandoff(f.options)!.childEnv;
    const runtime = await bootBun(childEnv[NPM_RUNTIME_CONTEXT]!, f);
    expect(runtime.getNpmNodePath()).toBe(realpathSync(originalExecPath));
    process.env[NPM_RUNTIME_CONTEXT] = JSON.stringify({
      node: f.bun,
      bun: f.bun,
      cli: f.script,
    });
    expect(runtime.getNpmNodePath()).toBe(realpathSync(originalExecPath));
    expect(process.execPath).toBe(f.bun);
    expect(process.argv[1]).toBe(f.script);
  });

  it('keeps a removed original Node path so npm cannot silently switch to Bun', async () => {
    const f = fixture();
    const removedNode = join(f.outer, 'removed-node');
    const runtime = await bootBun(
      JSON.stringify({
        node: removedNode,
        cli: realpathSync(f.script),
        bun: realpathSync(f.bun),
      }),
      f,
    );
    expect(runtime.getNpmNodePath()).toBe(removedNode);
  });

  it.each(['malformed', 'different CLI', 'different Bun'])(
    'does not accept %s context',
    async (problem) => {
      const f = fixture();
      const context = {
        node: originalExecPath,
        cli:
          problem === 'different CLI'
            ? join(f.outer, 'other.js')
            : realpathSync(f.script),
        bun:
          problem === 'different Bun' ? originalExecPath : realpathSync(f.bun),
      };
      const runtime = await bootBun(
        problem === 'malformed' ? 'invalid' : JSON.stringify(context),
        f,
      );
      expect(runtime.getNpmNodePath()).toBe(f.bun);
    },
  );
});

describe('shared interactive mode', () => {
  it.each([
    [{}, true, true],
    [{}, false, false],
    [{ query: 'hello' }, true, false],
    [{ prompt: 'hello' }, true, false],
    [{ promptInteractive: 'hello' }, true, true],
    [{ prompt: 'hello', promptInteractive: 'continue' }, true, true],
    [{ promptInteractive: '' }, false, false],
  ] as const)(
    'matches configuration for %j / tty=%s',
    (args, tty, expected) => {
      expect(isInteractiveInvocation(args, tty)).toBe(expected);
    },
  );
});
