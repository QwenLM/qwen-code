/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dangerous shell command patterns for YOLO / auto-approve mode.
 *
 * When YOLO mode is active, commands matching these patterns are **not**
 * auto-approved — they still require manual user confirmation.  This keeps
 * the convenience of auto-approving safe operations (builds, tests, git
 * read-only commands …) while maintaining a security boundary against
 * arbitrary code execution and system-level operations.
 *
 * Categories:
 *   1. Script interpreters / code execution
 *   2. Shell eval / exec primitives
 *   3. Privilege escalation
 *   4. Package managers (install/run arbitrary code)
 *   5. Network / data exfiltration
 *   6. Cloud CLIs
 *   7. Container / orchestration
 *   8. Destructive file-system operations
 *   9. System administration
 *  10. Compilers / linkers that can execute arbitrary code
 */

import { splitCommands } from '../utils/shell-utils.js';
import { parse } from 'shell-quote';

// ---------------------------------------------------------------------------
// Pattern list
// ---------------------------------------------------------------------------

/**
 * Each entry is a root command name (lower-cased) that is considered
 * dangerous when executed in YOLO mode.
 *
 * The list intentionally casts a wide net — it is cheaper to ask the user
 * once than to allow a destructive or exfiltrating operation by mistake.
 */
export const DANGEROUS_ROOT_COMMANDS: ReadonlySet<string> = new Set([
  // ── 1. Script interpreters / code execution ──────────────────────────
  'python',
  'python2',
  'python3',
  'node',
  'nodejs',
  'deno',
  'bun',
  'ruby',
  'irb',
  'perl',
  'php',
  'lua',
  'luajit',
  'r',
  'rscript',
  'julia',
  'scala',
  'groovy',
  'swift',
  'elixir',
  'erl', // Erlang
  'ghci', // Haskell REPL
  'runghc',
  'runhaskell',
  'dotnet-script',
  'pwsh', // PowerShell Core
  'powershell',
  'osascript', // macOS AppleScript / JXA

  // ── 2. Shell eval / exec primitives ──────────────────────────────────
  'eval',
  'exec',
  'source',
  '.', // POSIX equivalent of `source`
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'fish',
  'xargs', // can execute arbitrary commands
  'nohup',
  'setsid',
  'script', // typescript recording, but wraps a shell
  'expect',
  'screen',
  'tmux',
  'at',
  'batch',
  'crontab',

  // ── 3. Privilege escalation ──────────────────────────────────────────
  'sudo',
  'su',
  'doas',
  'pkexec',
  'runas',
  'chroot',
  'unshare',
  'nsenter',
  'setpriv',

  // ── 4. Package managers (install / run arbitrary code) ───────────────
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'pip',
  'pip3',
  'pipx',
  'gem',
  'bundle',
  'bundler',
  'cargo',
  'go', // go run / go install
  'composer',
  'mix', // Elixir
  'cabal',
  'stack', // Haskell
  'conda',
  'mamba',
  'poetry',
  'pdm',
  'uv', // Python uv
  'rye', // Python Rye
  'brew',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pacman',
  'zypper',
  'apk',
  'snap',
  'flatpak',
  'nix',
  'nix-env',
  'nix-shell',

  // ── 5. Network / data exfiltration ───────────────────────────────────
  'curl',
  'wget',
  'httpie',
  'http', // httpie alias
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'ftp',
  'telnet',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'openssl', // s_client can send data
  'nmap',
  'dig', // DNS queries (data exfil vector)
  'ngrok',
  'cloudflared',

  // ── 6. Cloud CLIs ────────────────────────────────────────────────────
  'aws',
  'gcloud',
  'az',
  'firebase',
  'heroku',
  'vercel',
  'flyctl',
  'fly',
  'doctl', // DigitalOcean
  'linode-cli',
  'oci', // Oracle Cloud
  'ibmcloud',
  'terraform',
  'tofu', // OpenTofu
  'pulumi',
  'serverless',
  'sls',
  'sam', // AWS SAM
  'cdk', // AWS CDK
  'copilot', // AWS Copilot

  // ── 7. Container / orchestration ─────────────────────────────────────
  'docker',
  'podman',
  'buildah',
  'kubectl',
  'helm',
  'minikube',
  'kind', // Kubernetes in Docker
  'k3s',
  'k3d',
  'oc', // OpenShift
  'vagrant',
  'ansible',
  'ansible-playbook',
  'salt',
  'puppet',
  'chef',

  // ── 8. Destructive file-system operations ────────────────────────────
  'rm',
  'rmdir',
  'shred',
  'srm',
  'mv',
  'dd',
  'mkfs',
  'fdisk',
  'parted',
  'mount',
  'umount',
  'chmod',
  'chown',
  'chgrp',
  'ln', // symlink creation

  // ── 9. System administration ─────────────────────────────────────────
  'systemctl',
  'service',
  'launchctl',
  'kill',
  'killall',
  'pkill',
  'reboot',
  'shutdown',
  'halt',
  'poweroff',
  'init',
  'useradd',
  'userdel',
  'usermod',
  'groupadd',
  'groupdel',
  'passwd',
  'visudo',
  'iptables',
  'ip6tables',
  'nft', // nftables
  'ufw',
  'firewall-cmd',
  'sysctl',
  'modprobe',
  'insmod',
  'rmmod',

  // ── 10. Compilers / build tools that can exec arbitrary code ─────────
  'make',
  'cmake',
  'gcc',
  'g++',
  'clang',
  'clang++',
  'rustc',
  'javac',
  'java',
  'mvn', // Maven
  'gradle',
  'gradlew',
  'ant',
  'msbuild',
  'dotnet',
]);

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

