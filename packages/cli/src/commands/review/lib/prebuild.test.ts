/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_ENV_HARDCODED_EXCLUSIONS } from '../../../config/shared-env-keys.js';
import { getSettingsSchema } from '../../../config/settingsSchema.js';
import type { BuildTestReport, CommandResult } from '../build-test.js';
import {
  PREBUILD_BUDGET_S,
  PREBUILD_COMMAND_TIMEOUT_S,
  PREBUILD_COVER_HEADROOM_S,
  PREBUILD_COVER_MS,
  PREBUILD_ENV,
  prebuildCovered,
  prebuildRequested,
  prebuildWorktree,
} from './prebuild.js';

describe('prebuildRequested', () => {
  const never = () => false;

  it('is on for 1 alone — the literal the workflow cover gate compares', () => {
    // A second grammar (a documented `true`) would run the prebuild under
    // a value the cover gate does not weld for — prebuild without cover.
    expect(prebuildRequested({ [PREBUILD_ENV]: '1' }, never)).toBe(true);
    expect(prebuildRequested({ [PREBUILD_ENV]: ' 1 ' }, never)).toBe(true);
  });

  it('is off when unset and for every other value', () => {
    expect(prebuildRequested({}, never)).toBe(false);
    for (const value of [
      '',
      '0',
      'false',
      'true',
      ' TRUE ',
      'True',
      'yes',
      'on',
    ]) {
      expect(prebuildRequested({ [PREBUILD_ENV]: value }, never)).toBe(false);
    }
  });

  it('is excluded from project .env files at load time', () => {
    // The registry the read-time check consults is per-process: a child
    // inheriting a file-sourced value sees an empty registry (R12-1). The
    // closure is the loader's hardcoded project-env exclusion — pinned with
    // both real symbols so neither side can drift; the loader-behavior arm
    // lives in config/environment.test.ts.
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(PREBUILD_ENV);
  });

  it('accepts a process-sourced value under the production default binding', () => {
    // No injected predicate: the default isFileSourcedEnvKey binding runs,
    // and a key the loader never registered is a real process variable.
    expect(prebuildRequested({ [PREBUILD_ENV]: '1' })).toBe(true);
  });

  it('ignores a value sourced from a .env file', () => {
    // The reviewed checkout's `.qwen/.env` reaches process.env through the
    // environment loader; a repository must not decide to prebuild its own
    // review. Same rule as QWEN_REVIEW_SANDBOX.
    expect(
      prebuildRequested({ [PREBUILD_ENV]: '1' }, (key) => key === PREBUILD_ENV),
    ).toBe(false);
  });
});

