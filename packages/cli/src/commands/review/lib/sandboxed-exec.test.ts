/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The reviewed repository's own commands, and the boundary they run behind
// (#9556). What these pin is not that a container starts — that needs a
// runtime and belongs to an integration harness — but the three decisions the
// argv encodes: what is mounted, what crosses in the environment, and what
// happens when there is no runtime at all.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { dirname, join, sep } from 'node:path';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { CLI_VERSION } from '../../../generated/git-commit.js';
import { fileURLToPath } from 'node:url';
import type { spawnSync } from 'node:child_process';
import { isolateOperatorReviewSettings } from './test-utils.js';
import * as environment from '../../../config/environment.js';
import {
  containerCommand,
  firstAnsweringRuntime,
  killContainer,
  containerPathFor,
  hasRootlessMarker,
  readInfoDocument,
  runtimeIsRootless,
  boxedRunLeftContainer,
  CONTAINER_HOME,
  containerEnv,
  containerName,
  handOffRefused,
  mountRootFor,
  refuseUnsandboxedPhase,
  reviewSandboxImage,
  runtimeClientEnv,
  sandboxPolicy,
  sandboxVerdict,
} from './sandboxed-exec.js';

describe('sandboxPolicy', () => {
  it('lets the environment outrank the setting, and defaults to off', () => {
    // CI has to be able to require containment without depending on a
    // settings file the runner may not carry.
    expect(sandboxPolicy({ QWEN_REVIEW_SANDBOX: 'required' }, {})).toBe(
      'required',
    );
    expect(
      sandboxPolicy({ QWEN_REVIEW_SANDBOX: 'auto' }, { sandbox: 'off' }),
    ).toBe('auto');
    expect(sandboxPolicy({}, { sandbox: 'required' })).toBe('required');
    // Today every review runs the reviewed code directly; turning that into a
    // container by default would change what native modules compile against
    // on machines nobody asked.
    expect(sandboxPolicy({}, {})).toBe('off');
    // A garbled value is not a policy — it falls through rather than being
    // guessed at.
    expect(sandboxPolicy({ QWEN_REVIEW_SANDBOX: 'yes' }, {})).toBe('off');
  });
});

