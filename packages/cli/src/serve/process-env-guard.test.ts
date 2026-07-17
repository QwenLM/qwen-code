/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

const scannedRoots = [
  path.join(repoRoot, 'packages', 'cli', 'src', 'serve'),
  path.join(repoRoot, 'packages', 'acp-bridge', 'src'),
];

interface ProcessEnvAllowance {
  readonly reason: string;
  readonly accesses: Readonly<Record<string, number>>;
}

function normalizeAllowances(
  entries: ReadonlyArray<readonly [string, ProcessEnvAllowance]>,
): ReadonlyMap<string, ProcessEnvAllowance> {
  return new Map(
    entries.map(([file, allowance]) => [path.normalize(file), allowance]),
  );
}

const allowedProcessEnvAccesses = normalizeAllowances([
  [
    'packages/acp-bridge/src/bridge.ts',
    {
      reason: 'The ACP bridge debug switch is process-scoped.',
      accesses: { 'key:QWEN_SERVE_DEBUG': 1 },
    },
  ],
  [
    'packages/acp-bridge/src/spawnChannel.ts',
    {
      reason:
        'Standalone channel spawning keeps a process-environment compatibility fallback.',
      accesses: { whole: 1 },
    },
  ],
  [
    'packages/cli/src/serve/acp-http-enabled.ts',
    {
      reason:
        'Embedded callers may omit the daemon-level environment argument.',
      accesses: { whole: 1 },
    },
  ],
  [
    'packages/cli/src/serve/acp-http/index.ts',
    {
      reason:
        'Embedded ACP mounts may omit the daemon-level environment argument.',
      accesses: { whole: 1 },
    },
  ],
  [
    'packages/cli/src/serve/channel-worker-supervisor.ts',
    {
      reason:
        'The process-global channel supervisor needs a base environment for child workers.',
      accesses: { whole: 1 },
    },
  ],
  [
    'packages/cli/src/serve/daemon-logger.ts',
    {
      reason: 'Daemon log and runtime locations are process-scoped.',
      accesses: {
        'key:QWEN_DAEMON_LOG_FILE': 1,
        'key:QWEN_RUNTIME_DIR': 1,
      },
    },
  ],
  [
    'packages/cli/src/serve/debug-mode.ts',
    {
      reason: 'Serve debug logging is process-scoped.',
      accesses: { 'key:QWEN_SERVE_DEBUG': 1 },
    },
  ],
  [
    'packages/cli/src/serve/env-snapshot.ts',
    {
      reason:
        'The daemon snapshots its process environment before applying workspace overlays.',
      accesses: { whole: 1 },
    },
  ],
  [
    'packages/cli/src/serve/fast-path-settings.ts',
    {
      reason:
        'Fast-path settings initialize daemon bootstrap compatibility state.',
      accesses: {
        'computed:key': 4,
        'key:CLOUD_SHELL': 1,
        'key:GOOGLE_CLOUD_PROJECT': 2,
        'key:QWEN_CODE_TRUSTED_FOLDERS_PATH': 1,
        'key:QWEN_HOME': 3,
        whole: 4,
      },
    },
  ],
  [
    'packages/cli/src/serve/fast-path.ts',
    {
      reason:
        'The fast-path entry point initializes process-level daemon defaults.',
      accesses: { whole: 2 },
    },
  ],
  [
    'packages/cli/src/serve/fs/audit.ts',
    {
      reason: 'Filesystem audit redaction is a daemon-wide logging policy.',
      accesses: { 'key:QWEN_AUDIT_RAW_PATHS': 1 },
    },
  ],
  [
    'packages/cli/src/serve/run-qwen-serve.ts',
    {
      reason:
        'The serve entry point owns daemon bootstrap, feature flags, and child-process defaults.',
      accesses: {
        'computed:QWEN_SERVER_TOKEN_ENV': 1,
        'computed:QWEN_SERVE_CDP_TUNNEL_OVER_WS_ENV': 1,
        'computed:QWEN_SERVE_CLIENT_MCP_OVER_WS_ENV': 1,
        'computed:QWEN_SERVE_PROMPT_DEADLINE_MS_ENV': 1,
        'computed:QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS_ENV': 1,
        'computed:RUNTIME_STARTUP_TIMEOUT_ENV': 1,
        'key:QWEN_CODE_IDE_WORKSPACE_PATH': 1,
        'key:QWEN_SERVE_NO_MCP_POOL': 1,
        'key:QWEN_SERVE_NO_PERSISTENT_REGISTRATION': 1,
        'key:VITEST_WORKER_ID': 1,
        whole: 5,
      },
    },
  ],
  [
    'packages/cli/src/serve/server/fs-factory.ts',
    {
      reason:
        'Embedded server construction keeps a process-environment compatibility fallback.',
      accesses: { 'computed:IDE_WORKSPACE_PATH_ENV_VAR': 1 },
    },
  ],
  [
    'packages/cli/src/serve/server.ts',
    {
      reason:
        'Embedded server construction keeps a process-environment compatibility fallback.',
      accesses: { whole: 1 },
    },
  ],
  [
    'packages/cli/src/serve/server/serve-features.ts',
    {
      reason:
        'Embedded feature detection defaults to the daemon process environment.',
      accesses: { whole: 1 },
    },
  ],
]);

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listTypeScriptFiles(full).forEach((file) => out.push(file));
    } else if (entry.isFile() && /\.tsx?$/.test(full)) {
      out.push(full);
    }
  }
  return out;
}

