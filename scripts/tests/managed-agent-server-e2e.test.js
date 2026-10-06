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
  const loadWaitUntil = () => load(WAIT_UNTIL_DEPS, 'waitUntil')();

  // Source-level MySQL invocation sites, so client protections can be
  // asserted per call site: a whole-file count detects a removed safeguard
  // but stays green when a fifth invocation without one is added.
  const mysqlCalls = (sourceText) => {
    const ast = createSourceFile(
      'runner.ts',
      sourceText,
      ScriptTarget.Latest,
      true,
    );
    const calls = [];
    const visit = (node) => {
      if (isCallExpression(node) && node.arguments.length > 0) {
        // The long-lived mysqld server launches through start(), which
        // spawns internally: scanning spawnSync alone inventories 3 of the
        // 4 MySQL process launches.
        const callee = node.expression.getText(ast);
        if (
          callee === 'spawnSync' ||
          callee === 'spawn' ||
          callee === 'start'
        ) {
          const binary = node.arguments[0].getText(ast);
          if (['mysql', 'mysqladmin', 'mysqld'].includes(binary)) {
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
      }
      node.forEachChild(visit);
    };
    visit(ast);
    return calls;
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
    const { waitUntil } = loadWaitUntil();
    await expect(
      waitUntil(
        'probe',
        () => Promise.reject(new Error('HTTP 503 wedged')),
        300,
      ),
    ).rejects.toThrow(/wedged/);
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
    const spawns = [];
    const { runMysql } = load(
      ['runMysql'],
      'runMysql',
      'spawnSync',
      'mysql',
      'mysqlClientHome',
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
      '/tmp/mysql-client-home',
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
  // empty HOME under the runner's one scratch root, so the finally reclaims
  // it; the two mysqld server launches deliberately keep the real HOME.
  it('isolates the MySQL client HOME under the runner scratch root', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toContain("path.join(temporary, 'mysql-client-home')");
    // Per call site, not a whole-file count: a count detects a removed
    // override but stays green when a fifth client invocation without one is
    // added. The mysqld server launches deliberately keep the real HOME, so
    // the isolated override is required on the mysql/mysqladmin clients.
    const calls = mysqlCalls(source);
    // The exact inventory, not a lower bound: a scan that silently stops
    // seeing a call site — or a fifth launch added without the protections —
    // must fail here, not pass against a collapsed population.
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
        `${call.binary} must run with the isolated mysqlClientHome`,
      ).toContain('HOME: mysqlClientHome');
    }
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
