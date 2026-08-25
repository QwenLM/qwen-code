/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
import type { ServeChannelSelection } from '../serve/types.js';
import type { RunHandle } from '../serve/run-qwen-serve.js';
import { normalizeServeChannelSelection } from '../serve/channel-selection.js';
// Type-only imports — no runtime cost. The serve module pulls in express +
// body-parser + qs + the daemon transport stack; static-importing it from
// here would tax every `qwen` invocation (interactive, mcp, channel, etc.)
// with ~50ms of cold ESM resolution. The runtime import is deferred to the
// handler below so it only loads when the user actually runs `qwen serve`.
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import { DEFAULT_RING_SIZE } from '@qwen-code/acp-bridge/eventBus';
import {
  DEFAULT_COMPACTED_REPLAY_MAX_BYTES,
  DEFAULT_MAX_JOURNAL_BYTES,
  DEFAULT_MAX_JOURNAL_EVENTS,
  JOURNAL_GROWTH_HARD_CAP_BYTES,
} from '@qwen-code/acp-bridge/replayWindowLimits';
import { EXTERNAL_TOOL_GUARD_TOKEN_ENV } from '@qwen-code/acp-bridge/externalToolGuard';
import type { ChildHeapMode } from '@qwen-code/acp-bridge/childHeapPolicy';
import {
  isValidMemoryBudgetMb,
  JOURNAL_GROWTH_POOL_FRACTION,
  MAX_JOURNAL_GROWTH_POOL_MB,
  memoryBudgetRangeError,
  MIN_MEMORY_BUDGET_MB,
} from '@qwen-code/acp-bridge/daemonMemoryBudget';
import {
  ApprovalMode,
  MCP_BUDGET_WARN_FRACTION,
  MEMORY_PROJECT_SCOPES,
  openBrowserSecurely,
  parsePositiveIntegerEnv,
  shouldLaunchBrowser,
  type MemoryProjectScope,
} from '@qwen-code/qwen-code-core';
import { loadSettings } from '../config/settings.js';
import { HEADLESS_YOLO_NO_SANDBOX_WARNING } from '../utils/headlessSafetyWarnings.js';

/**
 * Pause the current async function indefinitely. Used after the daemon
 * listener is up so yargs `parse()` never resolves — if it did, the
 * top-level CLI would fall through to the interactive (TUI) entry point
 * in `gemini.tsx`. SIGINT / SIGTERM in `runQwenServe` is the sole exit
 * route.
 */
function blockForever(): Promise<never> {
  return new Promise<never>(() => {});
}

const DEFAULT_SERVE_HOSTNAME = '127.0.0.1';

/**
 * Turn Local Control on through the daemon and print the pairing QR.
 *
 * The flag no longer implements Local Control — it calls the same service the
 * Web Shell and the desktop menu item drive. It is a caller now, not a second
 * implementation, which is why `--local-control` composes with `--token` and
 * `--allow-origin`: the LAN listener gets its own credential and origin.
 */
async function startLocalControl(
  handle: RunHandle,
  address: string | undefined,
): Promise<void> {
  await handle.runtimeReady;
  if (!handle.webShellMounted) {
    throw new Error('Local Control requires the Web Shell.');
  }
  const service = handle.getLocalControl();
  if (!service) {
    throw new Error('Local Control is unavailable on this daemon.');
  }
  let status;
  try {
    status = await service.enable(address ? { address } : {});
  } catch (err) {
    // The service reports ambiguity to its caller rather than picking for
    // them; in a terminal the way to answer is a flag, which only this caller
    // knows about.
    if (
      err instanceof Error &&
      (err as { code?: string }).code === 'ambiguous_lan_interface'
    ) {
      throw new Error(`${err.message}. Pass --local-control-address <ip>.`);
    }
    throw err;
  }
  if (!status.url) {
    throw new Error('Local Control did not return a pairing URL.');
  }
  const { default: qrcode } = (await import('qrcode-terminal')) as {
    default: typeof import('qrcode-terminal');
  };
  qrcode.setErrorLevel('Q');
  writeStdoutLine(
    '\nLocal Control is on. Scan this QR code from the same network:',
  );
  writeStdoutLine(`\n${status.interfaceName}: ${status.url}`);
  qrcode.generate(status.url, { small: true }, (code) => {
    writeStdoutLine(code.trimEnd());
  });
  writeStdoutLine(
    '\nKeep this terminal open. ' +
      (status.sleepInhibited
        ? 'Sleep is inhibited while this session is active. '
        : 'Sleep inhibition is unavailable here, so the host may sleep. ') +
      (status.encrypted
        ? 'Traffic is encrypted.'
        : 'Traffic is unencrypted — use it only on a network you trust.') +
      ' Turn Local Control off from the Web Shell Settings card, or press ' +
      'Ctrl+C to exit the daemon.',
  );
}

