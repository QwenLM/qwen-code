import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { touchesManagedAgent } from '../../.github/scripts/managed-agent-gate-scope.mjs';

const gate = parse(
  readFileSync('.github/workflows/managed-agent-gate.yml', 'utf8'),
);
const sdkJava = parse(readFileSync('.github/workflows/sdk-java.yml', 'utf8'));

// Evaluates the &&/||/==/!= subset of a GitHub expression that these
// workflows use; both languages return the winning operand.
function evaluate(text, context) {
  const body = String(text)
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .replace(/!=/g, '!==')
    .replace(/([^!=])==/g, '$1===')
    .replace(/\bfromJSON\(/g, 'JSON.parse(')
    .replace(/\bformat\(/g, 'format(');
  const format = (pattern, ...args) =>
    pattern.replace(/\{(\d+)\}/g, (_, i) => String(args[i]));
  return new Function(
    'github',
    'needs',
    'inputs',
    'format',
    `return (${body});`,
  )(context.github ?? {}, context.needs ?? {}, context.inputs ?? {}, format);
}

const interpolate = (text, context) =>
  String(text).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr) =>
    String(evaluate(expr, context)),
  );

const github = (eventName, event = {}) => ({
  event_name: eventName,
  sha: 'merge-sha',
  ref: 'refs/pull/7/merge',
  event: { review: {}, pull_request: {}, ...event },
});

describe('Managed Agent gate scope', () => {
  it.each([
    'packages/managed-agent-server/src/main/java/A.java',
    'packages/sdk-java/qwencode/pom.xml',
    'packages/cli/src/serve/server.ts',
    'packages/core/src/managed-runtime/runtime.ts',
    'integration-tests/helpers/hosted-harness-process.ts',
    'integration-tests/vitest.hosted.config.ts',
    'scripts/run-managed-agent-server-e2e.ts',
    '.github/workflows/sdk-java.yml',
    '.github/workflows/managed-agent-gate.yml',
    '.github/scripts/managed-agent-gate-scope.mjs',
  ])('runs the suite for %s', (path) => {
    expect(touchesManagedAgent(['README.md', path])).toBe(true);
  });

  it.each([
    'README.md',
    'packages/cli/src/ui/App.tsx',
    'packages/core/src/tools/shell.ts',
    'packages/web-shell/client/App.tsx',
    'integration-tests/cli/run.test.ts',
    '.github/workflows/ci.yml',
  ])('leaves %s to the nightly run', (path) => {
    expect(touchesManagedAgent([path])).toBe(false);
  });

  it('reads paths from stdin when run as a script', () => {
    const run = (input) =>
      spawnSync('node', ['.github/scripts/managed-agent-gate-scope.mjs'], {
        input,
        encoding: 'utf8',
      }).stdout;
    expect(run('docs/a.md\npackages/sdk-java/x\n')).toBe('true\n');
    expect(run('docs/a.md\n')).toBe('false\n');
    expect(run('')).toBe('false\n');
  });
});

