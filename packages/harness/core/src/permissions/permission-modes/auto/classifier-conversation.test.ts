/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { LlmAutoJudge } from './auto-judge.js';
import { ClassifierConversation } from './classifier-conversation.js';
import { renderLlmHistory, type LlmHistoryRecord } from './llm-transcript.js';
import {
  AutoClassifier,
  type AutoClassifierSession,
} from './auto-classifier.js';
import {
  invokeClassifierJson,
  type ClassifierPromptMessages,
} from './classifier-invoke.js';
import type { ClassifierInvokeFn, ClassifierMessage } from './classifier.js';

const allow = '{"shouldBlock":false,"reason":"requested local operation"}';
const deny = '{"shouldBlock":true,"reason":"user prohibited this operation"}';
const action = '{"bash":{"command":"echo test"}}\n';

class TestClassifier extends AutoClassifier {
  protected override readJevSettings() {
    return { classifier: 'llm' as const };
  }
}

function fixture(
  reply: (
    options: Parameters<ClassifierInvokeFn>[0],
    index: number,
  ) => string = () => allow,
) {
  const classifier = new TestClassifier();
  const requests: Array<{
    options: Parameters<ClassifierInvokeFn>[0];
    messages: ClassifierPromptMessages;
  }> = [];
  const invoke: ClassifierInvokeFn = (options) =>
    invokeClassifierJson(options, async (messages) => {
      requests.push({ options, messages: structuredClone(messages) });
      return reply(options, requests.length);
    });
  const session: AutoClassifierSession = {
    getSessionId: () => 'session',
    judges: { llm: new LlmAutoJudge(invoke) },
    getMessages: () => [],
    getToolLookup: () => ({
      get: () => ({ toAutoClassifierInput: (input) => input }),
    }),
  };
  const classify = (
    messages: ClassifierMessage[],
    agentId = '',
    signal = new AbortController().signal,
  ) =>
    classifier.classify(
      session,
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'reviewed',
              name: 'Bash',
              input: { command: 'echo test' },
            },
          ],
        },
        ...messages,
      ],
      'Bash',
      { command: 'echo test' },
      session.getToolLookup(),
      signal,
      classifier.getView(session.getSessionId(), agentId).conversation,
    );
  return { classifier, session, requests, classify };
}

describe('approval dialogue', () => {
  it('rebuilds an oversized dialogue before retrying and saves only the recovery input', async () => {
    const f = fixture((_options, index) => {
      if (index === 2) throw new Error('maximum context length exceeded');
      return allow;
    });
    const messages: ClassifierMessage[] = [
      { role: 'user', content: 'Never delete files.' },
    ];
    await f.classify(messages);
    expect((await f.classify(messages)).shouldBlock).toBe(false);
    expect(f.requests[1].options.history).toHaveLength(2);
    expect(f.requests[2].options.history).toEqual([]);
    expect(f.requests[2].options.userPrompt).toContain('Never delete files.');
    await f.classify([
      ...messages,
      { role: 'user', content: 'Inspect the build.' },
    ]);
    expect(f.requests[3].options.history).toEqual([]);
    expect(f.requests[3].options.userPrompt).toContain('Never delete files.');
  });

  it('appends genuine verdicts and new evidence, marking only the latest input', async () => {
    const f = fixture();
    const first: ClassifierMessage[] = [
      { role: 'user', content: 'Never delete source files.' },
    ];
    await f.classify(first);
    await f.classify([
      ...first,
      { role: 'user', content: 'Build the project.' },
    ]);
    const [a, b] = f.requests;
    expect(b.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(b.options.history?.[0].content).toBe(a.options.userPrompt);
    expect(b.options.history?.[1].content).toBe(allow);
    expect(b.options.userPrompt).toContain('Build the project.');
    expect(b.options.userPrompt).not.toContain('Never delete source files.');
    expect(b.options.history?.[0].content).toContain(
      'Never delete source files.',
    );
    expect(b.messages[3].content).toEqual([
      {
        type: 'text',
        text: b.options.userPrompt,
        cacheControl: { type: 'ephemeral' },
      },
    ]);
    expect(typeof b.messages[1].content).toBe('string');
  });

  it('rebuilds when evidence is rewritten, preserving current restrictions without old verdicts', async () => {
    const f = fixture();
    await f.classify([{ role: 'user', content: 'Original context' }]);
    await f.classify([
      { role: 'user', content: 'Replacement context: do not write files.' },
    ]);
    expect(f.requests[1].messages.map((m) => m.role)).toEqual([
      'system',
      'user',
    ]);
    expect(f.requests[1].options.userPrompt).toContain('do not write files');
    expect(f.requests[1].options.userPrompt).not.toContain('Original context');
  });

  it('keeps fast results out of thinking and saves only the final real reply', async () => {
    const f = fixture((options) => (options.stage === 'fast' ? deny : allow));
    const messages: ClassifierMessage[] = [
      { role: 'user', content: 'Build project' },
    ];
    await f.classify(messages);
    expect(f.requests[0].options.history).toEqual([]);
    expect(f.requests[1].options.history).toEqual([]);
    expect(f.requests[1].messages.map((m) => m.role)).toEqual([
      'system',
      'user',
    ]);
    await f.classify([...messages, { role: 'user', content: 'Run tests' }]);
    expect(f.requests[2].options.history).toEqual([
      { role: 'user', content: f.requests[1].options.userPrompt },
      { role: 'assistant', content: allow },
    ]);
  });

  it('does not save failed or cancelled approvals', async () => {
    let failing = true;
    const f = fixture(() => {
      if (failing) throw new Error('network unavailable');
      return allow;
    });
    const messages: ClassifierMessage[] = [
      { role: 'user', content: 'Build project' },
    ];
    expect((await f.classify(messages)).unavailable).toBe(true);
    failing = false;
    await f.classify(messages);
    expect(f.requests.at(-1)!.options.history).toEqual([]);
    const controller = new AbortController();
    const cancelled = fixture(() => {
      controller.abort();
      return allow;
    });
    await cancelled.classify(messages, '', controller.signal);
    await cancelled.classify(messages);
    expect(cancelled.requests.at(-1)!.options.history).toEqual([]);
  });

  it('does not save a verdict whose invoker returned no raw reply', async () => {
    const classifier = new TestClassifier();
    const options: Array<Parameters<ClassifierInvokeFn>[0]> = [];
    const invoke: ClassifierInvokeFn = async (next) => {
      options.push(next);
      return { shouldBlock: false, reason: 'requested local operation' };
    };
    const session: AutoClassifierSession = {
      getSessionId: () => 'session',
      judges: { llm: new LlmAutoJudge(invoke) },
      getMessages: () => [],
      getToolLookup: () => ({
        get: () => ({ toAutoClassifierInput: (input) => input }),
      }),
    };
    const classify = () =>
      classifier.classify(
        session,
        [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'reviewed',
                name: 'Bash',
                input: { command: 'echo test' },
              },
            ],
          },
          { role: 'user', content: 'Build project' },
        ],
        'Bash',
        { command: 'echo test' },
        session.getToolLookup(),
        new AbortController().signal,
        classifier.getView(session.getSessionId(), '').conversation,
      );
    await classify();
    await classify();
    expect(options[1].history).toEqual([]);
  });

  it('isolates agents and releases their approval history with their views', async () => {
    const f = fixture();
    const messages: ClassifierMessage[] = [
      { role: 'user', content: 'Build project' },
    ];
    await f.classify(messages, 'a');
    await f.classify(messages, 'b');
    expect(f.requests[1].options.history).toEqual([]);
    await f.classify(messages, 'a');
    expect(f.requests[2].options.history).toHaveLength(2);
    f.classifier.releaseView('session', 'a');
    await f.classify(messages, 'a');
    expect(f.requests[3].options.history).toEqual([]);
    f.classifier.disposeSession('session');
    await f.classify(messages, 'b');
    expect(f.requests[4].options.history).toEqual([]);
  });
});

