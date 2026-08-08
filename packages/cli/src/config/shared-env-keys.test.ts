/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  HOME_ENV_BOOTSTRAP_KEYS,
  INHERITED_LOADER_ENV_KEYS,
  isHardcodedProjectEnvExclusion,
  isLoaderEnvKey,
  PROJECT_ENV_HARDCODED_EXCLUSIONS,
  reportRejectedLoaderKeys,
  resetLoaderKeyRejectionReportingForTesting,
  scrubAndReportInheritedLoaderEnv,
  scrubInheritedLoaderEnv,
} from './shared-env-keys.js';

describe('PROJECT_ENV_HARDCODED_EXCLUSIONS', () => {
  // Security guard: a project `.env` must never be able to disable TLS
  // certificate verification. Removing this key would let an untrusted repo
  // silently turn off MITM protection for all API connections.
  it('excludes QWEN_TLS_INSECURE so a project .env cannot disable TLS', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('QWEN_TLS_INSECURE');
  });

  // isTlsVerificationDisabled() also honors NODE_TLS_REJECT_UNAUTHORIZED=0, and
  // the initial .env load only consults this list, so it must be blocked here
  // too — otherwise a project .env could bypass TLS via the Node-native var.
  it('excludes NODE_TLS_REJECT_UNAUTHORIZED so a project .env cannot disable TLS', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(
      'NODE_TLS_REJECT_UNAUTHORIZED',
    );
  });

  it('excludes attribution markers so a project .env cannot spoof channel', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('QWEN_CODE_SERVE');
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('QWEN_CODE_DESKTOP');
  });

  // QWEN_CLI_ENTRY is the spawned session-process entrypoint; a project file
  // fixing it is arbitrary script execution as the daemon.
  // NODE_EXTRA_CA_CERTS adds a TLS trust anchor — the
  // NODE_TLS_REJECT_UNAUTHORIZED outcome by addition instead of disable.
  it('excludes entrypoint and trust-anchor keys', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('QWEN_CLI_ENTRY');
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('NODE_EXTRA_CA_CERTS');
  });

  // The compile-cache keys stay settable from project files: a
  // project-configured V8 cache dir is a pinned feature (#7594, tests in
  // both loaders), and Node validates cache entries against the source, so
  // a poisoned/shared dir degrades to cache misses.
  it('keeps compile-cache keys out of the hardcoded exclusions', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).not.toContain(
      'NODE_COMPILE_CACHE',
    );
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).not.toContain(
      'QWEN_CODE_PENDING_COMPILE_CACHE',
    );
  });

  // DEV gates the daemon's loader-env scrub; a project file setting it
  // would keep loader vars in the base env distributed to every workspace's
  // session children, reopening the #8653 vector.
  it('excludes DEV so a project .env cannot spoof the dev harness', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('DEV');
  });

  // Workspace settings.env QWEN_SERVER_TOKEN is an intentional fast-path
  // feature (fast-path.test.ts loads it without the full settings loader);
  // it stays reload-only rather than hardcoded-excluded.
  it('keeps QWEN_SERVER_TOKEN out of the hardcoded exclusions', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).not.toContain('QWEN_SERVER_TOKEN');
  });

  it('does not bootstrap attribution markers from a home .env', () => {
    expect(HOME_ENV_BOOTSTRAP_KEYS).not.toContain('QWEN_CODE_SERVE');
    expect(HOME_ENV_BOOTSTRAP_KEYS).not.toContain('QWEN_CODE_DESKTOP');
  });
});

describe('isHardcodedProjectEnvExclusion', () => {
  // Windows env lookup is case-insensitive; exact-case membership would let
  // `node_extra_ca_certs`/`qwen_cli_entry` slip past every application gate.
  it('matches the hardcoded exclusions case-insensitively', () => {
    expect(isHardcodedProjectEnvExclusion('QWEN_HOME')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('qwen_home')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('node_extra_ca_certs')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('Node_Extra_Ca_Certs')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('qwen_cli_entry')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('DEV')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('dev')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('QWEN_SERVER_TOKEN')).toBe(false);
    expect(isHardcodedProjectEnvExclusion('NODE_OPTIONS')).toBe(false);
  });
});