describe('Managed Agent gate path matching', () => {
  // The step's git pipeline is what produces the matcher's input, and its
  // failure modes (a quoted non-ASCII path, a rename reported as only its
  // destination, a review run diffing the head's parent) all classify a
  // touched change as untouched — so the cases below run the step body
  // against real fixture repositories instead of feeding the matcher
  // literals.
  const step = gate.jobs.scope.steps.find(
    (s) => s.name === 'Match the changed paths',
  );
  const root = mkdtempSync(join(tmpdir(), 'managed-agent-paths-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    }
    return result.stdout.trim();
  };
  const commit = (repo, message) => {
    git(repo, 'add', '-A');
    git(
      repo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=test',
      'commit',
      '-qm',
      message,
    );
    return git(repo, 'rev-parse', 'HEAD');
  };
  const write = (repo, path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };

  // build fills an origin repository and returns { base, head }; the
  // workspace fetches its head from that origin, exactly as the step later
  // fetches the base by sha (which a file:// remote allows).
  const workspace = (name, build) => {
    const origin = join(root, `${name}-origin`);
    mkdirSync(origin, { recursive: true });
    git(origin, 'init', '-q');
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const refs = build(origin);
    const ws = join(root, name);
    mkdirSync(join(ws, '.github', 'scripts'), { recursive: true });
    copyFileSync(
      '.github/scripts/managed-agent-gate-scope.mjs',
      join(ws, '.github', 'scripts', 'managed-agent-gate-scope.mjs'),
    );
    git(ws, 'init', '-q');
    git(ws, 'remote', 'add', 'origin', `file://${origin}`);
    git(ws, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', refs.head);
    git(ws, 'checkout', '-q', 'FETCH_HEAD');
    return { ws, ...refs };
  };

  const runPaths = (ws, env) => {
    const output = join(root, `output-${Math.random()}`);
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', step.run], {
      cwd: ws,
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        EVENT_NAME: '',
        PUSH_BEFORE: '',
        MERGE_GROUP_BASE: '',
        ...env,
      },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    );
  };

  it('matches a touched path whose name needs quoting', () => {
    const { ws, base } = workspace('quoted-path', (origin) => {
      write(origin, 'README.md', 'a');
      const base = commit(origin, 'base');
      write(origin, 'packages/managed-agent-server/src/Caf\u00e9.java', 'c');
      return { base, head: commit(origin, 'cafe') };
    });
    expect(
      runPaths(ws, { EVENT_NAME: 'push', PUSH_BEFORE: base }).touched,
    ).toBe('true');
  });

  it("counts a rename's source path, not only its destination", () => {
    const { ws, base } = workspace('rename', (origin) => {
      write(origin, 'packages/managed-agent-server/src/A.java', 'a');
      const base = commit(origin, 'base');
      git(origin, 'mv', 'packages/managed-agent-server/src/A.java', 'A.java');
      return { base, head: commit(origin, 'move out') };
    });
    expect(
      runPaths(ws, { EVENT_NAME: 'push', PUSH_BEFORE: base }).touched,
    ).toBe('true');
  });

  it('treats an all-zero before as touched without fetching', () => {
    const { ws } = workspace('zero-base', (origin) => {
      write(origin, 'README.md', 'a');
      const base = commit(origin, 'base');
      return { base, head: base };
    });
    expect(
      runPaths(ws, {
        EVENT_NAME: 'push',
        PUSH_BEFORE: '0000000000000000000000000000000000000000',
      }).touched,
    ).toBe('true');
  });
});

describe('Managed Agent gate triggers', () => {
  it('runs on every PR, approval, main push and merge group', () => {
    expect(gate.on).toEqual({
      pull_request: { branches: ['main'] },
      pull_request_review: { types: ['submitted'] },
      push: { branches: ['main'] },
      merge_group: null,
    });
  });

  it('calls the SDK Java suite with the selected commit and tier', () => {
    expect(gate.jobs.suite).toMatchObject({
      needs: 'scope',
      if: "${{ needs.scope.outputs.tier != 'none' }}",
      uses: './.github/workflows/sdk-java.yml',
      with: {
        ref: '${{ needs.scope.outputs.sha }}',
        tier: '${{ needs.scope.outputs.tier }}',
      },
    });
  });

  it('groups every event of one pull request so a push cancels its approval run', () => {
    const group = (ctx) => interpolate(gate.concurrency.group, ctx);
    const review = (state, sha, id = 1) =>
      github('pull_request_review', {
        review: { state, id },
        pull_request: { number: 7, head: { sha } },
      });
    const pr = (number) => github('pull_request', { pull_request: { number } });
    const push = (sha) => ({ github: { ...github('push'), sha } });
    // One group per pull request across pushes and approvals: a push
    // that supersedes an in-flight approval run must be able to cancel it,
    // since that run reports a head branch protection no longer reads.
    expect(group({ github: pr(7) })).toBe(
      group({ github: review('approved', 'h1') }),
    );
    expect(group({ github: review('approved', 'h1') })).toBe(
      group({ github: review('approved', 'h2', 2) }),
    );
    // A group keeps one pending run and a newcomer cancels it, so a comment
    // or change request must stay out of the pull request's group, or it
    // would cancel an approval run waiting behind the fast tier.
    for (const state of ['commented', 'changes_requested']) {
      expect(group({ github: review(state, 'h1', 3) }), state).not.toBe(
        group({ github: pr(7) }),
      );
    }
    expect(group({ github: review('commented', 'h1', 3) })).not.toBe(
      group({ github: review('commented', 'h1', 4) }),
    );
    expect(group({ github: pr(7) })).not.toBe(group({ github: pr(8) }));
    // A main push carries no pull request, so it stays keyed per commit.
    expect(group(push('s1'))).not.toBe(group(push('s2')));
    // cancel-in-progress belongs to the incoming run: only a pull_request run
    // cancels, so a second approval queues behind the first full run and then
    // finds it through the deduplication instead of displacing it.
    const cancel = gate.concurrency['cancel-in-progress'];
    for (const event of ['pull_request_review', 'push', 'merge_group']) {
      expect(evaluate(cancel, { github: github(event) }), event).toBe(false);
    }
    expect(evaluate(cancel, { github: github('pull_request') })).toBe(true);
  });
});

