/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect, isDeepStrictEqual } from 'node:util';
import {
  createSourceFile,
  isArrayLiteralExpression,
  isCallExpression,
  isFunctionDeclaration,
  isVariableStatement,
  ScriptTarget,
  transpileModule,
} from 'typescript';
import { describe, expect, it, vi } from 'vitest';
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
  it('queries tables from the shared fresh-database baseline', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    const baseline = read(
      'packages/managed-agent-server/persistence/src/main/resources/db/managed-schema/V1__managed_schema.sql',
    );
    const tables = new Set(
      [...baseline.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]),
    );
    const queried = new Set(
      [...source.matchAll(/qwen_managed_agent\.(\w+)/g)].map(
        (match) => match[1],
      ),
    );
    expect(queried.size).toBeGreaterThan(0);
    for (const table of queried) {
      expect(
        tables.has(table),
        `E2E table ${table} is absent from canonical V1`,
      ).toBe(true);
    }
  });

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
    const { freePort, startHeldExecutionStartProxy } = load(
      ['freePort', 'startHeldExecutionStartProxy', 'allocatedPorts'],
      'freePort, startHeldExecutionStartProxy',
      'createServer',
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

  // #14481 step 2: a lost reply is a reply the server already committed and
  // answered, so the helper must wait for `response` before destroying it.
  // Destroying on `request` would send nothing and let every retry assertion
  // pass on a request the control plane never saw.
  it('drops a committed reply without skipping the request', async () => {
    const { postAndDropReply } = load(
      ['postAndDropReply'],
      'postAndDropReply',
      'httpRequest',
    )(httpRequest);
    let received = '';
    const server = createServer((request, response) => {
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        received += chunk;
      });
      request.on('end', () => {
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end('{"id":"operation-1"}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      await postAndDropReply(
        `http://127.0.0.1:${port}/v1/agents/sessions/s/events`,
        '{"type":"x"}',
        {
          'content-type': 'application/json',
          'idempotency-key': 'retry-key',
        },
      );
      expect(received).toBe('{"type":"x"}');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // A 4xx means the control plane committed nothing, so dropping that reply
  // would let the retry assertions pass over a request the server rejected.
  it('refuses to drop a reply the control plane did not accept', async () => {
    const { postAndDropReply } = load(
      ['postAndDropReply'],
      'postAndDropReply',
      'httpRequest',
    )(httpRequest);
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end('{"error":"turn_active"}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      await expect(
        postAndDropReply(
          `http://127.0.0.1:${port}/v1/agents/sessions/s/events`,
          '{"type":"x"}',
          { 'content-type': 'application/json' },
        ),
      ).rejects.toThrow(/expected 202/);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // The reviewer's probe: a 202 only admits the response operation, so the
  // Action row is still `requested` with a null receipt. The after-decision
  // barrier must reject that answer, or a crash proves delivery, not commit.
  it('refuses an admitted but undelivered decision as the after-decision barrier', () => {
    const { approvalDecisionCommitted } = load(
      ['approvalDecisionCommitted'],
      'approvalDecisionCommitted',
    )();
    expect(approvalDecisionCommitted('requested\t0\t0')).toBe(false);
    expect(approvalDecisionCommitted('decided\t0\t0')).toBe(false);
    expect(approvalDecisionCommitted('decided\t1\t0')).toBe(false);
    expect(approvalDecisionCommitted('decided\t1\t1')).toBe(true);
  });

  it('recognizes only a turn.settled store commit as the terminal write', () => {
    const { commitCarriesTurnSettled } = load(
      ['commitCarriesTurnSettled'],
      'commitCarriesTurnSettled',
    )();
    const commit = (kind) =>
      Buffer.from(
        JSON.stringify({
          recordBytesBase64: Buffer.from(
            JSON.stringify({
              subtype: 'managed_session_event_v1',
              managedSession: { kind },
            }),
          ).toString('base64'),
        }),
      );
    expect(commitCarriesTurnSettled(commit('turn.settled'))).toBe(true);
    expect(commitCarriesTurnSettled(commit('message.committed'))).toBe(false);
    expect(commitCarriesTurnSettled(Buffer.from('{}'))).toBe(false);
    expect(commitCarriesTurnSettled(Buffer.from('not json'))).toBe(false);
  });

  it('pins the #14481 approval fault arms to durable barriers', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    const workflow = read('.github/workflows/sdk-java.yml');
    const manifest = read('package.json');
    const scripts = [
      'test:e2e:managed-harness-restart-approval-after-decision',
      'test:e2e:managed-harness-restart-approval-after-prepare',
      'test:e2e:managed-harness-restart-approval-after-result',
      'test:e2e:managed-harness-restart-approval-finished-before-commit',
      'test:e2e:managed-harness-restart-approval-decision-reply-lost',
      'test:e2e:managed-harness-restart-approval-admission-reply-lost',
      'test:e2e:managed-harness-restart-approval-load-reply-lost',
      'test:e2e:managed-harness-restart-approval-terminal-reply-lost',
      'test:e2e:managed-harness-restart-approval-terminal-write-failed',
      'test:e2e:managed-harness-restart-approval-cleanup-failed',
    ];
    for (const script of scripts) {
      expect(manifest, `${script} must be an npm script`).toContain(
        `"${script}"`,
      );
      expect(workflow, `${script} must be a CI step`).toContain(script);
    }
    // Deny, Cancel and expiry have no approved execution, so layering a
    // crash there would silently assert a weaker path.
    expect(source).toMatch(
      /if \(approvalFault && verificationMode !== 'allow'\)/,
    );
    // The lost decision must retry the same key and land on one operation.
    expect(source).toContain("operation_kind='ACTION_RESPONSE'");
    // The crash arms scrap the crashed home and require a third generation,
    // rather than reusing the killed owner's disk.
    const recovery = source.indexOf("'Post-fault recovery Harness'");
    const scrap = source.indexOf(
      'rmSync(replacementHarnessHome, { recursive: true, force: true })',
    );
    expect(recovery).toBeGreaterThan(-1);
    expect(scrap).toBeGreaterThan(-1);
    expect(
      scrap,
      'the crashed home must be scrapped before recovery',
    ).toBeLessThan(recovery);
    expect(source).toMatch(
      /await waitUntil\(\s*'Post-fault recovery Harness adopted the Session'/,
    );
    // The partial-prepare crash needs the held :start and a PREPARED row
    // with no dispatch, or it degrades into the after-decision barrier.
    expect(source).toContain("execution === 'PREPARED\\t0'");
    expect(source).toContain(
      'replacementBrokerProxy?.heldPath() !== undefined',
    );
    // The after-decision crash must read the durable decision row, not the
    // 202: hold :start so it cannot reach dispatch, and require the state,
    // receipt and digest together.
    expect(source).toContain('Approval decision durably committed');
    expect(source).toMatch(/approvalDecisionCommitted\(\s*runMysql\(/);
    expect(source).toContain(
      'IF(decision_receipt_id IS NULL, 0, 1), IF(decision_digest IS NULL, 0, 1)',
    );
    const proxy = source.indexOf(
      'replacementBrokerProxy = await startHeldExecutionStartProxy',
    );
    expect(proxy).toBeGreaterThan(-1);
    expect(source.slice(proxy - 500, proxy)).toContain(
      "approvalFault === 'after-decision'",
    );
    // The result-commit crash waits for the settled result and the held
    // model round, then releases the hold; its reissue must reuse the same
    // saved request or the proof is about a rewritten one.
    expect(source).toContain(
      'Approved result committed and its prefix published',
    );
    expect(source).toContain('SETTLED\\t1');
    expect(source).toContain('releaseApprovalResultHold()');
    expect(source).toContain(
      'Result-commit recovery changed the saved model request',
    );
    expect(source).toContain('publishedPrefixSequences');
    expect(source).toContain("approvalFault === 'after-result'");
    expect(source).toContain('expectedModelsAfterResults');
    expect(source).toContain('? 2');
    // R1-3: the retraction assertion must be pinned, or deleting it keeps
    // every script suite green while the arm stops proving the prefix left.
    expect(source).toContain('Result-commit recovery left');
    // R1-2: the structured half (stream.reconciled ordering) must be
    // asserted, not only written to the evidence file.
    expect(source).toContain(
      'Result-commit recovery did not reconcile the published prefix',
    );
    // R1-6: a parity failure must retain the two request bodies for diffing.
    expect(source).toContain('model-request-parity.json');
    // R1-5: the pre-dispatch proxy must never hold after-result's :start.
    expect(source.slice(proxy - 500, proxy)).not.toContain(
      "approvalFault === 'after-result'",
    );
    // C1 arms its crash barrier only after the store confirms a 200, and
    // records that pre-crash count; a non-200 first commit must not pass.
    expect(source).toContain('forwarded 200 dropped reply');
    expect(source).toContain('terminalAcceptsAtBarrier');
    expect(source).toContain('postCrashTerminalAccepts');
    expect(source).toContain('did not commit the terminal before recovery');
    // C1/C2: the store proxy must be armed before the decision and must
    // distinguish a lost reply (committed) from a refused write (missing).
    expect(source).toContain('storeFaultProxy = await startStoreFaultProxy');
    expect(source).toContain('Terminal commit store fault observed');
    expect(source).toContain('storeFaultProxy?.armTerminal(');
    expect(source).toContain('storeFaultProxy?.allowTerminal()');
    expect(source).toContain('commitCarriesTurnSettled');
    expect(source).toContain('Terminal write fault was not compensated');
    // C1 must drop every bounded retry, not only the first answer, or the
    // doomed generation can receive a replay before the crash.
    expect(source).toContain('&& !terminalAllowed');
    // A terminal alone is not the answer: the surviving transcript must
    // still carry the model response.
    expect(source).toContain('Approval recovery answer differs');
    // C3 refuses the release until the crash, then reopens it so the
    // replacement's own release is witnessed on the same proxy, and the
    // crash only lands once the control plane projected the terminal.
    expect(source).toContain('releaseFailureCount: () => releaseFailureCount');
    expect(source).toContain('replacementBrokerProxy.allowRelease()');
    expect(source).toContain("'Runtime cleanup release refused'");
    expect(source).toContain(
      "'Original Turn projected before the cleanup crash'",
    );
    expect(source).toContain(
      "'Post-fault cleanup retry reached the replacement'",
    );
    expect(source).toContain(
      'Cleanup fault was not retried after the replacement',
    );
    expect(source).toContain("owner_kind='HOSTED_CLEANUP'");
    // A4 loses the first takeover load reply once via a test-gated hook on the
    // replacement, and asserts the fault landed before trusting the recovery
    // (a redrive that never lost a reply would prove nothing).
    expect(source).toContain('QWEN_E2E_DROP_LOAD_REPLY: session.id');
    expect(source).toContain("'Takeover load reply lost'");
    expect(source).toContain('E2E dropping first load reply');
    const harnessSource = read(
      'packages/cli/src/serve/hosted-harness-session.ts',
    );
    expect(harnessSource).toContain("process.env['QWEN_E2E_DROP_LOAD_REPLY']");
    expect(harnessSource).toContain('E2E dropping first load reply');
    // B3a crashes the replacement inside the window after its post-tool stream
    // Finished marker is durable but before the assistant commit, via a
    // test-gated hook set only on that generation. The barrier proves the
    // fault landed; the recovery parity proves the next generation reissued
    // the saved request rather than compensating an already-committed terminal.
    expect(source).toContain(
      'QWEN_E2E_CRASH_BEFORE_ASSISTANT_COMMIT: session.id',
    );
    expect(source).toContain(
      "'Finished turn held before the assistant commit'",
    );
    expect(source).toContain(
      'E2E holding finished turn before assistant commit',
    );
    // The flag rides only the crashing generation, never the recovery one.
    // Pin both call sites and the parameter default, not merely the
    // identifiers (which appear at several runner sites): giving the recovery
    // generation the flag, or flipping the default to true, must red here.
    expect(source).toMatch(
      /startReplacementHarness\(\s*'Replacement Hosted Harness',\s*approvalFault === 'finished-before-commit',\s*approvalFault === 'sibling-approval',?\s*\)/,
    );
    expect(source).toMatch(
      /startReplacementHarness\(\s*'Post-fault recovery Harness',?\s*\)/,
    );
    expect(source).toContain('crashBeforeAssistantCommit = false');
    expect(source).toContain('holdPendingSiblingApproval = false');
    // B3a asserts the durable crash precondition (the approved result settled)
    // from MySQL like the sibling crash arms, not only the hook's log line.
    expect(source).toContain(
      'Finished-before-commit crash did not land after the approved result settled',
    );
    // R1-1 (deeper): the settled execution is not the window. The barrier must
    // also read the post-tool main attempt's durable Finished marker from the
    // same journal the recovery reads, and assert no assistant commit follows
    // it, before the SIGKILL. Pin this window-shaped — the journal assertion
    // must sit between the B3a barrier and the crash, and its discriminator
    // must mirror findHostedCommittedModelOutput — so deleting the assertion or
    // moving the hold above the output_committed commit cannot stay green. A
    // bare identifier check would survive both, since the recovery reader also
    // accepts a saved request whose attempt is still started.
    const b3aBarrier = source.indexOf(
      "'Finished turn held before the assistant commit'",
    );
    const b3aCrash = source.indexOf('await crashChild(', b3aBarrier);
    expect(b3aBarrier).toBeGreaterThan(-1);
    expect(b3aCrash).toBeGreaterThan(b3aBarrier);
    const b3aWindow = source.slice(b3aBarrier, b3aCrash);
    expect(b3aWindow).toContain('finishedBeforeCommitWindow(');
    expect(b3aWindow).toContain(
      'SELECT prompt_id FROM qwen_managed_agent.ma_turn',
    );
    // R4-2: the window helper only runs through its arming ternary. Pin the
    // condition itself, so narrowing the guard (e.g. to 'after-result') reds
    // here instead of silently deleting the arm's only durable-window check
    // while the helper name still appears in the barrier->crash slice.
    expect(source).toMatch(
      /approvalFault === 'finished-before-commit'\s*\?\s*finishedBeforeCommitWindow\(/,
    );
    expect(source).toContain(
      'Finished-before-commit crash landed before the model Finished marker committed',
    );
    expect(source).toContain(
      'Finished-before-commit crash landed after the assistant commit',
    );
    const windowFn = source.indexOf('function finishedBeforeCommitWindow(');
    expect(windowFn).toBeGreaterThan(-1);
    const windowFnBody = source.slice(
      windowFn,
      source.indexOf('\n}', windowFn),
    );
    // The journal HEX decode is shared (R1-7); the window reader rides it.
    expect(windowFnBody).toContain('readJournalManagedEvents(');
    const journalFn = source.indexOf('function readJournalManagedEvents(');
    expect(journalFn).toBeGreaterThan(-1);
    // A fixed window: the return-type annotation contains "\n}>" which would
    // truncate a first-"\n}" slice before the body.
    expect(source.slice(journalFn, journalFn + 1500)).toContain(
      'qwen_managed_agent.ma_session_journal_tx',
    );
    expect(windowFnBody).toContain(':main:');
    expect(windowFnBody).toContain(
      "latestAttempt.payload['state'] !== 'output_committed'",
    );
    expect(windowFnBody).toContain("event.payload['role'] === 'assistant'");
    expect(windowFnBody).toContain('event.sequence > latestAttempt.sequence');
    // B3a must take the same deep-equal parity gate as after-result; pin the
    // combined condition so reverting it to after-result-only reds here rather
    // than silently deleting the arm's only deep-equal assertion.
    expect(source).toMatch(
      /if \(\s*approvalFault === 'after-result' \|\|\s*approvalFault === 'finished-before-commit'\s*\)/,
    );
    expect(harnessSource).toContain(
      "process.env['QWEN_E2E_CRASH_BEFORE_ASSISTANT_COMMIT']",
    );
    expect(harnessSource).toContain(
      'E2E holding finished turn before assistant commit',
    );
    // A3 crashes the replacement inside a two-call approval batch — sibling[0]
    // decided, sibling[1] still requested — via a test-gated hook on the first
    // approval the replacement asks. The barrier proves the crash landed in
    // the approval gap; the recovery assertions prove the decided sibling was
    // not re-asked, the pending sibling kept its original Action/deadline and
    // earned its own Allow, and both siblings recovered in order, once each.
    const toolTurnSource = read(
      'packages/cli/src/serve/hosted-workspace-tool-turn.ts',
    );
    expect(source).toContain("'sibling-approval'");
    expect(source).toContain('call_managed_continuation_sibling');
    expect(source).toContain(
      'QWEN_E2E_HOLD_PENDING_SIBLING_APPROVAL: session.id',
    );
    // The flag rides only the crashing generation, gated on the parameter.
    expect(source).toMatch(
      /holdPendingSiblingApproval\s*\?\s*\{\s*QWEN_E2E_HOLD_PENDING_SIBLING_APPROVAL: session\.id\s*\}/,
    );
    expect(toolTurnSource).toContain(
      "process.env['QWEN_E2E_HOLD_PENDING_SIBLING_APPROVAL']",
    );
    expect(toolTurnSource).toContain('E2E holding pending sibling approval');
    // The barrier asserts the durable approval-gap shape, not the log alone,
    // and the shape checks sit between the barrier and the SIGKILL.
    expect(source).toContain("'Pending sibling approval held'");
    expect(source).toContain(
      'Sibling-approval crash did not land in the approval gap',
    );
    expect(source).toContain(
      'Sibling-approval crash plan is not the pending second sibling',
    );
    const a3Barrier = source.indexOf("'Pending sibling approval held'");
    const a3Crash = source.indexOf('await crashChild(', a3Barrier);
    expect(a3Barrier).toBeGreaterThan(-1);
    expect(a3Crash).toBeGreaterThan(a3Barrier);
    const a3Window = source.slice(a3Barrier, a3Crash);
    expect(a3Window).toContain('siblingPlan.approvalOrdinal !== 1');
    expect(a3Window).toContain("decidedSibling?.[1] !== 'decided'");
    expect(a3Window).toContain("pendingSibling?.[1] !== 'requested'");
    // The recovery generation re-decides the ORIGINAL pending sibling and
    // asserts its identity/deadline survived before answering.
    expect(source).toContain('const siblingBefore = await fetchJson');
    expect(source).toContain(
      'Recovery did not preserve the pending sibling Action/deadline',
    );
    expect(source).toContain('actions/${siblingApprovalId}/responses');
    // Two siblings settle once each under their original identities: the
    // count, both Action rows, the pending sibling's own decision, the second
    // file effect and the order-sensitive final plan are all pinned.
    // R1-7 / F1: anchor each count ternary to its own site. The bare `? 2 : 1`
    // matches both expectedExecutions and expectedOriginalPlanCalls, so each is
    // pinned separately and narrowing either one (2 -> 1) reds here at unit
    // speed, not only at the real-stack barrier.
    expect(source).toMatch(
      /const expectedExecutions =[\s\S]*?approvalFault === 'sibling-approval' \|\|\s*approvalFault === 'after-earlier-tools'\s*\?\s*2\s*:\s*1/,
    );
    // `\s*`, not `[\s\S]*?`: the gap here is whitespace-only, so a tight anchor
    // cannot span past this site to the expectedExecutions ternary and mask a
    // narrowed count (the spanning form stays green under `? 2` -> `? 1`).
    expect(source).toMatch(
      /const expectedOriginalPlanCalls =\s*approvalFault === 'sibling-approval'\s*\?\s*2\s*:\s*1/,
    );
    // R1-7: pin the per-call identity loop itself (match by prepare key, not
    // the pre-PR single-execution shape), so reverting it reds here at unit
    // speed rather than only on a full real-stack run.
    expect(source).toContain(
      'for (const [ordinal, call] of plan.calls.entries())',
    );
    expect(source).toContain('(row) => row[1] === call.prepareKey');
    expect(source).toContain(
      'Replacement changed the original prepared execution identity for call',
    );
    // R1-4: the decided sibling is read and asserted still decided with its
    // original deadline BEFORE the pending sibling is answered.
    expect(source).toContain('const decidedBefore = await fetchJson');
    expect(source).toContain("decidedBefore.state !== 'decided'");
    expect(source).toContain(
      'Recovery re-touched the decided sibling Action/deadline',
    );
    // R1-5: execution order is gated on settled_at along the plan, not only
    // the plan resource order, so a reverse dispatch reds.
    expect(source).toContain(
      'request_digest, settled_at FROM qwen_managed_agent.ma_tool_execution',
    );
    expect(source).toContain('settledAtByOrdinal.push(Number(execution[8]))');
    expect(source).toContain(
      'Replacement settled the siblings out of plan order',
    );
    expect(source).toContain('Sibling approval identities/states differ');
    expect(source).toContain('Stored sibling decision differs');
    expect(source).toContain('Sibling physical file assertion failed');
    expect(source).toContain('Sibling recovery reordered or rewrote call');
    expect(source).toContain(
      'Sibling recovery changed the original Action IDs',
    );
    // The order assertion reads the recovered final plan the way recovery
    // does (latest hosted.batch.planned link for the batch, stage final).
    expect(source).toContain('siblingFinalPlan(');
    const a3PlanFn = source.indexOf('function siblingFinalPlan(');
    expect(a3PlanFn).toBeGreaterThan(-1);
    const a3PlanFnBody = source.slice(
      a3PlanFn,
      source.indexOf('\n}', a3PlanFn),
    );
    expect(a3PlanFnBody).toContain('readJournalManagedEvents(');
    expect(a3PlanFnBody).toContain("event.kind !== 'hosted.batch.planned'");
    expect(a3PlanFnBody).toContain("payload['batchId'] !== batchId");
    expect(a3PlanFnBody).toContain("plan.stage !== 'final'");
    // B3 after-earlier-tools: the multi-round fixture, the second-Allow
    // choreography, the round/budget continuity readers + assertions, and the
    // later-round deep-equal parity are all pinned so a regression reds here.
    expect(source).toContain("'after-earlier-tools'");
    expect(source).toContain('call_managed_b3_second');
    expect(source).toContain('b3BudgetDirective');
    expect(source).toContain('Second earlier-tool approval requested');
    expect(source).toContain('Earlier tools settled and the later round held');
    expect(source).toContain('b3RoundAndBudget(');
    expect(source).toContain('B3 recovery reset the logical round');
    expect(source).toContain('B3 recovery reset the turn budget snapshot');
    expect(source).toContain('B3 recovery wiped the per-model token ledger');
    expect(source).toContain('B3 second physical file assertion failed');
    expect(source).toContain(
      'B3 recovery changed the saved later-round model request',
    );
    expect(source).toContain('B3 earlier execution');
    expect(source).toContain('B3 approval identities/states differ');
    // The hold armed for B3 must also be RELEASED after the crash: a release
    // gated to after-result alone leaves the recovery generation's reissued
    // request held forever (the .75 head run crash-looped on exactly that).
    const releaseAt = source.indexOf('releaseApprovalResultHold();');
    expect(releaseAt).toBeGreaterThan(-1);
    expect(source.slice(releaseAt - 200, releaseAt)).toContain(
      "approvalFault === 'after-earlier-tools'",
    );
    // B3 shares after-result's published-prefix capture and retraction proof.
    expect(source).toMatch(
      /approvalFault === 'after-result' \|\|\s*approvalFault === 'after-earlier-tools'\s*\) \{\s*\/\/ The reissue must retract the held prefix/,
    );
    // The fixture must charge non-zero usage (the fake default is all zeros,
    // which makes the ledger continuity assertion vacuous) and the ledger
    // check must compare per-model totals — an empty {} ledger is truthy.
    expect(source).toContain('completion_tokens: 300');
    expect(source).toContain(
      'B3 crash-boundary per-model token ledger is empty',
    );
    expect(source).toContain('B3 crash-boundary turn budget was not exercised');
    expect(source).toContain('afterTokens < beforeTokens');
    expect(source).toContain('assertB3CostContinuity(');
    // R1-3: the budget guard must test the NUMERIC field — a non-null snapshot
    // with budget: null is a legal production state, so an object-truthy guard
    // would let a lost +Nk directive pass as null == null.
    const b3CostFn = source.indexOf('function assertB3CostContinuity(');
    expect(b3CostFn).toBeGreaterThan(-1);
    const b3CostFnBody = source.slice(
      b3CostFn,
      source.indexOf('\n}', b3CostFn),
    );
    expect(b3CostFnBody).toContain(
      'b3Budget === null || b3Budget === undefined',
    );
    // R1-4: site-anchor the B3 post-tool request count like the neighbouring
    // R1-7 / F1 pins — the identifier alone survives a conflict resolution
    // back to the pre-PR ternary, which would only red in the real-stack lane.
    // Deleting the after-earlier-tools ? 3 clause must red here.
    expect(source).toMatch(
      /const expectedModelsAfterResults =[\s\S]*?approvalFault === 'after-earlier-tools'\s*\?\s*3\s*:/,
    );
    const b3Fn = source.indexOf('function b3RoundAndBudget(');
    expect(b3Fn).toBeGreaterThan(-1);
    const b3FnBody = source.slice(b3Fn, source.indexOf('\n}', b3Fn));
    expect(b3FnBody).toContain('readJournalManagedEvents(');
    expect(b3FnBody).toContain("event.kind === 'model.attempt'");
    expect(b3FnBody).toContain('SELECT HEX(inline_bytes)');
    expect(b3FnBody).toContain("attempts[i].payload['recoveryRef']");
    expect(b3FnBody).toContain("['usageRef', 'routeRef']");
  });

  // R4-2 (behavioural): the source pins above assert the window helper's
  // spelling; this exercises finishedBeforeCommitWindow itself on injected
  // journal rows, so the latest-attempt selection and both throw branches are
  // proven on data, not on text. runMysql is injected through load() (the
  // parameter must be spelled exactly runMysql to shadow the free identifier);
  // the helper stays a top-level declaration so extracted() can walk it.
  it('behaves finishedBeforeCommitWindow on injected journal rows', () => {
    const promptId = 'turn_b3a';
    const attempt = (sequence, state, prompt = promptId) => ({
      kind: 'model.attempt',
      sequence,
      payload: { attemptId: `${prompt}:main:${sequence}`, state },
    });
    const assistantCommit = (sequence) => ({
      kind: 'message.committed',
      sequence,
      payload: { role: 'assistant' },
    });
    // The helper reads HEX(record_bytes) rows; each row decodes to UTF-8 JSON
    // Lines of managed_session_event_v1 records. Encode the events the way the
    // journal writer does, as one HEX blob the helper splits back into lines.
    const rows = (events) =>
      Buffer.from(
        events
          .map((event) =>
            JSON.stringify({
              subtype: 'managed_session_event_v1',
              managedSession: event,
            }),
          )
          .join('\n'),
        'utf8',
      ).toString('hex');
    const run = (events) =>
      load(
        ['finishedBeforeCommitWindow', 'readJournalManagedEvents'],
        'finishedBeforeCommitWindow',
        'runMysql',
      )(() => rows(events)).finishedBeforeCommitWindow(0, 'filter', promptId);

    // output_committed with no following assistant commit: the window holds.
    expect(run([attempt(25, 'output_committed')])).toEqual({
      attemptId: `${promptId}:main:25`,
      attemptSequence: 25,
    });
    // An assistant commit before the attempt does not close the window.
    expect(run([assistantCommit(20), attempt(25, 'output_committed')])).toEqual(
      {
        attemptId: `${promptId}:main:25`,
        attemptSequence: 25,
      },
    );
    // A non-assistant commit after the attempt does not close the window.
    expect(
      run([
        attempt(25, 'output_committed'),
        { kind: 'message.committed', sequence: 27, payload: { role: 'user' } },
      ]),
    ).toEqual({ attemptId: `${promptId}:main:25`, attemptSequence: 25 });
    // The latest main attempt wins, even when rows arrive unsorted.
    expect(
      run([attempt(30, 'output_committed'), attempt(25, 'output_committed')]),
    ).toEqual({ attemptId: `${promptId}:main:30`, attemptSequence: 30 });
    // Another prompt's attempts are not this window's.
    expect(() => run([attempt(25, 'output_committed', 'other_turn')])).toThrow(
      /no main model attempt/,
    );
    // A still-started latest attempt: the crash landed before the Finished
    // marker committed (a mutation the source pins alone cannot catch).
    expect(() => run([attempt(25, 'started')])).toThrow(
      /before the model Finished marker committed: attemptState=started/,
    );
    // A newer started attempt after an older completed one is still before the
    // window: the recovery reader accepts a started attempt, so only the latest
    // attempt's state discriminates.
    expect(() =>
      run([attempt(25, 'output_committed'), attempt(30, 'started')]),
    ).toThrow(
      /before the model Finished marker committed: attemptState=started/,
    );
    // An assistant commit after the attempt: the crash landed after the commit.
    expect(() =>
      run([attempt(25, 'output_committed'), assistantCommit(27)]),
    ).toThrow(
      /after the assistant commit: commitSequence=27 attemptSequence=25/,
    );
  });

  // A3 (behavioural): exercise siblingFinalPlan on injected journal rows and
  // plan resources, so the latest-link selection, the batch filter and both
  // throw branches are proven on data, not on text. runMysql is injected
  // through load() and dispatches on the query (journal HEX rows vs the plan
  // resource, keyed by resource_id); the helper stays a top-level declaration
  // so extracted() can walk it.
  it('behaves siblingFinalPlan on injected journal rows', () => {
    const batchId = 'batch_a3';
    const call = (ordinal, actionId) => ({
      runtimeCallId: `rc_${ordinal}`,
      partIndex: ordinal,
      prepareKey: `rs:rc_${ordinal}`,
      requestDigest: `sha256:digest_${ordinal}`,
      actionId,
    });
    const finalPlan = {
      stage: 'final',
      calls: [call(0, 'action_0'), call(1, 'action_1')],
    };
    const planned = (sequence, batch = batchId, resourceId = 'res_final') => ({
      kind: 'hosted.batch.planned',
      sequence,
      payload: { batchId: batch, planRevision: 1, planRef: { resourceId } },
    });
    const journalRows = (events) =>
      Buffer.from(
        events
          .map((event) =>
            JSON.stringify({
              subtype: 'managed_session_event_v1',
              managedSession: event,
            }),
          )
          .join('\n'),
        'utf8',
      ).toString('hex');
    const run = (events, plans = { res_final: finalPlan }) =>
      load(
        ['siblingFinalPlan', 'sqlString', 'readJournalManagedEvents'],
        'siblingFinalPlan',
        'runMysql',
      )((_port, query) => {
        if (query.includes('ma_session_journal_tx')) return journalRows(events);
        if (query.includes('ma_resource')) {
          const resourceId = query.match(/resource_id='([^']+)'/)?.[1];
          const plan = plans[resourceId];
          if (!plan) throw new Error(`no plan for ${String(resourceId)}`);
          return JSON.stringify(plan);
        }
        throw new Error(`unexpected query: ${query}`);
      }).siblingFinalPlan(0, 'filter', batchId);

    // The hosted.batch.planned link for the batch resolves the final plan.
    expect(run([planned(10)])).toEqual(finalPlan);
    // The highest-sequence link wins, even when rows arrive unsorted: each
    // link points at a different resource, so selecting the older one reds.
    const newerPlan = {
      stage: 'final',
      calls: [call(0, 'action_0'), call(1, 'action_new')],
    };
    // Descending input kills a last-row-wins implementation.
    expect(
      run([planned(30, batchId, 'res_new'), planned(20, batchId, 'res_old')], {
        res_new: newerPlan,
        res_old: finalPlan,
      }),
    ).toEqual(newerPlan);
    // Ascending input (the real query's ORDER BY first_sequence direction, so
    // the newest link is the LAST row) kills a first-match implementation: a
    // first-match guard would pick the stale res_old here. Both directions
    // together force a genuine highest-sequence selection.
    expect(
      run([planned(20, batchId, 'res_old'), planned(30, batchId, 'res_new')], {
        res_new: newerPlan,
        res_old: finalPlan,
      }),
    ).toEqual(newerPlan);
    // Another batch's link is not this batch's plan.
    expect(() => run([planned(10, 'other_batch')])).toThrow(
      /no final batch plan link/,
    );
    // No link at all.
    expect(() => run([])).toThrow(/no final batch plan link/);
    // A non-final plan resource is refused: recovery must resume the final plan.
    expect(() =>
      run([planned(10)], { res_final: { stage: 'approval', calls: [] } }),
    ).toThrow(/not a final batch plan/);
    // Non-planned events are skipped, not parsed as the batch plan link.
    expect(
      run([
        {
          kind: 'message.committed',
          sequence: 5,
          payload: { role: 'assistant' },
        },
        planned(10),
      ]),
    ).toEqual(finalPlan);
  });

  // B3 (behavioural): exercise b3RoundAndBudget on injected journal rows and
  // request/route/usage resources, so the latest-attempt round selection, the
  // reverse-scan for budget/models, and both throw branches are proven on data.
  // runMysql is injected through load() and dispatches on the query (journal
  // HEX rows vs HEX resource bytes keyed by resource_id); sqlString is
  // extracted too.
  it('behaves b3RoundAndBudget on injected journal rows', () => {
    const attempt = (sequence, refs) => ({
      kind: 'model.attempt',
      sequence,
      payload: refs,
    });
    const journalRows = (events) =>
      Buffer.from(
        events
          .map((event) =>
            JSON.stringify({
              subtype: 'managed_session_event_v1',
              managedSession: event,
            }),
          )
          .join('\n'),
        'utf8',
      ).toString('hex');
    const budgetSnapshot = { budget: 500000, outputTokensAtTurnStart: 100 };
    const resources = {
      // The saved request carries the full system prompt, so its JSON has \"
      // and \\ sequences — the shape mysql --batch escaping corrupted when the
      // helper read CONVERT(inline_bytes) instead of HEX.
      req_round2: { round: 2, prompt: 'reply "exactly" then \\ stop' },
      req_round0: { round: 0 },
      usage1: { budget: budgetSnapshot, models: { m: { output: 150 } } },
      route2: { budget: budgetSnapshot },
      // R1-2: a discriminating pair — the older attempt carries a DIFFERENT
      // budget and a smaller ledger, the newest its own. An oldest-first scan
      // returns 900000/300 where the newest-first contract returns 500000/600,
      // so the direction is proven on data, not only on the round selection.
      usageOld: {
        budget: { budget: 900000, outputTokensAtTurnStart: 0 },
        models: { m: { tokens: { candidates: 300 } } },
      },
      usageNew: {
        budget: budgetSnapshot,
        models: { m: { tokens: { candidates: 600 } } },
      },
    };
    const run = (events) =>
      load(
        ['b3RoundAndBudget', 'sqlString', 'readJournalManagedEvents'],
        'b3RoundAndBudget',
        'runMysql',
      )((_port, query) => {
        if (query.includes('ma_session_journal_tx')) return journalRows(events);
        if (query.includes('ma_resource')) {
          const resourceId = query.match(/resource_id='([^']+)'/)?.[1];
          const res = resources[resourceId];
          if (!res) throw new Error(`no resource ${String(resourceId)}`);
          return Buffer.from(JSON.stringify(res), 'utf8').toString('hex');
        }
        throw new Error(`unexpected query: ${query}`);
      }).b3RoundAndBudget(0, 'filter');

    // The latest attempt's request gives the round; budget/models reverse-scan
    // across the route/usage refs (budget from the newest, models from usage1).
    expect(
      run([
        attempt(10, {
          recoveryRef: { resourceId: 'req_round0' },
          usageRef: { resourceId: 'usage1' },
        }),
        attempt(20, {
          recoveryRef: { resourceId: 'req_round2' },
          routeRef: { resourceId: 'route2' },
        }),
      ]),
    ).toEqual({
      round: 2,
      budget: budgetSnapshot,
      models: { m: { output: 150 } },
    });
    // Models still resolve from an earlier attempt when the newest has no usage.
    expect(
      run([
        attempt(10, {
          recoveryRef: { resourceId: 'req_round0' },
          usageRef: { resourceId: 'usage1' },
        }),
        attempt(20, { recoveryRef: { resourceId: 'req_round2' } }),
      ]),
    ).toEqual({
      round: 2,
      budget: budgetSnapshot,
      models: { m: { output: 150 } },
    });
    // R1-2: the newest attempt's own usage wins over an older, different one —
    // an oldest-first budget/models scan reds here (900000/300 vs 500000/600).
    expect(
      run([
        attempt(10, {
          recoveryRef: { resourceId: 'req_round0' },
          usageRef: { resourceId: 'usageOld' },
        }),
        attempt(20, {
          recoveryRef: { resourceId: 'req_round2' },
          usageRef: { resourceId: 'usageNew' },
        }),
      ]),
    ).toEqual({
      round: 2,
      budget: budgetSnapshot,
      models: { m: { tokens: { candidates: 600 } } },
    });
    // No attempt at all.
    expect(() => run([])).toThrow(/no model attempt/);
    // An attempt with no saved request round.
    expect(() => run([attempt(10, {})])).toThrow(
      /no saved model-request round/,
    );
  });

  // R1-2 / R1-3 (behavioural): the cost-continuity assertion on injected
  // before/after states. isDeepStrictEqual is injected through load() because
  // the extracted body's free identifiers resolve against the harness scope.
  it('behaves assertB3CostContinuity on injected before/after states', () => {
    const assertCost = load(
      ['assertB3CostContinuity'],
      'assertB3CostContinuity',
      'isDeepStrictEqual',
    )(isDeepStrictEqual).assertB3CostContinuity;
    const snapshot = {
      sessionId: 's',
      promptId: 'p',
      budget: 500000,
      directiveText: '+500k',
      outputTokensAtTurnStart: 0,
    };
    const ledger = (candidates) => ({
      'fake-model': { tokens: { candidates } },
    });
    const before = { round: 2, budget: snapshot, models: ledger(600) };
    // The healthy recovery: snapshot deep-equal, ledger grown by the final round.
    expect(() =>
      assertCost(before, { round: 2, budget: snapshot, models: ledger(700) }),
    ).not.toThrow();
    // R1-3: a non-null snapshot whose numeric budget is null (the +Nk directive
    // stopped being parsed) must red — an object-truthy guard passes it and the
    // deep-equal then compares null with null.
    expect(() =>
      assertCost(
        { ...before, budget: { ...snapshot, budget: null } },
        {
          round: 2,
          budget: { ...snapshot, budget: null },
          models: ledger(700),
        },
      ),
    ).toThrow(/turn budget was not exercised/);
    // A missing snapshot reds the same guard.
    expect(() =>
      assertCost({ ...before, budget: null }, { ...before, budget: null }),
    ).toThrow(/turn budget was not exercised/);
    // A re-baselined snapshot (different turn-start baseline) reds deep-equal.
    expect(() =>
      assertCost(before, {
        round: 2,
        budget: { ...snapshot, outputTokensAtTurnStart: 600 },
        models: ledger(700),
      }),
    ).toThrow(/reset the turn budget snapshot/);
    // An empty crash-boundary ledger is vacuous and must red.
    expect(() =>
      assertCost({ ...before, models: {} }, { ...before, models: {} }),
    ).toThrow(/token ledger is empty/);
    // A zeroed ({}) after-ledger must red — {} is truthy, so a null check passes it.
    expect(() =>
      assertCost(before, { round: 2, budget: snapshot, models: {} }),
    ).toThrow(/wiped the per-model token ledger/);
    // A shrunk per-model total must red (the dropped-restore shape).
    expect(() =>
      assertCost(before, { round: 2, budget: snapshot, models: ledger(100) }),
    ).toThrow(
      /wiped the per-model token ledger: model=fake-model before=600 after=100/,
    );
  });

  // B2 (behavioural): the stream-identity grouping on injected public events —
  // distinct item/part ids per prefix text, sequences collected, and blanked
  // (null-identity) deltas excluded from the identity sets.
  it('behaves b2DeltaIdentity on injected public events', () => {
    const group = load(
      ['b2DeltaIdentity', 'eventText', 'textDeltas'],
      'b2DeltaIdentity',
    )().b2DeltaIdentity;
    const delta = (sequence, text, itemId, partId) => ({
      sequence,
      terminal: false,
      type: 'item.output_text.delta',
      item_id: itemId,
      content_part_id: partId,
      data: { text },
    });
    const events = [
      delta(1, 'PARTIAL_ONE', 'item-1', 'part-1'),
      delta(2, 'PARTIAL_ONE more', 'item-1', 'part-1'),
      delta(5, 'PARTIAL_TWO', 'item-2', 'part-2'),
      delta(9, 'ANSWER', 'item-3', 'part-3'),
      delta(1, '', null, null), // a retracted delta carries no identity
    ];
    expect(group(events, 'PARTIAL_ONE')).toEqual({
      itemIds: ['item-1'],
      partIds: ['part-1'],
      sequences: [1, 2],
    });
    expect(group(events, 'PARTIAL_TWO')).toEqual({
      itemIds: ['item-2'],
      partIds: ['part-2'],
      sequences: [5],
    });
    expect(group(events, 'ANSWER')).toEqual({
      itemIds: ['item-3'],
      partIds: ['part-3'],
      sequences: [9],
    });
    expect(group(events, 'ABSENT')).toEqual({
      itemIds: [],
      partIds: [],
      sequences: [],
    });
  });

  // B2 (behavioural): the attempt-identity reader on injected journal HEX rows —
  // prompt-scoped, oldest first, skipping foreign events (runMysql injected).
  it('behaves b2ModelAttempts on injected journal rows', () => {
    const journalRows = (events) =>
      Buffer.from(
        events
          .map((event) =>
            JSON.stringify({
              subtype: 'managed_session_event_v1',
              managedSession: event,
            }),
          )
          .join('\n'),
        'utf8',
      ).toString('hex');
    const attempt = (sequence, attemptId, state) => ({
      kind: 'model.attempt',
      sequence,
      payload: { attemptId, state },
    });
    const rows = journalRows([
      attempt(30, 'turn_b2:main:c', 'started'),
      { kind: 'message.committed', sequence: 20, payload: {} },
      attempt(10, 'turn_b2:main:a', 'output_committed'),
      attempt(20, 'turn_b2:main:b', 'abandoned'),
      attempt(40, 'other_turn:main:z', 'started'),
    ]);
    const attempts = load(
      ['b2ModelAttempts', 'readJournalManagedEvents'],
      'b2ModelAttempts',
      'runMysql',
    )(() => rows).b2ModelAttempts(0, 'filter', 'turn_b2');
    expect(attempts).toEqual([
      { attemptId: 'turn_b2:main:a', state: 'output_committed', sequence: 10 },
      { attemptId: 'turn_b2:main:b', state: 'abandoned', sequence: 20 },
      { attemptId: 'turn_b2:main:c', state: 'started', sequence: 30 },
    ]);
  });

  // B2 (behavioural): the SSE client on an injected observer — the drain window
  // keeps reading past the first terminal (R1-2: a double projection must be
  // observed), Last-Event-ID passthrough, and abort rejects with a B2 error
  // (R1-1: the caller's .catch guard is what keeps teardown alive).
  it('behaves readPublicSse on an injected observer', async () => {
    const waitUntilStub = async (_name, predicate) => {
      for (let i = 0; i < 10_000; i += 1) {
        if (await predicate()) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error('waitUntil stub budget expired');
    };
    const loadSse = (FakeObserver) =>
      load(
        ['readPublicSse', 'b2SseObservers'],
        'readPublicSse',
        'SseObserver',
        'waitUntil',
      )(FakeObserver, waitUntilStub).readPublicSse;
    const terminal = (sequence) => ({
      sequence,
      terminal: true,
      type: 'turn.completed',
      data: {},
    });
    // The drain witness: the first terminal arrives at once, a SECOND terminal
    // 20ms later — inside the 100ms drain. A client that returned on the first
    // terminal would report one; the drained capture must report both.
    class DrainingObserver {
      frames = [];
      controller = new AbortController();
      failure = undefined;
      task = Promise.resolve();
      constructor(opts) {
        this.opts = opts;
        DrainingObserver.last = this;
      }
      async start(after) {
        this.startedWith = after;
        this.frames.push({ id: 1, event: 'turn.completed', data: terminal(1) });
        // start resolves at connect (first frame); the second terminal arrives
        // asynchronously on the task, like the real observer's stream.
        this.task = new Promise((resolve) => {
          setTimeout(() => {
            this.frames.push({
              id: 2,
              event: 'turn.completed',
              data: terminal(2),
            });
            resolve();
          }, 20);
        });
      }
    }
    const capture = await loadSse(DrainingObserver)('http://spring', 'sess', {
      tenantId: 't',
      after: 0,
      until: (events) => events.some((event) => event.terminal),
      timeoutMs: 5_000,
      drainMs: 100,
    });
    expect(DrainingObserver.last.startedWith).toBe(0);
    expect(capture.events.filter((event) => event.terminal)).toHaveLength(2);
    expect(capture.lastId).toBe('2');
    // Last-Event-ID is converted to the observer's numeric after.
    class ReplayObserver extends DrainingObserver {}
    await loadSse(ReplayObserver)('http://spring', 'sess', {
      tenantId: 't',
      lastEventId: '0',
      until: (events) => events.some((event) => event.terminal),
      timeoutMs: 5_000,
      drainMs: 0,
    });
    expect(ReplayObserver.last.startedWith).toBe(0);
    // Abort semantics (R1-1): a pending capture rejects with a B2 error when
    // the teardown aborts the registry; with the runner's .catch guard attached
    // no unhandledRejection fires, and a later await still sees the rejection.
    class PendingObserver {
      frames = [];
      controller = new AbortController();
      failure = undefined;
      task = Promise.resolve();
      constructor(opts) {
        this.opts = opts;
        PendingObserver.last = this;
      }
      start() {
        return new Promise((_resolve, reject) => {
          this.controller.signal.addEventListener('abort', () =>
            reject(new Error('This operation was aborted')),
          );
        });
      }
    }
    const readSsePending = load(
      ['readPublicSse', 'b2SseObservers'],
      'readPublicSse',
      'SseObserver',
      'waitUntil',
    )(PendingObserver, waitUntilStub).readPublicSse;
    let unhandled = false;
    const onUnhandled = () => {
      unhandled = true;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const pending = readSsePending('http://spring', 'sess', {
        tenantId: 't',
        until: () => false,
        timeoutMs: 5_000,
      });
      pending.catch(() => undefined); // the runner's R1-1 guard
      await new Promise((resolve) => setImmediate(resolve));
      PendingObserver.last.controller.abort(); // what the main finally does
      await expect(pending).rejects.toThrow(/B2 live SSE aborted/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toBe(false);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // B2 (behavioural): the shared SseObserver parse loop — split frames, the
  // wire-format assertions (id === sequence, event === type, SSE content-type)
  // and early close. This is the tree's split-frame witness now that the
  // runner drives the shared observer instead of a private loop (R1-5).
  it('behaves SseObserver on split chunks and wire violations', async () => {
    const { SseObserver } = await import(
      '../../integration-tests/helpers/hosted-sse-observer.js'
    );
    const chunksOf = (text, size) => {
      const chunks = [];
      for (let i = 0; i < text.length; i += size)
        chunks.push(text.slice(i, i + size));
      return chunks;
    };
    const sseResponse = (chunks, contentType = 'text/event-stream') => ({
      status: 200,
      headers: {
        get: (name) => (name === 'content-type' ? contentType : null),
      },
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks)
            controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
    });
    const opts = {
      surface: 'public',
      sessionId: 'sess',
      storeUrl: 'http://spring',
      tenantId: 't',
      timeoutMs: 5_000,
    };
    const stream =
      'id: 1\nevent: item.output_text.delta\ndata: {"sequence":1,"type":"item.output_text.delta","data":{"text":"A"}}\n\n' +
      'id: 2\nevent: turn.completed\ndata: {"sequence":2,"type":"turn.completed","terminal":true}\n\n';
    vi.stubGlobal('fetch', async () => sseResponse(chunksOf(stream, 1)));
    const observer = new SseObserver(opts);
    await observer.start(0);
    await observer.task;
    expect(observer.failure).toBeUndefined();
    expect(observer.frames.map((frame) => frame.id)).toEqual([1, 2]);
    expect(observer.frames[0].data.data.text).toBe('A');
    // id disagreeing with the payload sequence is a wire failure, not a frame.
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        'id: 9\nevent: item.output_text.delta\ndata: {"sequence":1,"type":"item.output_text.delta"}\n\n',
      ]),
    );
    const badId = new SseObserver(opts);
    await badId.start();
    await badId.task;
    expect(badId.failure).toBeDefined();
    expect(badId.frames).toHaveLength(0);
    // A 200 that is not an SSE stream fails at start, not as zero frames.
    vi.stubGlobal('fetch', async () => sseResponse([], 'text/html'));
    const html = new SseObserver(opts);
    await expect(html.start()).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  // B2 (behavioural): the lifted stream-view audit (R1-6) — every clause is
  // executed on injected views, including the double-terminal, shared-Part,
  // missing-item, blanking and replay-Part regressions (R1-2/R1-3/R1-4).
  it('behaves assertB2StreamViews on injected views', () => {
    const audit = load(
      [
        'assertB2StreamViews',
        'b2DeltaIdentity',
        'textDeltas',
        'eventText',
        'reconciledBetween',
      ],
      'assertB2StreamViews',
    )().assertB2StreamViews;
    const delta = (sequence, text, partId, itemId = 'item_turn_assistant') => ({
      sequence,
      terminal: false,
      type: 'item.output_text.delta',
      turn_id: 'turn_x',
      item_id: itemId,
      content_part_id: partId,
      data: { text },
    });
    const blanked = (sequence) => ({
      sequence,
      terminal: false,
      type: 'item.output_text.delta',
      turn_id: 'turn_x',
      item_id: null,
      content_part_id: null,
      data: { text: '' },
    });
    const reconciled = (sequence) => ({
      sequence,
      terminal: false,
      type: 'stream.reconciled',
      turn_id: 'turn_x',
      data: {},
    });
    const terminal = (sequence) => ({
      sequence,
      terminal: true,
      type: 'turn.completed',
      turn_id: 'turn_x',
      data: {},
    });
    const views = () => ({
      live: [
        delta(1, 'P1', 'partA'),
        reconciled(2),
        delta(3, 'P2', 'partB'),
        reconciled(4),
        delta(5, 'ANSWER', 'partC'),
        terminal(6),
      ],
      reload: [
        blanked(1),
        blanked(3),
        delta(5, 'ANSWER', 'partC'),
        terminal(6),
      ],
      replay: [
        blanked(1),
        blanked(3),
        delta(5, 'ANSWER', 'partC'),
        terminal(6),
      ],
      partials: ['P1', 'P2'],
      answer: 'ANSWER',
      firstPrefixSequence: 1,
      secondPrefixSequence: 3,
      originalTurnId: 'turn_x',
    });
    const healthy = audit(views());
    expect(healthy.livePartial1.partIds).toEqual(['partA']);
    expect(healthy.reloadAnswer.partIds).toEqual(['partC']);
    // R1-2: a second terminal in the drained live capture must red.
    const doubleTerminal = views();
    doubleTerminal.live.push(terminal(7));
    expect(() => audit(doubleTerminal)).toThrow(/B2 live SSE: .*terminals=2/);
    // A shared content Part means the retraction never broke the continuation.
    const sharedPart = views();
    sharedPart.live[2] = delta(3, 'P2', 'partA');
    expect(() => audit(sharedPart)).toThrow(/share a content Part/);
    // R1-3: a generation carrying no item_id must red, not pass via the union.
    const missingItem = views();
    missingItem.live[0] = delta(1, 'P1', 'partA', null);
    expect(() => audit(missingItem)).toThrow(
      /expected one shared assistant item/,
    );
    // An unblanked prefix in reload must red.
    const unblanked = views();
    unblanked.reload[0] = delta(1, 'P1', 'partA');
    expect(() => audit(unblanked)).toThrow(/not blanked in reload/);
    // R1-4: the replay must match the surviving answer's Part, not just item.
    const replayPart = views();
    replayPart.replay[2] = delta(5, 'ANSWER', 'partD');
    expect(() => audit(replayPart)).toThrow(/B2 replay view/);
    // A wrong converged live text must red.
    const wrongText = views();
    wrongText.live[4] = delta(5, 'WRONG', 'partC');
    expect(() => audit(wrongText)).toThrow(/B2 live SSE/);
    // F5: the LIVE answer's identity is load-bearing — a live stream that
    // delivers the surviving answer under the dead generation's Part, with no
    // identity, or under a foreign item must red even when reload/replay are
    // correct (live-only counterexamples).
    const liveDeadPart = views();
    liveDeadPart.live[4] = delta(5, 'ANSWER', 'partA');
    expect(() => audit(liveDeadPart)).toThrow(
      /live answer identity differs from reload/,
    );
    const liveNoIdentity = views();
    liveNoIdentity.live[4] = delta(5, 'ANSWER', null, null);
    expect(() => audit(liveNoIdentity)).toThrow(
      /live answer carries no identity/,
    );
    const liveForeignItem = views();
    liveForeignItem.live[4] = delta(5, 'ANSWER', 'partZ', 'item_foreign');
    expect(() => audit(liveForeignItem)).toThrow(
      /live answer identity differs from reload/,
    );
    // F6: a replay failure terminal (same turn id, text and identities) must
    // red — a reconnecting client shown a failure while live/reload show
    // success is not a passing B2.
    const replayFailed = views();
    replayFailed.replay[3] = { ...terminal(6), type: 'turn.failed' };
    expect(() => audit(replayFailed)).toThrow(/B2 replay view/);
    const replayCancelled = views();
    replayCancelled.replay[3] = { ...terminal(6), type: 'turn.cancelled' };
    expect(() => audit(replayCancelled)).toThrow(/B2 replay view/);
    // Adversarial completeness: every remaining clause has a counterexample.
    // A live FAILURE terminal (count still one) must red.
    const liveFailed = views();
    liveFailed.live[5] = { ...terminal(6), type: 'turn.failed' };
    expect(() => audit(liveFailed)).toThrow(/B2 live SSE/);
    // A missing earlier prefix in the live capture must red.
    const missingPartial = views();
    missingPartial.live.splice(2, 1);
    expect(() => audit(missingPartial)).toThrow(/B2 live SSE/);
    // Only one retraction in the live capture must red.
    const singleRetraction = views();
    singleRetraction.live.splice(3, 1);
    expect(() => audit(singleRetraction)).toThrow(/B2 live SSE/);
    // A retraction AFTER the new prefix (wrong order) must red.
    const lateRetraction = views();
    lateRetraction.live = [
      delta(1, 'P1', 'partA'),
      delta(3, 'P2', 'partB'),
      reconciled(4),
      delta(5, 'ANSWER', 'partC'),
      reconciled(6),
      terminal(7),
    ];
    lateRetraction.firstPrefixSequence = 1;
    lateRetraction.secondPrefixSequence = 3;
    expect(() => audit(lateRetraction)).toThrow(/B2 live SSE/);
    // An unblanked prefix in the REPLAY view must red.
    const replayUnblanked = views();
    replayUnblanked.replay[0] = delta(1, 'P1', 'partA');
    expect(() => audit(replayUnblanked)).toThrow(/B2 replay view/);
  });

  // B2: pin the identity/live-SSE observations and their harness-only gate so a
  // regression reds here at unit speed, not only in the real-stack lane.
  it('pins the B2 stream-identity and live-SSE observations', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toContain('function b2DeltaIdentity(');
    expect(source).toContain('function b2ModelAttempts(');
    expect(source).toContain('async function readPublicSse(');
    expect(source).toContain('function assertB2StreamViews(');
    expect(source).toContain('function readJournalManagedEvents(');
    expect(source).toContain('function textDeltas(');
    expect(source).toContain('item_id?: string | null;');
    expect(source).toContain('content_part_id?: string | null;');
    expect(source).toContain('turn_id?: string | null;');
    expect(source).toContain('B2 attempt identities:');
    expect(source).toContain('B2 live SSE:');
    expect(source).toContain('B2 stream identities:');
    expect(source).toContain('B2 replay view:');
    expect(source).toContain('b2-identities.json');
    // R1-5: the runner drives the shared observer, not a private parse loop.
    expect(source).toContain(
      "import { SseObserver } from '../integration-tests/helpers/hosted-sse-observer.js';",
    );
    // R1-2: the terminal is a progress signal; a bounded drain keeps reading.
    expect(source).toContain('const drainMs = options.drainMs ?? 2_000;');
    // R1-1: the capture promise is marked handled at creation, and the
    // teardown aborts observers (not bare controllers).
    expect(source).toContain('b2LiveCapture.catch(() => undefined);');
    expect(source).toContain(
      'for (const observer of b2SseObservers) observer.controller.abort();',
    );
    // R1-10: the model-round evidence is named explicitly, not borrowed from
    // a packaged-undefined-<epoch> gate directory.
    expect(source).toContain('const modelRoundEvidenceDirectory =');
    expect(source).toContain('writeEvidenceFile(modelRoundEvidenceDirectory, ');
    // The live capture starts before the first prefix and only in the
    // harness-only model-round variant; the frozen control plane keeps scope.
    const captureAt = source.indexOf('b2LiveCapture = readPublicSse(');
    expect(captureAt).toBeGreaterThan(-1);
    expect(source.slice(captureAt - 600, captureAt)).toContain(
      'if (harnessOnly)',
    );
    // The converged live view is the deltas after the LAST retraction — the
    // public stream.reconciled frame has no payload, so a raw concatenation of
    // every delta frame would still include the dead prefixes.
    const viewsAt = source.indexOf('function assertB2StreamViews(');
    expect(viewsAt).toBeGreaterThan(-1);
    expect(source.slice(viewsAt, viewsAt + 1600)).toContain(
      'event.sequence > last',
    );
    // The attempt-identity check runs before the shared audit (root-cause
    // diagnosis), gated on harnessOnly; the replay uses Last-Event-ID.
    const auditAt = source.indexOf('B2 attempt identities:');
    expect(source.slice(auditAt - 600, auditAt)).toContain('if (harnessOnly)');
    expect(source).toContain("lastEventId: '0',");
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
    expect(read('packages/managed-agent-server/README.md')).toContain(
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
    const readme = read('packages/managed-agent-server/README.md');
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
  // runtimeTakeover modes.
  it('pins the runtime recovery flags for every runner mode', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toContain(
      'const runtimeTakeover = inflightFailover || continuationFailover;',
    );
    expect(
      source.match(
        /if \(runtimeTakeover && !harnessOnly && process\.platform !== 'linux'\)/,
      ),
      'only orphaned Runtime takeover modes must require Linux',
    ).not.toBeNull();
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
      'both non-runtimeTakeover branches must pin durable local process off',
    ).toHaveLength(2);
    expect(
      source.match(
        /\.\.\.\(runtimeTakeover\s*\?\s*\{\s*QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS:\s*process\.platform === 'linux' \? 'true' : 'false'/g,
      ),
      'both durable local process branches must follow runtimeTakeover, Linux-gated',
    ).toHaveLength(2);
  });

  // The frozen control-plane arm proves #12952 Q2's binding half only if the
  // woken former Spring really tried its stale claim: without the general-log
  // witness every unchanged row would hold just as well after a wake that
  // never reached a store call. A failed run must also wake the stopped JVM
  // before teardown, or stopChild's SIGTERM stays pending on it.
  it('keeps the frozen control-plane wake non-vacuous and woken at teardown', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toContain("SET GLOBAL general_log = 'ON'");
    expect(source).toMatch(
      /LOCATE\(\$\{sqlString\(formerDispatchOwner\)\}, CONVERT\(argument USING utf8mb4\)\)/,
    );
    // Only statements sent after the wake may count, or the frozen owner's
    // pre-freeze renewals would satisfy the witness on their own.
    expect(source).toMatch(
      /FROM mysql\.general_log WHERE event_time >= \$\{sqlString\(wokeAt\)\}/,
    );
    const quiet = source.indexOf("'Replacement quiet before the wake'");
    const wake = source.indexOf(
      "signalProcessTree(child.child, 'SIGCONT');",
      quiet,
    );
    const witness = source.indexOf(
      '(remainingMs) => staleClaimUpdates(remainingMs) > 0',
    );
    const compare = source.indexOf('const afterWake = fencedState();');
    expect(quiet).toBeGreaterThan(-1);
    expect(
      wake,
      'the before-wake snapshot must settle before the former pair resumes',
    ).toBeGreaterThan(quiet);
    expect(witness).toBeGreaterThan(wake);
    expect(
      compare,
      'the fenced-state comparison must wait for the stale-claim witness',
    ).toBeGreaterThan(witness);
    // The waits are awaited: a floating one would let the comparison run
    // before anything it waits for was observed.
    for (const label of [
      'Replacement quiet before the wake',
      'Woken control plane exercises its stale claim',
      'Woken Harness meets the writer fence',
    ]) {
      expect(source).toMatch(new RegExp(`await waitUntil\\(\\s*'${label}'`));
    }
    // A dead replacement would hold every snapshot still: each wait in the
    // window watches the pair, and the verdict checks it once more.
    expect(source).toContain(
      'const owners = [replacementSpring, finishingHarness];',
    );
    for (const label of [
      'Replacement quiet before the wake',
      'Former control plane wake',
      'Woken control plane exercises its stale claim',
      'Woken Harness meets the writer fence',
    ]) {
      const at = source.indexOf(`'${label}'`);
      const end = source.indexOf('\n        );', at);
      expect(at, label).toBeGreaterThan(-1);
      expect(source.slice(at, end), label).toMatch(/\n {10}owners,$/);
    }
    const ownersAlive = source.indexOf(
      'for (const owner of owners) {\n          if (childExited(owner.child)) {\n            throw new Error(',
      compare,
    );
    expect(ownersAlive).toBeGreaterThan(compare);
    expect(ownersAlive).toBeLessThan(
      source.indexOf('const moved = (', compare),
    );
    // The baseline the comparison uses is the snapshot the quiet poll
    // settled on, taken before the wake.
    const settle = source.indexOf('beforeWake = settled;', quiet);
    expect(
      settle,
      'the snapshot the equality gate compares must be taken before the wake',
    ).toBeGreaterThan(quiet);
    expect(settle).toBeLessThan(wake);
    expect(
      source.slice(wake, compare),
      'the baseline must not be re-taken after the wake',
    ).not.toMatch(/\bbeforeWake\s*=/);
    // The woken Harness needs its home, or the checks hold by absence.
    const home = source.indexOf(
      "'Frozen control-plane arm lost the Harness home the wake depends on'",
    );
    expect(home).toBeGreaterThan(quiet);
    expect(home).toBeLessThan(wake);
    // The writer axis: no refusal before the wake, one after it, and the
    // comparison waits for it. The refusal text is the store's own.
    const refusal = 'The Managed Session writer grant is stale or unavailable';
    expect(source).toContain(`'${refusal}'`);
    expect(
      read(
        'packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedSessionStore.java',
      ),
    ).toContain(`"${refusal}."`);
    const writerBefore = source.indexOf(
      'if (harness.log().includes(staleWriterRefusal))',
    );
    // Counted on the output kept since the wake, not the rolling log tail.
    expect(source).toContain(
      'harnessOutputSinceWake.split(staleWriterRefusal).length - 1',
    );
    const writerWitness = source.indexOf('() => staleWriterRefusals() > 0');
    expect(writerBefore).toBeGreaterThan(quiet);
    expect(writerBefore).toBeLessThan(wake);
    expect(writerWitness).toBeGreaterThan(wake);
    expect(compare).toBeGreaterThan(writerWitness);
    const teardown = source.lastIndexOf('} finally {');
    const teardownWake = source.indexOf(
      'for (const child of frozenChildren.splice(0))',
      teardown,
    );
    const stop = source.indexOf('await stopChild(child.child);', teardown);
    expect(teardownWake).toBeGreaterThan(teardown);
    expect(stop).toBeGreaterThan(teardownWake);
  });

  // Every mode now runs through the G0 public Workspace admission, and the
  // failover modes hand the same Session to a replacement owner: both Spring
  // launch sites and both Harness launch sites must carry the admission
  // wiring, or a mode turns red only after the failover kill with an error
  // that reads like a takeover defect instead of a config asymmetry.
  it('pins the G0 workspace admission at both launch sites', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toContain(
      'const workspaceTurns = runtimeTakeover || bigOutput;',
    );
    expect(
      source.match(
        /\.\.\.\(workspaceTurns\s*\?\s*\{\s*workspace:\s*\{\s*workspace_id:\s*boundWorkspaceId\s*\}\s*\}/,
      ),
      'every workspaceTurns mode must create a Workspace-bound Session',
    ).not.toBeNull();
    expect(
      source.match(
        /directory === runtimeState && workspaceTurns\s*\?\s*\{\s*mode:\s*0o700\s*\}/,
      ),
      'every workspaceTurns mode must keep Runtime state owner-only',
    ).not.toBeNull();
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
      source.match(/INSERT INTO qwen_managed_agent\.ma_workspace\b/g),
      'the Workspace registry row must be seeded for every mode',
    ).toHaveLength(1);
    expect(
      source.match(/INSERT INTO qwen_managed_agent\.ma_workspace_access/g),
      'the Workspace access grant must be seeded for every mode',
    ).toHaveLength(1);
    // The counts above cannot see WHERE an item sits: the runner before the
    // admission alignment gated these same items inside workspaceTurns
    // conditionals and satisfied every count. These negative pins are the
    // symmetry witness. The windows stay short so the gates that must stay
    // (durable local process, the Linux check, the 0700 state dir, the
    // unbound create body) and comments mentioning either predicate do not
    // trip them.
    for (const predicate of ['workspaceTurns', 'runtimeTakeover']) {
      for (const reGated of [
        new RegExp(
          `${predicate}[\\s\\S]{0,120}?QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER`,
        ),
        new RegExp(
          `${predicate}[\\s\\S]{0,120}?QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED`,
        ),
        new RegExp(`${predicate}[\\s\\S]{0,120}?--managed-runtime-broker-url`),
        new RegExp(`${predicate}[\\s\\S]{0,120}?workspaceMount`),
        new RegExp(`if \\(${predicate}\\) \\{\\s*runMysql\\(`),
      ]) {
        expect(
          source.match(reGated),
          `G0 admission re-gated behind ${predicate}: ${reGated}`,
        ).toBeNull();
      }
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
    const readme = read('packages/managed-agent-server/README.md');
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
    const readme = read('packages/managed-agent-server/README.md');
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
    // The by-hand recipe re-anchors Spring to the Prerequisites environment.
    // Without a store descriptor the Harness answers every attach with
    // 400 invalid_managed_session_store, so the store must come on with the
    // Harness and find its workspace ID there: application.yml derives the
    // switch from the Harness, and Prerequisites exports the ID.
    expect(
      read(
        'packages/managed-agent-server/server/src/main/resources/application.yml',
      ),
      'the Session Store switch must follow the Harness by default',
    ).toContain(
      "enabled: '${QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED:${qwen.managed-agent.harness.enabled:false}}'",
    );
    const prerequisites = readme.slice(
      readme.indexOf('## Prerequisites'),
      readme.indexOf('## Public Session lifecycle'),
    );
    expect(
      prerequisites,
      'Prerequisites must export the workspace ID that scopes the store',
    ).toMatch(/^export QWEN_MANAGED_AGENT_WORKSPACE_ID='[^']+'$/m);
    // The base URL is read once at JVM startup: exported below the restart
    // cue it never reaches the reader's JVM, and every Turn fails while the
    // recipe reads complete. The cue is hard-wrapped, so compare on the
    // collapsed slice, and require both positions so neither can pass as -1.
    const flat = slice.replace(/\s+/g, ' ');
    const cue = flat.indexOf('restart it with the override');
    const baseUrlExport = flat.indexOf(
      `QWEN_MANAGED_AGENT_HARNESS_BASE_URL='http://127.0.0.1:${port}'`,
    );
    expect(cue, 'the slice must keep the Spring restart cue').toBeGreaterThan(
      -1,
    );
    expect(baseUrlExport).toBeGreaterThan(-1);
    expect(
      baseUrlExport,
      'the Harness base-url export must precede the Spring restart cue',
    ).toBeLessThan(cue);
  });

  it('keeps the review-corrections merge gates behind the CI-gated Hosted proofs', () => {
    // The hosted-harness-mysql CI job runs HostedWorkspaceToolTurnIT (a real
    // file-tool Turn through the packaged worker), fail-closed via the
    // failsafe includes and check-failsafe-reports.js, and the
    // hosted-failover-e2e job runs the three owner-failover E2E modes
    // against the production HTTP durable-store adapter. While both
    // oracles stand, the review-corrections gates must not re-assert those
    // capabilities as unproven — the foundation-boundary banner names that
    // document the current authority, so the false claim reaches
    // integrators in either language.
    const toolTurnIt =
      'packages/managed-agent-server/verification/src/test/java/com/alibaba/qwen/code/managedagent/HostedWorkspaceToolTurnIT.java';
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
    const readme = read('packages/managed-agent-server/README.md');
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

  // The mirror of the stall bound: a poll already in flight at the deadline
  // must be allowed to answer. The final iteration can start with a sliver
  // of budget left, and a dependency that becomes ready inside that sliver
  // is ready — discarding its answer misreports it as a wedged predicate.
  it('waitUntil lets the final in-flight poll answer past the deadline', async () => {
    const { waitUntil } = loadWaitUntil();
    let polls = 0;
    await expect(
      waitUntil(
        'probe',
        async () => {
          // Key the transition on the poll count, not the clock: a
          // clock-keyed predicate must outwait one interval before it can
          // answer true, leaving the loop's re-entry a ~30ms sliver that
          // ordinary CI timer lateness eats. The instant first decline
          // re-enters with ~150ms of budget, and this poll's fixed sleep
          // still answers past the 250ms deadline.
          if (polls++ === 0) return false;
          await new Promise((resolve) => setTimeout(resolve, 300));
          return true;
        },
        250,
      ),
    ).resolves.toBeUndefined();
  });

  it('waitUntil reports a child that exited early', async () => {
    const { waitUntil } = loadWaitUntil();
    await expect(
      waitUntil('probe', () => new Promise(() => {}), 300, {
        child: { exitCode: 1, signalCode: null },
        log: () => '',
        name: 'Only',
      }),
    ).rejects.toThrow(/exited early: Only\n/);
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
        name: 'Only',
      }),
    ).rejects.toThrow(/exited early: Only\n/);
  });

  // The model-round terminal wait watches the control plane and the Harness
  // generation finishing the round; either one dying must end the wait and
  // say which one died, and a deadline must still report both tails.
  it('waitUntil watches every child it is given', async () => {
    const { waitUntil } = loadWaitUntil();
    const live = (name) => ({
      child: { exitCode: null, signalCode: null },
      log: () => `${name} log`,
      name,
    });
    const dead = (name) => ({
      child: { exitCode: 1, signalCode: null },
      log: () => `${name} log`,
      name,
    });
    await expect(
      waitUntil('probe', () => false, 300, [dead('First'), live('Second')]),
    ).rejects.toThrow(/exited early: First\nFirst log/);
    await expect(
      waitUntil('probe', () => false, 300, [live('First'), dead('Second')]),
    ).rejects.toThrow(/exited early: Second\nSecond log/);
    await expect(
      waitUntil('probe', () => false, 300, [live('First'), live('Second')]),
    ).rejects.toThrow(/did not become ready\nFirst log\nSecond log$/);
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toMatch(
      /waitForTerminal\(\s*replacementSpringUrl,\s*tenant,\s*session\.id,\s*0,\s*\[replacementSpring, finishingHarness\],/,
    );
  });

  // A rejecting-then-hanging predicate must keep both facts: the deadline
  // found the hang, so the older real error is named as predating the stall
  // rather than posing as the state the deadline saw.
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
    expect(failure.message).toContain(
      'predicate stalled; last error before the stall: ECONNREFUSED',
    );
  });

  // The stall wording is earned by a stalled final poll: a predicate that
  // answers every poll with the same real error must not acquire it.
  it('waitUntil names no stall when the error is the deadline state', async () => {
    const { waitUntil } = loadWaitUntil();
    const failure = await waitUntil(
      'probe',
      () =>
        Promise.reject(
          new Error('fetch failed', { cause: new Error('ECONNREFUSED') }),
        ),
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
    // payload is printed eagerly. The freeze arm's wake record reads as a
    // pass line on stdout too, so it defers the same way — no eager
    // console.log of a JSON payload remains inside the try at all.
    expect(source.match(/resultJson = JSON\.stringify\(/g)).toHaveLength(5);
    expect(
      source.match(/approvalResultJson = JSON\.stringify\(/g),
    ).toHaveLength(1);
    expect(source.match(/g3SummaryJson = JSON\.stringify\(/g)).toHaveLength(1);
    expect(source.match(/fencedWriterJson = JSON\.stringify\(/g)).toHaveLength(
      2,
    );
    expect(source).not.toMatch(/console\.log\(\s*JSON\.stringify\(/);
    // No gate typechecks scripts/ (tsx strips types unchecked), so the
    // module-scope binding the deferred print reads is pinned by text:
    // dropped, the print below throws ReferenceError on the success path.
    expect(source).toMatch(/^let resultJson: string \| undefined;$/m);
    expect(source).toMatch(/^let approvalResultJson: string \| undefined;$/m);
    expect(source).toMatch(/^let g3SummaryJson: string \| undefined;$/m);
    expect(source).toMatch(/^let fencedWriterJson: string \| undefined;$/m);
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
    const approvalPrint = source.indexOf('console.log(approvalResultJson)');
    const summaryPrint = source.indexOf('console.log(g3SummaryJson)');
    expect(approvalPrint).toBeGreaterThan(signalThrow);
    expect(summaryPrint).toBeGreaterThan(approvalPrint);
    expect(summaryPrint).toBeLessThan(print);
    expect(
      print,
      'the success payload must print only after both exit guards',
    ).toBeGreaterThan(signalThrow);
    // The freeze arm's wake record follows the main result, restoring the
    // base's ordering, and sits behind the same two guards.
    const wakePrint = source.indexOf('console.log(fencedWriterJson)');
    expect(
      wakePrint,
      'the freeze wake record must print only after the main result',
    ).toBeGreaterThan(print);
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
  // timeout, and the lease polls (writer and dispatch lease expiry, the
  // model-round arm's second writer lease, and the approval fault arms'
  // post-crash writer lease) derive each call's timeout from the remaining
  // waitUntil budget rather than a site-local constant that can overshoot
  // the declared budget several-fold.
  it('bounds every synchronous MySQL probe by the poll budget', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toMatch(/spawnSync\(\s*mysqladmin,[\s\S]*?timeout: 10_000/);
    // Pin the forwarded argument, not the parameter list: an arrow that
    // takes remainingMs but never passes it on falls back to the 10 s
    // default inside a budget that may be smaller.
    expect(
      source.match(/\(remainingMs\) =>\s*runMysql\([\s\S]*?remainingMs,/g),
      'every lease poll must derive the probe timeout from the waitUntil budget',
    ).toHaveLength(4);
    // The frozen arm's snapshot fans one budget out over several
    // synchronous probes; each takes its share, not the whole budget.
    const fenced = source.slice(
      source.indexOf('const fencedState = ('),
      source.indexOf('// The replacement must go quiet first'),
    );
    const probes = Number(source.match(/const fencedProbes = (\d+);/)?.[1]);
    expect(fenced).toContain(
      'const probeMs = Math.max(1, Math.floor(timeoutMs / fencedProbes));',
    );
    expect(fenced.match(/runMysql\(/g)).toHaveLength(probes);
    expect(fenced.match(/^\s*probeMs,$/gm)).toHaveLength(probes);
    expect(fenced).not.toMatch(/^\s*timeoutMs,$/m);
  });

  // The model-round arm samples the head once per generation: each
  // takeover must advance the writer, the journal and the committed
  // sequence, not the writer generation alone.
  it('requires every head column to advance across the model-round takeovers', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toMatch(
      /!\[0, 1, 2\]\.every\(\s*\(column\) => head\[column\] > heads\[index - 1\]\[column\],?\s*\)/,
    );
    expect(source).toMatch(
      /const currentHead = \(\) =>\s*runMysql\(\s*mysqlPort,\s*`SELECT writer_generation, journal_revision, committed_sequence FROM/,
    );
  });

  it('selects the executable classifier for the runner and image', () => {
    const script = read('scripts/run-managed-agent-server-e2e.ts');
    expect(script).toContain(
      'qwen-managed-agent-server-${pomVersion}-exec.jar',
    );
    const dockerfile = read('packages/managed-agent-server/Dockerfile');
    expect(dockerfile).toContain('qwen-managed-agent-server-*-exec.jar');
    expect(dockerfile).toContain('/tmp/qwen-managed-agent-server.jar');
    expect(read('packages/managed-agent-server/server/pom.xml')).toContain(
      '<classifier>exec</classifier>',
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
    const match = read('packages/managed-agent-server/pom.xml').match(pattern);
    expect(match?.[0]).toContain(
      '<artifactId>qwen-managed-agent-parent</artifactId>',
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
      '<artifactId>qwen-managed-agent-parent</artifactId>\n  <version>\n    9.9.9\n  </version>';
    expect(wrapped.match(pattern)?.[1]).toBe('9.9.9');
    expect(
      '<artifactId>qwen-managed-agent-parent</artifactId><version></version>'.match(
        pattern,
      ),
    ).toBeNull();
  });

  it('keeps the image on the loopback default and the jar guard loud', () => {
    const dockerfile = read('packages/managed-agent-server/Dockerfile');
    // The module has no HTTP authentication, so the published image must
    // not bind beyond loopback by default: publishing is the operator's
    // explicit -e opt-in at docker run, documented in the README's
    // container section. The cardinality guard stays loud, so the build
    // fails rather than shipping a wrong or glob-stat jar.
    // Dockerfile instructions are case-insensitive and tolerate leading
    // whitespace, so anchor on the instruction rather than its
    // conventional spelling: a lowercase or indented ENV would
    // reintroduce the published wide bind with an uppercase-only pin
    // green.
    expect(dockerfile).not.toMatch(
      /^[ \t]*ENV[ \t]+QWEN_MANAGED_AGENT_SERVER_ADDRESS/im,
    );
    expect(dockerfile).not.toMatch(
      /^[ \t]*ENV[ \t]+QWEN_MANAGED_AGENT_RUNTIME_BROKER_HOST/im,
    );
    // Pin the bind default at the file that owns it, not only at one
    // downstream file declining to override it: every Java test passes
    // --server.address on the command line and the e2e runner passes none,
    // so a flipped yml default would otherwise ship silently.
    const applicationYml = read(
      'packages/managed-agent-server/server/src/main/resources/application.yml',
    );
    expect(applicationYml).toMatch(
      /address: '\$\{QWEN_MANAGED_AGENT_SERVER_ADDRESS:127\.0\.0\.1\}'/,
    );
    expect(dockerfile).toMatch(/\{ \[ "\$count" -eq 1 \] \|\|/);
    expect(dockerfile).toContain('expected exactly one executable server jar');
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
    const readme = read('packages/managed-agent-server/README.md');
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
        // Docker drops a valueless -e whose variable is unset without a
        // warning, so the recipe prose must have the operator export BOTH
        // valueless variables: an instruction naming only the password
        // boots the container with an empty signing key, and the JVM dies
        // at BrokerSecurity's minimum-key guard with the published port
        // refused. The Dockerfile's comment defers to the README's
        // container section rather than repeating the precondition, so
        // the pin is README-only.
        if (document === readme) {
          const preceding = document.slice(0, before === -1 ? 0 : before);
          expect(
            preceding,
            'the prose ahead of a documented server wildcard bind must have the operator export both valueless variables',
          ).toMatch(
            /export[\s\S]{0,160}?QWEN_MANAGED_AGENT_AUTH_SIGNING_KEY[\s\S]{0,160}?SPRING_DATASOURCE_PASSWORD/,
          );
        }
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
      const dockerfile = read('packages/managed-agent-server/Dockerfile');
      const stage = dockerfile.match(
        /cd packages\/managed-agent-server\/server\/target \\[\s\S]*?&& cp "\$main" \/tmp\/qwen-managed-agent-server\.jar/,
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
        { jars: ['qwen-managed-agent-server-1.0.jar'], status: 1, found: 0 },
        { jars: ['qwen-managed-agent-server-1.0-exec.jar'], status: 0 },
        {
          jars: [
            'qwen-managed-agent-server-1.0.jar',
            'qwen-managed-agent-server-1.0-exec.jar',
            'qwen-managed-agent-server-1.0-workspace-bundle.jar',
            'qwen-managed-agent-server-1.0-operator-recovery.jar',
          ],
          status: 0,
        },
        {
          jars: [
            'qwen-managed-agent-server-1.0.jar',
            'qwen-managed-agent-server-1.0-exec.jar',
            'qwen-managed-agent-server-1.0-workspace-bundle.jar',
            'qwen-managed-agent-server-1.0-workspace-migration.jar',
            'qwen-managed-agent-server-1.0-operator-recovery.jar',
          ],
          status: 0,
        },
        {
          jars: [
            'qwen-managed-agent-server-1.0-exec.jar',
            'qwen-managed-agent-server-2.0-exec.jar',
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
              'cd packages/managed-agent-server/server/target',
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
              `expected exactly one executable server jar, found ${found}`,
            );
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );
});