const ENV_ASSIGNMENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Commands that act as transparent wrappers — the real command follows
 * after wrapper-specific arguments.  We skip these and inspect the
 * effective root instead.
 *
 * Only wrappers with simple, well-defined argument patterns are listed
 * here.  Wrappers with complex positional arguments (nice, timeout,
 * strace …) are intentionally excluded to avoid mis-parsing.
 */
const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  'env', // env [-i] [VAR=val…] CMD …
  'command', // command [-pvV] CMD …
  'builtin', // builtin CMD …
]);

/**
 * Strip trailing version / dot-suffixes from a command basename so that
 * `python3.11`, `ruby3.2`, `node18`, `gcc-12` all normalise to their
 * canonical entry in the dangerous set.
 *
 * Strategy: try progressively shorter prefixes (e.g. python3.11 → python3
 * → python) until one matches the dangerous set, or return the full basename
 * for a final exact-match attempt.
 */
function normaliseBinName(basename: string): string {
  // Try exact match first (covers the common case fast).
  if (DANGEROUS_ROOT_COMMANDS.has(basename)) {
    return basename;
  }

  // Strip trailing version / numeric suffix separated by `.` or `-`.
  // e.g. python3.11 → python3, gcc-12 → gcc, ruby3.2.1 → ruby3 → ruby
  //
  // Uses a manual right-to-left scan instead of regex to avoid polynomial
  // backtracking (CodeQL: polynomial-redos).
  let name = basename;
  for (;;) {
    // Find the rightmost `.-` or `--` followed by a digit.
    let cutPos = -1;
    for (let i = name.length - 1; i >= 1; i--) {
      const prev = name[i - 1];
      if (
        (prev === '.' || prev === '-') &&
        name[i]! >= '0' &&
        name[i]! <= '9'
      ) {
        cutPos = i - 1;
        break;
      }
    }
    if (cutPos < 0) break;
    name = name.substring(0, cutPos);
    if (!name) break;
    if (DANGEROUS_ROOT_COMMANDS.has(name)) {
      return name;
    }
  }

  // Also try stripping a trailing bare digit run: `python3` → `python`
  const noDigitSuffix = name.replace(/\d+$/, '');
  if (
    noDigitSuffix &&
    noDigitSuffix !== name &&
    DANGEROUS_ROOT_COMMANDS.has(noDigitSuffix)
  ) {
    return noDigitSuffix;
  }

  return basename;
}

/**
 * Extract the effective root command from a single shell segment, skipping
 * leading environment variable assignments (e.g. `FOO=bar cmd …`) and
 * transparent wrappers (e.g. `env`, `command`, `builtin`).
 */
function extractRootCommand(segment: string): string | undefined {
  const trimmed = segment.trim();
  if (!trimmed) {
    return undefined;
  }

  let tokens: string[];
  try {
    tokens = parse(trimmed).filter((t): t is string => typeof t === 'string');
  } catch {
    // If shell-quote can't parse it, fall back to simple split.
    tokens = trimmed.split(/\s+/);
  }

  // Skip environment variable assignments: `VAR=val cmd …`
  let idx = 0;
  while (idx < tokens.length && ENV_ASSIGNMENT_REGEX.test(tokens[idx]!)) {
    idx++;
  }

  if (idx >= tokens.length) {
    return undefined;
  }

  // Take the basename of the token (handles /usr/bin/python3).
  const raw = tokens[idx]!;
  let basename = (
    raw.includes('/') ? raw.split('/').pop()! : raw
  ).toLowerCase();

  // Skip transparent wrappers — inspect their effective command argument.
  // e.g. `env python3 …`, `env VAR=val python3 …`, `command -v python3`
  if (TRANSPARENT_WRAPPERS.has(basename)) {
    idx++;
    // Skip flags (tokens starting with '-') and env-var assignments (VAR=val).
    while (
      idx < tokens.length &&
      (tokens[idx]!.startsWith('-') || ENV_ASSIGNMENT_REGEX.test(tokens[idx]!))
    ) {
      idx++;
    }
    if (idx >= tokens.length) {
      return basename; // wrapper with no command argument → return wrapper itself
    }
    const nextRaw = tokens[idx]!;
    basename = (
      nextRaw.includes('/') ? nextRaw.split('/').pop()! : nextRaw
    ).toLowerCase();
  }

  return normaliseBinName(basename);
}

/**
 * Check whether a shell command matches any dangerous pattern.
 *
 * The command string is split on `&&`, `||`, `;`, and `|` boundaries,
 * and each segment's root command is tested against the dangerous set.
 *
 * @returns The first matched dangerous command name, or `undefined` if safe.
 */
export function matchDangerousPattern(command: string): string | undefined {
  if (typeof command !== 'string' || !command.trim()) {
    return undefined;
  }

  const segments = splitCommands(command);
  for (const segment of segments) {
    const root = extractRootCommand(segment);
    if (root && DANGEROUS_ROOT_COMMANDS.has(root)) {
      return root;
    }
  }

  return undefined;
}

/**
 * Convenience boolean wrapper around {@link matchDangerousPattern}.
 */
export function isDangerousCommand(command: string): boolean {
  return matchDangerousPattern(command) !== undefined;
}
