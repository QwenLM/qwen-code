/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  countReasoningItems,
  downgradeRejectedReasoningItems,
  parseReasoningIdRejection,
} from './responses-reasoning-rejection.js';
import type { ResponsesApiInputItem } from './types.js';

// Contract matrices for the classifier and the downgrade, written after the
// behavior was driven out through the pipeline seam. Every id and payload
// here is synthetic.

function body(fields: Record<string, unknown>): string {
  return JSON.stringify({ error: fields });
}

const MAX_64 =
  "Invalid 'input[1].id': string too long. Expected a string with maximum " +
  'length 64, but got a string with length 83 instead.';

function rejection(param: string, message: string): string {
  return body({
    message,
    type: 'invalid_request_error',
    param,
    code: 'string_above_max_length',
  });
}

describe('parseReasoningIdRejection', () => {
  it('classifies the direct API shape and trusts an associated maximum', () => {
    expect(
      parseReasoningIdRejection(400, rejection('input[1].id', MAX_64)),
    ).toEqual({ namedIndex: 1, maxLength: 64 });
  });

  it('accepts an already-parsed object body', () => {
    expect(
      parseReasoningIdRejection(400, {
        error: {
          message: MAX_64,
          param: 'input[1].id',
          code: 'string_above_max_length',
        },
      }),
    ).toEqual({ namedIndex: 1, maxLength: 64 });
  });

  it('reads a \\u escape in the quoted parameter', () => {
    // "input[1]\u002Eid" -- a proxy re-encoding the body can escape the dot.
    const escaped =
      '{"error":{"message":"' +
      MAX_64 +
      '","param":"input[1]\\u002Eid","code":"string_above_max_length"}}';
    expect(parseReasoningIdRejection(400, escaped)).toEqual({
      namedIndex: 1,
      maxLength: 64,
    });
  });

  it.each([200, 401, 404, 413, 429, 500, 502, 0, -1])(
    'refuses status %s even with a matching body',
    (status) => {
      expect(
        parseReasoningIdRejection(status, rejection('input[1].id', MAX_64)),
      ).toBeUndefined();
    },
  );

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['a number', 400],
    ['a boolean', true],
    ['an array', [{ code: 'string_above_max_length', param: 'input[1].id' }]],
    ['an empty string', ''],
    ['HTML', '<html><body>Bad Gateway</body></html>'],
    ['a JSON primitive', '"string_above_max_length input[1].id"'],
    ['a JSON array', '[{"code":"string_above_max_length"}]'],
    ['an unterminated object', '{"error":{"code":"string_above_max_length"'],
    ['an unterminated string', '{"error":{"code":"string_above_max_length}'],
  ])('returns undefined for %s', (_label, value) => {
    expect(parseReasoningIdRejection(400, value)).toBeUndefined();
  });

  it('returns undefined for an object it cannot stringify', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(parseReasoningIdRejection(400, cyclic)).toBeUndefined();
  });

  it('returns undefined for a body past the size bound', () => {
    const padded = JSON.stringify({
      error: {
        message: MAX_64,
        param: 'input[1].id',
        code: 'string_above_max_length',
        pad: 'x'.repeat(64_000),
      },
    });
    expect(padded.length).toBeGreaterThan(64_000);
    expect(parseReasoningIdRejection(400, padded)).toBeUndefined();
  });

  it('returns undefined once the object-candidate budget is exhausted', () => {
    const padded = (count: number) =>
      `{"items":[${Array.from({ length: count }, (_, i) => `{"n":${i}}`).join(
        ',',
      )}],"error":{"message":"${MAX_64}","param":"input[1].id","code":"string_above_max_length"}}`;
    // The identical shape under the bound still classifies, so this is the
    // bound firing rather than the shape failing to parse.
    expect(parseReasoningIdRejection(400, padded(10))).toEqual({
      namedIndex: 1,
      maxLength: 64,
    });
    expect(parseReasoningIdRejection(400, padded(40))).toBeUndefined();
  });

  it.each<[string, string]>([
    [
      'the code and param live on different objects',
      JSON.stringify({
        error: { code: 'string_above_max_length', message: MAX_64 },
        detail: { param: 'input[1].id' },
      }),
    ],
    [
      'a relevant key is declared twice',
      '{"error":{"code":"string_above_max_length","code":"other","param":"input[1].id"}}',
    ],
    [
      'two objects both match',
      JSON.stringify({
        first: {
          code: 'string_above_max_length',
          param: 'input[1].id',
          message: MAX_64,
        },
        second: {
          code: 'string_above_max_length',
          param: 'input[3].id',
          message: MAX_64,
        },
      }),
    ],
    [
      'the fields appear only as prose',
      body({ message: 'string_above_max_length on input[1].id', code: '400' }),
    ],
    [
      'the code is a different one',
      rejection('input[1].id', MAX_64).replace(
        'string_above_max_length',
        'string_too_long',
      ),
    ],
    ['the param is not an input id', rejection('model', MAX_64)],
    ['the param index is negative', rejection('input[-1].id', MAX_64)],
    [
      'the param index is not a safe integer',
      rejection('input[99999999999999999999].id', MAX_64),
    ],
    ['the param has trailing content', rejection('input[1].id.extra', MAX_64)],
    ['the param has leading content', rejection('body.input[1].id', MAX_64)],
  ])('returns undefined when %s', (_label, value) => {
    expect(parseReasoningIdRejection(400, value)).toBeUndefined();
  });

  // A matching object is only ever read out of the body's own structured
  // error. Anything the endpoint merely quoted -- in a debug field, past the
  // envelope, or behind an escape the JSON grammar does not define -- is not
  // evidence about the request we sent.
  it.each<[string, string]>([
    [
      'a matching object is quoted inside an unrelated debug field',
      JSON.stringify({
        error: {
          message: 'Unsupported model',
          param: 'model',
          code: 'model_not_found',
        },
        debug: `example: ${rejection('input[1].id', MAX_64)}`,
      }),
    ],
    [
      'trailing non-whitespace follows the top-level object',
      `${rejection('input[1].id', MAX_64)} trailing`,
    ],
    [
      'an unterminated string tail follows a matching object',
      `{"error":{"message":"${MAX_64}","param":"input[1].id",` +
        '"code":"string_above_max_length"},"tail":"oops',
    ],
    [
      'the body uses an unknown backslash escape',
      '{"error":{"message":"Invalid \'input[1]\\.id\': string too long. ' +
        'Expected a string with maximum length 64, but got a string with ' +
        'length 83 instead.","param":"input[1]\\.id",' +
        '"code":"string_above_max_length"}}',
    ],
    [
      'a \\u escape is not followed by four hex digits',
      '{"error":{"message":"Invalid \'input[1].id\' \\u00ZZ: string too long. ' +
        'Expected a string with maximum length 64.","param":"input[1].id",' +
        '"code":"string_above_max_length"}}',
    ],
    [
      'the envelope declares a key twice',
      `{"error":{"param":"input[1].id","code":"string_above_max_length"},` +
        `"error":{"other":1}}`,
    ],
    [
      'a raw control character sits outside every string',
      '{"error":\u0001{"param":"input[1].id",' +
        '"code":"string_above_max_length"}}',
    ],
  ])('returns undefined when %s', (_label, value) => {
    expect(parseReasoningIdRejection(400, value)).toBeUndefined();
  });

  // Raw control characters are tolerated only where a proxy actually splices
  // them: a raw newline, tab, or carriage return inside the ONE recognized
  // `error.message`. Anywhere else -- another field, another control
  // character, or outside the object entirely -- the body is not one we can
  // read exactly, so it is not one we act on.
  it.each<[string, string]>([
    [
      'a raw newline sits inside an unrelated top-level field',
      `{"error":{"message":"${MAX_64}","param":"input[1].id",` +
        '"code":"string_above_max_length"},"debug":"first\nsecond"}',
    ],
    [
      'a raw NUL sits inside the recognized error message',
      `{"error":{"message":"${MAX_64}\u0000","param":"input[1].id",` +
        '"code":"string_above_max_length"}}',
    ],
    [
      'a raw newline sits in a sibling of the recognized error message',
      `{"error":{"message":"${MAX_64}","type":"invalid\nrequest_error",` +
        '"param":"input[1].id","code":"string_above_max_length"}}',
    ],
    [
      'a raw newline sits inside the quoted upstream body itself',
      // The attested proxy shape splices its control character BEFORE the
      // quoted JSON. One spliced inside the quoted body's own fields is
      // damage we have no account of, so the reopened text is read strictly.
      '{"error":{"message":"upstream said -{\\"error\\":{\\"message\\":\\"' +
        MAX_64 +
        '\n\\",\\"param\\":\\"input[1].id\\",\\"code\\":' +
        '\\"string_above_max_length\\"}}","code":"400"}}',
    ],
    [
      'a vertical tab follows the top-level object',
      `${rejection('input[1].id', MAX_64)}\u000b`,
    ],
    [
      'a form feed follows the top-level object',
      `${rejection('input[1].id', MAX_64)}\u000c`,
    ],
    [
      'a no-break space follows the top-level object',
      `${rejection('input[1].id', MAX_64)}\u00a0`,
    ],
    [
      'a vertical tab precedes the top-level object',
      `\u000b${rejection('input[1].id', MAX_64)}`,
    ],
  ])('returns undefined when %s', (_label, value) => {
    expect(parseReasoningIdRejection(400, value)).toBeUndefined();
  });

  // The control for the block above: the four characters JSON's own grammar
  // calls whitespace stay acceptable on both sides of the object.
  it('accepts JSON whitespace around the top-level object', () => {
    expect(
      parseReasoningIdRejection(
        400,
        ` \t\r\n${rejection('input[1].id', MAX_64)} \t\r\n`,
      ),
    ).toEqual({ namedIndex: 1, maxLength: 64 });
  });

  it('returns undefined for a revoked proxy rather than throwing', () => {
    const { proxy, revoke } = Proxy.revocable({ error: {} }, {});
    revoke();
    expect(parseReasoningIdRejection(400, proxy)).toBeUndefined();
  });

  it('preserves the valid JSON escapes the grammar does define', () => {
    const message =
      'Invalid \\"input[1].id\\" \\\\ \\/ \\u2014 string too long. ' +
      'Expected a string with maximum length 64.';
    expect(
      parseReasoningIdRejection(
        400,
        `{"error":{"message":"${message}","param":"input[1].id",` +
          '"code":"string_above_max_length"}}',
      ),
    ).toEqual({ namedIndex: 1, maxLength: 64 });
  });

  it("never inherits a nested object's fields onto its envelope", () => {
    // The outer object declares neither code nor param; only the inner one
    // matches, so this stays a single match rather than two.
    expect(
      parseReasoningIdRejection(400, rejection('input[2].id', MAX_64)),
    ).toEqual({ namedIndex: 2, maxLength: null });
  });

  describe('maximum association', () => {
    it.each<[string, string, number | null]>([
      ['names the matched param and one maximum', MAX_64, 64],
      [
        'names a different param',
        "Invalid 'input[7].id': maximum length 64 exceeded.",
        null,
      ],
      [
        'names two params',
        "Invalid 'input[1].id' and 'input[3].id': maximum length 64.",
        null,
      ],
      ['reports no maximum', "Invalid 'input[1].id': string too long.", null],
      [
        'reports two maxima',
        "Invalid 'input[1].id': maximum length 64 or maximum length 128.",
        null,
      ],
      [
        'reports a zero maximum',
        "Invalid 'input[1].id': maximum length 0.",
        null,
      ],
    ])('%s', (_label, message, expected) => {
      expect(
        parseReasoningIdRejection(400, rejection('input[1].id', message)),
      ).toEqual({ namedIndex: 1, maxLength: expected });
    });

    it('treats a missing message as no maximum', () => {
      expect(
        parseReasoningIdRejection(
          400,
          body({ param: 'input[1].id', code: 'string_above_max_length' }),
        ),
      ).toEqual({ namedIndex: 1, maxLength: null });
    });
  });

  describe('proxied nesting', () => {
    function proxied(inner: string, control = ''): string {
      return `{"error":{"message":"upstream said -${control}${inner.replace(
        /"/g,
        '\\"',
      )}","code":"400"}}`;
    }

    it.each<[string, string, boolean]>([
      ['no control character', '', true],
      ['a raw newline', '\n', false],
      ['a raw tab', '\t', false],
      ['a raw carriage return', '\r', false],
    ])(
      'classifies a nested object with %s',
      (_label, control, parsesAsJson) => {
        const wrapped = proxied(rejection('input[1].id', MAX_64), control);
        // A raw control character is precisely why the whole body cannot be
        // read with JSON.parse -- pin that, so a future "just parse it"
        // simplification fails here rather than in production.
        if (parsesAsJson) {
          expect(() => JSON.parse(wrapped)).not.toThrow();
        } else {
          expect(() => JSON.parse(wrapped)).toThrow(SyntaxError);
        }
        expect(parseReasoningIdRejection(400, wrapped)).toEqual({
          namedIndex: 1,
          maxLength: 64,
        });
      },
    );

    it('does not descend a second nesting level', () => {
      const once = rejection('input[1].id', MAX_64).replace(/"/g, '\\"');
      const twice = proxied(`{\\"relay\\":\\"${once}\\"}`);
      expect(parseReasoningIdRejection(400, twice)).toBeUndefined();
    });
  });
});