function findProcessEnvAccesses(
  file: string,
  source: string,
): Readonly<Record<string, number>> {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const accesses = new Map<string, number>();
  const record = (access: string): void => {
    accesses.set(access, (accesses.get(access) ?? 0) + 1);
  };
  const visit = (node: ts.Node): void => {
    const isProcessEnv =
      (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'process' &&
        node.name.text === 'env') ||
      (ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'process' &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'env');
    if (isProcessEnv) {
      const parent = node.parent;
      if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const argument = parent.argumentExpression;
        record(
          ts.isStringLiteralLike(argument)
            ? `key:${argument.text}`
            : `computed:${argument.getText(sourceFile)}`,
        );
      } else if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node
      ) {
        record(`key:${parent.name.text}`);
      } else {
        record('whole');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.fromEntries(
    [...accesses].sort(([left], [right]) => left.localeCompare(right)),
  );
}

describe('serve process.env guard', () => {
  it('detects dot and element process.env access expressions', () => {
    expect(
      findProcessEnvAccesses(
        'example.ts',
        `
          process.env.DOT;
          process['env']['ELEMENT'];
          process['env'].MIXED;
          const whole = process['env'];
        `,
      ),
    ).toEqual({
      'key:DOT': 1,
      'key:ELEMENT': 1,
      'key:MIXED': 1,
      whole: 1,
    });
  });

  it('detects computed process.env access expressions', () => {
    expect(
      findProcessEnvAccesses(
        'example.ts',
        ['process.env[DYNAMIC_VAR];', 'process.env[`TEMPLATE_${key}`];'].join(
          '\n',
        ),
      ),
    ).toEqual({
      'computed:`TEMPLATE_${key}`': 1,
      'computed:DYNAMIC_VAR': 1,
    });
  });

  it('allows only documented process-scoped process.env expressions', () => {
    const actual = new Map<string, Readonly<Record<string, number>>>();
    for (const root of scannedRoots) {
      for (const file of listTypeScriptFiles(root)) {
        if (/\.(?:test|spec)\.tsx?$/.test(file)) continue;
        const accesses = findProcessEnvAccesses(
          file,
          fs.readFileSync(file, 'utf8'),
        );
        if (Object.keys(accesses).length === 0) continue;
        actual.set(path.normalize(path.relative(repoRoot, file)), accesses);
      }
    }

    const mismatches = [
      ...new Set([...actual.keys(), ...allowedProcessEnvAccesses.keys()]),
    ]
      .sort()
      .flatMap((file) => {
        const found = actual.get(file) ?? {};
        const allowance = allowedProcessEnvAccesses.get(file);
        const expected = allowance?.accesses ?? {};
        const sorted = (accesses: Readonly<Record<string, number>>) =>
          Object.entries(accesses).sort(([left], [right]) =>
            left.localeCompare(right),
          );
        return JSON.stringify(sorted(found)) ===
          JSON.stringify(sorted(expected))
          ? []
          : [
              {
                file,
                found,
                expected,
                reason: allowance?.reason ?? 'No process-scoped exception',
              },
            ];
      });

    expect(
      mismatches,
      'process.env access mismatches — update allowedProcessEnvAccesses with a reason and the new access pattern',
    ).toEqual([]);
  });
});
