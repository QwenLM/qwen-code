/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GenerateContentParameters, Part } from '@google/genai';
import OpenAI from 'openai';
import sharp from 'sharp';
import { convertToFunctionResponse } from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import { convertLlmRequestToOpenAI } from '@qwen-code/qwen-code-core/core/openaiContentGenerator/converter.js';
import { convertGeminiContentsToResponsesInput } from '@qwen-code/qwen-code-core/core/openaiResponsesContentGenerator/responses-converter.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import {
  parseManagedToolInvocationReference,
  type ManagedToolMediaContext,
} from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import type {
  ManagedToolExecutionResult,
  ManagedToolInvocationStatus,
} from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';
import { BrokerManagedRuntimeProvider } from '../../packages/cli/src/serve/broker-managed-runtime-provider.js';
import { waitUntil } from './hosted-harness-process.js';
import { mediaFixture, type MediaCase } from './provider-media-fixtures.js';

const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, 'utf8')) as {
  tenantId: string;
  brokerUrl: string;
  statusGateUrl: string;
  sessions: Array<{
    sessionId: string;
    workspaceId: string;
    directory: string;
    fault: MediaCase;
  }>;
};
assert(config.sessions.length > 0);
const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
let brokerUrl = config.brokerUrl;
let dropStart = false;
let startDrops = 0;
let modelRequests = 0;
let expectedCallId = '';
let expectedSplitToolMedia = true;
let expectedMedia: Array<{
  mime: string;
  hash: string;
  bytes: number;
  width?: number;
  height?: number;
}> = [];
let proxyFailure: unknown;
const proxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const upstream = await fetch(new URL(req.url!, brokerUrl), {
      method: req.method,
      headers: {
        authorization: 'Bearer hosted-tools-broker-token',
        'content-type': 'application/json',
      },
      ...(bytes.length ? { body: bytes } : {}),
      signal: AbortSignal.timeout(45_000),
    });
    const response = Buffer.from(await upstream.arrayBuffer());
    if (dropStart && req.url!.endsWith(':start') && upstream.status === 200) {
      dropStart = false;
      startDrops++;
      res.destroy();
      return;
    }
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(response);
  } catch (cause) {
    proxyFailure = cause;
    res.destroy();
  }
});
const model = createServer(async (req, res) => {
  let stage = 'request';
  try {
    assert.equal(req.url, '/v1/chat/completions');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString()) as {
      model: string;
      messages: Array<{
        role: string;
        tool_call_id?: string;
        content?:
          | string
          | Array<{
              type: string;
              image_url?: { url: string };
              file?: { file_data: string };
            }>;
      }>;
    };
    assert.equal(request.model, 'provider-media-fixture');
    stage = 'tool-call-correlation';
    const tools = request.messages.filter((message) => message.role === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(
      tools[0].tool_call_id,
      expectedCallId,
      'model HTTP original call correlation',
    );
    const mediaOf = (
      message: (typeof request.messages)[number] | undefined,
    ) => {
      const parts =
        message && Array.isArray(message.content) ? message.content : [];
      return parts.flatMap((part) => {
        const url = part.image_url?.url ?? part.file?.file_data;
        return url ? [{ type: part.type, url }] : [];
      });
    };
    stage = 'media-role';
    const toolMedia = mediaOf(tools[0]);
    const following = request.messages[request.messages.indexOf(tools[0]) + 1];
    const userMedia = following?.role === 'user' ? mediaOf(following) : [];
    if (expectedSplitToolMedia) {
      assert.equal(
        toolMedia.length,
        0,
        'default tool reply must contain only text',
      );
      if (expectedMedia.length)
        assert.equal(
          following?.role,
          'user',
          'default media follows the original tool reply',
        );
    } else
      assert.equal(
        userMedia.length,
        0,
        'compatibility media stays inside the tool reply',
      );
    const media = expectedSplitToolMedia ? userMedia : toolMedia;
    stage = 'media-count';
    assert.equal(
      request.messages.flatMap(mediaOf).length,
      expectedMedia.length,
      'no duplicated or misplaced HTTP media',
    );
    assert.equal(media.length, expectedMedia.length, 'model HTTP media count');
    for (const [index, part] of media.entries()) {
      stage = 'data-uri';
      const match = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(part.url);
      assert(match, 'model media must be an inline data URI');
      const expected = expectedMedia[index];
      stage = 'mime';
      assert.equal(match[1], expected.mime);
      assert.equal(
        part.type,
        expected.mime === 'application/pdf' ? 'file' : 'image_url',
      );
      const bytes = Buffer.from(match[2], 'base64');
      stage = 'decoded-length';
      assert.equal(bytes.length, expected.bytes, 'model HTTP decoded length');
      stage = 'decoded-sha256';
      assert.equal(digest(bytes), expected.hash, 'model HTTP decoded bytes');
      if (expected.width !== undefined) {
        stage = 'image-dimensions';
        const metadata = await sharp(bytes).metadata();
        assert.equal(metadata.width, expected.width);
        assert.equal(metadata.height, expected.height);
        assert.equal(`image/${metadata.format}`, expected.mime);
      }
    }
    modelRequests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'media-proof',
        object: 'chat.completion',
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'MEDIA_ACCEPTED' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  } catch {
    // Assertions must never expose inline bytes in Maven's captured output.
    proxyFailure = new Error(
      `Deterministic model rejected the outgoing media request at ${stage}.`,
    );
    res
      .writeHead(500)
      .end(JSON.stringify({ error: `media assertion failed at ${stage}` }));
  }
});
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const provider = new BrokerManagedRuntimeProvider({
  baseUrl: await listen(proxy),
  token: 'hosted-tools-broker-token',
});
const modelClient = new OpenAI({
  apiKey: 'local-fixture-only',
  baseURL: (await listen(model)) + '/v1',
  maxRetries: 0,
});
async function evidence(sessionId: string, phase: string, fields: object = {}) {
  if (proxyFailure) throw proxyFailure;
  const response = await fetch(
    new URL(`/media/${sessionId}/${phase}`, config.statusGateUrl),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
      signal: AbortSignal.timeout(45_000),
    },
  );
  assert.equal(response.status, 200, `media probe ${phase}`);
  return (await response.json()) as { brokerUrl?: string; done?: boolean };
}
const reports: Array<Record<string, unknown>> = [];
const harnessDirectory = await mkdtemp(
  path.join(tmpdir(), 'qwen-provider-media-harness-'),
);
const originalCwd = process.cwd();
process.chdir(harnessDirectory);
try {
  for (const session of config.sessions) {
    const name = session.fault;
    const fixture = await mediaFixture(name);
    const replacement = await mediaFixture(name, true);
    const file = path.join(session.directory, fixture.filename);
    await writeFile(file, fixture.bytes);
    await writeFile(file + '.replacement', replacement.bytes);
    const decoy = path.join(harnessDirectory, fixture.filename);
    await writeFile(decoy, replacement.bytes);
    assert.notEqual(
      digest(fixture.bytes),
      digest(replacement.bytes),
      'Harness decoy differs from Workspace fixture',
    );
    const request = {
      protocolVersion: 1 as const,
      tenantId: config.tenantId,
      workspaceId: session.workspaceId,
      workspaceCwd: session.directory,
      sessionId: randomUUID(),
      turnKind: 'bootstrap' as const,
    };
    const client = await provider.getToolV2Client(request, {
      harnessSessionId: session.sessionId,
    });
    const manifest = await client.manifest();
    const identity = {
      sessionId: request.sessionId,
      promptId: randomUUID(),
      callId: randomUUID(),
      capabilityDigest: manifest.capabilityDigest,
      policyRevision: manifest.policyRevision,
    };
    await client.fileHistory!.bind({
      ownerSessionId: session.sessionId,
      ownerRuntimeSessionId: request.sessionId,
      executionCwd: session.directory,
      snapshots: [],
    });
    await client.beginTurn(identity);
    const input = {
      file_path: file,
      ...(name === 'pdf-render' || name === 'pdf-text' ? { pages: '1' } : {}),
    };
    const context: ManagedToolMediaContext | undefined =
      name === 'image-missing'
        ? undefined
        : {
            inputModalities: {
              image: name !== 'image-disabled',
              pdf: name !== 'pdf-render' && name !== 'pdf-text',
            },
          };
    // Concurrent preparations with opposite capabilities must keep separate snapshots.
    const [prepared] = await Promise.all([
      client.prepare(identity, 'read_file', input, undefined, context),
      client.prepare(
        { ...identity, callId: randomUUID() },
        'read_file',
        input,
        undefined,
        {
          inputModalities: {
            image: name === 'image-disabled' || name === 'image-missing',
            pdf: false,
          },
        },
      ),
    ]);
    const reference = parseManagedToolInvocationReference({
      ...identity,
      invocationId: prepared.invocationId,
      argsDigest: prepared.argsDigest,
    });
    assert.equal(Object.keys(reference).length, 7);
    expectedCallId = reference.callId;
    assert.equal('responseParts' in prepared, false);
    await assert.rejects(() =>
      client.prepare(identity, 'read_file', input, undefined, {
        inputModalities: {
          image: context?.inputModalities.image !== true,
          pdf: false,
        },
      }),
    );
    const confirmation = await client.confirmation(reference);
    if (confirmation || prepared.defaultPermission === 'ask')
      await client.confirm(reference, ToolConfirmationOutcome.ProceedOnce);
    await client.preflight(reference);
    const reservation = await client.prepareExecution!(reference);
    await evidence(session.sessionId, 'prepared', {
      reference,
      executionCallId: reservation.executionCallId,
    });
    dropStart = name === 'lost-start';
    let execution: ManagedToolExecutionResult | undefined;
    if (dropStart) {
      await assert.rejects(() => client.execute(reference));
      await waitUntil(
        async () =>
          (await evidence(session.sessionId, 'worker-done')).done === true,
      );
      await writeFile(file, replacement.bytes);
    } else {
      try {
        execution = await client.execute(reference);
      } catch (cause) {
        if (name !== 'lost-execute') throw cause;
      }
    }
    const beforeRecoveryCounts =
      name === 'lost-start' || name === 'lost-execute'
        ? await readFile(
            path.join(session.directory, '.provider-media-reads.json'),
            'utf8',
          )
        : undefined;
    let status: ManagedToolInvocationStatus | undefined;
    await waitUntil(async () => {
      try {
        status = await client.status(reference);
        return status.state === 'settled';
      } catch (cause) {
        if (name !== 'lost-execute') throw cause;
        return false;
      }
    });
    execution ??= status!.result!;
    const resultHash = digest(JSON.stringify(execution));
    const resultBytes = Buffer.byteLength(JSON.stringify(execution));
    const assertResult = (observed: unknown, label: string) => {
      const encoded = JSON.stringify(observed);
      assert.equal(Buffer.byteLength(encoded), resultBytes, `${label} length`);
      assert.equal(digest(encoded), resultHash, `${label} SHA256`);
    };
    assertResult(status!.result, 'execute and status retained result');
    await evidence(session.sessionId, 'settled', { resultHash, resultBytes });
    const readCounts = await readFile(
      path.join(session.directory, '.provider-media-reads.json'),
      'utf8',
    );
    if (beforeRecoveryCounts !== undefined)
      assert.equal(
        readCounts,
        beforeRecoveryCounts,
        'first lost-reply observation added no worker reads',
      );
    if (name === 'lost-start' || name === 'lost-execute') {
      await writeFile(file, replacement.bytes);
      assert.notEqual(
        digest(await readFile(file)),
        digest(fixture.bytes),
        'recovery fixture actually changed',
      );
    }
    assertResult(
      (await client.status(reference)).result,
      'original-reference recovery',
    );
    assertResult(
      (await client.cancel(reference)).result,
      'settled cancellation observation',
    );
    assert.equal(
      await readFile(
        path.join(session.directory, '.provider-media-reads.json'),
        'utf8',
      ),
      readCounts,
      'observations added no worker file reads',
    );
    assert(
      execution.result && !('responseParts' in execution.result),
      'provider result must be nested ToolResult',
    );
    const content = execution.result.llmContent;
    const responseParts = convertToFunctionResponse(
      'read_file',
      reference.callId,
      content,
    );
    const media = responseParts
      .flatMap((part) => part.functionResponse?.parts ?? [])
      .flatMap((part) => (part.inlineData ? [part.inlineData] : []));
    const refused = name === 'pdf-too-large';
    const disabled = name === 'image-disabled' || name === 'image-missing';
    assert.equal(execution.executionStatus, refused ? 'error' : 'success');
    if (refused) assert.equal(execution.result.error?.type, 'file_too_large');
    assert.equal(
      media.length,
      refused || disabled || name === 'pdf-text' ? 0 : 1,
      `${name} inline media`,
    );
    if (name === 'pdf-text')
      assert(JSON.stringify(content).includes('provider media text proof'));
    expectedMedia = [];
    for (const part of media) {
      assert(part.data && part.mimeType, 'complete media part');
      const bytes = Buffer.from(part.data, 'base64');
      if (fixture.mime === 'application/pdf' && name !== 'pdf-render') {
        assert.equal(part.mimeType, 'application/pdf');
        assert.equal(
          bytes.length,
          fixture.bytes.length,
          'native PDF byte length',
        );
        assert.equal(digest(bytes), digest(fixture.bytes), 'native PDF bytes');
        expectedMedia.push({
          mime: part.mimeType,
          hash: digest(fixture.bytes),
          bytes: fixture.bytes.length,
        });
      } else {
        const metadata = await sharp(bytes).metadata();
        assert.equal(part.mimeType, `image/${metadata.format}`);
        if (name === 'pdf-render')
          assert(
            metadata.width! > 8 && metadata.height! > 6,
            'Poppler rendered a real page',
          );
        else {
          assert.equal(metadata.width, 8);
          assert.equal(metadata.height, 6);
          if (name === 'gif') {
            assert.equal(part.mimeType, 'image/gif', 'native GIF MIME');
            assert.equal(
              bytes.length,
              fixture.bytes.length,
              'native GIF length',
            );
            assert.equal(
              digest(bytes),
              digest(fixture.bytes),
              'native GIF SHA256',
            );
          } else
            assert.equal(
              part.mimeType,
              'image/jpeg',
              'safe image overview MIME',
            );
          const statistics = await sharp(bytes).stats();
          assert(
            statistics.channels[0].mean < 60 &&
              statistics.channels[2].mean > 210,
            'Workspace image pixels, not the red Harness decoy',
          );
        }
        expectedMedia.push({
          mime: part.mimeType,
          hash: digest(bytes),
          bytes: bytes.length,
          width: metadata.width,
          height: metadata.height,
        });
      }
    }
    const modelRequest: GenerateContentParameters = {
      model: 'provider-media-fixture',
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read_file',
                id: reference.callId,
                args: input,
              },
            },
          ],
        },
        { role: 'user', parts: responseParts as Part[] },
      ],
    };
    for (const splitToolMedia of [true, false]) {
      expectedSplitToolMedia = splitToolMedia;
      const messages = convertLlmRequestToOpenAI(modelRequest, {
        model: modelRequest.model,
        modalities: { image: true, pdf: true },
        startTime: 0,
        splitToolMedia,
      });
      const completion = await modelClient.chat.completions.create({
        model: modelRequest.model,
        messages,
      });
      assert.equal(completion.choices[0].message.content, 'MEDIA_ACCEPTED');
    }
    if (name === 'native-pdf') {
      const responses = JSON.stringify(
        convertGeminiContentsToResponsesInput(modelRequest),
      );
      assert(
        responses.includes('application/pdf') &&
          responses.includes('Unsupported'),
        'Responses native PDF limitation',
      );
      assert(
        !responses.includes(fixture.bytes.toString('base64')),
        'Responses must not claim native PDF delivery',
      );
    }
    assert.equal(
      await provider.release(request.sessionId, request, { terminal: true }),
      true,
    );
    assert.equal(
      await provider.release(request.sessionId, request, { terminal: true }),
      true,
    );
    await evidence(session.sessionId, 'released', { resultHash, resultBytes });
    assert.equal(
      digest(await readFile(decoy)),
      digest(replacement.bytes),
      'Harness decoy untouched',
    );
    reports.push({
      ...session,
      runtimeSessionId: request.sessionId,
      reference,
      executionCallId: reservation.executionCallId,
      resultHash,
      resultBytes,
      mediaCount: media.length,
      executionStatus: execution.executionStatus,
    });
    console.log(
      `M4_PROVIDER_MEDIA ${name}: media=${media.length} dispatch=1 released=true`,
    );
  }
  const restart = await evidence(config.sessions[0].sessionId, 'restart');
  assert(
    restart.brokerUrl && restart.brokerUrl !== brokerUrl,
    'fresh Embedded Broker endpoint',
  );
  brokerUrl = restart.brokerUrl;
  for (const report of reports) {
    const inspection = await provider.inspectExecution({
      harnessSessionId: report['sessionId'] as string,
      runtimeSessionId: report['runtimeSessionId'] as string,
      executionCallId: report['executionCallId'] as string,
    });
    assert.equal(inspection.outcome, 'known');
    assert(inspection.outcome === 'known');
    assert.equal(inspection.status.state, 'settled');
    assert.equal(
      Buffer.byteLength(JSON.stringify(inspection.status.result)),
      report['resultBytes'],
      'MySQL recovery length after Broker restart',
    );
    assert.equal(
      digest(JSON.stringify(inspection.status.result)),
      report['resultHash'],
      'MySQL recovery after Broker restart',
    );
    await evidence(report['sessionId'] as string, 'restarted', {
      resultHash: report['resultHash'],
      resultBytes: report['resultBytes'],
    });
  }
  assert.equal(startDrops, 1);
  assert.equal(modelRequests, reports.length * 2);
  if (proxyFailure) throw proxyFailure;
  await writeFile(configPath + '.results', JSON.stringify(reports));
  console.log(
    `HOSTED_PROVIDER_MEDIA_OK cases=${reports.length} modelRequests=${modelRequests} startDrops=${startDrops}`,
  );
} finally {
  process.chdir(originalCwd);
  await rm(harnessDirectory, { recursive: true, force: true });
  provider.dispose();
  for (const server of [proxy, model]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
