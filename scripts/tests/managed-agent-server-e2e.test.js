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
});