describe('values a repository must not be able to set', () => {
  // `loadEnvironment` walks up from cwd and applies `<repo>/.qwen/.env` —
  // repository content, from the checkout under review, admitted by default
  // because folder trust starts off. So `process.env` is NOT the operator's
  // alone, and every containment decision read from it needs to know which
  // half it came from. The policy is additionally protected by only ever
  // tightening; these three have no such ordering to fall back on.

  it('ignores a repo-shipped image override — the image IS the code', () => {
    vi.stubEnv('QWEN_REVIEW_SANDBOX_IMAGE', 'attacker.example/rogue:1');
    const spy = vi
      .spyOn(environment, 'isFileSourcedEnvKey')
      .mockImplementation((k) => k === 'QWEN_REVIEW_SANDBOX_IMAGE');
    try {
      expect(reviewSandboxImage()).not.toContain('attacker.example');
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  // Skipped, not returned early: an early return reports PASSED with zero
  // assertions, which reads on the Windows lane as "this held" when nothing
  // was checked.
  it.skipIf(process.getuid === undefined)(
    'ignores a repo-shipped SANDBOX_SET_UID_GID=false',
    () => {
      // Left honoured, a committed opt-out puts the container back to root and
      // leaves root-owned residue the host pipeline cannot sweep.
      vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
      const spy = vi
        .spyOn(environment, 'isFileSourcedEnvKey')
        .mockImplementation((k) => k === 'SANDBOX_SET_UID_GID');
      try {
        const { args } = containerCommand('npm ci', {
          cwd: join(sep, 'repo', '.qwen', 'tmp', 'review-pr-9'),
          tmpDir: join(sep, 'repo', '.qwen', 'tmp'),
          kind: 'install',
          runtime: 'docker',
          image: 'example/image:tag',
          rootless: false,
          name: 'qwen-review-test',
        });
        expect(args).toContain('--user');
      } finally {
        spy.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it('drops a repo-shipped DOCKER_HOST from the runtime client env', () => {
    // It decides WHICH daemon answers: a repository that ships one points the
    // availability probe and every `docker run` at a daemon it controls, so
    // `required` reads as satisfied and whatever that daemon returns is scored
    // as build, test and probe evidence.
    // By PROVENANCE, not by name. The list was the first design and it lost
    // twice — it named the daemon selectors and missed the proxy family, then
    // named those and missed `DOCKER_API_VERSION`, which selects nothing and
    // merely makes every call fail, turning `auto` containment off because the
    // probe reads a broken client as "no runtime". So the fixture includes a
    // key nobody would think to enumerate, and expects it gone too.
    const selectors = [
      'DOCKER_API_VERSION',
      'PATH',
      'SOMETHING_NOBODY_ENUMERATED',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'DOCKER_HOST',
      'DOCKER_CERT_PATH',
      'DOCKER_TLS_VERIFY',
      'DOCKER_CONTEXT',
      'CONTAINER_HOST',
      'DOCKER_CONFIG',
      'CONTAINERS_CONF',
      'CONTAINERS_REGISTRIES_CONF',
      'CONTAINERS_STORAGE_CONF',
    ];
    for (const key of selectors) vi.stubEnv(key, 'from-the-repo');
    const spy = vi
      .spyOn(environment, 'isFileSourcedEnvKey')
      .mockImplementation((k) => selectors.includes(k));
    try {
      const scrubbed = runtimeClientEnv();
      for (const key of selectors) expect(scrubbed[key]).toBeUndefined();
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
    }
    // An OPERATOR's own DOCKER_HOST — a remote engine, colima, rootless — is
    // untouched; only the file-sourced one is dropped. Without this half the
    // scrub could be "delete everything" and still ship green.
    vi.stubEnv('DOCKER_HOST', 'unix:///run/user/1000/docker.sock');
    try {
      expect(runtimeClientEnv()['DOCKER_HOST']).toBe(
        'unix:///run/user/1000/docker.sock',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the operator opt-out still works', () => {
  it.skipIf(process.getuid === undefined)(
    'honours SANDBOX_SET_UID_GID=false when it is the operator’s own',
    () => {
      // Both uid tests assert `--user` is PRESENT; without this one the
      // documented opt-out could stop working and nothing would say so.
      vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
      try {
        const { args } = containerCommand('npm ci', {
          cwd: join(sep, 'repo', '.qwen', 'tmp', 'review-pr-9'),
          tmpDir: join(sep, 'repo', '.qwen', 'tmp'),
          kind: 'install',
          runtime: 'docker',
          image: 'example/image:tag',
          rootless: false,
          name: 'qwen-review-test',
        });
        expect(args).not.toContain('--user');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});

describe('sandboxVerdict', () => {
  it('does not let an already-sandboxed session satisfy `required`', () => {
    // The first cut returned `direct` here, reasoning that the outer boundary
    // is the one the operator asked for. That is wrong for the property this
    // module is about: the CLI's own sandbox constrains the filesystem and the
    // network and hands the child `process.env` ENTIRE — and stripping the
    // secrets is half of what `required` promises. So `SANDBOX` is not a
    // shortcut past the policy; the runtime probe still decides.
    const got = sandboxVerdict(
      'required',
      { SANDBOX: 'qwen-code-abc123' },
      () => null,
    );
    expect(got.kind).toBe('refused');
    expect(got.kind === 'refused' && got.reason).toContain(
      'does not satisfy "required"',
    );
  });

  it('turns `required` with no runtime into a refusal a phase can act on', () => {
    // The refusal has to reach something that stops the phase. Left to "the
    // caller", no caller acted and `required` ran the reviewed code
    // unsandboxed with the full environment — the policy meant nothing.
    const tree = join(sep, 'repo', '.qwen', 'tmp', 'review-pr-9');
    const mounted = () => tree;
    const verdict = sandboxVerdict('required', {}, () => null);
    expect(
      refuseUnsandboxedPhase(tree, verdict, mounted, 'required'),
    ).toContain('no container runtime');
    // ...and a verdict that is not a refusal never stops one.
    expect(
      refuseUnsandboxedPhase(
        tree,
        sandboxVerdict('off', {}, () => null),
        mounted,
      ),
    ).toBe(null);
    expect(
      refuseUnsandboxedPhase(
        tree,
        sandboxVerdict('auto', {}, () => 'docker'),
        mounted,
        'auto',
      ),
    ).toBe(null);
  });

  it('refuses a phase a healthy runtime still cannot contain', () => {
    // "A runtime answered" is not containment. A `/review` of a local checkout
    // has no `.qwen/tmp` layout to mount, so the command falls through to the
    // direct spawn — with the full environment, and a report indistinguishable
    // from a contained run. The policy's question is whether THIS phase can be
    // contained, and the mount is the half that fails while the daemon is fine.
    const contained = sandboxVerdict('required', {}, () => 'docker');
    expect(contained.kind).toBe('container');
    const local = join(sep, 'home', 'me', 'myrepo');
    expect(
      refuseUnsandboxedPhase(local, contained, () => null, 'required'),
    ).toContain('cannot be mounted');

    // ...and ONLY under `required`. Under `auto` the contract is "contain it
    // when that is possible", so an unmountable tree falls back to the direct
    // spawn — refusing there would take the build/test and efficacy evidence
    // away from every local review the moment a daemon happened to be running.
    expect(refuseUnsandboxedPhase(local, contained, () => null, 'auto')).toBe(
      null,
    );
  });

  it('discloses rather than hides that the reviewed code ran as you', () => {
    const got = sandboxVerdict('off', {}, () => null);
    expect(got.kind).toBe('direct');
    expect(got.kind === 'direct' && got.disclose).toContain('ran as you');
  });
});

describe('the decisions this module exists to make', () => {
  // Cells the surrounding suite reached only by accident of the machine it ran
  // on. Each is a pure function with its ambient dependency already
  // injectable, so pinning them costs nothing and leaves no mutant alive on
  // the properties this feature is sold on.

  // Swept, like the `mountRootFor` block's: a suite about not leaving residue
  // behind has no business leaving a temp tree per run.
  const made: string[] = [];
  const fixture = (prefix: string): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it('lets the environment tighten the policy and never loosen it', () => {
    // "A repository cannot switch off the containment that exists to contain
    // it" is the whole claim. It rests on two halves, and both are asserted
    // here rather than described: strictest-wins in BOTH directions, and a
    // value the loader wrote from a file counting for nothing.
    expect(sandboxPolicy({ QWEN_REVIEW_SANDBOX: 'required' }, {})).toBe(
      'required',
    );
    // env stricter than settings → env
    expect(
      sandboxPolicy({ QWEN_REVIEW_SANDBOX: 'required' }, { sandbox: 'auto' }),
    ).toBe('required');
    // settings stricter than env → settings. The direction that matters: an
    // operator's opt-in cannot be undone by an environment variable.
    expect(
      sandboxPolicy({ QWEN_REVIEW_SANDBOX: 'off' }, { sandbox: 'required' }),
    ).toBe('required');
    // ...and a FILE-SOURCED env value is not read at all, so a repository
    // shipping `QWEN_REVIEW_SANDBOX` in its own `.env` cannot even tighten,
    // let alone loosen.
    expect(
      sandboxPolicy(
        { QWEN_REVIEW_SANDBOX: 'off' },
        { sandbox: 'required' },
        () => true,
      ),
    ).toBe('required');
    expect(
      sandboxPolicy(
        { QWEN_REVIEW_SANDBOX: 'required' },
        { sandbox: 'off' },
        () => true,
      ),
    ).toBe('off');
  });

  it('reads either side the way an operator would write it', () => {
    // The env half was normalised and the settings half was not, and the
    // asymmetry fell the wrong way: settings.json is the documented place to
    // turn this ON, so `"Required"` — or a stray trailing space — matched no
    // policy, resolved to `off`, and disabled the control without a word.
    // Fail-open on the one setting whose entire purpose is to fail closed.
    expect(sandboxPolicy({}, { sandbox: 'Required' })).toBe('required');
    expect(sandboxPolicy({}, { sandbox: 'required ' })).toBe('required');
    expect(sandboxPolicy({ QWEN_REVIEW_SANDBOX: 'Required' }, {})).toBe(
      'required',
    );
    expect(sandboxPolicy({ QWEN_REVIEW_SANDBOX: ' required ' }, {})).toBe(
      'required',
    );
    // Every policy, not just the strict one: normalisation keyed on the value
    // it was reported against would leave an operator's `"Auto"` resolving to
    // `off` — the same silent downgrade one rung lower.
    expect(sandboxPolicy({}, { sandbox: 'Auto' })).toBe('auto');
    expect(sandboxPolicy({ QWEN_REVIEW_SANDBOX: 'Auto' }, {})).toBe('auto');
    expect(sandboxPolicy({}, { sandbox: 'OFF' })).toBe('off');

    // A value that is not a policy at all still resolves to `off` — the
    // normalisation widens spelling, not the set of accepted values.
    expect(sandboxPolicy({}, { sandbox: 'requiredish' })).toBe('off');
    // ...and an unreadable ENVIRONMENT value is dropped on its own rather than
    // taking the operator's setting down with it. This is the cell that
    // matters: the environment is the half a repository can reach, so garbage
    // there must never be able to answer for the half it cannot.
    expect(
      sandboxPolicy(
        { QWEN_REVIEW_SANDBOX: 'yes-please' },
        { sandbox: 'required' },
      ),
    ).toBe('required');
  });

  it('reads the process environment when no env is passed', () => {
    // The other production default, and the twin of the settings one below:
    // every assertion in this block hands `sandboxPolicy` an env literal, so
    // `env = {}` as the default stops the environment half from being read at
    // all and nothing here notices.
    vi.stubEnv('QWEN_REVIEW_SANDBOX', 'required');
    try {
      expect(sandboxPolicy(undefined, {})).toBe('required');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads the operator settings file when no settings are passed', () => {
    // The production shape: every real caller takes the default. With the
    // default replaced by `{}` the whole settings half stops being consulted
    // and every other assertion here — which passes settings explicitly —
    // stays green.
    const isolation = isolateOperatorReviewSettings();
    try {
      writeFileSync(
        join(isolation.home, 'settings.json'),
        JSON.stringify({ review: { sandbox: 'required' } }),
      );
      expect(sandboxPolicy({})).toBe('required');
    } finally {
      isolation.dispose();
    }
  });

  it('falls back to running directly under `auto` when nothing answers', () => {
    // The cell that makes `auto` usable on a machine without a runtime — and
    // the one a mutant turning it into a refusal would sail through, because
    // every other test either has a runtime or is not `auto`.
    const verdict = sandboxVerdict('auto', {}, () => null);
    expect(verdict.kind).toBe('direct');
    // `required` with the same absent runtime is the opposite answer, so this
    // is about the policy and not about the probe.
    expect(sandboxVerdict('required', {}, () => null).kind).toBe('refused');
  });

  it('passes the phase when `required` is actually satisfiable', () => {
    // Every other assertion about this gate is a refusal. Without the pass
    // path, a mutant refusing unconditionally under `required` — which would
    // make the feature refuse every review on a perfectly good host — leaves
    // the suite green.
    const verdict = { kind: 'container', runtime: 'docker' } as const;
    expect(
      refuseUnsandboxedPhase(
        join(sep, 'repo', '.qwen', 'tmp', 'review-pr-9'),
        verdict,
        () => join(sep, 'repo', '.qwen', 'tmp'),
        'required',
      ),
    ).toBeNull();
    // ...and the same satisfiable verdict against a root that cannot be
    // mounted still refuses, so the null above is the pass and not a hole.
    expect(
      refuseUnsandboxedPhase(
        join(sep, 'elsewhere', 'review-pr-9'),
        verdict,
        () => null,
        'required',
      ),
    ).toContain('cannot be mounted');
  });

  it('takes the first runtime whose daemon answers, in order', () => {
    // Order is the content: a client installed but not running must never
    // shadow one that is. With the loop reversed or short-circuited on the
    // first NAME rather than the first ANSWER, `auto` silently picks a runtime
    // that cannot run anything and the phase degrades to direct.
    expect(firstAnsweringRuntime(() => true)).toBe('docker');
    expect(firstAnsweringRuntime((rt) => rt === 'podman')).toBe('podman');
    expect(firstAnsweringRuntime(() => false)).toBeNull();
  });

  it('reaps by name, with the flag that makes it a kill', () => {
    // The reap runs after a deadline already cost the phase its result, so
    // nothing downstream would notice a garbled argv — and what survives is a
    // container holding the review tree open past the end of the run. `-f`,
    // because a container that ignored the client's signal is exactly the one
    // this is for.
    const calls: Array<[string, readonly string[]]> = [];
    const spawn = ((file: string, args: readonly string[]) => {
      calls.push([file, args]);
      return { status: 0 } as ReturnType<typeof spawnSync>;
    }) as unknown as typeof spawnSync;
    killContainer('podman', 'qwen-review-1-abc-0', spawn);
    expect(calls).toEqual([['podman', ['rm', '-f', 'qwen-review-1-abc-0']]]);

    // Best-effort by construction: a reap that throws must not become a second
    // failure on top of the timeout that is already being reported.
    const throwing = (() => {
      throw new Error('no daemon');
    }) as unknown as typeof spawnSync;
    expect(() =>
      killContainer('docker', 'qwen-review-1-abc-1', throwing),
    ).not.toThrow();
  });

  it('spells the workdir canonically, and survives a tree not built yet', () => {
    // This feeds `--workdir` at both spawn sites: a lexical spelling names a
    // directory the container does not have, and every command fails before
    // it starts.
    const root = fixture('qwen-workdir-');
    const real = join(root, 'review-pr-9');
    mkdirSync(real);
    expect(containerPathFor(real)).toBe(realpathSync(real));

    // A path reached through a link resolves to the canonical spelling the
    // mount actually carries.
    const link = join(root, 'link-to-tree');
    symlinkSync(real, link);
    expect(containerPathFor(link)).toBe(realpathSync(real));

    // The probe tree is NAMED before it is created; its parent exists, and
    // the fallback canonicalises that and re-attaches the leaf.
    const unborn = join(link, 'not-created-yet');
    expect(containerPathFor(unborn)).toBe(
      join(realpathSync(real), 'not-created-yet'),
    );
  });
});

describe('containerCommand', () => {
  const tmpDir = join(sep, 'repo', '.qwen', 'tmp');
  const base = {
    tmpDir,
    runtime: 'docker' as const,
    image: 'example/image:tag',
    name: 'qwen-review-test',
    rootless: false,
  };

  // Skipped rather than returned early, for the same reason as the sibling
  // above: an early return reports PASSED with nothing asserted.
  it.skipIf(process.getuid === undefined || process.getgid === undefined)(
    'drops --user on a rootless runtime and keeps it on a rootful one',
    () => {
      // Rootless engines map the container's uid onto a host SUBUID, so naming
      // the host uid here hands the container process an identity that owns
      // nothing in the tree it is mounted on: `npm ci` cannot create
      // `node_modules`, and whatever it does create comes out unsweepable. The
      // container's root already IS the invoking user there, so the flag's job
      // is done without it. On a rootful engine it is still the only thing
      // between the reviewed code and real uid 0 on the mount.
      //
      // The documented opt-out is a real thing an operator exports, and it
      // removes the very flag this asserts — without pinning it off, this test
      // reports a failure of the code in a shell where the code is correct.
      // Restored in a `finally`, so a failing assertion below fails THIS test
      // instead of leaking the stub into whichever test runs next.
      vi.stubEnv('SANDBOX_SET_UID_GID', '');
      try {
        const cwd = join(tmpDir, 'review-pr-9');
        const rootful = containerCommand('npm ci', {
          ...base,
          cwd,
          kind: 'install',
        });
        expect(rootful.args).toContain('--user');
        // Optional-called because the skipIf guard above cannot narrow these
        // for the compiler; the test does not run where they are undefined.
        expect(rootful.args[rootful.args.indexOf('--user') + 1]).toBe(
          `${process.getuid?.()}:${process.getgid?.()}`,
        );

        const rootless = containerCommand('npm ci', {
          ...base,
          cwd,
          kind: 'install',
          rootless: true,
        });
        expect(rootless.args).not.toContain('--user');
        // Everything else is the SAME run — dropping --user must not quietly take
        // the mount, the tmpfs HOME or the image with it.
        expect(rootless.args).toContain('--volume');
        expect(rootless.args).toContain('--tmpfs');
        expect(rootless.args.at(-4)).toBe(base.image);

        // The opt-out is read case- and space-insensitively, so an operator
        // who exports `False` gets the documented behaviour rather than a
        // flag they thought they had turned off.
        vi.stubEnv('SANDBOX_SET_UID_GID', ' False ');
        expect(
          containerCommand('npm ci', { ...base, cwd, kind: 'install' }).args,
        ).not.toContain('--user');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('answers rootful when the runtime will not say', () => {
    // The unknown case must land on the LOUD side: keeping `--user` breaks a
    // rootless run visibly, dropping it on a rootful engine runs the reviewed
    // code as real uid 0 on a writable mount and says nothing. An empty
    // document is how "could not tell" reaches the predicate.
    expect(runtimeIsRootless('podman', () => '')).toBe(false);
    expect(
      runtimeIsRootless(
        'podman',
        () => '{"host":{"security":{"rootless":true}}}',
      ),
    ).toBe(true);
    // ...and a runtime that is not on this machine produces exactly that empty
    // document rather than throwing out of the argv builder.
    expect(readInfoDocument('qwen-no-such-runtime' as never)).toBe('');
  });

  it("reads rootlessness out of either runtime's info document", () => {
    // The negative case is a LIVE rootful docker's actual `info` output
    // (docker 29.5.2), not a hand-written stub: the marker search only holds
    // if the word genuinely does not occur in a rootful document, and a stub
    // written by the same hand that wrote the matcher cannot show that.
    expect(
      hasRootlessMarker(
        '{"SecurityOptions":["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"],"ServerVersion":"29.5.2","OperatingSystem":"Ubuntu 24.04.4 LTS"}',
      ),
    ).toBe(false);
    // docker spells it as a security option...
    expect(
      hasRootlessMarker(
        '{"SecurityOptions":["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]}',
      ),
    ).toBe(true);
    // ...podman as a field under Host.Security, which is why this searches the
    // document rather than one runtime's schema path.
    expect(
      hasRootlessMarker(
        '{"host":{"security":{"rootless":true,"seccompEnabled":true}}}',
      ),
    ).toBe(true);
    expect(hasRootlessMarker('{"host":{"security":{"rootless":false}}}')).toBe(
      false,
    );
    // Go marshals an exported field under its own name unless a tag renames
    // it, so the capitalised spelling is a real shape, not a defensive guess.
    expect(hasRootlessMarker('{"Host":{"Security":{"Rootless":true}}}')).toBe(
      true,
    );
  });

  it('mounts the review temp dir, not the tree the command runs in', () => {
    // The dependency farm links OUT of every tree: each package in the probe
    // tree's `node_modules` points at the review worktree's copy (1 722 of
    // them on a live CI review). Mounting the probe tree alone would leave
    // every one of those dangling and no probe would resolve a dependency.
    const probeTree = join(tmpDir, 'review-pr-9-probe');
    const { file, args } = containerCommand('npm test', {
      ...base,
      cwd: probeTree,
      kind: 'test',
    });

    expect(file).toBe('docker');
    const mount = args[args.indexOf('--volume') + 1];
    expect(mount).toBe(`${tmpDir}:${tmpDir}`);
    expect(mount).not.toContain('-probe');
    // ...and the command still RUNS in the tree.
    expect(args[args.indexOf('--workdir') + 1]).toBe(probeTree);
    // `<repo>/.git` — the filter/fsmonitor/replace surface — is outside it.
    expect(mount.startsWith(join(sep, 'repo', '.git'))).toBe(false);
  });

  it('gives the network to an install and to nothing else', () => {
    const cwd = join(tmpDir, 'review-pr-9');
    const install = containerCommand('npm ci', {
      ...base,
      cwd,
      kind: 'install',
    });
    // Both argv shapes: the separated form this builds, and the joined
    // `--network=none` a refactor could switch to, which `not.toContain('none')`
    // alone would not see.
    expect(install.args.some((a) => a.startsWith('--network'))).toBe(false);
    expect(install.args).not.toContain('none');

    for (const kind of ['build', 'test'] as const) {
      const r = containerCommand('npm run build', { ...base, cwd, kind });
      expect(r.args[r.args.indexOf('--network') + 1]).toBe('none');
    }
  });

  it('hands the reviewed code an env allowlist, never the inherited one', () => {
    // This is the finding the design is built on: both call sites used to give
    // the PR's code `process.env`, which on CI carries the review's model and
    // GitHub credentials. A `postinstall` reading them is one line.
    const env = containerEnv('/cache-in-mount');
    expect(env).toEqual([
      'CI=1',
      'npm_config_yes=true',
      'QWEN_SKIP_PREPARE=1',
      // HOME is a tmpfs path, NOT under the mount: `sh -lc` sources
      // `$HOME/.profile` and npm reads `$HOME/.npmrc`, so a HOME on the shared
      // mount lets one run plant what the next one executes — across `--rm`
      // and across reviews.
      `HOME=${CONTAINER_HOME}`,
      'npm_config_cache=/cache-in-mount',
    ]);

    // A PLANTED canary, not whatever the runner's shell happens to export:
    // the regression this guards against is `containerCommand` forwarding the
    // inherited environment, and on a box exporting no TOKEN/KEY/SECRET the
    // old form shipped green.
    vi.stubEnv('OPENAI_API_KEY', 'canary-should-not-cross');
    vi.stubEnv('GH_TOKEN', 'canary-should-not-cross');
    try {
      const { args } = containerCommand('npm ci', {
        ...base,
        cwd: join(tmpDir, 'review-pr-9'),
        kind: 'install',
      });
      const passed = args.filter((_, i) => args[i - 1] === '--env');
      expect(passed.some((e) => e.includes('canary-should-not-cross'))).toBe(
        false,
      );
      // ...and the WIRING, not just `containerEnv` called with a literal: HOME
      // must be the tmpfs the argv also declares, or the mapped uid has no
      // writable home and npm fails before the install starts.
      expect(passed).toContain(`HOME=${CONTAINER_HOME}`);
      const tmpfs = args[args.indexOf('--tmpfs') + 1];
      expect(tmpfs.startsWith(`${CONTAINER_HOME}:`)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Windows has no `process.getuid`, so the flag is correctly absent there —
  // and the merge queue runs this file on Windows.
  it.skipIf(process.getuid === undefined)(
    'maps the host uid so its writes stay removable from the host',
    () => {
      // The container writes into a mount the HOST then cleans up — `node_modules`
      // after an install timeout, the tree at `discardWorktree`, the sweeps. Root
      // in the container makes every one of those EACCES, and the residue
      // accumulates across reviews: the cross-run-state class #9221 closed.
      // The documented opt-out (`SANDBOX_SET_UID_GID=false`) is something a
      // developer's own shell may carry, which would fail this spuriously; it
      // is stubbed rather than assumed.
      vi.stubEnv('SANDBOX_SET_UID_GID', 'true');
      try {
        const { args } = containerCommand('npm ci', {
          ...base,
          cwd: join(tmpDir, 'review-pr-9'),
          kind: 'install',
        });
        const user = args[args.indexOf('--user') + 1];
        expect(user).toBe(`${process.getuid?.()}:${process.getgid?.()}`);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('names the container so a deadline can reach it', () => {
    // `--rm` fires only when the container exits on its own, and a `spawnSync`
    // timeout kills the runtime CLIENT: measured on docker 29.1.3, an attached
    // client forwards the signal and waits, so a workload whose own trap
    // ignores it keeps running with this mount writable — past the budget and
    // past the end of the review. Without a name there is nothing to aim at.
    const { args } = containerCommand('npm test', {
      ...base,
      cwd: join(tmpDir, 'review-pr-9-probe'),
      kind: 'test',
    });
    expect(args[args.indexOf('--name') + 1]).toBe(base.name);
    // ...and two calls never collide, or one run's cleanup would reach
    // another's container.
    expect(containerName()).not.toBe(containerName());
  });

  it('runs one ephemeral container per command', () => {
    // Not one long-lived container per phase: that would be cheaper by about
    // a percent of the efficacy budget and would re-introduce the cross-run
    // state this pipeline spent rounds closing.
    const { args } = containerCommand('npm test', {
      ...base,
      cwd: join(tmpDir, 'review-pr-9-probe'),
      kind: 'test',
    });
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
  });

  it('passes the command to a shell inside, not to the host', () => {
    const { args } = containerCommand('npm ci && npm test', {
      ...base,
      cwd: join(tmpDir, 'review-pr-9'),
      kind: 'install',
    });
    expect(args.slice(-3)).toEqual(['sh', '-lc', 'npm ci && npm test']);
  });
});

describe('handOffRefused', () => {
  it('turns the agent-shell hand-off into a refusal under `required`', () => {
    // `unsupportedReport` tells the agent to install and build with its own
    // shell — contained by nothing here — and the phase gate cannot catch it,
    // because that gate passes exactly when a runtime answered and the tree is
    // mountable, which is when a repo the adapters cannot scope still reaches
    // the hand-off.
    expect(handOffRefused('unsupported', 'required')).toBe(true);
    // Under the other policies a hand-off is what it has always been.
    expect(handOffRefused('unsupported', 'auto')).toBe(false);
    expect(handOffRefused('unsupported', 'off')).toBe(false);
    // ...and a real run is never converted.
    expect(handOffRefused('npm', 'required')).toBe(false);
    expect(handOffRefused('refused', 'required')).toBe(false);
  });
});

describe('boxedRunLeftContainer', () => {
  it('reaps for every abnormal exit, not just the timeout', () => {
    // The first cut reaped on `spawnTimedOut` alone. A `maxBuffer` overflow —
    // a reviewed command writing 64 MB to one stream, which a postinstall can
    // do — kills the client with ENOBUFS and no timeout, so the container kept
    // the review temp dir mounted read-write past the end of the review. The
    // two call sites had also drifted to different conditions, which is how one
    // came to miss a case the other caught.
    expect(boxedRunLeftContainer(null)).toBe(true); // ETIMEDOUT, ENOBUFS, signal
    // A normal exit needs no reaping — `--rm` has already fired.
    expect(boxedRunLeftContainer(0)).toBe(false);
    expect(boxedRunLeftContainer(1)).toBe(false);
  });
});

describe('mountRootFor', () => {
  // Real directories, because the function is no longer lexical: it realpaths
  // the root and refuses a redirected ancestor, and a fixture of invented
  // paths would pin the arithmetic while missing both.
  const made: string[] = [];
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-mount-'));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  // Every absolute Windows path carries a colon — the drive letter — so the
  // check below refuses all of them there. That is the shipped behaviour (see
  // `mountRootFor`, and the win32 test at the end of this block), but it makes
  // "which root is mountable" a question Windows cannot be asked, and these
  // three cases exist only to ask it. `test_windows` is merge_group-only, so
  // an ungated assertion here would first go red inside the merge queue.
  const itWhereRootsCanMount = it.skipIf(process.platform === 'win32');

  itWhereRootsCanMount('refuses a root the -v grammar cannot spell', () => {
    // `-v src:dst` has exactly one separator. A checkout at `/…/my:repo` makes
    // the spec `…/my:repo/.qwen/tmp:…/my:repo/.qwen/tmp`, which docker rejects
    // as "too many colons" — measured, not assumed. Saying "mountable" about
    // that root sends every command in the phase into a raw mount error
    // instead of the fallback (`auto`) or the refusal (`required`) already
    // written for roots that cannot be mounted.
    const root = tmp();
    const colon = join(root, 'my:repo', '.qwen', 'tmp', 'review-pr-9');
    mkdirSync(colon, { recursive: true });
    expect(mountRootFor(colon)).toBeNull();
    // The comparison case, so this is a statement about the colon and not
    // about a deep path: docker takes a comma in a `-v` spec without complaint.
    const comma = join(root, 'my,repo', '.qwen', 'tmp', 'review-pr-9');
    mkdirSync(comma, { recursive: true });
    expect(mountRootFor(comma)).not.toBeNull();
  });

  itWhereRootsCanMount('takes the DEEPEST temp dir, not the first', () => {
    // A review run from inside another review's worktree — this pipeline's own
    // dogfood geometry — nests one `.qwen/tmp` inside another. First-occurrence
    // search widens the mount to the OUTER temp dir, which pulls `<repo>/.git`
    // and every sibling checkout into the container and defeats the one
    // property the mount exists for.
    const root = tmp();
    const inner = join(
      root,
      '.qwen',
      'tmp',
      'checkouts',
      'myrepo',
      '.qwen',
      'tmp',
    );
    mkdirSync(join(inner, 'review-pr-1-probe'), { recursive: true });

    expect(mountRootFor(join(inner, 'review-pr-1-probe'))).toBe(
      realpathSync(inner),
    );
  });

  itWhereRootsCanMount(
    'refuses a root reached through a symlink instead of mounting it',
    () => {
      // `resolve` never touches the filesystem, so a link at or above
      // `.qwen/tmp` — committable as mode 120000, materialised by a fresh clone
      // — would silently widen a read-write bind mount to wherever it points.
      // Every other creating or destroying path in this pipeline refuses that.
      const root = tmp();
      const elsewhere = tmp();
      mkdirSync(join(elsewhere, 'tmp', 'review-pr-1'), { recursive: true });
      mkdirSync(join(root, '.qwen'), { recursive: true });
      symlinkSync(join(elsewhere, 'tmp'), join(root, '.qwen', 'tmp'));

      expect(mountRootFor(join(root, '.qwen', 'tmp', 'review-pr-1'))).toBe(
        null,
      );

      // ...and the same layout without the link is mounted normally, so the
      // refusal is about the redirect and not about the shape.
      const honest = tmp();
      mkdirSync(join(honest, '.qwen', 'tmp', 'review-pr-1'), {
        recursive: true,
      });
      expect(mountRootFor(join(honest, '.qwen', 'tmp', 'review-pr-1'))).toBe(
        realpathSync(join(honest, '.qwen', 'tmp')),
      );
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'refuses every absolute path on Windows, where the drive letter is a colon',
    () => {
      // The other side of the same coin, and the reason the three above are
      // skipped rather than deleted: containment is unavailable on Windows —
      // this mount uses one path as both source and target, and the container
      // side has no `C:` — so refusing is the honest answer, not a casualty.
      const root = tmp();
      const tree = join(root, '.qwen', 'tmp', 'review-pr-1');
      mkdirSync(tree, { recursive: true });
      // The layout has to EXIST first. Named at a path that does not, this
      // returns null out of the realpath catch and says nothing at all about
      // the drive letter — the first version of this test did exactly that,
      // and a build with the colon check deleted passed it.
      expect(existsSync(tree)).toBe(true);
      expect(mountRootFor(tree)).toBe(null);
    },
  );

  it('is null outside a temp dir, so a local checkout is never mounted', () => {
    // `/review` of a local checkout has no sibling layout: the tree under test
    // IS the user's working copy.
    const root = tmp();
    expect(mountRootFor(join(root, 'myrepo'))).toBe(null);
  });
});

describe('reviewSandboxImage', () => {
  it('is overridable, because one image cannot carry every toolchain', () => {
    expect(reviewSandboxImage({ QWEN_REVIEW_SANDBOX_IMAGE: 'mine:1' })).toBe(
      'mine:1',
    );
    // The operator's own sandbox image, if they configured one for
    // `qwen --sandbox`, rather than ignoring it and pulling a second one.
    expect(reviewSandboxImage({ QWEN_SANDBOX_IMAGE: 'theirs:2' })).toBe(
      'theirs:2',
    );
    // ORDER, with both set at once — the only way a reordering of the chain
    // can be seen. Reviewed-repository-specific beats the operator's general
    // one, because the review override exists for a toolchain the repository
    // declared it needs; the other way round runs the build in an image
    // missing it.
    expect(
      reviewSandboxImage({
        QWEN_REVIEW_SANDBOX_IMAGE: 'mine:1',
        QWEN_SANDBOX_IMAGE: 'theirs:2',
      }),
    ).toBe('mine:1');
    expect(
      reviewSandboxImage({
        QWEN_CODE_CUSTOM_SANDBOX_IMAGE: 'custom:3',
        QWEN_SANDBOX_IMAGE: 'theirs:2',
      }),
    ).toBe('custom:3');
    expect(
      reviewSandboxImage({
        QWEN_REVIEW_SANDBOX_IMAGE: 'mine:1',
        QWEN_CODE_CUSTOM_SANDBOX_IMAGE: 'custom:3',
      }),
    ).toBe('mine:1');
  });

  it('consults the manifest, and falls back to a name that exists', () => {
    // These two cannot be told apart by their VALUE: `DEFAULT_IMAGE`'s tag is
    // `CLI_VERSION`, generated from the same manifest version, so today the
    // fallback string-equals the manifest field. Deleting the manifest lookup
    // entirely therefore leaves the pin below green. Injecting the reader is
    // what makes the mechanism visible at all.
    expect(reviewSandboxImage({}, () => 'manifest-image:test')).toBe(
      'manifest-image:test',
    );
    // ...and when the manifest cannot be found — the unusual install layout
    // the literal exists for — the argv still names something that resolves.
    // This is the branch the defect this PR fixes lived in: with no coverage,
    // reverting it to an unpullable name ships green.
    const fallback = reviewSandboxImage({}, () => undefined);
    expect(fallback).toBe(`ghcr.io/qwenlm/qwen-code:${CLI_VERSION}`);
    expect(fallback).not.toContain('/sandbox');
    expect(fallback).not.toContain(':latest');
  });

  it('defaults to the image this CLI actually ships with', () => {
    // Pinned against the MANIFEST, not against a spelling. The assertion this
    // replaces was `toContain('sandbox')`, which is how a default of
    // `ghcr.io/qwenlm/qwen-code/sandbox:latest` shipped: it contains the word,
    // it is not the CLI's image, and it does not resolve at all — an anonymous
    // manifest request answers 403 where the real one answers 200, so every
    // command of an opted-in review failed at image pull. Nineteen rounds of
    // argv-level review could not see it because no container was ever
    // started. The real image happens NOT to contain "sandbox", so the old
    // assertion would fail on the correct value and pass on the broken one.
    const manifest = JSON.parse(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          '..',
          '..',
          '..',
          '..',
          'package.json',
        ),
        'utf8',
      ),
    ) as { config?: { sandboxImageUri?: string } };
    expect(manifest.config?.sandboxImageUri).toBeTruthy();
    expect(reviewSandboxImage({})).toBe(manifest.config?.sandboxImageUri);
  });
});
