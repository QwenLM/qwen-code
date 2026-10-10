import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { URL, pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';

/** Original shared runner for streamed diagnostics; legacy fixtures retain disclosed ChatRecord composition. */
export async function generateNativeTextTurns(
  stores,
  input,
  contract,
  evidence,
  root,
) {
  const core = (name) =>
    pathToFileURL(`${root}/packages/core/dist/src/managed-runtime/${name}.js`)
      .href;
  const { openManagedSession } = await import(core('managed-session-assembly'));
  const { createManagedHarnessHandle } = await import(
    core('managed-harness-factory')
  );
  const { ManagedHookActivationController } = await import(
    core('managed-hook-activation')
  );
  const { runHostedHarnessTextTurn } = await import(
    pathToFileURL(`${root}/packages/cli/dist/src/serve/hosted-harness-model.js`)
      .href
  );
  const runHostedHarnessTurn = input.streamed
    ? (
        await import(
          pathToFileURL(
            `${root}/packages/cli/dist/src/serve/hosted-harness-turn.js`,
          ).href
        )
      ).runHostedHarnessTurn
    : undefined;
  const longDelta = '汉'.repeat(1023) + '😀' + '🧪'.repeat(1000) + 'END';
  const promptFor = (turn) =>
    turn === 5 ? 'A'.repeat(65300) : `owned prompt ${turn} 汉字\nline`;
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    try {
      let wire = '';
      for await (const chunk of req) wire += chunk.toString('utf8');
      const body = JSON.parse(wire);
      const content = body.messages.findLast(
        (message) => message.role === 'user',
      )?.content;
      const texts =
        typeof content === 'string'
          ? [content]
          : content
              .filter((part) => part.type === 'text')
              .map((part) => part.text);
      const matches = [1, 2, 3, 4, 5].filter((turn) =>
        texts.includes(promptFor(turn)),
      );
      if (
        req.method !== 'POST' ||
        req.url !== '/v1/chat/completions' ||
        matches.length !== 1
      ) {
        res.writeHead(400);
        res.end('Unknown owned provider request');
        return;
      }
      const turn = matches[0];
      const base = {
        id: `owned-response-${turn}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'owned-model',
      };
      const chunks = [];
      const add = (delta, finish_reason = null) =>
        chunks.push({ ...base, choices: [{ index: 0, delta, finish_reason }] });
      add({
        role: 'assistant',
        reasoning_content: `owned reasoning ${turn} 汉字\n`,
      });
      if (turn === 3) {
        add({
          tool_calls: [
            {
              index: 0,
              id: 'owned-tool-call',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"file_path":"must-not-read"}',
              },
            },
          ],
        });
        add({}, 'tool_calls');
      } else if (input.streamed && turn === 2) {
        add({ content: `owned partial ${requests.length + 1} 😀` });
      } else {
        add({
          content:
            input.streamed && turn === 1 ? longDelta : `owned answer ${turn} ✓`,
        });
        if (input.streamed && turn === 1) add({ content: '尾😀🧪' });
        add({}, 'stop');
      }
      const usage =
        turn === 4
          ? {
              prompt_tokens: 15.5,
              completion_tokens: 11.25,
              total_tokens: 26.75,
              prompt_tokens_details: { cached_tokens: 1.25 },
              completion_tokens_details: { reasoning_tokens: 3.5 },
            }
          : {
              prompt_tokens: 11 + turn,
              completion_tokens: 7 + turn,
              total_tokens: 18 + 2 * turn,
              completion_tokens_details: { reasoning_tokens: 3 },
            };
      if (!input.streamed || turn !== 2)
        chunks.push({ ...base, choices: [], usage });
      const sse =
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
        (input.streamed && turn === 2 ? '' : 'data: [DONE]\n\n');
      const observed = { turn, wire, chunks, sse };
      requests.push(observed);
      if (body.tools?.length)
        throw new Error('No-tool diagnostic declared tools');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (input.streamed && turn === 2) {
        if (requests.filter((request) => request.turn === 2).length > 3)
          throw new Error('Owned provider retry budget exceeded');
        res.write(sse);
        await new Promise((resolve) => setTimeout(resolve, 150));
        res.destroy();
        observed.physicalStreamCut = res.destroyed;
      } else res.end(sse);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  process.env.OPENAI_BASE_URL = baseUrl;
  await mkdir(process.env.QWEN_HOME, { recursive: true });
  await writeFile(
    `${process.env.QWEN_HOME}/settings.json`,
    JSON.stringify({
      security: {
        auth: { selectedType: 'openai', apiKey: 'owned-dummy-key', baseUrl },
      },
      model: { name: 'owned-model', skipNextSpeakerCheck: true },
      telemetry: { enabled: false },
    }),
  );
  let managed;
  const observations = [];
  const record = (type, parentUuid, fields) => ({
    uuid: randomUUID(),
    parentUuid,
    sessionId: input.sessionKey.sessionId,
    timestamp: new Date().toISOString(),
    type,
    cwd: input.cwd,
    version: 'hosted-harness/1',
    ...fields,
  });
  try {
    const definitionRef = await stores.resourceStore.publish(
      'managed-definition',
      Buffer.from(
        JSON.stringify({
          engine: 'managed',
          sessionId: input.sessionKey.sessionId,
          toolProfile: 'csi-files-retirement/1',
        }),
      ),
    );
    const rootSnapshotRef = await stores.resourceStore.publish(
      'managed-root',
      Buffer.from(JSON.stringify({ cwd: input.cwd })),
    );
    managed = await openManagedSession({
      runtimeBaseDir: process.env.QWEN_RUNTIME_DIR,
      transcriptPath: '',
      sessionId: input.sessionKey.sessionId,
      sessionKey: input.sessionKey,
      cwd: input.cwd,
      version: 'hosted-harness/1',
      workerId: contract.bootId,
      activationLeaseDurationMs: 300000,
      journalStore: stores.journalStore,
      resourceStore: stores.resourceStore,
      requireNew: true,
      create: { definitionRef, rootSnapshotRef, createdBy: 'hosted-harness' },
    });
    for (let turn = 1; turn <= 5; turn++) {
      const promptId = randomUUID(),
        text = promptFor(turn);
      const bytes = Buffer.from(JSON.stringify([{ type: 'text', text }]));
      const digest = createHash('sha256').update(bytes).digest('hex');
      const contentRef = await managed.resources.publish(
        'managed-input',
        bytes,
      );
      const admissionRef = await managed.resources.publish(
        'managed-admission',
        Buffer.from(JSON.stringify({ promptId, digest: `sha256:${digest}` })),
      );
      await managed.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: promptId,
          sessionKey: input.sessionKey,
          contentDigest: digest,
        },
        {
          inputId: promptId,
          turnId: promptId,
          source: 'hosted-harness',
          contentRef,
          admissionRef,
          deadline: null,
          wakeReason: 'input',
        },
      );
      if (runHostedHarnessTurn) {
        const abort = new globalThis.AbortController();
        const timeout = setTimeout(() => abort.abort(), 20000);
        let turnResult;
        try {
          turnResult = await runHostedHarnessTurn({
            session: { managed, cwd: input.cwd, blocked: false },
            sessionId: input.sessionKey.sessionId,
            cwd: input.cwd,
            promptId,
            text,
            abort,
            historyMode: 'settled',
          });
        } finally {
          clearTimeout(timeout);
        }
        const projected = await managed.sink.project();
        const assistant = projected.findLast(
          (record) =>
            record.daemonPromptId === promptId && record.type === 'assistant',
        );
        const expectedState = turn === 2 || turn === 3 ? 'error' : 'completed';
        if (
          turnResult.systemPayload.state !== expectedState ||
          (expectedState === 'completed') !== Boolean(assistant)
        )
          throw new Error(`Unexpected shared runner outcome ${turn}`);
        const result = assistant && {
          parts: assistant.message.parts,
          model: assistant.model,
          text: assistant.message.parts
            .filter((part) => !part.thought)
            .map((part) => part.text)
            .join(''),
        };
        observations.push({
          turn,
          promptId,
          result,
          turnResult,
          checkpoint: managed.authority.latestCheckpoint,
          projected,
          sharedHostedRunner: true,
          privateHttpAttachment: false,
        });
        continue;
      }
      const harness = createManagedHarnessHandle(managed);
      let result, refusal;
      await new ManagedHookActivationController(managed).runTurn(
        promptId,
        async (modelScope) =>
          harness.run(async () => {
            const history = await managed.sink.project();
            const user = record('user', history.at(-1)?.uuid ?? null, {
              daemonPromptId: promptId,
              message: { role: 'user', parts: [{ text }] },
            });
            await managed.sink.write(user);
            try {
              result = await runHostedHarnessTextTurn({
                sessionId: input.sessionKey.sessionId,
                cwd: input.cwd,
                history,
                prompt: text,
                promptId,
                signal: globalThis.AbortSignal.timeout(15000),
                modelScope,
              });
              await managed.sink.write(
                record('assistant', user.uuid, {
                  daemonPromptId: promptId,
                  model: result.model,
                  message: { role: 'model', parts: result.parts },
                }),
              );
            } catch (error) {
              refusal = error.message;
            }
            await managed.sink.write(
              record('system', null, {
                subtype: 'turn_result',
                systemPayload: {
                  promptId,
                  state: refusal ? 'error' : 'completed',
                  stopReason: refusal ? 'error' : 'end_turn',
                  endedAt: Date.now(),
                },
              }),
            );
          }),
      );
      if (
        turn === 3
          ? refusal !== 'Hosted Harness no-tool turn refused a tool call.'
          : refusal || !result
      ) {
        throw new Error(`Unexpected original turn ${turn}: ${refusal}`);
      }
      observations.push({
        turn,
        promptId,
        result,
        refusal,
        checkpoint: managed.authority.latestCheckpoint,
        projected: await managed.sink.project(),
      });
    }
    if (requests.length !== (input.streamed ? 7 : 5))
      throw new Error('Owned provider request count differs');
    if (input.streamed) {
      const fourth = JSON.parse(
        requests.find((request) => request.turn === 4).wire,
      );
      const history = fourth.messages.flatMap((message) =>
        typeof message.content === 'string'
          ? [message.content]
          : (message.content ?? [])
              .filter((part) => part.type === 'text')
              .map((part) => part.text),
      );
      if (
        !history.includes(promptFor(1)) ||
        !history.some((text) => text.includes(longDelta)) ||
        history.includes(promptFor(2)) ||
        history.includes(promptFor(3)) ||
        history.some((text) => text.includes('owned partial'))
      )
        throw new Error('Actual next provider history differs');
    }
    return observations;
  } finally {
    try {
      if (managed) await managed.close();
    } finally {
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await writeFile(
        new URL('provider-requests.json', evidence),
        JSON.stringify(requests, null, 2) + '\n',
      );
    }
  }
}
