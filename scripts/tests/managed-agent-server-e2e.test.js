/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
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

  it('waitUntil surfaces the last predicate error', async () => {
    const { waitUntil } = new Function(
      `${extracted(['waitUntil', 'receivedSignal', 'childExited'])}\nreturn { waitUntil };`,
    )();
    await expect(
      waitUntil(
        'probe',
        () => Promise.reject(new Error('HTTP 503 wedged')),
        300,
      ),
    ).rejects.toThrow(/wedged/);
  });

  it('waitUntil bounds a stalled iteration by the deadline', async () => {
    const { waitUntil } = new Function(
      `${extracted(['waitUntil', 'receivedSignal', 'childExited'])}\nreturn { waitUntil };`,
    )();
    const started = Date.now();
    await expect(
      waitUntil('probe', () => new Promise(() => {}), 300),
    ).rejects.toThrow(/predicate stalled/);
    // A hung predicate used to outlive timeoutMs several-fold.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  // waitUntil calls childExited, so every extraction of it must name the
  // predicate: a free identifier in generated code resolves against the
  // global scope, and the early-exit branch would die with a ReferenceError
  // that points at the runner instead of at this harness's extraction list.
  it('waitUntil reports a child that exited early', async () => {
    const { waitUntil } = new Function(
      `${extracted(['waitUntil', 'receivedSignal', 'childExited'])}\nreturn { waitUntil };`,
    )();
    await expect(
      waitUntil('probe', () => new Promise(() => {}), 300, {
        child: { exitCode: 1, signalCode: null },
        log: () => '',
      }),
    ).rejects.toThrow(/exited early/);
  });

  // A rejecting-then-hanging predicate must surface the real error, not the
  // synthetic stall metadata the race rejects with on later iterations.
  it('waitUntil keeps a real predicate error when a later iteration stalls', async () => {
    const { waitUntil } = new Function(
      `${extracted(['waitUntil', 'receivedSignal', 'childExited'])}\nreturn { waitUntil };`,
    )();
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
    const { waitUntil } = new Function(
      `${extracted(['waitUntil', 'receivedSignal', 'childExited'])}\nreturn { waitUntil };`,
    )();
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
    const { waitUntil } = new Function(
      `${extracted(['waitUntil', 'receivedSignal', 'childExited'])}\nreturn { waitUntil };`,
    )();
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
    const { crashProcess } = new Function(
      'process',
      `${extracted(['crashProcess', 'childExited'])}\nreturn { crashProcess };`,
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

  it('checks the received signal at the success exit too', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toMatch(
      /if \(failure\) throw failure;[\s\S]{0,300}receivedSignal\) throw new Error/,
    );
  });

  it('passes --no-defaults to every MySQL client invocation', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    // mysqld twice, the mysql client once, mysqladmin once; the
    // isolated-home comment above the lookup must not fake a fifth hit.
    expect(source.match(/--no-defaults/g)).toHaveLength(4);
  });

  // A timed-out spawn sets error and leaves status null with empty stderr,
  // so a status-only check throws "MySQL command failed: " and the one
  // diagnostic a wedged durable-state dump exists to produce is lost.
  it('runMysql surfaces the spawn-level reason on a timeout', () => {
    const { runMysql } = new Function(
      'spawnSync',
      'mysql',
      'mysqlClientHome',
      `${extracted(['runMysql'])}\nreturn { runMysql };`,
    )(
      () => ({
        status: null,
        signal: 'SIGTERM',
        stderr: '',
        error: new Error('spawnSync mysql ETIMEDOUT'),
      }),
      'mysql',
      '/tmp/mysql-client-home',
    );
    expect(() => runMysql(3306, 'SELECT 1')).toThrow(/ETIMEDOUT/);
  });

  // --no-defaults does not disable $HOME/.mylogin.cnf, so a developer's
  // mysql_config_editor credential would still auth-connect to the scratch
  // empty-password server. Both client invocations — the mysql client in
  // runMysql and the mysqladmin readiness probe — run against an isolated
  // empty HOME under the runner's one scratch root, so the finally reclaims
  // it; the two mysqld server launches deliberately keep the real HOME.
  it('isolates the MySQL client HOME under the runner scratch root', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toContain("path.join(temporary, 'mysql-client-home')");
    expect(
      source.match(/HOME: mysqlClientHome/g),
      'the mysql client and the mysqladmin probe must both use the isolated HOME',
    ).toHaveLength(2);
  });

  // spawnSync blocks the event loop, so waitUntil's race cannot bound a
  // synchronous probe: the mysqladmin readiness probe carries its own
  // timeout, and the two lease polls derive each call's timeout from the
  // remaining waitUntil budget rather than a site-local constant that can
  // overshoot the declared budget several-fold.
  it('bounds every synchronous MySQL probe by the poll budget', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toMatch(/spawnSync\(\s*mysqladmin,[\s\S]*?timeout: 10_000/);
    expect(
      source.match(/\(remainingMs\) =>\s*runMysql\(/g),
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
  });
});
