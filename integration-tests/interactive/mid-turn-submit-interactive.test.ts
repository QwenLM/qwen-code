/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import stripAnsi from 'strip-ansi';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIHandler,
  type FakeOpenAIResponse,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  TestRig,
  type,
  printDebugInfo,
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
} from '../test-helper.js';

type RigSession = ReturnType<TestRig['runInteractive']>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rendered by the CLI while the model stream is deliberately held open. Seeing
 * it is what proves the run is mid-stream: awaiting the fake server's handler
 * only ever holds a turn before the first byte, and a pre-first-byte turn is a
 * different CLI state from the one every case below submits into.
 */
const HELD_MARKER = 'MID_TURN_HELD_MARKER';
const HELD_TAIL = 'MID_TURN_HELD_TAIL';
const QUIT_DESCRIPTION = 'exit the cli';
const NOTES_CANARY = 'MID_TURN_NOTES_CANARY_4821';
const TOOL_RESULT_CANARY = 'MID_TURN_TOOL_RESULT_CANARY_4822';
const STEER_PROMPT = 'Also fold in the notes file';
const STEER_TEXT = `@notes.txt ${STEER_PROMPT}`;
/** A project command's prompt body: proof the command ran, nothing else emits it. */
const DEFERRED_CANARY = 'MID_TURN_DEFERRED_COMMAND_CANARY_4823';
const DEFERRED_INVOCATION = '/defer-probe fold the readiness hop in';

let releaseHeldTurn: (() => void) | undefined;

/**
 * First-turn response that stops after one content delta and waits for the
 * test to release it.
 */
function heldFirstTurn(extra: Partial<FakeOpenAIResponse> = {}): {
  response: FakeOpenAIResponse;
  release: () => void;
} {
  let release!: () => void;
  const holdUntil = new Promise<void>((resolve) => {
    release = () => {
      releaseHeldTurn = undefined;
      resolve();
    };
  });
  releaseHeldTurn = release;
  return {
    release,
    response: {
      ...extra,
      contentChunks: [HELD_MARKER, HELD_TAIL],
      holdAfterChunks: 1,
      holdUntil,
    },
  };
}