describe('prebuildWorktree', () => {
  let root: string;
  let worktree: string;
  let plan: string;
  let report: string;

  beforeEach(() => {
    // realpath once: macOS's tmpdir is a symlink, and the paths handed back
    // must compare equal to what the seam receives.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-prebuild-')));
    worktree = join(root, 'wt');
    mkdirSync(worktree);
    plan = join(root, 'fetch.json');
    writeFileSync(plan, '{}');
    report = join(root, 'prebuild.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const builtCmd: CommandResult = {
    command: 'npm run build --workspace="packages/cli"',
    exitCode: 0,
    seconds: 12,
    timedOut: false,
    output: '',
  };

  const green: BuildTestReport = {
    toolchain: 'npm',
    affected: ['packages/cli'],
    buildSet: ['packages/core', 'packages/cli'],
    widenedWith: [],
    install: null,
    build: [builtCmd],
    test: [],
    buildOnly: true,
    ok: true,
    timedOut: [],
    note: '',
  };

  /** A build step that installs the way npm does: the marker lands last. */
  function installs(result: BuildTestReport) {
    return vi.fn((args: { worktree: string }) => {
      mkdirSync(join(args.worktree, 'node_modules'), { recursive: true });
      writeFileSync(
        join(args.worktree, 'node_modules', '.package-lock.json'),
        '{}',
      );
      return result;
    });
  }

  it("runs Agent 7's build-test with install and build-only under the step-sized budget", () => {
    const run = installs(green);
    const clock = [1_000, 4_500];
    const out = prebuildWorktree({
      plan,
      worktree,
      report,
      run,
      now: () => clock.shift() ?? 4_500,
    });
    // Every argument is the contract: the same command Agent 7 runs, with
    // the tests left to Agent 7 and the budget sized to a workflow step.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      plan,
      worktree,
      out: report,
      timeout: PREBUILD_COMMAND_TIMEOUT_S,
      budget: PREBUILD_BUDGET_S,
      install: true,
      buildOnly: true,
    });
    expect(PREBUILD_BUDGET_S).toBeGreaterThan(600);
    expect(PREBUILD_COMMAND_TIMEOUT_S).toBeGreaterThan(600);
    expect(PREBUILD_BUDGET_S).toBeGreaterThanOrEqual(
      PREBUILD_COMMAND_TIMEOUT_S,
    );
    expect(out).toEqual({
      installed: true,
      built: true,
      note: '',
      report,
      durationMs: 3_500,
    });
    // The report is build-test's own, verbatim — one format for whoever
    // diagnoses a prebuild next.
    expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual(green);
  });

  it('is not built when the budget cut the closure short, even on ok: true', () => {
    // build-test keeps `ok` for the packages it did build; a closure with a
    // package never compiled is not a tree a probe can run against — the
    // same rule base-tree applies to the merge-base tree.
    const out = prebuildWorktree({
      plan,
      worktree,
      report,
      run: installs({ ...green, notBuilt: ['packages/cli'] }),
    });
    expect(out.installed).toBe(true);
    expect(out.built).toBe(false);
  });

  it('is not built when build-test handed the repo to the brief', () => {
    // The `unsupported` hand-off carries `ok: true` — a hand-off, not a
    // failure — but it is not an npm compile; base-tree refuses the same
    // shape (`toolchain !== 'npm'`), and the report must agree.
    const out = prebuildWorktree({
      plan,
      worktree,
      report,
      run: vi.fn(() => ({
        ...green,
        toolchain: 'unsupported' as const,
        note: 'fall back to the build/test precedence in your brief',
      })),
    });
    expect(out.installed).toBe(false);
    expect(out.built).toBe(false);
  });

  it('is not built when the npm scope had nothing to compile', () => {
    // The docs-only shape: no affected workspace returns `ok: true` with
    // zero build commands. Nothing compiled is not a compiled closure.
    const out = prebuildWorktree({
      plan,
      worktree,
      report,
      run: installs({ ...green, build: [] }),
    });
    expect(out.installed).toBe(true);
    expect(out.built).toBe(false);
  });

  it("carries build-test's verdict and note when the build failed", () => {
    const out = prebuildWorktree({
      plan,
      worktree,
      report,
      run: installs({
        ...green,
        ok: false,
        note: 'packages/cli: build exited 2',
      }),
    });
    expect(out.installed).toBe(true);
    expect(out.built).toBe(false);
    expect(out.note).toBe('packages/cli: build exited 2');
    expect(out.report).toBe(report);
  });

  it("reads `installed` off npm's marker, not off build-test's word", () => {
    // A green report over a tree with no marker (the install phase was
    // skipped, or npm never wrote it) must not claim a complete
    // node_modules: Agent 7's install gate reads the marker, and the report
    // must agree with the gate.
    const out = prebuildWorktree({
      plan,
      worktree,
      report,
      run: vi.fn(() => green),
    });
    expect(out.installed).toBe(false);
    expect(out.built).toBe(true);
  });

  it('never throws: a build-test that throws is recorded, not raised', () => {
    const out = prebuildWorktree({
      plan,
      worktree,
      report,
      run: vi.fn(() => {
        throw new Error('plan report is not valid JSON');
      }),
    });
    expect(out).toEqual({
      installed: false,
      built: false,
      note: 'prebuild did not run: plan report is not valid JSON',
      report: null,
      durationMs: expect.any(Number),
    });
    expect(existsSync(report)).toBe(false);
  });

  it('keeps the outcome when the report file cannot be written', () => {
    const out = prebuildWorktree({
      plan,
      worktree,
      report: join(root, 'no-such-dir', 'prebuild.json'),
      run: installs(green),
    });
    expect(out.installed).toBe(true);
    expect(out.built).toBe(true);
    expect(out.report).toBeNull();
  });
});