describe('Managed Agent gate required check', () => {
  const name = (event, tier, touched) =>
    evaluate(gate.jobs.gate.name, {
      github: github(event),
      needs: { scope: { outputs: { tier, touched } } },
    });

  it.each([
    ['pull_request', 'none', 'false', 'Managed Agent gate'],
    ['pull_request', 'fast', 'true', 'Managed Agent fast tier'],
    ['pull_request_review', 'full', 'true', 'Managed Agent gate'],
    [
      'pull_request_review',
      'none',
      'true',
      'Managed Agent review (no full run)',
    ],
    ['pull_request_review', 'none', 'false', 'Managed Agent gate'],
    ['push', 'fast', 'true', 'Managed Agent gate'],
    ['merge_group', 'fast', 'true', 'Managed Agent gate'],
    // A failed tier selection leaves the outputs empty and must still
    // report, and fail, under the required name.
    ['pull_request', '', '', 'Managed Agent gate'],
    ['pull_request_review', '', '', 'Managed Agent gate'],
  ])(
    '%s with tier %j, touched %j reports as %s',
    (event, tier, touched, expected) => {
      expect(name(event, tier, touched)).toBe(expected);
    },
  );

  it('always reports after the tier selection and the suite', () => {
    expect(gate.jobs.gate.if).toBe('${{ always() }}');
    expect(gate.jobs.gate.needs).toEqual(['scope', 'suite']);
    // Same trust routing as the scope job, which the runner-routing
    // inventory evaluates: a starved hosted queue must not hold the check.
    expect(gate.jobs.gate['runs-on']).toBe(gate.jobs.scope['runs-on']);
  });

  const report = gate.jobs.gate.steps.find(
    (s) => s.name === 'Report the tier result',
  ).run;
  it.each([
    ['failure', '', '', 'skipped', 1],
    ['cancelled', '', '', 'skipped', 1],
    ['success', 'none', 'false', 'skipped', 0],
    ['success', 'none', 'true', 'skipped', 0],
    ['success', 'fast', 'true', 'success', 0],
    ['success', 'fast', 'true', 'failure', 1],
    ['success', 'full', 'true', 'success', 0],
    ['success', 'full', 'true', 'failure', 1],
    ['success', 'full', 'true', 'cancelled', 1],
  ])(
    'scope %s, tier %j, touched %j, suite %s exits %i',
    (scope, tier, touched, suite, code) => {
      const result = spawnSync('bash', ['-c', report], {
        env: {
          PATH: process.env.PATH,
          EVENT_NAME: '',
          SCOPE_RESULT: scope,
          TIER: tier,
          TOUCHED: touched,
          SUITE_RESULT: suite,
        },
      });
      expect(result.status).toBe(code);
    },
  );

  it.each([
    // A superseding push cancels the in-flight fast tier: the check then
    // means "replaced by a newer run", so it reports neutral, not failure.
    ['pull_request', 'fast', 'cancelled', 0],
    // Every other cancellation stays red: a full run's so the next approval
    // retries the suite instead of deduping against a green check, and a
    // push/merge-group arm's because nothing there cancels in progress — a
    // cancellation is a timeout or an operator stop.
    ['pull_request', 'full', 'cancelled', 1],
    ['pull_request_review', 'full', 'cancelled', 1],
    ['push', 'fast', 'cancelled', 1],
    ['merge_group', 'fast', 'cancelled', 1],
    // A genuine failure stays red everywhere.
    ['pull_request', 'fast', 'failure', 1],
  ])('%s %s tier %s exits %i', (event, tier, suite, code) => {
    const result = spawnSync('bash', ['-c', report], {
      env: {
        PATH: process.env.PATH,
        EVENT_NAME: event,
        SCOPE_RESULT: 'success',
        TIER: tier,
        TOUCHED: 'true',
        SUITE_RESULT: suite,
      },
    });
    expect(result.status).toBe(code);
  });
});