describe('isLoaderEnvKey', () => {
  // npm's config reader matches /^npm_config_/i and then replaces
  // non-leading underscores with hyphens, so the hyphen spelling
  // npm_config_node-options maps onto the same node-options config and is
  // injected as NODE_OPTIONS into every `npm run` lifecycle script. Both
  // spellings (in every case variant) must count as the same loader key.
  it('matches npm underscore/hyphen spelling variants case-insensitively', () => {
    expect(isLoaderEnvKey('npm_config_node_options')).toBe(true);
    expect(isLoaderEnvKey('npm_config_node-options')).toBe(true);
    expect(isLoaderEnvKey('NPM_CONFIG_NODE-OPTIONS')).toBe(true);
    expect(isLoaderEnvKey('Node_Options')).toBe(true);
    expect(isLoaderEnvKey('ld_preload')).toBe(true);
    expect(isLoaderEnvKey('npm_config_registry')).toBe(false);
    expect(isLoaderEnvKey('PATH')).toBe(false);
    expect(isLoaderEnvKey('NODE_OPTIONS_EXTRA')).toBe(false);
  });

  // The npm config-file keys redirect npm to an attacker-chosen .npmrc —
  // the node-options hijack one level up. Note the underscore/hyphen
  // equivalence only covers npm's real config names: `userconfig` has no
  // hyphen, so npm_config_user-config maps to a different (harmless) key.
  it('matches the npm config-file redirect keys', () => {
    expect(isLoaderEnvKey('npm_config_userconfig')).toBe(true);
    expect(isLoaderEnvKey('npm_config_globalconfig')).toBe(true);
    expect(isLoaderEnvKey('npm_config_script_shell')).toBe(true);
    expect(isLoaderEnvKey('npm_config_prefix')).toBe(true);
    expect(isLoaderEnvKey('NPM_CONFIG_USERCONFIG')).toBe(true);
    expect(isLoaderEnvKey('npm_config_script-shell')).toBe(true);
    expect(isLoaderEnvKey('npm_config_user-config')).toBe(false);
  });

  // bash imports exported function definitions from the environment even in
  // non-interactive `bash -c`; the function name is embedded in the key, so
  // this is a prefix rule rather than a listed literal.
  it('matches BASH_FUNC_* exported function definitions by prefix', () => {
    expect(isLoaderEnvKey('BASH_FUNC_id%%')).toBe(true);
    expect(isLoaderEnvKey('BASH_FUNC_anything()')).toBe(true);
    expect(isLoaderEnvKey('bash_func_id%%')).toBe(true);
  });

  // Library search paths and the interactive-sh-only ENV are deliberately
  // reload-only: scrubbing them breaks mainstream toolchains.
  it('does not match search paths or the ENV convention', () => {
    expect(isLoaderEnvKey('LD_LIBRARY_PATH')).toBe(false);
    expect(isLoaderEnvKey('DYLD_LIBRARY_PATH')).toBe(false);
    expect(isLoaderEnvKey('ENV')).toBe(false);
    expect(isLoaderEnvKey('env')).toBe(false);
  });
});

describe('scrubInheritedLoaderEnv', () => {
  // Regression for #8653: loader vars inherited from the daemon's launch
  // shell must not reach session subprocesses of other workspaces.
  it('removes every loader-affecting key and keeps the rest', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: '--import file:///other-checkout/register.mjs',
      npm_config_node_options: '--import file:///other-checkout/hook.mjs',
      npm_config_userconfig: '/other-checkout/.npmrc',
      NODE_PATH: '/other-checkout/node_modules',
      LD_PRELOAD: '/evil.so',
      LD_AUDIT: '/evil-audit.so',
      DYLD_INSERT_LIBRARIES: '/evil.dylib',
      BASH_ENV: '/tmp/hook.sh',
      ZDOTDIR: '/other-checkout/zdot',
      'BASH_FUNC_id%%': '() { echo pwned; }',
      LD_LIBRARY_PATH: '/opt/conda/lib',
      DYLD_LIBRARY_PATH: '/usr/local/cuda/lib64',
      ENV: 'production',
      PATH: '/other-checkout/node_modules/.bin:/usr/bin',
      HOME: '/home/user',
      QWEN_SERVER_TOKEN: 'leave-secret-scrubbing-to-other-layers',
    };

    const removedKeys = scrubInheritedLoaderEnv(env);

    for (const key of INHERITED_LOADER_ENV_KEYS) {
      expect(env[key]).toBeUndefined();
    }
    // The removed-key list backs the startup breadcrumb and must only name
    // keys that were actually present.
    expect(removedKeys).toEqual([
      'NODE_OPTIONS',
      'npm_config_node_options',
      'npm_config_userconfig',
      'NODE_PATH',
      'LD_PRELOAD',
      'LD_AUDIT',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'ZDOTDIR',
      'BASH_FUNC_id%%',
    ]);
    expect(scrubInheritedLoaderEnv(env)).toEqual([]);
    // PATH/HOME are launch-environment facts the session still needs, and
    // the library search paths / ENV stay for toolchain compatibility; only
    // injection-class keys are scrubbed.
    expect(env['PATH']).toBe('/other-checkout/node_modules/.bin:/usr/bin');
    expect(env['HOME']).toBe('/home/user');
    expect(env['LD_LIBRARY_PATH']).toBe('/opt/conda/lib');
    expect(env['DYLD_LIBRARY_PATH']).toBe('/usr/local/cuda/lib64');
    expect(env['ENV']).toBe('production');
    expect(env['QWEN_SERVER_TOKEN']).toBe(
      'leave-secret-scrubbing-to-other-layers',
    );
  });

  // npm applies npm_config_* env vars case-insensitively, and Windows env
  // lookup is case-insensitive outright, so exact-case scrubbing would leave
  // variants like NPM_CONFIG_NODE_OPTIONS loader-effective after the scrub.
  it('removes case variants of loader-affecting keys', () => {
    const env: NodeJS.ProcessEnv = {
      NPM_CONFIG_NODE_OPTIONS: '--import file:///other-checkout/hook.mjs',
      Node_Options: '--import file:///other-checkout/harness.mjs',
      ld_preload: '/evil.so',
      PATH: '/usr/bin',
    };

    expect(scrubInheritedLoaderEnv(env)).toEqual([
      'NPM_CONFIG_NODE_OPTIONS',
      'Node_Options',
      'ld_preload',
    ]);
    expect(env['PATH']).toBe('/usr/bin');
  });

  // npm treats npm_config_node-options (hyphen) and npm_config_node_options
  // (underscore) as the same config key, so the scrub must remove both
  // spellings or the hyphen variant survives into session subprocesses.
  it('removes npm underscore/hyphen spelling variants', () => {
    const env: NodeJS.ProcessEnv = {
      'npm_config_node-options': '--import file:///other-checkout/hook.mjs',
      'NPM_CONFIG_NODE-OPTIONS': '--import file:///other-checkout/hook.mjs',
      PATH: '/usr/bin',
    };

    expect(scrubInheritedLoaderEnv(env)).toEqual([
      'npm_config_node-options',
      'NPM_CONFIG_NODE-OPTIONS',
    ]);
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('pins the exact loader-key list so silent edits fail', () => {
    expect([...INHERITED_LOADER_ENV_KEYS].sort()).toEqual([
      'BASH_ENV',
      'DYLD_INSERT_LIBRARIES',
      'LD_AUDIT',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'NODE_PATH',
      'ZDOTDIR',
      'npm_config_globalconfig',
      'npm_config_node_options',
      'npm_config_prefix',
      'npm_config_script_shell',
      'npm_config_userconfig',
    ]);
  });
});

