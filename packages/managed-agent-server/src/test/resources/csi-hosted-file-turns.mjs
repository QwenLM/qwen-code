/** Controlled inference drives the actual Hosted producer; SQL/Broker/worker stay live. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export async function runHostedFileTurn({
  root,
  output,
  session,
  promptId,
  prompt,
  index,
  mutation,
  files,
  recover,
  recoveryCut = 'receipt_complete',
}) {
  const failures = [];
  let requests = 0;
  const functions = [
    ...(index === 0
      ? [{ name: 'write_file', args: { file_path: '.', content: 'refused' } }]
      : []),
    { name: 'read_file', args: { file_path: 'marker.txt' } },
    mutation,
  ];
  const provider = createServer(async (request, response) => {
    try {
      let wire = '';
      for await (const chunk of request) wire += chunk.toString('utf8');
      const body = JSON.parse(wire);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(), [
        'edit',
        'read_file',
        'write_file',
      ]);
      assert.ok(wire.includes(prompt));
      const round = requests++;
      assert.ok(round < 2, 'No extra inference request may repair this turn');
      if (index === 1)
        assert.ok(
          body.messages.some(
            (message) =>
              message.role === 'assistant' &&
              JSON.stringify(message.content).includes('owned file answer 1 ✓'),
          ),
          'The second turn must include the first committed answer',
        );
      const results = body.messages.filter(
        (message) => message.role === 'tool',
      );
      assert.deepEqual(
        results.map((message) => message.tool_call_id),
        Array.from({ length: index + round }, (_, turn) =>
          Array.from(
            { length: turn === 0 ? 3 : 2 },
            (_, ordinal) => `owned-function-${turn}-${ordinal}`,
          ),
        ).flat(),
      );
      if (round === 1) {
        assert.ok(results.every((message) => message.content.length > 0));
        assert.ok(
          JSON.stringify(results[index === 0 ? 1 : 3]).includes(
            index === 0 ? 'alpha' : 'beta',
          ),
        );
      }
      const base = {
        id: `owned-files-${index}-${round}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'owned-model',
      };
      const chunks = [];
      const add = (delta, finish_reason = null) =>
        chunks.push({ ...base, choices: [{ index: 0, delta, finish_reason }] });
      add({
        role: 'assistant',
        reasoning_content: `owned file reasoning ${index + 1}`,
      });
      if (round === 0) {
        add({
          tool_calls: functions.map((call, ordinal) => ({
            index: ordinal,
            id: `owned-function-${index}-${ordinal}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        });
        add({}, 'tool_calls');
      } else {
        add({ content: `owned file answer ${index + 1} ✓` });
        add({}, 'stop');
      }
      chunks.push({
        ...base,
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
          'data: [DONE]\n\n',
      );
    } catch (cause) {
      failures.push(String(cause));
      response.writeHead(500);
      response.end('Owned inference contract failed');
    }
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
    await fs.mkdir(process.env.QWEN_HOME, { recursive: true });
    await fs.writeFile(
      path.join(process.env.QWEN_HOME, 'settings.json'),
      JSON.stringify({
        $version: 4,
        security: {
          auth: { selectedType: 'openai', apiKey: 'owned-dummy-key', baseUrl },
        },
        model: { name: 'owned-model', skipNextSpeakerCheck: true },
        telemetry: { enabled: false },
      }),
    );
    for (const name of ['system', 'defaults'])
      await fs.writeFile(path.join(output, `${name}.json`), '{"$version":4}');
    process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH = path.join(
      output,
      'system.json',
    );
    process.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH = path.join(
      output,
      'defaults.json',
    );
    process.env.OPENAI_API_KEY = 'owned-dummy-key';
    process.env.OPENAI_MODEL = 'owned-model';
    process.env.OPENAI_BASE_URL = baseUrl;
    const { runHostedCsiTextTurn } = await import(
      pathToFileURL(
        `${root}/packages/cli/dist/src/serve/hosted-csi-text-turn.js`,
      )
    );
    const before = session.authority.committedSequence;
    let resume;
    let recoveredFinalOutput;
    if (recover) {
      const write = session.sink.write.bind(session.sink);
      const publish = session.resources.publish.bind(session.resources);
      const checkpoint = session.authority.commitCheckpoint.bind(
        session.authority,
      );
      if (recoveryCut === 'missing_receipt') {
        session.resources.publish = async (kind, bytes, ...options) => {
          if (
            kind === 'managed-tool-outcome' &&
            JSON.parse(bytes.toString()).history.parts[0].functionResponse
              .id === `owned-function-${index}-2`
          ) {
            interrupted = true;
            throw new Error(
              'Owned missing-receipt cut after original execution settlement',
            );
          }
          return publish(kind, bytes, ...options);
        };
      }
      if (recoveryCut === 'final_output') {
        session.authority.commitCheckpoint = async (
          command,
          request,
          actor,
        ) => {
          const state = JSON.parse(request.state.toString());
          if (
            state.continuation.phase === 'results_ready' &&
            state.tools?.items.length &&
            state.tools.items.every((item) => item.consumed)
          ) {
            const tail = await session.sink.project();
            assert.equal(tail.at(-1).type, 'assistant');
            assert.ok(
              tail
                .at(-1)
                .message.parts.some(
                  (part) => part.text === 'owned file answer 1 ✓',
                ),
            );
            interrupted = true;
            throw new Error(
              'Owned complete-output cut before result consumption',
            );
          }
          return checkpoint(command, request, actor);
        };
      }
      let interrupted = false;
      session.sink.write = async (record) => {
        if (
          recoveryCut === 'receipt_complete' &&
          record.type === 'tool_result' &&
          record.message.parts[0].functionResponse.id ===
            `owned-function-${index}-2`
        ) {
          interrupted = true;
          throw new Error(
            'Owned receipt-complete cut before the last result message',
          );
        }
        return write(record);
      };
      try {
        await assert.rejects(
          runHostedCsiTextTurn(
            { managed: session, cwd: '/workspace', files },
            promptId,
            prompt,
            new AbortController(),
          ),
          /recovery|receipt|complete-output/i,
        );
      } finally {
        session.sink.write = write;
        session.resources.publish = publish;
        session.authority.commitCheckpoint = checkpoint;
      }
      assert.equal(interrupted, true);
      assert.equal(requests, recoveryCut === 'final_output' ? 2 : 1);
      const recovered = await recover();
      session = recovered.session;
      resume = recovered.parts;
      recoveredFinalOutput = recovered.finalOutput;
      assert.deepEqual(
        resume.map((part) => part.functionResponse.id),
        functions.map((_, ordinal) => `owned-function-${index}-${ordinal}`),
      );
    }
    const terminal = await runHostedCsiTextTurn(
      { managed: session, cwd: '/workspace', files },
      promptId,
      prompt,
      new AbortController(),
      resume,
      recoveredFinalOutput,
    );
    assert.deepEqual(failures, []);
    assert.equal(requests, 2);
    assert.equal(terminal.systemPayload.state, 'completed');
    const events = session.authority.eventsInSequenceRange(
      before + 1,
      session.authority.committedSequence,
    );
    const attempts = events.filter(
      (event) =>
        event.kind === 'model.attempt' &&
        event.payload.state === 'output_committed',
    );
    assert.equal(attempts.length, 2);
    const final = events.find(
      (event) =>
        event.kind === 'message.committed' &&
        event.payload.modelAttemptId === attempts[1].payload.attemptId,
    );
    assert.equal(final.sequence, attempts[1].sequence + 1);
    const intents = events.filter((event) => event.kind === 'tool.intent');
    const receipts = events.filter((event) => event.kind === 'tool.receipt');
    assert.equal(intents.length, 2);
    assert.equal(receipts.length, 2);
    for (const [ordinal, intent] of intents.entries()) {
      const id = intent.payload.executionCallId;
      const originalOrdinal = ordinal + (index === 0 ? 1 : 0);
      assert.equal(intent.payload.ordinal, originalOrdinal);
      assert.equal(intent.eventId, `tool-intent:${id}`);
      const receipt = receipts.find(
        (event) => event.payload.executionCallId === id,
      );
      assert.ok(receipt, 'Every original tool intent must have its receipt');
      assert.equal(receipt.eventId, `tool-receipt:${id}`);
      assert.ok(
        intent.sequence < receipt.sequence && receipt.sequence < final.sequence,
      );
      const outcome = JSON.parse(
        (
          await session.resources.read(receipt.payload.toolOutcomeRef)
        ).toString(),
      );
      assert.equal(outcome.executionCallId, id);
      assert.equal(
        outcome.history.parts[0].functionResponse.id,
        `owned-function-${index}-${originalOrdinal}`,
      );
    }
    const projected = await session.sink.project();
    const answer = projected.find(
      (entry) => entry.uuid === final.payload.messageId,
    );
    assert.ok(answer.message.parts.some((part) => part.thought === true));
    assert.ok(
      answer.message.parts.some(
        (part) => part.text === `owned file answer ${index + 1} ✓`,
      ),
    );
    const ready = await session.authority.harnessRunAuthorization();
    assert.equal(ready.status, 'runnable');
    const results = projected.filter(
      (entry) =>
        entry.type === 'tool_result' && entry.daemonPromptId === promptId,
    );
    assert.equal(results.length, functions.length);
    assert.deepEqual(
      results.map((entry) => entry.message.parts[0].functionResponse.name),
      functions.map((call) => call.name),
    );
    if (index === 0) {
      const refused = results[0];
      assert.deepEqual(refused.message.parts[0].functionResponse, {
        id: 'owned-function-0-0',
        name: 'write_file',
        response: { error: 'CSI file input is invalid.' },
      });
      const refusal = events.find(
        (event) =>
          event.kind === 'message.committed' &&
          event.payload.messageId === refused.uuid,
      );
      assert.ok(refusal.sequence < intents[0].sequence);
    }
    return results.slice(index === 0 ? 1 : 0).map((entry) => ({
      messageId: entry.uuid,
      parts: entry.message.parts,
    }));
  } finally {
    await new Promise((resolve) => {
      provider.close(resolve);
      provider.closeAllConnections();
    });
  }
}