describe('Managed Agent gate tier selection', () => {
  const step = gate.jobs.scope.steps.find((s) => s.name === 'Choose the tier');
  const dir = mkdtempSync(join(tmpdir(), 'managed-agent-gate-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // A stand-in gh: check-runs prints FAKE_URLS; a run lookup prints the
  // event and pull request numbers recorded for that id in FAKE_EVENTS
  // ("id=event:pr ..."), tab-separated as the step's @tsv read expects; a
  // jobs lookup prints whether that id is listed in FAKE_FULL, standing in
  // for a run whose callee actually executed the full suite.
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/usr/bin/env bash',
      'case "$2" in',
      '  */check-runs*) printf "%s" "${FAKE_URLS}" ;;',
      '  */actions/runs/*/jobs*) id="${2%/jobs*}"; id="${id##*/}"; [[ " ${FAKE_FULL:-} " == *" ${id} "* ]] && echo true || echo false ;;',
      '  */actions/runs/*) id="${2##*/}"; for p in ${FAKE_EVENTS}; do if [[ "${p%%=*}" == "${id}" ]]; then rec="${p#*=}"; printf \'%s\\t%s\\n\' "${rec%%:*}" "${rec#*:}"; fi; done ;;',
      'esac',
    ].join('\n'),
  );
  chmodSync(join(dir, 'gh'), 0o755);

  const tier = (env) => {
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', step.run], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        REPO: 'QwenLM/qwen-code',
        RUN_ID: '100',
        HEAD_SHA: 'h1',
        BASE_REF: 'main',
        PR_NUMBER: '7',
        REVIEW_AUTHOR_ASSOCIATION: 'MEMBER',
        TOUCHED: 'true',
        FAKE_URLS: '',
        FAKE_EVENTS: '',
        FAKE_FULL: '',
        ...env,
      },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(output, 'utf8').trim();
  };
  const url = (run) =>
    `https://github.com/QwenLM/qwen-code/actions/runs/${run}/job/9`;

  it.each(['pull_request', 'push', 'merge_group'])(
    'runs the fast tier for a touched %s',
    (event) => {
      expect(tier({ EVENT_NAME: event })).toBe('tier=fast');
      expect(tier({ EVENT_NAME: event, TOUCHED: 'false' })).toBe('tier=none');
    },
  );

  it('runs the full suite on the first approval of a touched head', () => {
    const approve = {
      EVENT_NAME: 'pull_request_review',
      REVIEW_STATE: 'approved',
    };
    expect(tier(approve)).toBe('tier=full');
    expect(tier({ ...approve, TOUCHED: 'false' })).toBe('tier=none');
    expect(tier({ ...approve, REVIEW_STATE: 'commented' })).toBe('tier=none');
    expect(tier({ ...approve, BASE_REF: 'feature' })).toBe('tier=none');
  });

  it('starts the full tier only for a maintainer approval', () => {
    const approve = {
      EVENT_NAME: 'pull_request_review',
      REVIEW_STATE: 'approved',
    };
    // qwen-triage-finalize.yml watches this workflow and posts a deferred
    // APPROVE once a PR's checks land green; without this gate the fast tier
    // would buy the full suite with no human involved.
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(tier({ ...approve, REVIEW_AUTHOR_ASSOCIATION: association })).toBe(
        'tier=full',
      );
    }
    for (const association of ['NONE', 'FIRST_TIME_CONTRIBUTOR', '']) {
      expect(
        tier({ ...approve, REVIEW_AUTHOR_ASSOCIATION: association }),
        JSON.stringify(association),
      ).toBe('tier=none');
    }
  });

  it('skips an approval only when an earlier approval run covers the head', () => {
    const approve = {
      EVENT_NAME: 'pull_request_review',
      REVIEW_STATE: 'approved',
    };
    expect(
      tier({
        ...approve,
        FAKE_URLS: url(42),
        FAKE_EVENTS: '42=pull_request_review:7',
        FAKE_FULL: '42',
      }),
    ).toBe('tier=none');
    // An unaffected-change pass from the PR push run is no full run.
    expect(
      tier({ ...approve, FAKE_URLS: url(42), FAKE_EVENTS: '42=pull_request:' }),
    ).toBe('tier=full');
    // A rerun of this run's own jobs is not an earlier approval.
    expect(
      tier({
        ...approve,
        FAKE_URLS: url(100),
        FAKE_EVENTS: '100=pull_request_review:7',
        FAKE_FULL: '100',
      }),
    ).toBe('tier=full');
    // A review run of ANOTHER pull request whose head shares this sha ran no
    // suite for this PR: the dedup is scoped to the pull request.
    expect(
      tier({
        ...approve,
        FAKE_URLS: url(42),
        FAKE_EVENTS: '42=pull_request_review:8',
        FAKE_FULL: '42',
      }),
    ).toBe('tier=full');
    // A review run that reported the required name without running the
    // callee (an untouched classification) is no coverage either.
    expect(
      tier({
        ...approve,
        FAKE_URLS: url(42),
        FAKE_EVENTS: '42=pull_request_review:7',
      }),
    ).toBe('tier=full');
  });
});