describe('reportRejectedLoaderKeys', () => {
  it('returns every rejected key while warning only once per source and key', () => {
    resetLoaderKeyRejectionReportingForTesting();
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

    try {
      expect(
        reportRejectedLoaderKeys('/workspace/.env', [
          'NODE_OPTIONS',
          'PATH',
          'LD_PRELOAD',
        ]),
      ).toEqual(['NODE_OPTIONS', 'LD_PRELOAD']);
      expect(
        reportRejectedLoaderKeys('/workspace/.env', [
          'NODE_OPTIONS',
          'DYLD_INSERT_LIBRARIES',
        ]),
      ).toEqual(['NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES']);
    } finally {
      write.mockRestore();
    }

    expect(writes.join('').match(/NODE_OPTIONS/gu)).toHaveLength(1);
    expect(writes.join('')).toContain('LD_PRELOAD');
    expect(writes.join('')).toContain('DYLD_INSERT_LIBRARIES');
  });

  // Without the reset the dedup map survives across boots/reloads in one
  // process and silently swallows a repeat rejection for the same source.
  it('warns again for an already-reported source and key after the reset', () => {
    resetLoaderKeyRejectionReportingForTesting();
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

    try {
      reportRejectedLoaderKeys('/workspace/.env', ['NODE_OPTIONS']);
      reportRejectedLoaderKeys('/workspace/.env', ['NODE_OPTIONS']);
      resetLoaderKeyRejectionReportingForTesting();
      reportRejectedLoaderKeys('/workspace/.env', ['NODE_OPTIONS']);
    } finally {
      write.mockRestore();
    }

    expect(writes).toHaveLength(2);
  });
});

describe('scrubAndReportInheritedLoaderEnv', () => {
  function captureStderr(run: () => void): string {
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      run();
    } finally {
      write.mockRestore();
    }
    return writes.join('');
  }

  it('scrubs and reports the removed keys with the boundary labels', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: '--import file:///other-checkout/register.mjs',
      LD_PRELOAD: '/evil.so',
      HOME: '/home/user',
    };

    let removedKeys: string[] = [];
    const breadcrumb = captureStderr(() => {
      removedKeys = scrubAndReportInheritedLoaderEnv(
        env,
        'qwen serve',
        'daemon',
      );
    });

    expect(removedKeys).toEqual(['NODE_OPTIONS', 'LD_PRELOAD']);
    expect(env['HOME']).toBe('/home/user');
    expect(breadcrumb).toContain(
      'qwen serve: scrubbed inherited loader env vars from the daemon ' +
        'process; session subprocesses will not inherit them: ' +
        'NODE_OPTIONS, LD_PRELOAD',
    );
  });

  it('stays silent when there is nothing to scrub', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/home/user' };

    const breadcrumb = captureStderr(() => {
      expect(
        scrubAndReportInheritedLoaderEnv(env, 'qwen', 'ACP child'),
      ).toEqual([]);
    });

    expect(breadcrumb).toBe('');
  });
});
