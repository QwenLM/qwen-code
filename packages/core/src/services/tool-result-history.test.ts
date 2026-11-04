/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Part } from '@google/genai';
import type { RecordedToolResultAdmission } from './chatRecordingService.js';
import {
  matchToolResultParts,
  settleToolResultHistory,
} from './tool-result-history.js';

describe('tool result history admission', () => {
  const response: Part = {
    functionResponse: {
      id: 'read',
      name: 'read_file',
      response: { output: 'secret' },
    },
  };
  const companion: Part = { text: 'same text' };
  const image: Part = {
    inlineData: { mimeType: 'image/png', data: 'secret-image' },
  };
  const output = [response, companion, image];
  const input: Part = { text: 'same text' };
  const message = { role: 'user', parts: [...output, input] };

  it.each(['admitted', { withheld: 'first block' }] as const)(
    'keeps the first confirmed decision: %j',
    async (decision) => {
      const recorder = {
        recordToolResultAdmission: vi
          .fn()
          .mockResolvedValue([{ parts: output, decision }]),
      };
      const history = await settleToolResultHistory(
        recorder,
        message,
        output,
        'later cancellation',
      );
      if (decision === 'admitted') {
        expect(history).toEqual(message);
      } else {
        expect(history.parts).toEqual([
          expect.objectContaining({
            functionResponse: expect.objectContaining({
              id: 'read',
              response: { error: 'first block' },
            }),
          }),
          input,
        ]);
        expect(history.parts?.[1]).toBe(input);
      }
      expect(message.parts).toEqual([...output, input]);
    },
  );

  it('does not replace an earlier block with a later allow', async () => {
    const recorder = {
      recordToolResultAdmission: vi
        .fn()
        .mockResolvedValue([
          { parts: output, decision: { withheld: 'blocked' } },
        ]),
    };
    const history = await settleToolResultHistory(recorder, message, output);
    expect(JSON.stringify(history)).not.toContain('secret');
    expect(history.parts?.at(-1)).toBe(input);
    expect(history.parts).toHaveLength(2);
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'keeps shared companions with their own record: submit reversed=%s, receipt reversed=%s',
    async (reverseSubmission, reverseReceipts) => {
      const blocked: Part[] = [
        {
          functionResponse: {
            id: 'blocked',
            name: 'read_file',
            response: { output: 'private' },
          },
        },
        { text: 'same text' },
        { inlineData: { mimeType: 'image/png', data: 'same-image' } },
      ];
      const allowed: Part[] = [
        {
          functionResponse: {
            id: 'allowed',
            name: 'read_file',
            response: { output: 'public' },
          },
        },
        { text: 'same text' },
        { inlineData: { mimeType: 'image/png', data: 'same-image' } },
      ];
      const packets = reverseSubmission
        ? [allowed, blocked]
        : [blocked, allowed];
      const toolOutput = packets.flat();
      const independent = { text: 'same text' };
      const receipts: RecordedToolResultAdmission[] = [
        {
          parts: structuredClone(blocked),
          decision: { withheld: 'blocked earlier' },
        },
        { parts: allowed, decision: 'admitted' },
      ];
      if (reverseReceipts) receipts.reverse();
      const recorder = {
        recordToolResultAdmission: vi.fn(
          async (): Promise<RecordedToolResultAdmission[]> => {
            const matches = matchToolResultParts(
              receipts.map((receipt) => receipt.parts),
              toolOutput,
            );
            return receipts.map((receipt, index) => ({
              ...receipt,
              parts: matches[index],
            }));
          },
        ),
      };
      const result = await settleToolResultHistory(
        recorder,
        { role: 'user', parts: [...toolOutput, independent] },
        toolOutput,
        'later cancellation',
      );
      const blockedResponse = expect.objectContaining({
        functionResponse: expect.objectContaining({
          id: 'blocked',
          response: { error: 'blocked earlier' },
        }),
      });
      expect(result.parts).toEqual(
        reverseSubmission
          ? [...allowed, blockedResponse, independent]
          : [blockedResponse, ...allowed, independent],
      );
      expect(result.parts?.at(-1)).toBe(independent);
      expect(result.parts).toContain(allowed[1]);
      expect(result.parts).not.toContain(blocked[1]);
      expect(result.parts).toContain(allowed[2]);
      expect(result.parts).not.toContain(blocked[2]);
    },
  );

  it('anchors a complete packet without claiming an earlier identical companion', async () => {
    const unmatched: Part[] = [
      {
        functionResponse: {
          id: 'unmatched',
          name: 'read_file',
          response: { error: 'not recorded' },
        },
      },
      { text: 'same text' },
    ];
    const allowed: Part[] = [
      { text: 'same text' },
      {
        functionResponse: {
          id: 'allowed',
          name: 'read_file',
          response: { output: 'public' },
        },
      },
      { text: 'same text' },
    ];
    const recorder = {
      recordToolResultAdmission: vi
        .fn()
        .mockResolvedValue([{ parts: allowed, decision: 'admitted' }]),
    };
    const toolOutput = [...unmatched, ...allowed];
    const result = await settleToolResultHistory(
      recorder,
      { role: 'user', parts: [...toolOutput, input] },
      toolOutput,
      'cancelled',
    );
    expect(result.parts).toEqual([
      expect.objectContaining({
        functionResponse: expect.objectContaining({
          id: 'unmatched',
          response: { error: 'cancelled' },
        }),
      }),
      ...allowed,
      input,
    ]);
    expect(result.parts).not.toContain(unmatched[1]);
    expect(result.parts?.[1]).toBe(allowed[0]);
    expect(result.parts?.[3]).toBe(allowed[2]);
  });

  it('consumes separate occurrences when packets reuse a companion object', async () => {
    const allowed = [
      {
        functionResponse: {
          id: 'allowed',
          name: 'read_file',
          response: { output: 'public' },
        },
      },
      companion,
      image,
    ];
    const toolOutput = [...output, ...allowed];
    const recorder = {
      recordToolResultAdmission: vi.fn(
        async (): Promise<RecordedToolResultAdmission[]> => {
          const matches = matchToolResultParts([allowed, output], toolOutput);
          return [
            { parts: matches[0], decision: 'admitted' },
            { parts: matches[1], decision: { withheld: 'blocked' } },
          ];
        },
      ),
    };
    const result = await settleToolResultHistory(
      recorder,
      { role: 'user', parts: [...toolOutput, input] },
      toolOutput,
    );
    expect(result.parts?.filter((part) => part === companion)).toHaveLength(1);
    expect(result.parts?.filter((part) => part === image)).toHaveLength(1);
    expect(result.parts?.at(-1)).toBe(input);
    expect(
      result.parts?.flatMap((part) =>
        part.functionResponse?.id === 'read'
          ? [part.functionResponse.response]
          : [],
      ),
    ).toEqual([{ error: 'blocked' }]);
  });

  it('rejects an ambiguous packet before a decision can be committed', () => {
    const toolOutput = [...output, ...structuredClone(output)];
    expect(() => matchToolResultParts([output], toolOutput)).toThrow(
      'transcript',
    );
  });

  it('waits for confirmation and propagates a failed write without returning history', async () => {
    let reject!: (reason: Error) => void;
    const write = new Promise<RecordedToolResultAdmission[]>(
      (_resolve, fail) => {
        reject = fail;
      },
    );
    const recorder = { recordToolResultAdmission: vi.fn(() => write) };
    const committed = vi.fn();
    const pending = settleToolResultHistory(recorder, message, output).then(
      committed,
    );
    await Promise.resolve();
    expect(committed).not.toHaveBeenCalled();
    const failure = new Error('disk full');
    reject(failure);
    await expect(pending).rejects.toBe(failure);
    expect(committed).not.toHaveBeenCalled();
  });

  it('keeps the host policy when recording is disabled', async () => {
    expect(await settleToolResultHistory(undefined, message, output)).toEqual(
      message,
    );
    const blocked = await settleToolResultHistory(
      undefined,
      message,
      output,
      'not admitted',
    );
    expect(JSON.stringify(blocked)).not.toContain('secret');
    expect(blocked.parts?.at(-1)).toBe(input);
  });
});