describe('SDK Java fast tier', () => {
  const legs = (tier) =>
    evaluate(sdkJava.jobs.test.strategy.matrix.include, { inputs: { tier } });

  it('keeps only the Linux Java 21 leg on the fast tier', () => {
    expect(legs('fast')).toEqual([{ os: 'ubuntu-latest', java: '21' }]);
  });

  it.each(['full', undefined])('runs all five legs for tier %j', (tier) => {
    expect(legs(tier)).toEqual([
      { os: 'ubuntu-latest', java: '11' },
      { os: 'ubuntu-latest', java: '17' },
      { os: 'ubuntu-latest', java: '21' },
      { os: 'macos-latest', java: '21' },
      { os: 'windows-latest', java: '21' },
    ]);
  });

  it('skips exactly the slow lanes on the fast tier', () => {
    const skipped = Object.entries(sdkJava.jobs)
      .filter(([, job]) => job.if === "${{ inputs.tier != 'fast' }}")
      .map(([id]) => id)
      .sort();
    expect(skipped).toEqual([
      'event-transport-broker',
      'event-transport-multi-node',
      'hosted-failover-e2e',
      'hosted-harness-mysql',
      'mysql-integration',
    ]);
    for (const id of ['test', 'flyway-migrations', 'daemon-e2e']) {
      expect(sdkJava.jobs[id].if, id).toBeUndefined();
    }
  });

  it('keys the callee concurrency by event and commit', () => {
    expect(sdkJava.concurrency).toEqual({
      group:
        'sdk-java-${{ github.workflow }}-${{ github.event_name }}-${{ inputs.ref || github.ref }}',
      'cancel-in-progress': false,
    });
  });
});