/**
 * Open the Web Shell in a browser once the daemon is listening. Extracted from
 * the `serve` handler so it is unit-testable. Best-effort:
 *  - gated on `--open` and the UI actually being mounted
 *    (`webShellMounted`); bare `--open` remains a no-op when
 *    `shouldLaunchBrowser()` is false, while `--open-with-auth` prints a
 *    manual URL instead;
 *  - wildcard bind hosts (`0.0.0.0` / `[::]`) are rewritten to loopback so the
 *    URL is client-addressable;
 *  - the token rides in the URL fragment (`#token=`), which is never sent to
 *    the server, and the daemon's already-resolved (trimmed) token is used so
 *    it matches what the server authenticates against;
 *  - any launch failure is logged, never thrown, so it can't take down the
 *    already-listening daemon.
 *
 * Exported for tests.
 */
export async function maybeOpenWebShellBrowser(
  handle: {
    url: string;
    webShellMounted: boolean;
    resolvedToken?: string;
    runtimeReady?: Promise<void>;
  },
  open: boolean,
  manualFallbackWhenIneligible = false,
): Promise<void> {
  if (!open || !handle.webShellMounted) return;
  const shouldLaunch = shouldLaunchBrowser();
  if (!shouldLaunch && !manualFallbackWhenIneligible) return;
  try {
    await handle.runtimeReady;
  } catch (runtimeErr) {
    writeStderrLine(
      `qwen serve: Web Shell runtime not ready; skipping --open: ${
        runtimeErr instanceof Error ? runtimeErr.message : String(runtimeErr)
      }`,
    );
    return;
  }
  let target: URL | undefined;
  try {
    target = new URL(handle.url);
    // Node's URL returns the IPv6 wildcard as `[::]` (bracketed), never `::`.
    if (target.hostname === '0.0.0.0' || target.hostname === '[::]') {
      target.hostname = '127.0.0.1';
    }
    if (handle.resolvedToken) {
      target.hash = `token=${encodeURIComponent(handle.resolvedToken)}`;
    }
    if (!shouldLaunch) {
      writeStderrLine(
        'Browser launch is not available in this environment. ' +
          `Please open this URL manually: ${target.toString()}`,
      );
      return;
    }
    if (handle.resolvedToken) {
      writeStderrLine(
        'qwen serve: --open passes the token in the browser launch command ' +
          '(visible via `ps` / /proc); on a multi-user host open the URL manually instead.',
      );
    }
    await openBrowserSecurely(target.toString());
  } catch (browserErr) {
    const manualUrl =
      manualFallbackWhenIneligible && target
        ? `. Please open this URL manually: ${target.toString()}`
        : '';
    writeStderrLine(
      `qwen serve: failed to open browser: ${browserErr instanceof Error ? browserErr.message : String(browserErr)}${manualUrl}`,
    );
  }
}

interface ServeArgs {
  port: number;
  hostname: string;
  token?: string;
  'max-sessions': number;
  'max-total-sessions'?: number;
  'max-pending-prompts-per-session': number;
  'max-connections': number;
  'event-ring-size': number;
  'compacted-replay-max-bytes': number;
  'max-journal-events'?: number;
  'max-journal-bytes'?: number;
  workspace?: string | string[];
  'memory-project-scope'?: MemoryProjectScope;
  'require-auth': boolean;
  'enable-session-shell': boolean;
  'tls-cert'?: string;
  'tls-key'?: string;
  web: boolean;
  open: boolean;
  'open-with-auth': boolean;
  'local-control': boolean;
  'local-control-address'?: string;
  // Read from the kebab-case key only — the camelCase mirror that yargs
  // synthesizes is convenient for handlers but type-confusing here. The
  // handler reads `argv['http-bridge']` directly.
  'http-bridge': boolean;
  'mcp-client-budget'?: number;
  'memory-budget-mb'?: number;
  'memory-pressure-mode'?: 'off' | 'observe';
  'child-heap-mode'?: ChildHeapMode;
  'mcp-budget-mode'?: 'enforce' | 'warn' | 'off';
  'allow-origin'?: string[];
  'allow-private-auth-base-url': boolean;
  'prompt-deadline-ms'?: number;
  'writer-idle-timeout-ms'?: number;
  'channel-idle-timeout-ms'?: number;
  'initialize-timeout-ms'?: number;
  'session-restore-timeout-ms'?: number;
  'session-reap-interval-ms'?: number;
  'session-idle-timeout-ms'?: number;
  'permission-response-timeout-ms'?: number;
  'external-tool-guard-mode': 'off' | 'required';
  'external-tool-guard-endpoint'?: string;
  'external-tool-guard-timeout-ms'?: number;
  'rate-limit'?: boolean;
  'rate-limit-prompt'?: number;
  'rate-limit-mutation'?: number;
  'rate-limit-read'?: number;
  'rate-limit-window-ms'?: number;
  experimentalLsp?: boolean;
  restoreAskUserQuestion?: boolean;
  channel?: string[];
}

function primaryWorkspaceArg(
  workspace: string | string[] | undefined,
): string | undefined {
  return Array.isArray(workspace) ? workspace[0] : workspace;
}