describe('downgradeRejectedReasoningItems', () => {
  const LONG = `rs_${'a'.repeat(80)}`;

  function reasoningItem(
    id: string,
    summaries: string[],
  ): ResponsesApiInputItem {
    return Object.freeze({
      type: 'reasoning',
      id,
      encrypted_content: `enc-${id}`,
      summary: Object.freeze(
        summaries.map((text) => Object.freeze({ type: 'summary_text', text })),
      ),
    }) as ResponsesApiInputItem;
  }

  function userItem(content: string): ResponsesApiInputItem {
    return Object.freeze({
      type: 'message',
      role: 'user',
      content,
    }) as ResponsesApiInputItem;
  }

  it('returns the original array by identity when the named item is not reasoning', () => {
    const items = Object.freeze([
      userItem('hi'),
      reasoningItem(LONG, ['thought']),
    ]) as ResponsesApiInputItem[];
    expect(
      downgradeRejectedReasoningItems(items, { namedIndex: 0, maxLength: 64 }),
    ).toBe(items);
  });

  it('returns the original array by identity when the named index is out of range', () => {
    const items = Object.freeze([userItem('hi')]) as ResponsesApiInputItem[];
    expect(
      downgradeRejectedReasoningItems(items, { namedIndex: 9, maxLength: 64 }),
    ).toBe(items);
  });

  it('returns the original array by identity when the named id is within the maximum', () => {
    const items = Object.freeze([
      reasoningItem('rs_short', ['thought']),
    ]) as ResponsesApiInputItem[];
    expect(
      downgradeRejectedReasoningItems(items, { namedIndex: 0, maxLength: 64 }),
    ).toBe(items);
  });

  it('preserves every untargeted item by object identity and position', () => {
    const first = userItem('hi');
    const keep = reasoningItem('rs_short', ['kept']);
    const last = userItem('bye');
    const items = Object.freeze([
      first,
      reasoningItem(LONG, ['dropped']),
      keep,
      last,
    ]) as ResponsesApiInputItem[];

    const result = downgradeRejectedReasoningItems(items, {
      namedIndex: 1,
      maxLength: 64,
    });

    expect(result).not.toBe(items);
    expect(result[0]).toBe(first);
    expect(result[2]).toBe(keep);
    expect(result[3]).toBe(last);
    expect(result[1]).toEqual({
      type: 'message',
      role: 'assistant',
      content: 'dropped',
    });
  });

  it('joins multiple non-empty summary texts with a newline and skips empty ones', () => {
    const items = Object.freeze([
      reasoningItem(LONG, ['one', '', 'two']),
    ]) as ResponsesApiInputItem[];
    expect(
      downgradeRejectedReasoningItems(items, { namedIndex: 0, maxLength: 64 }),
    ).toEqual([{ type: 'message', role: 'assistant', content: 'one\ntwo' }]);
  });

  it('drops a targeted item whose summary carries no text', () => {
    const keep = userItem('hi');
    const items = Object.freeze([
      keep,
      reasoningItem(LONG, []),
      reasoningItem(`rs_${'b'.repeat(80)}`, ['']),
    ]) as ResponsesApiInputItem[];
    expect(
      downgradeRejectedReasoningItems(items, { namedIndex: 1, maxLength: 64 }),
    ).toEqual([keep]);
  });

  it('downgrades every reasoning item when no maximum is reported', () => {
    const items = Object.freeze([
      reasoningItem(LONG, ['long']),
      reasoningItem('rs_short', ['short']),
      userItem('bye'),
    ]) as ResponsesApiInputItem[];
    expect(
      downgradeRejectedReasoningItems(items, {
        namedIndex: 0,
        maxLength: null,
      }),
    ).toEqual([
      { type: 'message', role: 'assistant', content: 'long' },
      { type: 'message', role: 'assistant', content: 'short' },
      items[2],
    ]);
  });

  it('never mutates the input array or its items', () => {
    const items = Object.freeze([
      reasoningItem(LONG, ['thought']),
      userItem('bye'),
    ]) as ResponsesApiInputItem[];
    const snapshot = JSON.stringify(items);

    downgradeRejectedReasoningItems(items, { namedIndex: 0, maxLength: 64 });
    downgradeRejectedReasoningItems(items, { namedIndex: 0, maxLength: null });

    expect(JSON.stringify(items)).toBe(snapshot);
    expect(items).toHaveLength(2);
  });

  it('counts reasoning items for the retry diagnostic', () => {
    const items = [
      reasoningItem(LONG, ['a']),
      userItem('hi'),
      reasoningItem('rs_short', ['b']),
    ];
    expect(countReasoningItems(items)).toBe(2);
    expect(countReasoningItems([])).toBe(0);
  });
});