describe('Mid-turn submit', () => {
  let rig: TestRig;
  let fakeServer: FakeOpenAIServer | undefined;
  let restoreNoProxy: () => void;

  beforeEach(() => {
    rig = new TestRig();
    restoreNoProxy = applyContainerSandboxNoProxy();
  });

  afterEach(async () => {
    releaseHeldTurn?.();
    releaseHeldTurn = undefined;
    await fakeServer?.close();
    fakeServer = undefined;
    restoreNoProxy();
    await rig.cleanup();
  });

  async function rigSetup(dirName: string): Promise<void> {
    await rig.setup(dirName, {
      settings: {
        memory: {
          enableManagedAutoMemory: false,
          enableManagedAutoDream: false,
        },
        ui: {
          enableFollowupSuggestions: false,
        },
        security: {
          auth: {
            selectedType: 'openai',
          },
        },
      },
    });
  }

  /**
   * Starts the scripted server and pins the language the CLI child renders in:
   * every readiness and behaviour match below is an English UI string, and both
   * boot helpers spawn from `process.env` with no per-run override (the cron
   * suite pins the same variable for its sessions).
   */
  async function startHeldServer(
    handler: FakeOpenAIHandler,
  ): Promise<FakeOpenAIServer> {
    process.env['QWEN_CODE_LANG'] = 'en';
    fakeServer = await startFakeOpenAIServer(handler, fakeServerHostOptions());
    return fakeServer;
  }

  function cliArgs(server: FakeOpenAIServer): string[] {
    return [
      '--auth-type',
      'openai',
      '--openai-api-key',
      'fake-key',
      '--openai-base-url',
      server.baseUrl,
      '--model',
      'fake-model',
    ];
  }

  async function bootCli(handler: FakeOpenAIHandler): Promise<RigSession> {
    const server = await startHeldServer(handler);
    const session = rig.runInteractive(...cliArgs(server));

    const isReady = await rig.waitForText('Type your message', 30_000);
    if (!isReady) {
      printDebugInfo(rig, rig._interactiveOutput, { isReady });
    }
    expect(isReady, 'CLI did not start up in interactive mode').toBe(true);
    return session;
  }

  /**
   * Opens a turn and waits until the held delta is on screen — the state every
   * case submits into.
   */
  async function submitUntilMidTurn({ ptyProcess }: RigSession) {
    await type(ptyProcess, 'Start the review.');
    await type(ptyProcess, '\r');
    const midTurn = await rig.waitForText(HELD_MARKER, 30_000);
    if (!midTurn) {
      printDebugInfo(rig, rig._interactiveOutput, { midTurn });
    }
    expect(
      midTurn,
      'Held response never reached the screen, so the turn is not mid-stream',
    ).toBe(true);
  }

  /**
   * Everything the CLI has sent the model so far, as one haystack. Whether a
   * submission ran is read from request bodies rather than screen text: OpenTUI
   * repaints by diffing cells, so text a user can plainly see may never reach
   * the byte stream as a contiguous run.
   */
  function requestBodies(): string {
    return fakeServer!.requests
      .map((request) => JSON.stringify(request.body))
      .join('\n');
  }

  async function waitForRequestBody(fragment: string): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      if (requestBodies().includes(fragment)) return true;
      await sleep(200);
    }
    return false;
  }

  async function expectExitMidHold(
    { promise }: RigSession,
    label: string,
  ): Promise<void> {
    const exited = await Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000)),
    ]);
    if (!exited) {
      printDebugInfo(rig, rig._interactiveOutput, { exited });
    }
    expect(exited, `${label} did not exit while the stream was held`).toEqual(
      expect.objectContaining({ exitCode: 0 }),
    );
  }

  it('exits on /quit while the response stream is held mid-turn', async () => {
    await rigSetup('mid-turn-quit');
    const held = heldFirstTurn();
    const session = await bootCli(() => held.response);
    await submitUntilMidTurn(session);

    session.ptyProcess.write('/quit');
    // A single PTY write prevents the cumulative output from matching a popup
    // rendered for an intermediate prefix such as `/q`.
    const quitSuggested = await rig.waitForText(QUIT_DESCRIPTION, 30_000);
    if (!quitSuggested) {
      printDebugInfo(rig, rig._interactiveOutput, { quitSuggested });
    }
    expect(quitSuggested, '/quit never reached the completion popup').toBe(
      true,
    );
    await type(session.ptyProcess, '\r');

    await expectExitMidHold(session, '/quit');
    expect(stripAnsi(rig._interactiveOutput)).not.toContain(HELD_TAIL);
    held.release();
  });

  it('exits on a bare quit token while the response stream is held mid-turn', async () => {
    await rigSetup('mid-turn-bare-exit');
    const held = heldFirstTurn();
    const session = await bootCli(() => held.response);
    await submitUntilMidTurn(session);

    // No leading slash: `exit` has to be recognised as a quit before it can
    // reach the model as prompt text.
    await type(session.ptyProcess, 'exit');
    await type(session.ptyProcess, '\r');

    await expectExitMidHold(session, 'bare exit');
    expect(fakeServer!.requests).toHaveLength(1);
    expect(stripAnsi(rig._interactiveOutput)).not.toContain(HELD_TAIL);
    held.release();
  });

  it('holds a slash command back mid-turn and runs it once the stream ends', async () => {
    await rigSetup('mid-turn-deferred-command');
    rig.mkdir('.qwen/commands');
    rig.createFile(
      '.qwen/commands/defer-probe.md',
      `---\ndescription: Deferred command probe\n---\n${DEFERRED_CANARY} {{args}}\n`,
    );
    const held = heldFirstTurn();
    const session = await bootCli(({ requestIndex }) =>
      requestIndex === 0 ? held.response : { content: 'MID_TURN_DEFER_DONE' },
    );
    await submitUntilMidTurn(session);

    await type(session.ptyProcess, DEFERRED_INVOCATION);
    await type(session.ptyProcess, '\r');
    // No second request may open while the held turn is still in flight. This
    // is not the gate: a submission that skipped it would be steered into the
    // same turn and would leave this assertion untouched too (measured). The
    // gate's verdict is pinned in the app-shell units; what this case adds is
    // the drain half below.
    await sleep(3000);
    expect(
      requestBodies(),
      'A second request opened while the held turn was still in flight',
    ).not.toContain(DEFERRED_CANARY);

    held.release();
    const drained = await waitForRequestBody(DEFERRED_CANARY);
    if (!drained) {
      printDebugInfo(rig, rig._interactiveOutput, { drained });
    }
    expect(drained, 'The held-back slash command never ran').toBe(true);
    // It ran as a command: the prompt body the registry expands from the command
    // file, in a single extra turn, never the typed invocation as prompt text.
    expect(fakeServer!.requests).toHaveLength(2);
    expect(JSON.stringify(fakeServer!.requests[1].body)).toContain(
      'fold the readiness hop in',
    );
    expect(requestBodies()).not.toContain(DEFERRED_INVOCATION);

    session.ptyProcess.kill();
    await session.promise;
  });

  it('expands a steered @file mention into the tool continuation request', async () => {
    await rigSetup('mid-turn-steered-file');
    const toolFile = rig.createFile('tool-result.txt', TOOL_RESULT_CANARY);
    rig.createFile('notes.txt', NOTES_CANARY);
    const held = heldFirstTurn({
      toolCalls: [fakeToolCall('read_file', { file_path: toolFile })],
    });
    const session = await bootCli(({ requestIndex }) =>
      requestIndex === 0 ? held.response : { content: 'MID_TURN_STEER_DONE' },
    );
    await submitUntilMidTurn(session);

    // Typed while the first turn still streams: this mention can only reach the
    // model through the steering hop, never through the composer.
    await type(session.ptyProcess, STEER_TEXT);
    await type(session.ptyProcess, '\r');
    held.release();

    const done = await rig.waitForText('MID_TURN_STEER_DONE', 30_000);
    if (!done) {
      printDebugInfo(rig, rig._interactiveOutput, { done });
    }
    expect(done, 'Tool continuation never completed').toBe(true);
    expect(fakeServer!.requests).toHaveLength(2);

    const [firstBody, continuationBody] = fakeServer!.requests.map((request) =>
      JSON.stringify(request.body),
    );
    expect(
      firstBody,
      'The steered mention leaked into the request that opened the turn',
    ).not.toContain(NOTES_CANARY);
    expect(continuationBody).toContain(TOOL_RESULT_CANARY);
    expect(continuationBody).toContain(STEER_PROMPT);
    expect(
      continuationBody,
      'Steered @file reached the model unexpanded, so its content never did',
    ).toContain(NOTES_CANARY);

    session.ptyProcess.kill();
    await session.promise;
  });
});