export const serveCommand: CommandModule<unknown, ServeArgs> = {
  command: 'serve',
  describe:
    'Run Qwen Code as a local HTTP daemon (Stage 1 experimental: --http-bridge)',
  builder: (yargs: Argv) =>
    yargs
      .option('port', {
        type: 'number',
        default: 4170,
        description:
          'TCP port to bind (use 0 for an OS-assigned ephemeral port)',
      })
      .option('hostname', {
        type: 'string',
        default: DEFAULT_SERVE_HOSTNAME,
        description:
          'Interface to bind. Loopback (127.0.0.1, localhost, ::1, [::1]) is auth-free; anything else requires a token.',
      })
      .option('token', {
        type: 'string',
        description:
          'Bearer token required on every request. Falls back to the QWEN_SERVER_TOKEN env var.',
      })
      .option('max-sessions', {
        type: 'number',
        default: 32,
        description:
          'Cap on concurrent live sessions. New spawn requests beyond this return 503; ' +
          'attach to existing sessions still works. Set to 0 to disable.',
      })
      .option('max-total-sessions', {
        type: 'number',
        description:
          'Non-negative integer cap on concurrent live sessions across all ' +
          'workspace runtimes. Set to 0 to disable.',
      })
      .option('max-pending-prompts-per-session', {
        type: 'number',
        default: 5,
        description:
          'Per-session cap on accepted prompts waiting or running. ' +
          'New prompts beyond this return 503. Set to 0 to disable.',
      })
      .option('workspace', {
        type: 'string',
        array: true,
        requiresArg: true,
        description:
          'Absolute workspace path to register with this daemon. ' +
          'POST /session requests with a mismatched cwd return 400 workspace_mismatch. ' +
          'Defaults to process.cwd() when omitted. ' +
          'Repeat to register isolated workspace runtimes; the first is primary.',
      })
      .option('memory-project-scope', {
        type: 'string',
        choices: MEMORY_PROJECT_SCOPES,
        description:
          'Choose how project memory is partitioned. ' +
          'Defaults to "workspace" so each daemon workspace stays isolated; "git-root" preserves the legacy shared scope. ' +
          'Overrides QWEN_CODE_MEMORY_PROJECT_SCOPE when provided.',
      })
      .option('max-connections', {
        type: 'number',
        default: 256,
        description:
          'Listener-level TCP connection cap (server.maxConnections). Bounds raw ' +
          'sockets — slow/phantom SSE clients get rejected at accept time once full. ' +
          'Set to 0 to disable.',
      })
      .option('require-auth', {
        type: 'boolean',
        default: false,
        description:
          'Refuse to start without a bearer token, even on loopback. ' +
          'Hardens the loopback developer default for shared dev hosts / CI ' +
          'runners / multi-tenant workstations where any local user can hit ' +
          '127.0.0.1. Requires --token or QWEN_SERVER_TOKEN. /health also ' +
          'requires Authorization when enabled (no loopback exemption — ' +
          'k8s/Compose probes must pass the bearer too).',
      })
      .option('enable-session-shell', {
        type: 'boolean',
        default: false,
        description:
          'Enable direct POST /session/:id/shell execution. Requires a bearer token and a session-bound client id on each call.',
      })
      .option('tls-cert', {
        type: 'string',
        description:
          'Path to a PEM certificate file. Serve over HTTPS instead of HTTP. ' +
          'Required for secure-context browser APIs (voice input/getUserMedia, ' +
          'WebRTC) when accessed over a LAN IP. Must be used together with ' +
          '--tls-key. Generate a local cert with mkcert.',
      })
      .option('tls-key', {
        type: 'string',
        description:
          'Path to a PEM private key file. Must be used together with --tls-cert.',
      })
      .option('experimental-lsp', {
        type: 'boolean',
        default: false,
        description:
          'Forward the experimental LSP opt-in to spawned agent sessions.',
      })
      .option('restore-ask-user-question', {
        type: 'boolean',
        default: false,
        description:
          'On session load/resume, re-hang a trailing unanswered ask_user_question instead of synthesizing a failed tool result.',
      })
      .option('channel', {
        type: 'string',
        array: true,
        description:
          'Experimental: start a daemon-managed channel worker for the named channel. Repeat to select multiple channels, or use --channel all.',
      })
      .option('web', {
        type: 'boolean',
        default: true,
        description:
          'Serve the Web Shell UI at the daemon root path. Use --no-web for an API-only daemon.',
      })
      .option('open', {
        type: 'boolean',
        default: false,
        description:
          'Open the Web Shell in a browser once the daemon is listening. With a token configured, the launch URL (token included) is handed to the browser launcher and is visible in the process list, so prefer opening the URL manually on multi-user hosts. No-op with --no-web, when the UI assets are absent, or in headless/CI/SSH environments.',
      })
      .option('open-with-auth', {
        type: 'boolean',
        default: false,
        description:
          'Open the Web Shell with bearer authentication on loopback. Reuse --token or QWEN_SERVER_TOKEN, or generate a temporary 256-bit token and deliver it in the URL fragment. In headless environments, print the fragment URL for manual opening.',
      })
      .option('local-control', {
        type: 'boolean',
        default: false,
        description:
          'Share the Web Shell on the local IPv4 network with its own revocable pairing token, terminal QR code, and best-effort sleep inhibition. Ctrl+C turns it off by ending the whole daemon; the Web Shell Settings card turns it off while the daemon keeps running.',
      })
      .option('local-control-address', {
        type: 'string',
        description:
          'Which local IPv4 address to share when the host is on more than one network. Only needed if --local-control reports an ambiguous choice.',
      })
      .check((argv) => {
        // A wildcard or LAN primary bind already owns the port Local Control
        // needs on its selected address. Token and Origin settings remain
        // independent because the second listener owns those.
        if (argv['local-control'] === true && argv['web'] === false) {
          throw new Error('Local Control requires the Web Shell.');
        }
        if (
          argv['local-control'] === true &&
          argv.hostname !== DEFAULT_SERVE_HOSTNAME
        ) {
          throw new Error(
            `Local Control requires --hostname ${DEFAULT_SERVE_HOSTNAME}.`,
          );
        }
        if (
          argv['local-control'] !== true &&
          argv['local-control-address'] !== undefined
        ) {
          throw new Error('--local-control-address requires --local-control.');
        }
        if (argv['local-control-address'] === '') {
          throw new Error('--local-control-address must not be empty.');
        }
        return true;
      })
      .option('event-ring-size', {
        type: 'number',
        // Single source of truth — `DEFAULT_RING_SIZE` is also what
        // the bridge falls back to when the
        // option is undefined. Importing here keeps a future bump in
        // one place rather than drifting between CLI and bus.
        default: DEFAULT_RING_SIZE,
        description:
          'Per-session SSE replay ring depth. Sets the ' +
          'replay backlog available to `GET /session/:id/events` reconnects ' +
          'that send a `Last-Event-ID: N` header. Larger = more reconnect ' +
          'headroom at the cost of a few hundred KB extra RAM per session. ' +
          'Must be a positive finite integer.',
      })
      .option('compacted-replay-max-bytes', {
        type: 'number',
        default: DEFAULT_COMPACTED_REPLAY_MAX_BYTES,
        description:
          'Per-session in-memory compacted replay snapshot byte cap for ' +
          '`POST /session/:id/load` late attaches. Larger = more recent ' +
          'history in load snapshots at higher heap cost. Must be a positive ' +
          'safe integer no larger than 256 MiB.',
      })
      .option('max-journal-events', {
        type: 'number',
        nargs: 1,
        description:
          'Per-session baseline cap on replay entries retained in the ' +
          'in-flight live journal (current unfinished turn). Compatible ' +
          'text/thought chunks share bounded entries. When exceeded, the ' +
          'daemon first tries adaptive growth (see --max-journal-bytes); ' +
          'without granted headroom the oldest entries are dropped. Pinning ' +
          'this flag (or --max-journal-bytes) disables adaptive growth. ' +
          'Defaults to ' +
          DEFAULT_MAX_JOURNAL_EVENTS +
          ' when unset. Must be a positive safe integer.',
      })
      .option('max-journal-bytes', {
        type: 'number',
        nargs: 1,
        description:
          'Per-session baseline source-event byte cap on the in-flight live ' +
          'journal. When a turn outgrows it, adaptive growth raises the ' +
          "session's caps (per-session hard cap " +
          JOURNAL_GROWTH_HARD_CAP_BYTES / (1024 * 1024) +
          ' MiB) within a growth ' +
          'pool derived from the daemon memory budget (see ' +
          '--memory-budget-mb); without granted headroom the oldest entries ' +
          'are dropped whole (at least one is always kept), so the retained ' +
          'tail can be much smaller than the cap. Pinning this flag (or ' +
          '--max-journal-events) disables adaptive growth. Defaults to ' +
          DEFAULT_MAX_JOURNAL_BYTES +
          ' bytes when unset. Must be a positive safe integer.',
      })
      .option('http-bridge', {
        type: 'boolean',
        default: true,
        description:
          'HTTP bridge mode: attempt to preheat one primary `qwen --acp` child; trusted ' +
          'secondaries start one on demand. Stage 2 native in-process mode is ' +
          'not yet implemented; this flag will become opt-in then.',
      })
      .option('memory-budget-mb', {
        type: 'number',
        description:
          'Total memory budget in MB for the daemon process tree. When unset, ' +
          'derived as 50% of cgroup-constrained ' +
          'or host memory, and capped at the resolved available memory either ' +
          'way. It does not change how any `qwen --acp` child is sized; the ' +
          'one consumer today is adaptive live-journal growth: one ' +
          'daemon-wide pool of ' +
          JOURNAL_GROWTH_POOL_FRACTION * 100 +
          '% of the effective budget (capped at ' +
          MAX_JOURNAL_GROWTH_POOL_MB +
          ' MB; 0, growth disabled, when the effective budget falls below ' +
          'the ' +
          MIN_MEMORY_BUDGET_MB +
          ' MB minimum; see --max-journal-bytes). Reported under ' +
          '`limits.memory` in daemon status, alongside a modeled per-child ' +
          'partition under `limits.memory.childHeap`. Must be an integer in ' +
          '[1024, 1048576].',
      })
      .option('memory-pressure-mode', {
        choices: ['off', 'observe'] as const,
        default: 'observe' as const,
        description:
          'Whether the daemon derives a memory-pressure level from its own ' +
          'RSS and V8 heap. `observe` (default) reports the level in daemon ' +
          'status and raises a status issue when it leaves normal. `off` ' +
          'still reports the underlying figures but raises no issue, so the ' +
          'overall status rollup is unchanged — use it while calibrating, or ' +
          'if you alert on the top-level status. Nothing remediates in ' +
          'either mode.',
      })
      .option('child-heap-mode', {
        choices: ['off', 'observe'] as const,
        default: 'observe' as const,
        description:
          'Whether the daemon models a per-child heap partition of the ' +
          'memory budget. `observe` (default) reports the partition it would ' +
          'apply — `limits.memory.childHeap.perChildCeilingMb` and ' +
          '`maxConcurrentChildren` — and counts spawns that would have ' +
          'exceeded it. Nothing is applied: no child is sized from the ' +
          'budget and no spawn is refused. `off` models nothing. Note a ' +
          'refusal count of 0 does NOT mean the partition would be safe to ' +
          'apply; children still run on the much larger host-derived ' +
          'ceiling, so a workload needing more old space than the modeled ' +
          'ceiling looks healthy here.',
      })
      .option('mcp-client-budget', {
        type: 'number',
        description:
          'Cap on live MCP clients spawned inside the ACP child for the bound ' +
          'workspace. Positive integer. Combine with ' +
          '--mcp-budget-mode to control behavior at the cap. When unset, ' +
          'mode defaults to off (no accounting-driven enforcement, but ' +
          'GET /workspace/mcp still reports `clientCount`). Distinct from ' +
          'claude-code MCP_SERVER_CONNECTION_BATCH_SIZE which gates startup ' +
          'concurrency, not the total client count.',
      })
      .option('mcp-budget-mode', {
        choices: ['enforce', 'warn', 'off'] as const,
        description:
          'How --mcp-client-budget is enforced. ' +
          '`warn` (default when budget set): no refusal, snapshot surfaces ' +
          'warning at >=75% of budget. `enforce`: connects past the cap are ' +
          'refused (`disabledReason: "budget"`, deterministic by mcpServers ' +
          'declaration order). `off`: pure observability. Boot rejects ' +
          '`enforce` without a budget.',
      })
      .option('allow-origin', {
        type: 'string',
        array: true,
        description: 'Cross-origin allowlist for browser webui clients.',
      })
      .option('allow-private-auth-base-url', {
        type: 'boolean',
        default: false,
        description:
          'Allow /workspace/auth/provider to install localhost/private-network baseUrl values. ' +
          'Use only for local development with trusted clients.',
      })
      .option('prompt-deadline-ms', {
        type: 'number',
        description:
          'Server-side wallclock cap on POST /session/:id/prompt (ms). ' +
          'Falls back to QWEN_SERVE_PROMPT_DEADLINE_MS. Positive integer.',
      })
      .option('writer-idle-timeout-ms', {
        type: 'number',
        description:
          'Per-SSE-connection idle deadline (ms). ' +
          'Falls back to QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS. Positive integer.',
      })
      .option('channel-idle-timeout-ms', {
        type: 'number',
        description:
          'Milliseconds to keep ACP child alive after last session closes. ' +
          '0 or unset = immediate kill (default).',
      })
      .option('initialize-timeout-ms', {
        type: 'number',
        description:
          'ACP child request timeout, including the initialize handshake (ms). ' +
          'Default: 10000 (10 s).',
      })
      .option('session-restore-timeout-ms', {
        type: 'number',
        description:
          'ACP session load/resume timeout (ms). Default: 60000. An explicit ' +
          '--initialize-timeout-ms can raise (but never lower) this default.',
      })
      .option('session-reap-interval-ms', {
        type: 'number',
        description:
          'Session reaper scan interval (ms). 0 = disabled. Default: 60000.',
      })
      .option('session-idle-timeout-ms', {
        type: 'number',
        description:
          'Idle timeout before a disconnected session is reaped (ms). ' +
          '0 = disabled. Default: 1800000 (30 min).',
      })
      .option('permission-response-timeout-ms', {
        type: 'number',
        description:
          'Wall-clock timeout for a human permission / ask_user_question ' +
          'response in daemon (ACP) mode (ms). ' +
          '0 or unset = disabled (wait indefinitely). Default: 0.',
      })
      .option('external-tool-guard-mode', {
        choices: ['off', 'required'] as const,
        default: 'off' as const,
        description:
          'Managed ACP pre-execution policy mode. Default off preserves current CLI and daemon behavior. Required fails startup unless a compatible loopback provider is available.',
      })
      .option('external-tool-guard-endpoint', {
        type: 'string',
        description:
          'Origin-only loopback HTTP(S) endpoint for required external tool guarding, for example http://127.0.0.1:8787.',
      })
      .option('external-tool-guard-timeout-ms', {
        type: 'number',
        description:
          'Per-handshake/prepare external tool guard timeout in milliseconds. Default: 3000.',
      })
      .option('rate-limit', {
        type: 'boolean',
        description:
          'Enable per-tier HTTP rate limiting. Tiers: prompt (10/min), ' +
          'mutation (30/min), read (120/min). Health, heartbeat, SSE, ' +
          'and /acp are exempt.',
      })
      .option('rate-limit-prompt', {
        type: 'number',
        description:
          'Max prompt requests per window per client (default 10). ' +
          'Requires --rate-limit.',
      })
      .option('rate-limit-mutation', {
        type: 'number',
        description:
          'Max mutation requests per window per client (default 30). ' +
          'Requires --rate-limit.',
      })
      .option('rate-limit-read', {
        type: 'number',
        description:
          'Max read requests per window per client (default 120). ' +
          'Requires --rate-limit.',
      })
      .option('rate-limit-window-ms', {
        type: 'number',
        description:
          'Rate limit window duration in ms (default 60000). ' +
          'Requires --rate-limit.',
      }) as unknown as Argv<ServeArgs>,
  handler: async (argv) => {
    if (!argv['http-bridge']) {
      writeStderrLine(
        'qwen serve: --no-http-bridge (native mode) is not yet implemented; ' +
          'falling back to http-bridge.',
      );
    }
    if (argv.token) {
      // `--token` is visible to any local user via `/proc/<pid>/cmdline`
      // (Linux default; only suppressed under `hidepid=2`). Steer
      // operators toward the env-var path which uses
      // `/proc/<pid>/environ` (owner-only).
      writeStderrLine(
        'qwen serve: --token is visible in the process command line; ' +
          'prefer the QWEN_SERVER_TOKEN env var for any non-trivial ' +
          'deployment.',
      );
    }
    let channelSelection: ServeChannelSelection | undefined;
    try {
      channelSelection = normalizeServeChannelSelection(argv.channel);
    } catch (err) {
      writeStderrLine(
        `qwen serve: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    // Validate budget + mode combination at boot, before we
    // lazy-load the serve module. Yargs already constrains `choices`
    // for mcp-budget-mode, so we only have to police the budget value
    // and the `enforce` ⇒ budget invariant.
    const mcpClientBudget = argv['mcp-client-budget'];
    const mcpBudgetMode = argv['mcp-budget-mode'];
    if (mcpClientBudget !== undefined) {
      if (
        !Number.isFinite(mcpClientBudget) ||
        !Number.isInteger(mcpClientBudget) ||
        mcpClientBudget <= 0
      ) {
        writeStderrLine(
          'qwen serve: --mcp-client-budget must be a positive integer.',
        );
        process.exit(1);
      }
    }
    if (mcpBudgetMode === 'enforce' && mcpClientBudget === undefined) {
      writeStderrLine(
        'qwen serve: --mcp-budget-mode=enforce requires --mcp-client-budget=N.',
      );
      process.exit(1);
    }
    const resolvedMcpMode: 'enforce' | 'warn' | 'off' =
      mcpBudgetMode ?? (mcpClientBudget !== undefined ? 'warn' : 'off');
    const memoryBudgetMb = argv['memory-budget-mb'];
    if (
      memoryBudgetMb !== undefined &&
      !isValidMemoryBudgetMb(memoryBudgetMb)
    ) {
      writeStderrLine(memoryBudgetRangeError());
      process.exit(1);
    }
    const maxPendingPromptsPerSession = argv['max-pending-prompts-per-session'];
    if (
      maxPendingPromptsPerSession !== Number.POSITIVE_INFINITY &&
      (!Number.isFinite(maxPendingPromptsPerSession) ||
        !Number.isInteger(maxPendingPromptsPerSession) ||
        maxPendingPromptsPerSession < 0)
    ) {
      writeStderrLine(
        'qwen serve: --max-pending-prompts-per-session must be a non-negative integer (0 / Infinity = unlimited).',
      );
      process.exit(1);
    }
    if (mcpClientBudget !== undefined) {
      // Mirror the `--require-auth` breadcrumb: surface the active
      // policy in stderr (journald / docker logs) so operators don't
      // have to parse /capabilities or /workspace/mcp to confirm it.
      writeStderrLine(
        `qwen serve: --mcp-client-budget=${mcpClientBudget} mode=${resolvedMcpMode}` +
          (resolvedMcpMode === 'enforce'
            ? ' (servers past the cap will be refused at discovery)'
            : resolvedMcpMode === 'warn'
              ? ` (warnings at >=${Math.ceil(mcpClientBudget * MCP_BUDGET_WARN_FRACTION)}, no refusal)`
              : ''),
      );
    }

    // Emit the headless-YOLO safety warning at daemon startup if
    // settings.json statically configures yolo + no sandbox. We can't
    // use `getHeadlessYoloSafetyWarning(config)` here because the daemon
    // hasn't constructed a `Config` yet — sessions get their own — so
    // we re-derive the predicate from the same settings.json the
    // sessions will load. Per-session override (the ACP client flipping
    // approval mode mid-session) is out of scope here; this warns about
    // a deployment that's wide-open at boot. Suppress with
    // QWEN_CODE_SUPPRESS_YOLO_WARNING=1.
    try {
      const loaded = loadSettings(
        primaryWorkspaceArg(argv.workspace) ?? process.cwd(),
      );
      const merged = loaded.merged;
      const approvalMode = merged.tools?.approvalMode;
      const sandbox = merged.tools?.sandbox;
      const sandboxEnv = process.env['SANDBOX'];
      const suppress = process.env['QWEN_CODE_SUPPRESS_YOLO_WARNING'];
      const suppressed = suppress === '1' || suppress === 'true';
      if (
        approvalMode === ApprovalMode.YOLO &&
        !sandbox &&
        !sandboxEnv &&
        !suppressed
      ) {
        writeStderrLine(HEADLESS_YOLO_NO_SANDBOX_WARNING);
      }
    } catch {
      // Settings load can fail (corrupt JSON, etc.); don't block
      // daemon startup just to emit a warning — the existing settings
      // path will report the same error to the user via Session.
    }

    // Rate limit resolution: --rate-limit / --no-rate-limit override env var.
    // With no default, argv['rate-limit'] is undefined when neither flag is passed.
    const rateLimit =
      argv['rate-limit'] ??
      (process.env['QWEN_SERVE_RATE_LIMIT'] === '1' ||
        process.env['QWEN_SERVE_RATE_LIMIT'] === 'true');
    let rateLimitPrompt: number | undefined;
    let rateLimitMutation: number | undefined;
    let rateLimitRead: number | undefined;
    let rateLimitWindowMs: number | undefined;
    if (rateLimit) {
      const envInt = (key: string): number | undefined => {
        const raw = process.env[key];
        if (raw === undefined || raw === '') return undefined;
        return parsePositiveIntegerEnv(raw, Number.NaN);
      };
      rateLimitPrompt =
        argv['rate-limit-prompt'] ?? envInt('QWEN_SERVE_RATE_LIMIT_PROMPT');
      rateLimitMutation =
        argv['rate-limit-mutation'] ?? envInt('QWEN_SERVE_RATE_LIMIT_MUTATION');
      rateLimitRead =
        argv['rate-limit-read'] ?? envInt('QWEN_SERVE_RATE_LIMIT_READ');
      rateLimitWindowMs =
        argv['rate-limit-window-ms'] ??
        envInt('QWEN_SERVE_RATE_LIMIT_WINDOW_MS');

      for (const [name, value] of [
        ['--rate-limit-prompt', rateLimitPrompt],
        ['--rate-limit-mutation', rateLimitMutation],
        ['--rate-limit-read', rateLimitRead],
      ] as const) {
        if (
          value !== undefined &&
          (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)
        ) {
          writeStderrLine(`qwen serve: ${name} must be a positive integer.`);
          process.exit(1);
        }
      }
      if (
        rateLimitWindowMs !== undefined &&
        (!Number.isFinite(rateLimitWindowMs) ||
          !Number.isInteger(rateLimitWindowMs) ||
          rateLimitWindowMs < 1000)
      ) {
        writeStderrLine(
          'qwen serve: --rate-limit-window-ms must be an integer >= 1000.',
        );
        process.exit(1);
      }
    }

    const externalToolGuardToken =
      process.env[EXTERNAL_TOOL_GUARD_TOKEN_ENV] ?? '';
    delete process.env[EXTERNAL_TOOL_GUARD_TOKEN_ENV];
    const openWithAuth = argv['open-with-auth'];
    const open = argv.open || openWithAuth;

    // Lazy-load the slim serve runner so the yargs fallback path does not pull
    // the public serve barrel, which also exports REST/ACP runtime modules.
    const { runQwenServe } = await import('../serve/run-qwen-serve.js');
    try {
      const serveOptions = {
        port: argv.port,
        hostname: argv.hostname,
        token: argv.token,
        mode: 'http-bridge',
        maxSessions: argv['max-sessions'],
        ...(argv['max-total-sessions'] !== undefined
          ? { maxTotalSessions: argv['max-total-sessions'] }
          : {}),
        maxPendingPromptsPerSession,
        maxConnections: argv['max-connections'],
        eventRingSize: argv['event-ring-size'],
        compactedReplayMaxBytes: argv['compacted-replay-max-bytes'],
        ...(argv['max-journal-events'] !== undefined
          ? { maxJournalEvents: argv['max-journal-events'] }
          : {}),
        ...(argv['max-journal-bytes'] !== undefined
          ? { maxJournalBytes: argv['max-journal-bytes'] }
          : {}),
        workspace: argv.workspace,
        ...(argv['memory-project-scope'] !== undefined
          ? { memoryProjectScope: argv['memory-project-scope'] }
          : {}),
        requireAuth: argv['require-auth'],
        enableSessionShell: argv['enable-session-shell'],
        serveWebShell: argv.web,
        ...(argv['tls-cert'] !== undefined
          ? { tlsCert: argv['tls-cert'] }
          : {}),
        ...(argv['tls-key'] !== undefined ? { tlsKey: argv['tls-key'] } : {}),
        allowPrivateAuthBaseUrl: argv['allow-private-auth-base-url'],
        mcpClientBudget,
        mcpBudgetMode: resolvedMcpMode,
        ...(memoryBudgetMb !== undefined ? { memoryBudgetMb } : {}),
        memoryPressureMode: argv['memory-pressure-mode'],
        childHeapMode: argv['child-heap-mode'],
        // No Local Control special case: the service registers and removes the
        // LAN origin itself while a session is live.
        ...(argv['allow-origin'] && argv['allow-origin'].length > 0
          ? { allowOrigins: argv['allow-origin'] }
          : {}),
        ...(argv['prompt-deadline-ms'] !== undefined
          ? { promptDeadlineMs: argv['prompt-deadline-ms'] }
          : {}),
        ...(argv['writer-idle-timeout-ms'] !== undefined
          ? { writerIdleTimeoutMs: argv['writer-idle-timeout-ms'] }
          : {}),
        ...(argv['channel-idle-timeout-ms'] !== undefined
          ? { channelIdleTimeoutMs: argv['channel-idle-timeout-ms'] }
          : {}),
        ...(argv['initialize-timeout-ms'] !== undefined
          ? { initializeTimeoutMs: argv['initialize-timeout-ms'] }
          : {}),
        ...(argv['session-restore-timeout-ms'] !== undefined
          ? {
              sessionRestoreTimeoutMs: argv['session-restore-timeout-ms'],
            }
          : {}),
        ...(argv['session-reap-interval-ms'] !== undefined
          ? { sessionReapIntervalMs: argv['session-reap-interval-ms'] }
          : {}),
        ...(argv['session-idle-timeout-ms'] !== undefined
          ? { sessionIdleTimeoutMs: argv['session-idle-timeout-ms'] }
          : {}),
        ...(argv['permission-response-timeout-ms'] !== undefined
          ? {
              permissionResponseTimeoutMs:
                argv['permission-response-timeout-ms'],
            }
          : {}),
        ...(argv['external-tool-guard-mode'] === 'required'
          ? {
              externalToolGuard: {
                mode: 'required' as const,
                endpoint: argv['external-tool-guard-endpoint'] ?? '',
                token: externalToolGuardToken,
                ...(argv['external-tool-guard-timeout-ms'] !== undefined
                  ? {
                      timeoutMs: argv['external-tool-guard-timeout-ms'],
                    }
                  : {}),
              },
            }
          : {}),
        ...(rateLimit ? { rateLimit: true } : {}),
        ...(rateLimitPrompt !== undefined ? { rateLimitPrompt } : {}),
        ...(rateLimitMutation !== undefined ? { rateLimitMutation } : {}),
        ...(rateLimitRead !== undefined ? { rateLimitRead } : {}),
        ...(rateLimitWindowMs !== undefined ? { rateLimitWindowMs } : {}),
        ...(argv.experimentalLsp === true ? { experimentalLsp: true } : {}),
        ...(argv.restoreAskUserQuestion === true
          ? { restoreAskUserQuestion: true }
          : {}),
        ...(channelSelection !== undefined ? { channelSelection } : {}),
      } satisfies Parameters<typeof runQwenServe>[0];
      if (openWithAuth) {
        const { applyOpenWithAuth } = await import(
          '../serve/open-with-auth.js'
        );
        applyOpenWithAuth(serveOptions);
      }
      const handle = await runQwenServe(serveOptions);
      // Open the Web Shell in a browser once the listener is up (best-effort;
      // never throws — see maybeOpenWebShellBrowser).
      if (argv['local-control']) {
        try {
          // Sleep inhibition moved into the service: it is held for as long as
          // the LAN listener is up and released when it goes down, rather than
          // for the lifetime of the process regardless.
          await startLocalControl(handle, argv['local-control-address']);
        } catch (err) {
          await handle.close().catch(() => undefined);
          throw err;
        }
      }
      await maybeOpenWebShellBrowser(handle, open, openWithAuth);
    } catch (err) {
      writeStderrLine(
        `qwen serve: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    await blockForever();
  },
};