describe('prebuildCovered', () => {
  // The guard keys on the EFFECTIVE session shell default — the same value
  // the caller's shell tool applies to the fetch-pr call — not on the
  // opt-in's own value, so the CI weld keeps working and a local opt-in
  // under the built-in default skips instead of dying mid-`npm ci`.
  let qwenHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    qwenHome = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-cover-')));
    savedHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = qwenHome;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = savedHome;
    }
    rmSync(qwenHome, { recursive: true, force: true });
  });

  function weld(value: unknown): void {
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ tools: { shell: { defaultTimeoutMs: value } } }),
    );
  }

  it('carries the budget plus the headroom the cover is welded with', () => {
    expect(PREBUILD_COVER_HEADROOM_S).toBeGreaterThan(0);
    expect(PREBUILD_COVER_MS).toBe(
      (PREBUILD_BUDGET_S + PREBUILD_COVER_HEADROOM_S) * 1000,
    );
    weld(PREBUILD_COVER_MS);
    expect(prebuildCovered()).toBe(true);
  });

  it('is not covered by the built-in default of a local session', () => {
    // No settings at all: the session falls back to the 120000ms built-in,
    // far below the budget — the documented local opt-in would otherwise
    // die mid-install with the whole fetch-pr call.
    expect(prebuildCovered()).toBe(false);
  });

  it('is not covered by a session default below the cover', () => {
    weld(PREBUILD_COVER_MS - 1);
    expect(prebuildCovered()).toBe(false);
  });

  it('treats the disabled-timer sentinel as cover', () => {
    // 0 at the settings level disables the shell timeout entirely
    // (shell.ts's precedence comment): a call with no deadline at all
    // carries any budget, so the gate must not refuse the one
    // configuration that can never kill the prebuild.
    weld(0);
    expect(prebuildCovered()).toBe(true);
  });

  it('needs — and the loader grants — a value above the schema ceiling', () => {
    // The welded cover exceeds settingsSchema's interactive maximum for
    // tools.shell.defaultTimeoutMs on purpose; the startup loader applies
    // it unchecked and the runtime gate accepts it. Pinned against the
    // real schema and through the real loader, so a future range-check in
    // either cannot silently turn every CI cover into "not covered" (R2-6).
    const schema = getSettingsSchema() as unknown as {
      tools?: {
        properties?: {
          shell?: {
            properties?: { defaultTimeoutMs?: { maximum?: number } };
          };
        };
      };
    };
    const max =
      schema.tools?.properties?.shell?.properties?.defaultTimeoutMs?.maximum;
    expect(typeof max).toBe('number');
    expect(PREBUILD_COVER_MS).toBeGreaterThan(max as number);
    weld(PREBUILD_COVER_MS);
    expect(prebuildCovered()).toBe(true);
  });

  it('falls back to the built-in for values the runtime gate rejects', () => {
    // Config admits only in-range integers; anything else never reaches
    // the shell tool, so the guard must not read it as cover either.
    for (const value of ['lots', 1.5, -1, 2_147_483_648]) {
      weld(value);
      expect(prebuildCovered()).toBe(false);
    }
  });

  it('is not covered when the settings cannot be read at all', () => {
    // A directory where the settings file belongs: existsSync passes, the
    // read throws — loadSettings' FatalConfigError shape. The prebuild
    // must not end a review a broken settings file could not otherwise.
    rmSync(qwenHome, { recursive: true, force: true });
    mkdirSync(qwenHome);
    mkdirSync(join(qwenHome, 'settings.json'));
    expect(prebuildCovered()).toBe(false);
  });

  describe('workspace scope', () => {
    // The session's shell timer arms the FULL settings merge, where
    // Workspace overrides User, while the cover is welded into the
    // operator scopes. The gate must read both merges: the op-only one so
    // a repository cannot GRANT itself cover, and the full one so a
    // checkout cannot REVOKE the welded cover under the timer while the
    // gate still certifies it.
    let workspace: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      workspace = realpathSync(
        mkdtempSync(join(tmpdir(), 'qwen-cover-workspace-')),
      );
      mkdirSync(join(workspace, '.qwen'), { recursive: true });
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    });

    afterEach(() => {
      cwdSpy.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    });

    function weldWorkspace(value: unknown): void {
      writeFileSync(
        join(workspace, '.qwen', 'settings.json'),
        JSON.stringify({ tools: { shell: { defaultTimeoutMs: value } } }),
      );
    }

    it('is not covered when a below-cover workspace value overrides the welded cover', () => {
      weld(PREBUILD_COVER_MS);
      weldWorkspace(600_000);
      expect(prebuildCovered()).toBe(false);
    });

    it('is not covered when a gate-invalid workspace value falls back to the built-in', () => {
      weld(PREBUILD_COVER_MS);
      weldWorkspace('lots');
      expect(prebuildCovered()).toBe(false);
    });

    it('is not covered when only the workspace scope carries the cover', () => {
      // The upward direction: a repository must not grant its own
      // review's cover — the op-only read has just the 120000ms built-in.
      weldWorkspace(PREBUILD_COVER_MS);
      expect(prebuildCovered()).toBe(false);
    });

    it('stays covered when the workspace scope carries the cover too', () => {
      weld(PREBUILD_COVER_MS);
      weldWorkspace(PREBUILD_COVER_MS);
      expect(prebuildCovered()).toBe(true);
    });
  });
});
