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
    'packages/cli/src/serve/workspace-recovery-worker.ts',
    {
      reason:
        'The private offline migration worker pins deployment-owned QWEN_HOME and its retained file-history volume before validating recovery evidence.',
      accesses: { 'key:QWEN_HOME': 2 },
    },
  ],
  [
    'packages/acp-bridge/src/session-control-plane.ts',
    {
      reason: 'The ACP bridge debug switch is process-scoped.',
      accesses: { 'key:QWEN_SERVE_DEBUG': 1 },
    },
  ],
  [
    'packages/acp-bridge/src/process-registry.ts',
    {
      reason:
        'Windows process-tree cleanup resolves the trusted System32 taskkill path from the process-scoped OS root.',
      accesses: { 'key:SystemRoot': 1 },
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
    'packages/acp-bridge/src/workspacePaths.ts',
    {
      reason:
        'Whether the daemon runs inside a container sandbox is process-scoped: ' +
        'the sandbox launcher marks the whole process via the SANDBOX env, and ' +
        'workspace canonicalization uses it to map Windows-shaped host paths ' +
        'to their bind-mount location (#7139).',
      accesses: { 'key:SANDBOX': 1 },
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
    'packages/cli/src/serve/local-path-open.ts',
    {
      reason:
        'Local-open availability probes process-scoped host session state ' +
        '(SSH markers, display server, Windows session name, terminal ' +
        'emulators on PATH), so embedded callers may omit the environment ' +
        'argument; the win32 terminal fallback inherits the daemon ' +
        'environment to hand the target directory to PowerShell via one ' +
        'added variable.',
      accesses: { whole: 4 },
    },
  ],
  [
    'packages/cli/src/serve/managed-context-worker.ts',
    {
      reason:
        'Managed Runtime startup selects its deployment-owned MCP and Hook manifests and the delegated cgroup root for process isolation from the process environment; definitions are then scoped by tenant and workspace.',
      accesses: {
        'key:QWEN_MANAGED_HOOK_CGROUP_ROOT': 1,
        'key:QWEN_MANAGED_HOOK_CONFIG': 1,
        'key:QWEN_MANAGED_MCP_CONFIG': 1,
      },
    },
  ],
  [
    'packages/cli/src/serve/managed-csi-worker.ts',
    {
      reason:
        'The Kubernetes Downward API supplies the current Pod identity to the single-Pod CSI worker process; attestation, drain and ACK routes capture it at registration rather than from workspace environment overlays.',
      accesses: {
        'key:QWEN_NODE_NAME': 3,
        'key:QWEN_POD_NAMESPACE': 3,
        'key:QWEN_POD_UID': 3,
      },
    },
  ],
  [
    'packages/cli/src/serve/managed-hook-runtime.ts',
    {
      reason:
        'Hook commands use the Runtime host PATH and Windows SystemRoot for executable lookup and OS startup, and the deployment-owned cgroup root for process-tree isolation; HOME and USERPROFILE come from the verified Session directory.',
      accesses: {
        'key:PATH': 1,
        'key:QWEN_MANAGED_HOOK_CGROUP_ROOT': 1,
        'key:SystemRoot': 2,
      },
    },
  ],
  [
    'packages/cli/src/serve/managed-mcp-runtime.ts',
    {
      reason:
        'MCP stdio children use the Runtime host PATH and Windows SystemRoot for executable lookup and OS startup; their remaining environment comes from the verified workspace directory and deployment-owned definition.',
      accesses: { 'key:PATH': 1, 'key:SystemRoot': 2 },
    },
  ],
  [
    'packages/cli/src/serve/managed-runtime-attestation-worker.ts',
    {
      reason:
        'The Runtime worker scrubs the loader variables that only started its own process, so the commands it runs do not inherit them.',
      accesses: { whole: 1 },
    },
  ],
  [
    'packages/cli/src/serve/session-agents/adapters/claude-cli.ts',
    {
      reason:
        "A session agent runs the user's own Claude Code CLI as a child process, so it inherits the daemon process environment (with nested-Claude markers scrubbed).",
      accesses: { whole: 1 },
    },
  ],
  [
    'packages/cli/src/serve/session-agents/adapters/codex-app-server.ts',
    {
      reason:
        "A session agent runs the user's own Codex CLI as a child process, so it inherits the daemon process environment (CODEX_HOME, auth).",
      accesses: { whole: 1 },
    },
  ],
  [
    'packages/cli/src/serve/session-agents/program-probe.ts',
    {
      reason:
        'Probing which agent CLIs are installed reads the process PATH and the QWEN_AGENT_*_PATH overrides of the daemon process.',
      accesses: { whole: 2 },
    },
  ],
  [
    'packages/cli/src/serve/session-agents/orchestrator.ts',
    {
      reason:
        'The session_send MCP child re-runs this CLI; its entry point is process-scoped, mirroring managed-runtime-session-worker.',
      accesses: { 'key:QWEN_CLI_ENTRY': 1 },
    },
  ],
  [
    'packages/cli/src/serve/managed-runtime-ledger.ts',
    {
      reason:
        'The worker keeps its Shell process groups in a ledger the host named in the launch environment — read once and scrubbed so its own commands never inherit the path; its process-table queries read a full environment ' +
        'only to force the ps locale, and its Windows stop path resolves taskkill from the process-scoped OS root.',
      accesses: {
        'computed:MANAGED_RUNTIME_LEDGER_ENV': 2,
        'key:SystemRoot': 1,
        whole: 1,
      },
    },
  ],
  [
    'packages/cli/src/serve/managed-runtime-session-worker.ts',
    {
      reason:
        "A Managed session's host starts its Runtime worker from its own CLI entry and process environment, as a Legacy host's commands inherit it.",
      accesses: { 'key:QWEN_CLI_ENTRY': 1, whole: 3 },
    },
  ],
  [
    'packages/cli/src/serve/managed-runtime-tool-executor.ts',
    {
      reason:
        'The background Shell environment copies a fixed allowlist of inherited shell variables (PATH, HOME, locale, TMPDIR, USER, SHELL) from the Runtime worker process, matching what a Legacy host hands its commands; secrets are never copied by name.',
      accesses: { 'computed:key': 1 },
    },
  ],
  [
    'packages/cli/src/serve/native-directory-picker.ts',
    {
      reason:
        'Picker availability probes process-scoped host session state ' +
        '(SSH markers, display server, Windows session name), so embedded ' +
        'callers may omit the environment argument.',
      accesses: { whole: 1 },
    },
  ],
  [
    'packages/cli/src/serve/pem-certificate-blocks.ts',
    {
      reason:
        'The certificate-loader oracle child inherits the daemon process environment so it uses the same OpenSSL configuration as channel workers, while stripping NODE_OPTIONS that can alter eval input or corrupt its protocol.',
      accesses: { whole: 1 },
    },
  ],
  [
    'packages/cli/src/serve/run-qwen-serve.ts',
    {
      reason:
        'The serve entry point owns daemon bootstrap, feature flags, child-process defaults, and the launch-env loader scrub. ' +
        'NODE_EXTRA_CA_CERTS is read from the daemon process environment on purpose: it is the trust store Node itself ' +
        'already loaded for this process, so the worker TLS trust-gap check has to consult the same value to know whether ' +
        "an operator has already supplied the issuing CA. Read once into a local: the check now needs the file's " +
        'contents, not just the path, and a second read could see a different value. The whole-object read copies the ' +
        'daemon environment into the TLS trust probe child. NODE_TLS_REJECT_UNAUTHORIZED is read to skip the ' +
        'worker TLS trust check when it disables verification: workers inherit the variable unscrubbed and dial ' +
        'via fetch, which honors it, so the strict probe would flag an outage that never happens. ' +
        'The Hosted Harness capability digest is a process-scoped contract fixed at daemon bootstrap.',
      accesses: {
        'computed:EXTERNAL_TOOL_GUARD_TOKEN_ENV': 1,
        'computed:HOSTED_HARNESS_CAPABILITY_DIGEST_ENV': 1,
        'computed:QWEN_SERVE_CDP_TUNNEL_OVER_WS_ENV': 1,
        'computed:QWEN_SERVE_CLIENT_MCP_OVER_WS_ENV': 1,
        'computed:QWEN_SERVE_PROMPT_DEADLINE_MS_ENV': 1,
        'computed:QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS_ENV': 1,
        'computed:RUNTIME_STARTUP_TIMEOUT_ENV': 1,
        'key:DEV': 1,
        'key:NODE_EXTRA_CA_CERTS': 1,
        'key:NODE_TLS_REJECT_UNAUTHORIZED': 1,
        'key:QWEN_CODE_IDE_WORKSPACE_PATH': 1,
        'key:QWEN_SERVE_NO_MCP_POOL': 1,
        'key:QWEN_SERVE_NO_PERSISTENT_REGISTRATION': 1,
        'key:VITEST_WORKER_ID': 1,
        whole: 6,
      },
    },
  ],
  [
    'packages/cli/src/serve/serve-token.ts',
    {
      reason:
        'Daemon token selection defaults to the process-scoped QWEN_SERVER_TOKEN; ' +
        'the remote-bind resolver reads the same variable so the generation ' +
        'decision distinguishes an absent source from an explicitly empty one.',
      accesses: { 'computed:QWEN_SERVER_TOKEN_ENV': 2 },
    },
  ],
  [
    'packages/cli/src/serve/session-attachments-root.ts',
    {
      reason:
        'The session-attachment storage root is a process-scoped daemon setting read once at bridge construction.',
      accesses: { 'computed:SESSION_ATTACHMENTS_ROOT_ENV': 1 },
    },
  ],
  [
    'packages/cli/src/serve/sandbox.ts',
    {
      reason:
        'The sandbox launcher assembles the sandboxed child environment: ' +
        'it passes through the process environment, forwards provider keys, ' +
        'proxy settings, and debug switches, and reads the SANDBOX_* control ' +
        'variables. It entered the scanned serve/ layer via the #9146 ' +
        'leaf-layer move.',
      accesses: {
        'computed:envVar': 2,
        'key:BUILD_SANDBOX': 2,
        'key:COLORTERM': 2,
        'key:DEBUG': 5,
        'key:DEBUG_MODE': 1,
        'key:DEBUG_PORT': 2,
        'key:GEMINI_API_KEY': 2,
        'key:GEMINI_MODEL': 2,
        'key:GOOGLE_API_KEY': 2,
        'key:GOOGLE_APPLICATION_CREDENTIALS': 2,
        'key:GOOGLE_CLOUD_LOCATION': 2,
        'key:GOOGLE_CLOUD_PROJECT': 2,
        'key:GOOGLE_GENAI_USE_GCA': 2,
        'key:GOOGLE_GENAI_USE_VERTEXAI': 2,
        'key:HTTP_PROXY': 2,
        'key:HTTPS_PROXY': 2,
        'key:NO_PROXY': 2,
        'key:NODE_ENV': 1,
        'key:NODE_OPTIONS': 1,
        'key:OPENAI_API_KEY': 2,
        'key:OPENAI_BASE_URL': 2,
        'key:OPENAI_MODEL': 2,
        'key:PATH': 2,
        'key:PYTHONPATH': 2,
        'key:QWEN_CODE_INTEGRATION_TEST': 1,
        'key:QWEN_CODE_MCP_APPROVALS_PATH': 2,
        'key:QWEN_CODE_WARNINGS_FILE': 2,
        'key:QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE': 1,
        'key:QWEN_CODE_TEST_VAR': 2,
        'key:QWEN_SANDBOX_PROXY_COMMAND': 2,
        'key:SANDBOX_ENV': 2,
        'key:SANDBOX_FLAGS': 2,
        'key:SANDBOX_MOUNTS': 2,
        'key:SANDBOX_PORTS': 1,
        'key:SANDBOX_SET_UID_GID': 1,
        'key:SEATBELT_PROFILE': 1,
        'key:TERM': 2,
        'key:VIRTUAL_ENV': 1,
        'key:http_proxy': 2,
        'key:https_proxy': 2,
        'key:no_proxy': 2,
        whole: 6,
      },
    },
  ],
  [
    'packages/cli/src/serve/routes/daemon-update.ts',
    {
      reason:
        'The process-global updater snapshots the running daemon launcher and its managed npm installation stamp, not workspace configuration.',
      accesses: {
        'key:QWEN_CODE_CLI': 1,
        'key:QWEN_CODE_MANAGED_NPM_PIN': 1,
      },
    },
  ],
  [
    'packages/cli/src/serve/routes/workspace-extensions-controller.ts',
    {
      reason:
        'A daemon-wide ambient usage-statistics opt-out is a process-scoped ' +
        'operator decision that must close the gate for every hosted ' +
        'workspace; an ambient opt-in belongs to another hosted repository.',
      accesses: { 'key:QWEN_USAGE_STATISTICS_ENABLED': 2 },
    },
  ],
  [
    'packages/cli/src/serve/routes/workspace-git-branches.ts',
    {
      reason:
        "The git error redaction mirrors the daemon process's own HOME/" +
        'XDG_CONFIG_HOME to label the inherited config paths git echoes.',
      accesses: { 'key:HOME': 1, 'key:XDG_CONFIG_HOME': 1 },
    },
  ],
  [
    'packages/cli/src/serve/server/fs-factory.ts',
    {
      reason:
        'Embedded server construction keeps a process-environment compatibility fallback, ' +
        'and the new-file-mode policy parser defaults to the daemon process environment.',
      accesses: { 'computed:IDE_WORKSPACE_PATH_ENV_VAR': 1, whole: 1 },
    },
  ],
  [
    'packages/cli/src/serve/server.ts',
    {
      reason:
        'Embedded server construction keeps a process-environment compatibility fallback. ' +
        'The collaboration opt-in is read once at daemon startup and is process-scoped ' +
        'by design: it governs work no session owns (the dispatch timer and Host ' +
        'transport routes), so it cannot be a per-session setting.',
      accesses: { whole: 1, 'key:QWEN_CODE_ENABLE_AGENT_COLLABORATION': 1 },
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
  [
    'packages/cli/src/serve/server/session-pr-refresh.ts',
    {
      reason:
        'The PR-state refresh interval (QWEN_SESSION_PR_REFRESH_MINUTES) is a ' +
        'process-scoped operator switch; embedded callers may omit the ' +
        'environment argument.',
      accesses: { whole: 1 },
    },
  ],
  [
    'packages/cli/src/serve/live/live-host-coordinator.ts',
    {
      reason: 'Live Host diagnostics are enabled for the whole daemon process.',
      accesses: { 'key:QWEN_LIVE_DIAGNOSTICS': 1 },
    },
  ],
  [
    'packages/cli/src/serve/live/live-session-coordinator.ts',
    {
      reason:
        'Live audio diagnostics are enabled and located for the whole daemon process.',
      accesses: {
        'key:QWEN_LIVE_DIAGNOSTICS': 2,
        'key:QWEN_LIVE_DIAGNOSTICS_DIR': 1,
      },
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
