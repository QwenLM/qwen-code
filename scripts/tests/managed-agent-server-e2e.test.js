/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  createSourceFile,
  isArrayLiteralExpression,
  isCallExpression,
  isFunctionDeclaration,
  isVariableStatement,
  ScriptTarget,
  transpileModule,
} from 'typescript';
import { describe, expect, it } from 'vitest';
import { QWEN_SERVER_TOKEN_ENV } from '../../packages/cli/src/serve/channel-worker-env.js';
import { HOSTED_HARNESS_CAPABILITY_DIGEST_ENV } from '../../packages/cli/src/serve/hosted-harness-contract.js';
import { validateHostedHarnessProfile } from '../../packages/cli/src/serve/hosted-harness-profile.js';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

// Repo-root script mentions, bare or ./-prefixed. A package-relative tail such
// as packages/foo/scripts/bar.js is not a root mention, so the lookbehind
// still rejects a `scripts/` preceded by a path character.
const namedScripts = (text) => [
  ...new Set(
    [...text.matchAll(/(?<![\w./-])(?:\.\/)?scripts\/[\w./-]*[\w-]/g)].map(
      (match) => match[0].replace(/^\.\//, ''),
    ),
  ),
];

// Fenced shell blocks of a markdown text, bodies only; language-less fences
// are invisible to this scan.
const fencedShellBlocks = (text) =>
  [
    ...text.matchAll(/```[ \t]*(?:bash|sh|shell|console|zsh)\n([\s\S]*?)```/g),
  ].map((match) => match[1]);

describe('managed-agent-server e2e runner', () => {
  const extracted = (names) => {
    const source = createSourceFile(
      'runner.ts',
      read('scripts/run-managed-agent-server-e2e.ts'),
      ScriptTarget.Latest,
      true,
    );
    const text = source.statements
      .filter(
        (node) =>
          (isFunctionDeclaration(node) && names.includes(node.name?.text)) ||
          (isVariableStatement(node) &&
            node.declarationList.declarations.some((declaration) =>
              names.includes(declaration.name.getText(source)),
            )),
      )
      .map((node) => node.getText(source))
      .join('\n');
    return transpileModule(text, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
  };

  // waitUntil calls childExited, so its extraction list must name the
  // predicate: a free identifier in generated code resolves against the
  // global scope, and the early-exit branch would die with a ReferenceError
  // that points at the runner instead of at this harness's extraction list.
  // One inventory with one loader — pasted copies drift, and the drift reds
  // a test whose author did not touch it while the other copies stay
  // silently stale.
  const WAIT_UNTIL_DEPS = ['waitUntil', 'receivedSignal', 'childExited'];
  const load = (names, returns, ...params) =>
    new Function(...params, `${extracted(names)}\nreturn { ${returns} };`);
  // The interrupt setter closes over the extracted body's own
  // receivedSignal: without it the binding is permanently undefined and no
  // test can reach the poll-head interrupt early-exit.
  const loadWaitUntil = () =>
    load(
      WAIT_UNTIL_DEPS,
      'waitUntil, interrupt: (signal) => { receivedSignal = signal }',
      'inspect',
    )(inspect);

  // Source-level MySQL launch sites, selected on the launched binary
  // rather than the callee or a hand-listed identifier: a launch through
  // any spawner, with the binary spelled as a bare identifier or any quoted
  // literal, is inventoried the same way. The binary names come from the
  // runner's own command() resolutions, so a future mysql* binary joins the
  // inventory with its declaration.
  const mysqlCalls = (sourceText) => {
    const binaries = new Set();
    for (const match of sourceText.matchAll(
      /const (\w+) = command\('([^']+)'\)/g,
    )) {
      if (match[2].startsWith('mysql')) {
        binaries.add(match[1]).add(match[2]);
      }
    }
    const ast = createSourceFile(
      'runner.ts',
      sourceText,
      ScriptTarget.Latest,
      true,
    );
    const calls = [];
    const visit = (node) => {
      if (isCallExpression(node) && node.arguments.length > 0) {
        // command('mysql…') resolves a binary path; it is not a launch.
        if (node.expression.getText(ast) === 'command') {
          node.forEachChild(visit);
          return;
        }
        // getText returns a string literal with its quotes, so compare the
        // unquoted spelling: the quote style must not hide a launch.
        const binary = node.arguments[0]
          .getText(ast)
          .replace(/^['"`]|['"`]$/g, '');
        if (binaries.has(binary)) {
          const args = node.arguments[1];
          const firstArg =
            args !== undefined &&
            isArrayLiteralExpression(args) &&
            args.elements.length > 0
              ? args.elements[0].getText(ast)
              : undefined;
          calls.push({ binary, text: node.getText(ast), firstArg });
        }
      }
      node.forEachChild(visit);
    };
    visit(ast);
    return { calls, binaries };
  };

  it('keeps service and proxy ports distinct when an ephemeral port repeats', async () => {
    const outputText = extracted([
      'freePort',
      'startHeldExecutionStartProxy',
      'allocatedPorts',
    ]);
    const sequence = [
      33061, 33231, 36301, 36302, 36301, 36303, 38943, 36417, 36417, 36418,
      36417, 36418, 36419,
    ];
    const createServer = () => ({
      once() {},
      off() {},
      closeAllConnections() {},
      listen(port, _host, ready) {
        this.port = port || sequence.shift();
        expect(this.port).toBeDefined();
        ready();
      },
      address() {
        return { port: this.port };
      },
      close(done) {
        done?.();
      },
    });
    const { freePort, startHeldExecutionStartProxy } = new Function(
      'createServer',
      `${outputText}\nreturn { freePort, startHeldExecutionStartProxy };`,
    )(createServer);
    const ports = [];
    for (const count of [4, 3]) {
      for (let index = 0; index < count; index++) ports.push(await freePort());
      const proxy = await startHeldExecutionStartProxy('http://127.0.0.1:1');
      ports.push(Number(new URL(proxy.baseUrl).port));
      await proxy.close();
    }
    expect(new Set(ports).size).toBe(9);
  });

  // #12941: the Stage A acceptance criterion names a 15-second Runtime delay,
  // but the ordering assertion was gated at 20 s, so a --runtime-delay-ms 15000
  // run silently skipped it. Pin the threshold to the criterion's delay and
  // the README's statement of the arming delay to the threshold.
  it('arms the model-before-Runtime assertion at the criterion delay', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toContain('modelBeforeRuntimeAssertionDelayMs = 15_000');
    expect(source).toContain(
      'runtimeDelayMs >= modelBeforeRuntimeAssertionDelayMs',
    );
    const delaySeconds =
      Number(
        source
          .match(/modelBeforeRuntimeAssertionDelayMs = (\d[\d_]*)/)[1]
          .replace(/_/g, ''),
      ) / 1000;
    expect(read('packages/sdk-java/managed-agent-server/README.md')).toContain(
      `the ${delaySeconds} seconds the acceptance criterion`,
    );
  });

  // When the assertion fires the operator must tell an ordering defect from
  // provider latency, so the thrown message must carry the deciding sequence
  // operands alongside the in-scope timings (observedAt is a poll-batch stamp,
  // so the timings alone can be identical or argue against the verdict).
  it('reports the ordering timings when the assertion fires', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toContain('firstModelSequence=${firstModel.event.sequence}');
    expect(source).toContain(
      'runtimeReadySequence=${runtimeReady.event.sequence}',
    );
    expect(source).toContain(
      'firstModelEventMs=${firstModel.observedAt - requestStartedAt}',
    );
    expect(source).toContain(
      'runtimeReadyMs=${runtimeReady.observedAt - requestStartedAt}',
    );
    expect(source).toContain('runtimeDelayMs=${runtimeDelayMs}');
  });

  // #12941: the README named scripts/run-managed-hosted-runtime-e2e.ts as the
  // deterministic CI proof, a file that has never existed. Any script the
  // README names must be real.
  it('names only scripts that exist', () => {
    const readme = read('packages/sdk-java/managed-agent-server/README.md');
    expect(readme).not.toContain('run-managed-hosted-runtime-e2e');
    for (const script of namedScripts(readme)) {
      expect(
        existsSync(new URL(`../../${script}`, import.meta.url)),
        `${script} named in the managed-agent README does not exist`,
      ).toBe(true);
    }
  });

  // With the server defaults flipped on, dropping these pins would make the
  // runner start the durable path off Linux and fail at server startup while
  // `npm run test:scripts` stayed green: trusted recovery is pinned off at
  // both Spring launch sites, and durable local process only ever follows the
  // workspace-Turn modes.
  it('pins the runtime recovery flags for every runner mode', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(
      source.match(
        /QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY:\s*'false'/g,
      ),
      'both Spring launch sites must pin trusted reboot recovery off',
    ).toHaveLength(2);
    expect(
      source.match(
        /QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS:\s*'false'/g,
      ),
      'both non-workspaceTurns branches must pin durable local process off',
    ).toHaveLength(2);
  });

  // Every mode now runs through the G0 public Workspace admission, and the
  // failover modes hand the same Session to a replacement owner: both Spring
  // launch sites and both Harness launch sites must carry the admission
  // wiring, or a mode turns red only after the failover kill with an error
  // that reads like a takeover defect instead of a config asymmetry.
  it('pins the G0 workspace admission at both launch sites', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(
      source.match(
        /QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER: trustedActorHeader/g,
      ),
      'both Spring launch sites must configure the trusted actor header',
    ).toHaveLength(2);
    expect(
      source.match(/QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED: 'true'/g),
      'both Spring launch sites must enable Hosted Workspace files',
    ).toHaveLength(2);
    expect(
      source.match(/'--managed-runtime-broker-url'/g),
      'both Harness launch sites must pass the Runtime Broker flags',
    ).toHaveLength(2);
    // The mount argument is pushed once into the springArguments both Spring
    // launch sites share; re-gating it would fail validateWorkspaceFiles at
    // startup in every non-workspaceTurns mode while CI stayed green.
    expect(
      source.match(/workspace-mounts\[0\]\.root=/g),
      'the shared Spring arguments must configure the Workspace mount',
    ).toHaveLength(1);
    // The mount root itself must sit in the unconditional mkdir list: a
    // re-gated entry still starts Spring (nothing checks the root exists)
    // and only breaks the real-model side-effect assertion, which no lane
    // runs.
    expect(
      source.match(/^\s+workspaceMount,$/m),
      'the Workspace mount root must be created for every mode',
    ).not.toBeNull();
    expect(
      source.match(
        /INSERT INTO qwen_managed_agent\.managed_workspace_registry/g,
      ),
      'the Workspace registry row must be seeded for every mode',
    ).toHaveLength(1);
    expect(
      source.match(/INSERT INTO qwen_managed_agent\.managed_workspace_access/g),
      'the Workspace access grant must be seeded for every mode',
    ).toHaveLength(1);
    // The counts above cannot see WHERE an item sits: the runner before the
    // admission alignment gated these same items inside workspaceTurns
    // conditionals and satisfied every count. These negative pins are the
    // symmetry witness. The windows stay short so the gates that must stay
    // (durable local process, the Linux check, the 0700 state dir, the
    // unbound create body) and the comment mentioning workspaceTurns do not
    // trip them.
    for (const reGated of [
      /workspaceTurns[\s\S]{0,120}?QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER/,
      /workspaceTurns[\s\S]{0,120}?QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED/,
      /workspaceTurns[\s\S]{0,120}?--managed-runtime-broker-url/,
      /workspaceTurns[\s\S]{0,120}?workspaceMount/,
      /if \(workspaceTurns\) \{\s*runMysql\(/,
    ]) {
      expect(
        source.match(reGated),
        `G0 admission re-gated behind workspaceTurns: ${reGated}`,
      ).toBeNull();
    }
  });

  // The README currently names no script, so only a fixture can pin the
  // extractor itself: an extractor that stops matching must fail, not pass.
  it('extracts the script spellings the README could use', () => {
    expect(namedScripts('npx tsx ./scripts/nope.ts')).toEqual([
      'scripts/nope.ts',
    ]);
    expect(namedScripts('see `scripts/nope.ts`')).toEqual(['scripts/nope.ts']);
    expect(namedScripts('packages/foo/scripts/nope.ts')).toEqual([]);
  });

  it('pins the fenced hosted-harness launch block in the server README to a startable form', () => {
    // The oracle is the profile validator itself, not a copy of its rules:
    // the documented launch must supply everything
    // validateHostedHarnessProfile rejects for missing, or the launch fails
    // at startup while this pin stays green. The block is matched exactly —
    // a grammar that parses the fence into argv/env fails open on every
    // shell spelling it does not model. The CLI-side credential names come
    // from the production constants so renaming one reddens this pin instead
    // of stranding the README's spelling.
    const readme = read('packages/sdk-java/managed-agent-server/README.md');
    const fencedBlocks = fencedShellBlocks(readme);
    const command =
      'qwen serve --profile hosted-harness --port 4171 --hostname 127.0.0.1 --no-web';
    const launchBlocks = fencedBlocks.filter((block) =>
      block.includes(command),
    );
    expect(
      launchBlocks,
      'the README must fence exactly one hosted-harness launch block',
    ).toHaveLength(1);
    expect(launchBlocks[0]).toBe(
      [
        `${QWEN_SERVER_TOKEN_ENV}="$QWEN_MANAGED_AGENT_HARNESS_TOKEN" \\`,
        `${HOSTED_HARNESS_CAPABILITY_DIGEST_ENV}="$QWEN_MANAGED_AGENT_CAPABILITY_DIGEST" \\`,
        command,
      ].join('\n') + '\n',
    );
    // A `$VAR` reference defers to a name the reader was told to export in
    // the Prerequisites section; a renamed or dropped export there expands
    // to empty in the reader's shell and the launch dies at startup, so
    // every name the launch block references must be assigned inside that
    // section — an assignment in a fence anywhere else in the README never
    // reaches the reader's shell.
    const prereqStart = readme.indexOf('## Prerequisites');
    const prereqEnd = readme.indexOf('## Public Session lifecycle');
    expect(prereqStart).toBeGreaterThan(-1);
    expect(prereqEnd).toBeGreaterThan(prereqStart);
    const assigned = new Set();
    for (const fenced of fencedShellBlocks(
      readme.slice(prereqStart, prereqEnd),
    )) {
      for (const match of fenced.matchAll(
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm,
      )) {
        assigned.add(match[1]);
      }
    }
    for (const match of launchBlocks[0].matchAll(
      /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
    )) {
      expect(
        assigned.has(match[1]),
        `the launch block references $${match[1]}, which the Prerequisites section does not assign`,
      ).toBe(true);
    }
    // The validator's input is parsed from the pinned block so the fixture
    // cannot drift from the documented launch: an edit that drops --no-web
    // or widens --hostname must redden this oracle, not only the exact-text
    // pin above. mode stays the constant serve.ts hardcodes — the launch
    // carries no flag for it — and the deferred `$VAR` credentials stand in
    // as conforming values so the validator judges the launch's shape rather
    // than the placeholder spelling.
    expect(() =>
      validateHostedHarnessProfile({
        profile: 'hosted-harness',
        hostname: /--hostname\s+(\S+)/.exec(launchBlocks[0])[1],
        port: Number(/--port\s+(\d+)/.exec(launchBlocks[0])[1]),
        mode: 'http-bridge',
        token: 'documented-value',
        serveWebShell: !launchBlocks[0].includes('--no-web'),
        hostedHarnessCapabilityDigest: `sha256:${'a'.repeat(64)}`,
      }),
    ).not.toThrow();
  });

  it('pairs the 4171 base-url export with a startup-order note in the dual-path entry', () => {
    // The base URL is read once at JVM startup, so the section that moves
    // Spring to 4171 must say the value applies before (or via a restart
    // of) `mvn spring-boot:run`, or the reader's running server stays on
    // the 4170 value exported in Prerequisites.
    const readme = read('packages/sdk-java/managed-agent-server/README.md');
    const start = readme.indexOf(
      '## Full WebShell dual-path development entry',
    );
    const end = readme.indexOf('## Embedded Runtime Broker');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slice = readme.slice(start, end);
    // The export must point at the port the documented launch binds, not at
    // a second copy of the number: a launch-block port bump mirrored into
    // the launch pin above would otherwise leave this assertion green while
    // Spring keeps calling the old port and every Managed Turn fails.
    const launchBlocks = fencedShellBlocks(readme).filter((fenced) =>
      fenced.includes('qwen serve --profile hosted-harness'),
    );
    expect(
      launchBlocks,
      'the README must fence exactly one hosted-harness launch block',
    ).toHaveLength(1);
    const port = /--port\s+(\d+)/.exec(launchBlocks[0])[1];
    expect(
      slice,
      'the Spring base URL must point at the port the launch block binds',
    ).toContain(
      `QWEN_MANAGED_AGENT_HARNESS_BASE_URL='http://127.0.0.1:${port}'`,
    );
    // The caveat sentence is hard-wrapped in the README, so match across the
    // line break; the fallback is the restart clause, not the bare word
    // `restart` that any unrelated sentence in the slice could supply.
    expect(slice.replace(/\s+/g, ' ')).toMatch(
      /read once at JVM startup|restart it with the override/i,
    );
    // The by-hand recipe re-anchors Spring to the Prerequisites environment,
    // which never names the Session Store, and application.yml defaults the
    // store off — a reader who follows that path wires Spring without a
    // store descriptor and the Harness answers every attach with
    // 400 invalid_managed_session_store, so the slice must name the switch.
    expect(slice).toContain('QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED');
    // The store switch is read once at JVM startup exactly like the base
    // URL: exported below the restart cue it never reaches the reader's
    // JVM, and every attach fails with 400 invalid_managed_session_store
    // while the recipe reads complete — so the exports must land before the
    // single restart. The cue is hard-wrapped, so compare on the collapsed
    // slice; a missing cue fails closed through the -1.
    const flat = slice.replace(/\s+/g, ' ');
    expect(
      flat.indexOf('QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED'),
      'the Session Store exports must precede the Spring restart cue',
    ).toBeLessThan(flat.indexOf('restart it with the override'));
  });

  it('keeps the review-corrections merge gates behind the CI-gated Hosted proofs', () => {
    // The hosted-harness-mysql CI job runs HostedWorkspaceToolTurnIT (a real
    // file-tool Turn through the packaged worker) and the three
    // owner-failover E2E modes against the production HTTP durable-store
    // adapter, all fail-closed via the failsafe includes and
    // check-failsafe-reports.js. While both oracles stand, the
    // review-corrections gates must not re-assert those capabilities as
    // unproven — the foundation-boundary banner names that document the
    // current authority, so the false claim reaches integrators in either
    // language.
    const toolTurnIt =
      'packages/sdk-java/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/HostedWorkspaceToolTurnIT.java';
    expect(
      existsSync(new URL(`../../${toolTurnIt}`, import.meta.url)) &&
        read('.github/workflows/sdk-java.yml').includes(
          'test:e2e:managed-session-failover',
        ),
      'the Hosted tool-turn IT and the failover E2E lane must both exist for this oracle to mean anything',
    ).toBe(true);
    for (const [file, heading, claim] of [
      [
        'docs/design/2026-09-25-managed-agent-review-corrections.md',
        '## Remaining integration gates',
        /what remains unproven is[^.]*\./gi,
      ],
      [
        'docs/design/2026-09-25-managed-agent-review-corrections.zh-CN.md',
        '## 剩余集成门禁',
        /仍未证明[^。]*。/g,
      ],
    ]) {
      const doc = read(file);
      expect(doc, `${file} must keep its merge-gates section`).toContain(
        heading,
      );
      const gates = doc.slice(doc.indexOf(heading));
      for (const [sentence] of gates.matchAll(claim)) {
        expect(
          sentence,
          `${file} lists CI-gated Hosted capabilities as unproven`,
        ).not.toMatch(
          /tool turns|durable-store adapter|worker bundle|工具 Turn/i,
        );
      }
    }
  });

  it('pins the attach-time generation fence in the Harness attachment contract', () => {
    // The attachment paragraph publishes which identities an attach does NOT
    // compare. The Harness keys its in-memory Session by sessionId alone and
    // compares no tenant on attach, so the paragraph must say exactly that —
    // an integrator who reads a tenant-keyed coalescing claim leaves tenant
    // scoping out of their own gateway on the recovery redrive, which is not
    // fenced. The Harness writer generation is the one identity that IS
    // enforced — the contract middleware answers a stale boot id with 409
    // hosted_harness_generation_mismatch and the attach handler rejects a
    // store descriptor whose writerId differs before any coalescing — so the
    // paragraph must name that rejection: an integrator reading "not
    // rejected" for the generation omits the 409 path and every attach fails
    // after a Harness restart with no documented way out. Each fence pin
    // below matches a polarity phrase, not the bare name: the name alone
    // stays green when the paragraph says the generation is not rejected or
    // the store fence is shipped behavior.
    const readme = read('packages/sdk-java/managed-agent-server/README.md');
    const anchor = readme.indexOf('The Java connector caches an attachment');
    expect(anchor).toBeGreaterThan(-1);
    const end = readme.indexOf('\n\n', anchor);
    expect(end).toBeGreaterThan(anchor);
    const paragraph = readme.slice(anchor, end).replace(/\s+/g, ' ');
    expect(paragraph).toContain(
      'keys its in-memory Session by `sessionId` alone',
    );
    expect(paragraph).toContain(
      'fails closed with `409 hosted_harness_generation_mismatch`',
    );
    expect(paragraph).toContain(
      '`managed_session_store_conflict` fence is target design',
    );
  });

  it('waitUntil surfaces the last predicate error', async () => {
    const { waitUntil } = loadWaitUntil();
    await expect(
      waitUntil(
        'probe',
        () => Promise.reject(new Error('HTTP 503 wedged')),
        300,
      ),
    ).rejects.toThrow(/wedged/);
  });

  // A non-Error rejection is recorded on every poll; rendering only Error
  // instances would drop the one diagnostic the budget produced.
  it('waitUntil surfaces a non-Error predicate rejection', async () => {
    const { waitUntil } = loadWaitUntil();
    // An object rejection discriminates inspect from String: the latter
    // renders "[object Object]" and drops the one diagnostic the poll
    // produced.
    await expect(
      waitUntil('probe', () => Promise.reject({ status: 503 }), 300),
    ).rejects.toThrow(/503/);
    // The harness injects its own inspect as a parameter, so the runner's
    // binding is pinned by text: without the import, the free identifier
    // resolves to Node's deprecated global inspect in production.
    expect(read('scripts/run-managed-agent-server-e2e.ts')).toMatch(
      /import \{ inspect \} from 'node:util'/,
    );
  });

  it('exercises the poll-head interrupt early-exit through the setter', async () => {
    const { waitUntil, interrupt } = loadWaitUntil();
    interrupt('SIGINT');
    await expect(waitUntil('probe', () => false, 300)).rejects.toThrow(
      /Interrupted by SIGINT/,
    );
  });

  // Positive control: with no signal set the same poll fails by deadline,
  // so the setter — not a spurious initial value — drives the exit above.
  it('does not throw before the signal is set (positive control)', async () => {
    const { waitUntil } = loadWaitUntil();
    await expect(waitUntil('probe', () => false, 300)).rejects.toThrow(
      /did not become ready/,
    );
  });

  it('waitUntil bounds a stalled iteration by the deadline', async () => {
    const { waitUntil } = loadWaitUntil();
    const started = Date.now();
    await expect(
      waitUntil('probe', () => new Promise(() => {}), 300),
    ).rejects.toThrow(/predicate stalled/);
    // A hung predicate used to outlive timeoutMs several-fold.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('waitUntil reports a child that exited early', async () => {
    const { waitUntil } = loadWaitUntil();
    await expect(
      waitUntil('probe', () => new Promise(() => {}), 300, {
        child: { exitCode: 1, signalCode: null },
        log: () => '',
      }),
    ).rejects.toThrow(/exited early/);
  });

  // A child killed BY signal (OOM-kill, segfault) keeps exitCode null and
  // sets signalCode: an exitCode-only early-exit guard never trips, the
  // poll burns its whole site budget, and the failure reads "did not
  // become ready" — pointing at the dependency instead of the dead child.
  it('waitUntil reports a child that died by signal as exited early', async () => {
    const { waitUntil } = loadWaitUntil();
    await expect(
      waitUntil('probe', () => false, 300, {
        child: { exitCode: null, signalCode: 'SIGKILL' },
        log: () => '',
      }),
    ).rejects.toThrow(/exited early/);
  });

  // A rejecting-then-hanging predicate must surface the real error, not the
  // synthetic stall metadata the race rejects with on later iterations.
  it('waitUntil keeps a real predicate error when a later iteration stalls', async () => {
    const { waitUntil } = loadWaitUntil();
    let calls = 0;
    const failure = await waitUntil(
      'probe',
      () =>
        calls++ === 0
          ? Promise.reject(
              new Error('fetch failed', { cause: new Error('ECONNREFUSED') }),
            )
          : new Promise(() => {}),
      300,
    ).catch((error) => error);
    expect(failure.message).toContain('ECONNREFUSED');
    expect(failure.message).not.toContain('predicate stalled');
  });

  // The mirror: once the predicate answers falsy, a connectivity error from
  // an earlier phase no longer describes the state the deadline found.
  it('waitUntil drops an error that later answered iterations supersede', async () => {
    const { waitUntil } = loadWaitUntil();
    let calls = 0;
    const failure = await waitUntil(
      'probe',
      () =>
        calls++ === 0
          ? Promise.reject(
              new Error('fetch failed', { cause: new Error('ECONNREFUSED') }),
            )
          : false,
      300,
    ).catch((error) => error);
    expect(failure.message).toContain('did not become ready');
    expect(failure.message).not.toContain('ECONNREFUSED');
  });

  // spawnSync blocks the event loop, so the stall race cannot bound a
  // synchronous predicate: the remaining budget is handed to the predicate
  // for its own probe timeout, and wall time must stay near the budget
  // rather than near budget + a site-local probe timeout.
  it('waitUntil threads the remaining budget into a synchronous predicate', async () => {
    const { waitUntil } = loadWaitUntil();
    const started = Date.now();
    await expect(
      waitUntil(
        'probe',
        (remainingMs) =>
          spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 5_000)'], {
            timeout: remainingMs,
          }).status === 0,
        300,
      ),
    ).rejects.toThrow(/did not become ready/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('crashProcess reports a by-signal exit instead of throwing ESRCH', async () => {
    const { crashProcess } = load(
      ['crashProcess', 'childExited'],
      'crashProcess',
      'process',
    )(process);
    const child = spawn('node', [
      '-e',
      'setTimeout(() => process.kill(process.pid, "SIGKILL"), 20)',
    ]);
    // Let the by-signal death land first: guard reads signalCode, not
    // exitCode, and must refuse with the descriptive pre-exit diagnostic.
    await new Promise((resolve) => child.once('exit', resolve));
    await expect(crashProcess(child, 'probe')).rejects.toThrow(
      /exited before the crash was injected/,
    );
  });

  // The pre-crash guard is pinned above; the poll loop and the
  // survived-SIGKILL throw must read a by-signal death too: an exitCode-only
  // poll burns the 5 s deadline on a child SIGKILL already reaped, and an
  // exitCode-only throw reports that dead child as having survived.
  it('crashProcess returns promptly once its SIGKILL lands', async () => {
    const { crashProcess } = load(
      ['crashProcess', 'childExited'],
      'crashProcess',
      'process',
    )(process);
    const child = spawn('node', ['-e', 'setTimeout(() => {}, 30_000)']);
    const started = Date.now();
    await expect(crashProcess(child, 'probe')).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  // The success document must not reach stdout for a run the operator
  // stopped: every payload is assembled inside the try and printed only
  // after both post-finally throws, so the guard decides before the record
  // exists. A print inside the try would leave the finally's teardown —
  // seconds of stopChild awaits with the handlers still attached —
  // unguarded.
  it('checks the received signal at the success exit too', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    // The base's eager prints were multi-line calls, so a single-line
    // negative pin is true of base and head alike and can never fire: pin
    // the deferred assignment on every mode branch, and that no success
    // payload is printed eagerly. The freeze arm's wake record is a
    // mid-run diagnostic with no sessionId key, so the payload shape —
    // not any console.log(JSON.stringify( spelling — is what must not
    // print inside the try.
    expect(source.match(/resultJson = JSON\.stringify\(/g)).toHaveLength(4);
    expect(source).not.toMatch(
      /console\.log\(\s*JSON\.stringify\(\s*\{\s*(?:model,\s*)?sessionId/,
    );
    // No gate typechecks scripts/ (tsx strips types unchecked), so the
    // module-scope binding the deferred print reads is pinned by text:
    // dropped, the print below throws ReferenceError on the success path.
    expect(source).toMatch(/^let resultJson: string \| undefined;$/m);
    // The behavioural tests inject the signal through this harness's
    // synthesized setter, so the production link — the runner's own
    // handleSignal assigning the module-scope receivedSignal the guards
    // below read — is pinned by text: registered with an empty body, the
    // handlers swallow Ctrl-C and a CI cancellation, and the run prints
    // the success payload and exits 0. Pin the process.on pair only; the
    // finally removes both listeners during teardown.
    expect(source).toMatch(
      /const handleSignal = \(signal: NodeJS\.Signals\) => \{\s*receivedSignal = signal;\s*\};/,
    );
    expect(source).toMatch(/process\.on\('SIGINT', handleSignal\);/);
    expect(source).toMatch(/process\.on\('SIGTERM', handleSignal\);/);
    // An interrupted run is a non-pass: the finally's keep decision must
    // still honor the keep switch, or a stopped run deletes its own
    // evidence before the signal throw below reports it.
    expect(source).toMatch(
      /\(failure \|\| receivedSignal\) &&\s*process\.env\['QWEN_MANAGED_E2E_KEEP_TMP'\]/,
    );
    const failureThrow = source.indexOf('if (failure) throw failure;');
    const signalThrow = source.indexOf(
      'if (receivedSignal) throw new Error',
      failureThrow,
    );
    const print = source.indexOf('console.log(resultJson)');
    expect(failureThrow).toBeGreaterThan(-1);
    expect(signalThrow).toBeGreaterThan(failureThrow);
    expect(
      print,
      'the success payload must print only after both exit guards',
    ).toBeGreaterThan(signalThrow);
  });

  // A timed-out spawn sets error and leaves status null with empty stderr,
  // so a status-only check throws "MySQL command failed: " and the one
  // diagnostic a wedged durable-state dump exists to produce is lost.
  it('runMysql surfaces the spawn-level reason on a timeout', () => {
    const spawns = [];
    const { runMysql } = load(
      ['runMysql'],
      'runMysql',
      'spawnSync',
      'mysql',
      'mysqlClientEnv',
    )(
      (...args) => {
        spawns.push(args);
        return {
          status: null,
          signal: 'SIGTERM',
          stderr: '',
          error: new Error('spawnSync mysql ETIMEDOUT'),
        };
      },
      'mysql',
      { HOME: '/tmp/mysql-client-home' },
    );
    expect(() => runMysql(3306, 'SELECT 1')).toThrow(/ETIMEDOUT/);
    // A final waitUntil poll can hand runMysql a remaining budget below one
    // client round trip; the floor keeps the last probe possible.
    expect(() => runMysql(3306, 'SELECT 1', 3)).toThrow(/ETIMEDOUT/);
    expect(spawns[1][2].timeout).toBeGreaterThanOrEqual(2_000);
    // The default-timeout call pins the opposite direction: a budget above
    // the floor reaches spawnSync unchanged.
    expect(spawns[0][2].timeout).toBe(10_000);
  });

  // --no-defaults does not disable $HOME/.mylogin.cnf, so a developer's
  // mysql_config_editor credential would still auth-connect to the scratch
  // empty-password server. Both client invocations — the mysql client in
  // runMysql and the mysqladmin readiness probe — run against an isolated
  // environment: an empty HOME under the runner's one scratch root (so the
  // finally reclaims it) with MYSQL_PWD and MYSQL_TEST_LOGIN_FILE stripped;
  // the two mysqld server launches deliberately keep the real HOME.
  it('isolates the MySQL client HOME under the runner scratch root', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toContain("path.join(temporary, 'mysql-client-home')");
    // --no-defaults and the isolated HOME leave two credential sources
    // open: MYSQL_PWD is read as the password, and MYSQL_TEST_LOGIN_FILE
    // relocates .mylogin.cnf ahead of $HOME and past --no-defaults. The
    // shared client environment must strip both, or an exported developer
    // credential reaches the scratch empty-password server.
    expect(source).toContain("delete mysqlClientEnv['MYSQL_PWD'];");
    expect(source).toContain("delete mysqlClientEnv['MYSQL_TEST_LOGIN_FILE'];");
    // Per call site, not a whole-file count: a count detects a removed
    // override but stays green when a fifth client invocation without one is
    // added. The mysqld server launches deliberately keep the real HOME, so
    // the isolated override is required on the mysql/mysqladmin clients.
    const { calls, binaries } = mysqlCalls(source);
    // The exact inventory, not a lower bound — and the scan's binary set is
    // the runner's own command() resolutions, pinned exactly — so a scan
    // that silently stops seeing a call site or a declaration fails here
    // instead of passing against a collapsed population.
    expect([...binaries].sort()).toEqual(['mysql', 'mysqladmin', 'mysqld']);
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      // MySQL honors --no-defaults only as the first option, so pin the
      // position: containment would survive the flag moving off index 0.
      expect(
        call.firstArg,
        `${call.binary} must pass --no-defaults first`,
      ).toBe("'--no-defaults'");
      if (call.binary === 'mysqld') continue;
      expect(
        call.text,
        `${call.binary} must run with the isolated mysqlClientEnv`,
      ).toContain('env: mysqlClientEnv');
    }
  });

  // The inventory promises quote-style blindness: TypeScript reports a
  // no-substitution template literal with its backticks on, so the strip
  // class must cover the third JS string spelling or a backticked launch
  // is never inventoried.
  it('inventories a MySQL launch spelled with any quote style', () => {
    const { calls } = mysqlCalls(`
      const mysql = command('mysql');
      spawnSync('mysql', ['--no-defaults']);
      spawnSync("mysql", ['--no-defaults']);
      spawnSync(\`mysql\`, ['--no-defaults']);
    `);
    expect(calls).toHaveLength(3);
  });

  // spawnSync blocks the event loop, so waitUntil's race cannot bound a
  // synchronous probe: the mysqladmin readiness probe carries its own
  // timeout, and the two lease polls derive each call's timeout from the
  // remaining waitUntil budget rather than a site-local constant that can
  // overshoot the declared budget several-fold.
  it('bounds every synchronous MySQL probe by the poll budget', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toMatch(/spawnSync\(\s*mysqladmin,[\s\S]*?timeout: 10_000/);
    // Pin the forwarded argument, not the parameter list: an arrow that
    // takes remainingMs but never passes it on falls back to the 10 s
    // default inside a budget that may be smaller.
    expect(
      source.match(/\(remainingMs\) =>\s*runMysql\([\s\S]*?remainingMs,/g),
      'both lease polls must derive the probe timeout from the waitUntil budget',
    ).toHaveLength(2);
  });

  it('names the jar explicitly on both surfaces — pom-derived name in the runner, classifier exclusion at image build', () => {
    const script = read('scripts/run-managed-agent-server-e2e.ts');
    expect(script).not.toContain('qwen-managed-agent-server-0.1.0-alpha');
    // The pom's repackage executions leave three matching artifacts in
    // target/. The runner derives the unclassified name from the pom (one
    // source of truth); the Dockerfile selects by classifier exclusion
    // with a loud cardinality guard.
    expect(script).toContain('qwen-managed-agent-server-${pomVersion}.jar');
    expect(script).not.toContain('packagedJars');
    const dockerfile = read(
      'packages/sdk-java/managed-agent-server/Dockerfile',
    );
    expect(dockerfile).not.toContain('qwen-managed-agent-server-0.1.0-alpha');
    expect(dockerfile).toContain('/tmp/qwen-managed-agent-server.jar');
    expect(dockerfile).toContain(
      'workspace-bundle.jar|*-operator-recovery.jar',
    );
  });

  it('unrefs the waitUntil stall timer so a fast success does not idle the runner', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toMatch(/stallTimer\.unref\(\)/);
  });

  it('resolves the project version from the real pom', () => {
    // The runner's own regex executes against the real pom — lifted from
    // the runner source, not copied — so a whitespace change between
    // <artifactId> and <version> or a ${revision} indirection surfaces
    // here, not at the next local run of the script. A routine version
    // bump must stay green: pin the shape the runner depends on (the match
    // anchored at the module's own artifactId and a concrete, non-property
    // version), never today's value.
    const script = read('scripts/run-managed-agent-server-e2e.ts');
    const patternSource = script.match(
      /pomXml\.match\(\s*(\/(?:\\.|[^\\/])*\/)/,
    )?.[1];
    expect(patternSource).toBeTruthy();
    const pattern = new Function(`return ${patternSource};`)();
    const match = read('packages/sdk-java/managed-agent-server/pom.xml').match(
      pattern,
    );
    expect(match?.[0]).toContain(
      '<artifactId>qwen-managed-agent-server</artifactId>',
    );
    expect(match?.[1]).toBeTruthy();
    expect(match?.[1]).not.toContain('${');
    // The descriptive throw stays part of the lookup: a pom whose version
    // the regex cannot read must fail there, not at the jar existsSync.
    expect(script).toContain('Could not read the project <version>');
    // Whitespace inside the element (a formatter wrapping the value) must
    // not flow into the jar path: the lifted pattern's capture is
    // whitespace-tolerant, and an empty element still matches nothing, so
    // the runner's descriptive guard fires.
    const wrapped =
      '<artifactId>qwen-managed-agent-server</artifactId>\n  <version>\n    9.9.9\n  </version>';
    expect(wrapped.match(pattern)?.[1]).toBe('9.9.9');
    expect(
      '<artifactId>qwen-managed-agent-server</artifactId><version></version>'.match(
        pattern,
      ),
    ).toBeNull();
  });

  it('keeps the image on the loopback default and the jar guard loud', () => {
    const dockerfile = read(
      'packages/sdk-java/managed-agent-server/Dockerfile',
    );
    // The module has no HTTP authentication, so the published image must
    // not bind beyond loopback by default: publishing is the operator's
    // explicit -e opt-in at docker run, documented in the README's
    // container section. The cardinality guard stays loud, so the build
    // fails rather than shipping a wrong or glob-stat jar.
    expect(dockerfile).not.toMatch(/^ENV\s+QWEN_MANAGED_AGENT_SERVER_ADDRESS/m);
    expect(dockerfile).not.toMatch(
      /^ENV\s+QWEN_MANAGED_AGENT_RUNTIME_BROKER_HOST/m,
    );
    // Pin the bind default at the file that owns it, not only at one
    // downstream file declining to override it: every Java test passes
    // --server.address on the command line and the e2e runner passes none,
    // so a flipped yml default would otherwise ship silently.
    const applicationYml = read(
      'packages/sdk-java/managed-agent-server/src/main/resources/application.yml',
    );
    expect(applicationYml).toMatch(
      /address: '\$\{QWEN_MANAGED_AGENT_SERVER_ADDRESS:127\.0\.0\.1\}'/,
    );
    expect(dockerfile).toMatch(/\{ \[ "\$count" -eq 1 \] \|\|/);
    expect(dockerfile).toContain(
      'expected exactly one unclassified server jar',
    );
    // Host Maven output must not ride the build context into the stage the
    // guard inspects: a stale jar from a developer's target/ would trip the
    // cardinality check with an artifact this build did not produce. Both
    // spellings — a bare `target` is root-anchored under Docker's pattern
    // syntax.
    const dockerignore = read('.dockerignore');
    expect(dockerignore).toMatch(/^target$/m);
    expect(dockerignore).toMatch(/^\*\*\/target$/m);
    // The container section must document the opt-in and name the
    // default-bridge exposure, or an operator who skips -p concludes the
    // surface is closed.
    const readme = read('packages/sdk-java/managed-agent-server/README.md');
    expect(readme).toContain('-e QWEN_MANAGED_AGENT_SERVER_ADDRESS=0.0.0.0');
    expect(readme).toMatch(/with no `-p` at all/);
    // RuntimeBrokerHttpServer refuses a non-loopback broker bind unless the
    // allow-non-loopback flag is set, so a documented broker wildcard opt-in
    // must name the flag in the same block: the unguarded pair crash-loops
    // the container the moment the broker is enabled.
    for (const document of [dockerfile, readme]) {
      const wildcard = document.indexOf(
        'QWEN_MANAGED_AGENT_RUNTIME_BROKER_HOST=0.0.0.0',
      );
      if (wildcard === -1) continue;
      const before = document.lastIndexOf('\n\n', wildcard);
      const after = document.indexOf('\n\n', wildcard);
      expect(
        document.slice(
          before === -1 ? 0 : before,
          after === -1 ? undefined : after,
        ),
        'a documented broker wildcard bind must name ALLOW_NON_LOOPBACK=true',
      ).toMatch(
        /QWEN_MANAGED_AGENT_RUNTIME_BROKER_ALLOW_NON_LOOPBACK='?true'?/,
      );
    }
    // BrokerSecurity refuses a non-loopback server.address under the
    // shipped auto / allow-insecure-bind=false defaults, so a documented
    // wildcard opt-in whose command names neither override crash-loops the
    // container: every block setting SERVER_ADDRESS=0.0.0.0 must pass
    // signed mode with its signing key or the explicit insecure override as
    // -e flags — an override mentioned only in prose is not in the command
    // an operator copies.
    for (const document of [dockerfile, readme]) {
      for (const occurrence of document.matchAll(
        /QWEN_MANAGED_AGENT_SERVER_ADDRESS=0\.0\.0\.0/g,
      )) {
        const before = document.lastIndexOf('\n\n', occurrence.index);
        const after = document.indexOf('\n\n', occurrence.index);
        const block = document.slice(
          before === -1 ? 0 : before,
          after === -1 ? undefined : after,
        );
        // The signing key must be forwarded valueless: the = spelling
        // leaves the HMAC secret in the docker run argv, readable by any
        // local user from /proc/<pid>/cmdline for the container's
        // lifetime.
        const signed =
          /-e QWEN_MANAGED_AGENT_AUTH_MODE='?signed'?/.test(block) &&
          /-e QWEN_MANAGED_AGENT_AUTH_SIGNING_KEY(?!=)/.test(block);
        const insecure =
          /-e QWEN_MANAGED_AGENT_AUTH_ALLOW_INSECURE_BIND='?true'?/.test(block);
        expect(
          signed || insecure,
          'a documented server wildcard bind must pass -e AUTH_MODE=signed with a valueless signing key or -e AUTH_ALLOW_INSECURE_BIND=true',
        ).toBe(true);
        // The datasource password is a credential of the same class as
        // the signing key above: spelled with = it sits in the docker run
        // argv, readable from /proc/<pid>/cmdline for the container's
        // lifetime, so the recipe must forward it valueless.
        expect(
          block,
          'a documented server wildcard bind must pass -e SPRING_DATASOURCE_PASSWORD valueless',
        ).toMatch(/-e SPRING_DATASOURCE_PASSWORD(?!=)/);
        // Flyway runs against SPRING_DATASOURCE_URL at container start and
        // the yml default's 127.0.0.1 is the container itself: a publish
        // recipe that omits the datasource — or points it at loopback —
        // passes the auth guard and then dies at the datasource with the
        // published port refused. toContain stops at the flag name, so pin
        // the loopback spellings away from the host; the <db-host>
        // placeholder the recipes document stays valid.
        expect(
          block,
          'a documented server wildcard bind must pass -e SPRING_DATASOURCE_URL= with a container-reachable host',
        ).toMatch(
          /-e SPRING_DATASOURCE_URL='?jdbc:mysql:\/\/(?!127\.0\.0\.1|localhost)/,
        );
      }
    }
  });

  // The jar-selection guard is executable shell, and the text pins above
  // never look inside the loop body: deleting the glob break or forcing the
  // count both left them green. Run the stage's own shell text against
  // fixture target/ populations so the guard's behaviour is pinned, not its
  // spelling.
  // The fixture ends in `cp`, and a Git-Bash-only Windows PATH resolves
  // sh.exe without the coreutils: probe the capability the fixture consumes
  // and skip visibly — an in-body return would record the case as passed for
  // a guard that never ran.
  const hasShAndCp =
    spawnSync('sh', ['-c', 'command -v cp >/dev/null 2>&1'], {
      stdio: 'ignore',
    }).status === 0;

  it.skipIf(!hasShAndCp)(
    'fails the image build loudly when the jar selection is ambiguous',
    () => {
      const dockerfile = read(
        'packages/sdk-java/managed-agent-server/Dockerfile',
      );
      const stage = dockerfile.match(
        /cd packages\/sdk-java\/managed-agent-server\/target \\[\s\S]*?&& cp "\$main" \/tmp\/qwen-managed-agent-server\.jar/,
      );
      expect(
        stage,
        'the jar-selection RUN stage must be extractable from the Dockerfile',
      ).not.toBeNull();
      const script = stage[0]
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .map((line) => line.trimEnd().replace(/\\$/, ''))
        .join(' ');
      const populations = [
        { jars: [], status: 1, found: 0 },
        { jars: ['qwen-managed-agent-server-1.0.jar'], status: 0 },
        {
          jars: [
            'qwen-managed-agent-server-1.0.jar',
            'qwen-managed-agent-server-1.0-workspace-bundle.jar',
            'qwen-managed-agent-server-1.0-operator-recovery.jar',
          ],
          status: 0,
        },
        {
          jars: [
            'qwen-managed-agent-server-1.0.jar',
            'qwen-managed-agent-server-2.0.jar',
          ],
          status: 1,
          found: 2,
        },
      ];
      for (const { jars, status, found } of populations) {
        const dir = mkdtempSync(join(tmpdir(), 'jar-guard-'));
        try {
          for (const jar of jars) writeFileSync(join(dir, jar), '');
          const fixture = script
            .replace(
              'cd packages/sdk-java/managed-agent-server/target',
              `cd '${dir.replaceAll('\\', '/')}'`,
            )
            .replace(
              '/tmp/qwen-managed-agent-server.jar',
              `'${join(dir, 'published.jar').replaceAll('\\', '/')}'`,
            );
          const run = spawnSync('sh', ['-c', fixture], { encoding: 'utf8' });
          expect(run.status, `${jars.length} jars: ${run.stderr}`).toBe(status);
          if (found !== undefined) {
            expect(run.stderr).toContain(
              `expected exactly one unclassified server jar, found ${found}`,
            );
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );
});
