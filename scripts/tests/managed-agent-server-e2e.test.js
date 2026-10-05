/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  createSourceFile,
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
  it('keeps service and proxy ports distinct when an ephemeral port repeats', async () => {
    const source = createSourceFile(
      'runner.ts',
      read('scripts/run-managed-agent-server-e2e.ts'),
      ScriptTarget.Latest,
      true,
    );
    const allocation = source.statements
      .filter(
        (node) =>
          (isFunctionDeclaration(node) &&
            ['freePort', 'startHeldExecutionStartProxy'].includes(
              node.name?.text,
            )) ||
          (isVariableStatement(node) &&
            node.declarationList.declarations.some(
              (declaration) =>
                declaration.name.getText(source) === 'allocatedPorts',
            )),
      )
      .map((node) => node.getText(source))
      .join('\n');
    const { outputText } = transpileModule(allocation, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    });
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
});
