/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { JsInterpreterCommand } from '@qwen-code/qwen-code-core/utils/runtime-info.js';
import { NPM_RUNTIME_CONTEXT } from './env-provenance.js';
import {
  OPEN_TUI_RENDERER_VALUE,
  TUI_RENDERER_ENV_VAR,
  TUI_RENDERER_STRICT_ENV_VAR,
} from './tui-runtime.js';

const BUN_PACKAGES: Readonly<Record<string, string>> = {
  'darwin-arm64': '@oven/bun-darwin-aarch64',
  'darwin-x64': '@oven/bun-darwin-x64',
  'linux-arm64': '@oven/bun-linux-aarch64',
  'linux-x64': '@oven/bun-linux-x64',
};

function executableFile(file: string): string {
  const realPath = realpathSync(file);
  if (!statSync(realPath).isFile())
    throw new Error('Expected an executable file');
  accessSync(realPath, constants.X_OK);
  return realPath;
}

function npmPackageRoot(script: string): string {
  const root = dirname(realpathSync(script));
  const manifest = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ) as {
    name?: unknown;
    bin?: { qwen?: unknown };
  };
  if (
    basename(script) !== 'cli.js' ||
    manifest.name !== '@qwen-code/qwen-code' ||
    manifest.bin?.qwen !== 'cli-entry.js' ||
    basename(dirname(root)) !== '@qwen-code' ||
    basename(dirname(dirname(root))) !== 'node_modules'
  ) {
    throw new Error('The running CLI is not a published npm installation');
  }
  return root;
}

function npmNodeAtBoot(): string {
  if (!process.versions['bun']) return process.execPath;
  try {
    const context: unknown = JSON.parse(process.env[NPM_RUNTIME_CONTEXT] ?? '');
    if (!context || typeof context !== 'object') return process.execPath;
    const entry = context as Record<string, unknown>;
    if (
      typeof entry['node'] !== 'string' ||
      typeof entry['bun'] !== 'string' ||
      typeof entry['cli'] !== 'string' ||
      !isAbsolute(entry['node']) ||
      entry['cli'] !== realpathSync(process.argv[1]!) ||
      entry['bun'] !== realpathSync(process.execPath)
    ) {
      return process.execPath;
    }
    npmPackageRoot(entry['cli']);
    // The parent validated this executable. If it is later removed, npm must
    // fail at that Node path rather than silently executing through private Bun.
    return entry['node'];
  } catch {
    return process.execPath;
  }
}

// Capture before project settings/env can replace the launcher's private context.
const npmNodePath = npmNodeAtBoot();

export function getNpmNodePath(): string {
  return npmNodePath;
}

export interface NpmBunHandoff {
  interpreter: JsInterpreterCommand;
  childEnv: Readonly<Record<string, string>>;
}

export function selectNpmBunHandoff({
  interactive,
  screenReader,
  protocolMode,
  sandbox,
  env = process.env,
  script = process.argv[1],
  platform = process.platform,
  arch = process.arch,
  versions = process.versions,
  execArgv = process.execArgv,
  glibc,
}: {
  interactive: boolean;
  screenReader: boolean;
  protocolMode: boolean;
  sandbox: boolean;
  env?: NodeJS.ProcessEnv;
  script?: string;
  platform?: string;
  arch?: string;
  versions?: { bun?: string; node?: string };
  execArgv?: readonly string[];
  glibc?: boolean;
}): NpmBunHandoff | undefined {
  if (
    env[TUI_RENDERER_ENV_VAR]?.trim().toLowerCase() !==
      OPEN_TUI_RENDERER_VALUE ||
    !interactive ||
    screenReader ||
    protocolMode ||
    sandbox ||
    env['SANDBOX'] ||
    versions.bun
  ) {
    return undefined;
  }
  const unavailable = (reason: string): undefined => {
    if (
      ['1', 'true'].includes(
        env[TUI_RENDERER_STRICT_ENV_VAR]?.trim().toLowerCase() ?? '',
      )
    ) {
      throw new Error(`OpenTUI npm Bun handoff unavailable: ${reason}`);
    }
    return undefined;
  };
  const name = BUN_PACKAGES[`${platform}-${arch}`];
  const supportedLibc =
    platform !== 'linux' ||
    (glibc ??
      Boolean(
        (
          process.report?.getReport() as {
            header?: { glibcVersionRuntime?: string };
          }
        )?.header?.glibcVersionRuntime,
      ));
  if (!name || !supportedLibc || env['OPENTUI_LIBC'] === 'musl') {
    return unavailable('only macOS and glibc Linux arm64/x64 are supported');
  }
  if (env['QWEN_CODE_NO_RELAUNCH']) {
    return unavailable('QWEN_CODE_NO_RELAUNCH disables runtime handoff');
  }
  if (
    execArgv.some((arg) => arg !== '--expose-gc') ||
    env['NODE_OPTIONS']?.trim() ||
    env['BUN_OPTIONS']?.trim()
  ) {
    return unavailable('inherited runtime flags prevent Bun handoff');
  }
  if (!script) return undefined;
  let root: string;
  try {
    root = npmPackageRoot(script);
  } catch {
    // Source and standalone installations keep their existing runtime policy.
    return undefined;
  }
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as {
      optionalDependencies?: Record<string, string>;
    };
    const version = manifest.optionalDependencies?.[name];
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`no exact optional dependency pin for ${name}`);
    }
    const dependencyManifest = createRequire(
      join(root, 'package.json'),
    ).resolve(`${name}/package.json`);
    const dependencyRoot = dirname(realpathSync(dependencyManifest));
    const installed = JSON.parse(readFileSync(dependencyManifest, 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    const ownedDependency = [
      join(root, 'node_modules', name),
      join(dirname(dirname(root)), name),
    ].some((candidate) => {
      try {
        return realpathSync(candidate) === dependencyRoot;
      } catch {
        return false;
      }
    });
    if (
      installed.name !== name ||
      installed.version !== version ||
      !ownedDependency
    ) {
      throw new Error(
        `${name} does not match this installation's pinned runtime`,
      );
    }
    const command = executableFile(join(dependencyRoot, 'bin', 'bun'));
    return {
      interpreter: { command, runtime: 'bun' },
      childEnv: {
        [NPM_RUNTIME_CONTEXT]: JSON.stringify({
          node: executableFile(process.execPath),
          bun: command,
          cli: realpathSync(script),
        }),
      },
    };
  } catch (error) {
    return unavailable(
      `install the published optional dependency ${name}; ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
