/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getConversationMetering,
  withConversationMetering,
  recordScopedCredits,
  recordScopedInputTokens,
} from './conversation-metering.js';

describe(
  'internal conversation metering',
  () => {
    it(
      'isolates concurrent businesses and owners and excludes auxiliary calls',
      async () => {
        const owner = {};
        const other = {};
        const run = (
          businessId: string,
          role: 'main' | 'subagent' | undefined,
          credits: number,
          requestId: string,
          target = owner,
        ) =>
          (async () => {
            for await (const _ of withConversationMetering(
              { owner: target, sessionId: 's', businessId, role },
              async function*() {
                await Promise.resolve();
                recordScopedCredits(
                  's',
                  requestId,
                  credits
                );
                recordScopedCredits(
                  's',
                  requestId,
                  credits
                );
                recordScopedInputTokens(100);
                yield 1;
              },
            )) {
              /* consume */
            }
          })();
        await Promise.all([
          run(
            'a',
            'main',
            1,
            'r1'
          ),
          run(
            'a',
            'subagent',
            2,
            'r2'
          ),
          run(
            'b',
            'main',
            4,
            'r3'
          ),
          run(
            'a',
            undefined,
            100,
            'r4'
          ),
          run(
            'a',
            'main',
            8,
            'r1',
            other
          ),
        ]);
        expect(getConversationMetering(owner).snapshot('s')).toEqual([
          ['a', { credits: 3, contentLength: 100 }],
          ['b', { credits: 4, contentLength: 100 }],
        ]);
        expect(getConversationMetering(other).snapshot('s')).toEqual([
          ['a', { credits: 8, contentLength: 100 }],
        ]);
        expect(getConversationMetering(owner).snapshot('other')).toEqual([]);
      }
    );
    it(
      'updates valid raw main tokens in completion order and keeps unknown separate from zero',
      async () => {
        const owner = {};
        const run = async (
          role: 'main' | 'subagent',
          tokens?: number
        ) => {
          for await (const _ of withConversationMetering(
            { owner, sessionId: 's', businessId: 'b', role },
            async function*() {
              recordScopedInputTokens(tokens);
              yield 1;
            },
          )) {
            /* consume */
          }
        };
        await run(
          'main',
          10
        );
        await run('main');
        await run(
          'main',
          NaN
        );
        await run(
          'subagent',
          99
        );
        const before = getConversationMetering(owner).snapshot('s');
        expect(before).toEqual([['b', { contentLength: 10 }]]);
        await run(
          'main',
          0
        );
        expect(before).toEqual([['b', { contentLength: 10 }]]);
        expect(getConversationMetering(owner).snapshot('s')).toEqual([
          ['b', { contentLength: 0 }],
        ]);
        getConversationMetering(owner).clearSession('s');
        expect(getConversationMetering(owner).snapshot('s')).toEqual([]);
      }
    );
  }
);
