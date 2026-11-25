/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SimpleGit, SimpleGitFactory, SimpleGitOptions } from 'simple-git';
import type { ExtensionInstallMetadata } from '../config/config.js';
import type { GitCredential } from './extension-git-credentials.js';

interface ExtensionGitAuthentication {
  source: string;
  credential: GitCredential;
}

interface ExtensionGitClientOptions {
  baseDir: string;
  signal?: AbortSignal;
  networkPolicy?: ExtensionInstallMetadata['networkPolicy'];
  networkConfig?: string[];
  authentication?: ExtensionGitAuthentication;
}

type UnsafeOptions = NonNullable<SimpleGitOptions['unsafe']>;

function assertCredentialedHttpsSource(source: string): void {
  try {
    const parsed = new URL(source);
    // Git and WHATWG disagree on backslashes and userinfo: a URL that does
    // not round-trip unchanged, or that carries embedded credentials, can
    // make git connect to a different host than the one validated here.
    if (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      parsed.href === source
    ) {
      return;
    }
  } catch {
    // Use the same redacted error for malformed and non-HTTPS sources.
  }
  throw new Error(
    'Credentialed Git operations require a valid HTTPS repository URL.',
  );
}

// Mirrors the unsafe config-key blocklist matchers in @simple-git/argv-parser
// (3.0.0 via simple-git 4.1). Re-sync this table on a dependency bump: a new
// matcher that this table misses fails credentialed installs pre-spawn.
// Anchored tables (sendemail.*, imap.*, instaweb.*, browser.*/man.*, gpg
// signature trust) cannot match our `http.<url>.extraHeader` key shape and
// are omitted; so are the `/command$/` and `/\.cmd$/` catch-alls, enforced
// only under unsafe.recommended/strict, both off here.
const generatedConfigKeyAllowances = [
  [/alias/, 'allowUnsafeAlias'],
  [/core.askpass/, 'allowUnsafeAskPass'],
  [/core.editor/, 'allowUnsafeEditor'],
  [/core.fsmonitor/, 'allowUnsafeFsMonitor'],
  [/core.gitproxy/, 'allowUnsafeGitProxy'],
  [/core.hookspath/, 'allowUnsafeHooksPath'],
  [/core.pager/, 'allowUnsafePager'],
  [/core.sshcommand/, 'allowUnsafeSshCommand'],
  [/credential(..+)?.helper/, 'allowUnsafeCredentialHelper'],
  [/diff(..+)?.command/, 'allowUnsafeDiffExternal'],
  [/diff.external/, 'allowUnsafeDiffExternal'],
  [/difftool(..+)?.cmd/, 'allowUnsafeDiffExternal'],
  [/difftool(..+)?.path/, 'allowUnsafeDiffExternal'],
  [/diff(..+)?.textconv/, 'allowUnsafeDiffTextConv'],
  [/filter(..+)?.clean/, 'allowUnsafeFilter'],
  [/filter(..+)?.process/, 'allowUnsafeFilter'],
  [/filter(..+)?.smudge/, 'allowUnsafeFilter'],
  [/gpg(..+)?.program/, 'allowUnsafeGpgProgram'],
  [/gpg(..+)?.defaultkeycommand/, 'allowUnsafeGpgProgram'],
  [/include.path/, 'allowUnsafeInclude'],
  [/includeif/, 'allowUnsafeInclude'],
  [/init.templatedir/, 'allowUnsafeTemplateDir'],
  [/interactive.difffilter/, 'allowUnsafePager'],
  [/pager./, 'allowUnsafePager'],
  [/merge(..+)?.driver/, 'allowUnsafeMergeDriver'],
  [/mergetool(..+)?.path/, 'allowUnsafeMergeDriver'],
  [/mergetool(..+)?.cmd/, 'allowUnsafeMergeDriver'],
  [/protocol(..+)?.allow/, 'allowUnsafeProtocolOverride'],
  [/remote(..+)?.receivepack/, 'allowUnsafePack'],
  [/remote(..+)?.uploadpack/, 'allowUnsafePack'],
  [/uploadpack(..+)?.packobjectshook/, 'allowUnsafePack'],
  [/sequence.editor/, 'allowUnsafeEditor'],
  [/submodule(..+)?.update/, 'allowUnsafeSubmodule'],
  [/tar(..+)?.command/, 'allowUnsafeCommandBinaries'],
  [/trailer(..+)?.cmd/, 'allowUnsafeCommandBinaries'],
  [/trailer(..+)?.command/, 'allowUnsafeCommandBinaries'],
  [/url(..+)?.insteadof/, 'allowUnsafeUrlRewrite'],
] as const satisfies ReadonlyArray<readonly [RegExp, keyof UnsafeOptions]>;