describe('approval dialogue rebuild', () => {
  it('uses the real trimmed evidence verbatim, then resumes appending', () => {
    const conversation = new ClassifierConversation();
    const records: LlmHistoryRecord[] = [
      {
        kind: 'user',
        group: 0,
        current: true,
        text: 'Never delete source files.',
      },
    ];
    let trimmed = '';
    for (let n = 1; n < 60; n++) {
      records.push({
        kind: 'call',
        group: n,
        key: 'Bash',
        id: `c${n}`,
        projection: { command: `echo ${'test '.repeat(300)}` },
      });
      const evidence = renderLlmHistory(records, 'normal');
      const turn = conversation.prepare(
        'rules',
        '',
        evidence,
        JSON.stringify({ Bash: { command: `echo ${'test '.repeat(300)}` } }) +
          '\n',
      );
      if (evidence.includes('Host notice:')) {
        trimmed = evidence;
        expect(turn.history).toEqual([]);
        expect(turn.userPrompt).toContain(evidence);
        expect(turn.userPrompt).toContain('Never delete source files.');
        turn.complete(turn.userPrompt, allow);
        break;
      }
      turn.complete(turn.userPrompt, allow);
    }
    expect(trimmed).not.toBe('');
    const next = conversation.prepare(
      'rules',
      '',
      trimmed + '{"user":"Run tests"}\n',
      action,
    );
    expect(next.history).toHaveLength(2);
    expect(next.userPrompt).toContain('Run tests');
    expect(next.userPrompt).not.toContain('Host notice:');
  });

  it('rebuilds for rules, standing instructions and recovery without dropping evidence', () => {
    for (const change of ['rules', 'instructions', 'recovery']) {
      const c = new ClassifierConversation();
      const a = c.prepare('rules', 'instructions', action, action);
      a.complete(a.userPrompt, allow);
      const b = c.prepare(
        change === 'rules' ? 'new rules' : 'rules',
        change === 'instructions' ? 'new instructions' : 'instructions',
        action,
        action,
        change === 'recovery',
      );
      expect(b.history).toEqual([]);
      expect(b.userPrompt).toContain(action);
    }
  });

  it('bounds additional dialogue by rebuilding, without trimming its authoritative evidence', () => {
    const c = new ClassifierConversation();
    const evidence = '{"user":"Never delete source files"}\n' + action;
    const a = c.prepare('rules', '', evidence, action);
    a.complete(a.userPrompt, 'response '.repeat(40_000));
    const b = c.prepare('rules', '', evidence, action);
    expect(b.history).toEqual([]);
    expect(b.userPrompt).toContain(evidence);
  });

  it('does not retain an unshortened reviewed action when only its shortened record survives', () => {
    const c = new ClassifierConversation();
    const evidence =
      '{"omitted":"History already shortened"}\n{"user":"Keep source files"}\n';
    const a = c.prepare('rules', '', evidence, action);
    a.complete(a.userPrompt, allow);
    const selected =
      evidence + '{"bash":{"command":"echo …"},"id":"reviewed"}\n';
    const b = c.prepare('rules', '', selected, '{"bash":{"command":"next"}}\n');
    expect(b.history).toEqual([]);
    expect(b.userPrompt).toContain(selected);
    expect(b.userPrompt).not.toContain('echo test');
  });
});