function allowGeneratedConfigKeyFalsePositives(
  unsafe: UnsafeOptions,
  key: string,
): void {
  const normalizedKey = key.toLowerCase().trim();
  for (const [pattern, category] of generatedConfigKeyAllowances) {
    if (pattern.test(normalizedKey)) {
      unsafe[category] = true;
    }
  }
}

export function createExtensionGitClient(
  simpleGit: SimpleGitFactory,
  {
    baseDir,
    signal,
    networkPolicy,
    networkConfig = [],
    authentication,
  }: ExtensionGitClientOptions,
): SimpleGit {
  if (authentication) assertCredentialedHttpsSource(authentication.source);
  const restrictEnvironment =
    networkPolicy === 'public' || authentication !== undefined;
  const hasNetworkConfig = networkConfig.length > 0;
  const unsafe: UnsafeOptions = {};
  if (restrictEnvironment) unsafe.allowUnsafeConfigPaths = true;
  if (hasNetworkConfig) unsafe.allowUnsafeProtocolOverride = true;
  const credentialConfigKey = authentication
    ? `http.${authentication.source}.extraHeader`
    : undefined;
  if (credentialConfigKey) {
    unsafe.allowUnsafeConfigEnvCount = true;
    // @simple-git/argv-parser scans the whole key with unanchored matchers.
    // Enable only categories matched by this product-generated key.
    // The child environment below remains allowlisted.
    // Enabled categories relax the blocklist for every task on this client,
    // including argv `-c` entries. Callers must never pass user- or
    // extension-derived arguments or config through a client created here.
    allowGeneratedConfigKeyFalsePositives(unsafe, credentialConfigKey);
  }
  const environment = restrictEnvironment
    ? restrictedChildEnvironment(authentication)
    : undefined;
  const git = simpleGit(baseDir, {
    ...(signal ? { abort: signal } : {}),
    ...(hasNetworkConfig ? { config: networkConfig } : {}),
    ...(restrictEnvironment || hasNetworkConfig ? { unsafe } : {}),
    // simple-git v4 throws when a task env names a guarded variable without
    // an explicit opt-in. The restricted environment below sets exactly these
    // on purpose (hermetic config, no interactive prompt, optional inline
    // credential), so derive the allowance from it rather than restating it.
    ...(environment
      ? {
          allowEnvironment: Object.keys(environment).filter((key) =>
            /^git_/i.test(key),
          ),
        }
      : {}),
  });
  if (environment === undefined) return git;
  return git.env(environment);
}

/**
 * The restricted child environment. Its key set doubles as the client's
 * `allowEnvironment`, so adding a guarded key here cannot drift from the
 * opt-in list.
 */
function restrictedChildEnvironment(
  authentication: ExtensionGitClientOptions['authentication'],
): Record<string, string> {
  const environment: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: '1',
    // The literal '/dev/null' on every platform, NOT os.devNull: Git for
    // Windows special-cases the POSIX spelling in its compat layer, while
    // os.devNull's win32 value ('\\\\.\\nul') is rejected as
    // "fatal: unable to access '\\.\nul': Invalid argument".
    GIT_CONFIG_GLOBAL: '/dev/null',
    // Never let Git ask for credentials interactively. It reads that prompt
    // from /dev/tty, which the Ink TUI already holds in raw mode, so keystrokes
    // reach Ink and never Git: the prompt can be neither answered nor
    // dismissed, and nothing upstream cancels it. The /dev/null global config
    // above also drops the user's credential helper, so there is no
    // non-interactive fallback left. Without this, an extension whose Git
    // source needs authentication hangs every startup (#13447).
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (authentication) {
    const value = Buffer.from(
      `${authentication.credential.username}:${authentication.credential.password}`,
      'utf8',
    ).toString('base64');
    environment['GIT_CONFIG_COUNT'] = '1';
    environment['GIT_CONFIG_KEY_0'] =
      `http.${authentication.source}.extraHeader`;
    environment['GIT_CONFIG_VALUE_0'] = `Authorization: Basic ${value}`;
  }
  return environment;
}
