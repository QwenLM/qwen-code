/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  countReasoningItems,
  isEncryptedReasoningRejection,
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

const DIRECT_64 = rejection('input[1].id', MAX_64);
const MATCH_64 = { namedIndex: 1, maxLength: 64 };
const parse = (value: unknown) => parseReasoningIdRejection(400, value);

describe('parseReasoningIdRejection', () => {
  it('classifies the direct API shape and trusts an associated maximum', () => {
    expect(parse(DIRECT_64)).toEqual(MATCH_64);
  });

  it('accepts an already-parsed object body', () => {
    expect(
      parse({
        error: {
          message: MAX_64,
          param: 'input[1].id',
          code: 'string_above_max_length',
        },
      }),
    ).toEqual(MATCH_64);
  });

  it('reads a \\u escape in the quoted parameter', () => {
    // "input[1]\u002Eid" -- a proxy re-encoding the body can escape the dot.
    const escaped =
      '{"error":{"message":"' +
      MAX_64 +
      '","param":"input[1]\\u002Eid","code":"string_above_max_length"}}';
    expect(parse(escaped)).toEqual(MATCH_64);
  });

  it.each([200, 401, 404, 413, 429, 500, 502, 0, -1])(
    'refuses status %s even with a matching body',
    (status) => {
      expect(parseReasoningIdRejection(status, DIRECT_64)).toBeUndefined();
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
    expect(parse(value)).toBeUndefined();
  });

  it('returns undefined for an object it cannot stringify', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(parse(cyclic)).toBeUndefined();
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
    expect(parse(padded)).toBeUndefined();
  });

  it('returns undefined once the object-candidate budget is exhausted', () => {
    const padded = (count: number) =>
      `{"items":[${Array.from({ length: count }, (_, i) => `{"n":${i}}`).join(
        ',',
      )}],"error":{"message":"${MAX_64}","param":"input[1].id","code":"string_above_max_length"}}`;
    // The identical shape under the bound still classifies, so this is the
    // bound firing rather than the shape failing to parse.
    expect(parse(padded(10))).toEqual(MATCH_64);
    expect(parse(padded(40))).toBeUndefined();
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
      DIRECT_64.replace('string_above_max_length', 'string_too_long'),
    ],
    ['the param is not an input id', rejection('model', MAX_64)],
    ['the param index is negative', rejection('input[-1].id', MAX_64)],
    [
      'the param index is not a safe integer',
      rejection('input[99999999999999999999].id', MAX_64),
    ],
    ['the param has trailing content', rejection('input[1].id.extra', MAX_64)],
    ['the param has leading content', rejection('body.input[1].id', MAX_64)],
    // A matching object is only ever read out of the body's own structured
    // error. Anything the endpoint merely quoted -- in a debug field, past the
    // envelope, or behind an escape the JSON grammar does not define -- is not
    // evidence about the request we sent.
    [
      'a matching object is quoted inside an unrelated debug field',
      JSON.stringify({
        error: {
          message: 'Unsupported model',
          param: 'model',
          code: 'model_not_found',
        },
        debug: `example: ${DIRECT_64}`,
      }),
    ],
    [
      'trailing non-whitespace follows the top-level object',
      `${DIRECT_64} trailing`,
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
    // Raw control characters are tolerated only where a proxy actually splices
    // them: a raw newline, tab, or carriage return inside the ONE recognized
    // `error.message`. Anywhere else -- another field, another control
    // character, or outside the object entirely -- the body is not one we can
    // read exactly, so it is not one we act on.
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
    ['a vertical tab follows the top-level object', `${DIRECT_64}\u000b`],
    ['a form feed follows the top-level object', `${DIRECT_64}\u000c`],
    ['a no-break space follows the top-level object', `${DIRECT_64}\u00a0`],
    ['a vertical tab precedes the top-level object', `\u000b${DIRECT_64}`],
  ])('returns undefined when %s', (_label, value) => {
    expect(parse(value)).toBeUndefined();
  });

  // The control for the control-character rows above: the four characters
  // JSON's own grammar calls whitespace stay acceptable around the object.
  it('accepts JSON whitespace around the top-level object', () => {
    expect(parse(` \t\r\n${DIRECT_64} \t\r\n`)).toEqual(MATCH_64);
  });

  it('returns undefined for a revoked proxy rather than throwing', () => {
    const { proxy, revoke } = Proxy.revocable({ error: {} }, {});
    revoke();
    expect(parse(proxy)).toBeUndefined();
  });

  it('preserves the valid JSON escapes the grammar does define', () => {
    const message =
      'Invalid \\"input[1].id\\" \\\\ \\/ \\u2014 string too long. ' +
      'Expected a string with maximum length 64.';
    expect(
      parse(
        `{"error":{"message":"${message}","param":"input[1].id",` +
          '"code":"string_above_max_length"}}',
      ),
    ).toEqual(MATCH_64);
  });

  it("never inherits a nested object's fields onto its envelope", () => {
    // The outer object declares neither code nor param; only the inner one
    // matches, so this stays a single match rather than two.
    expect(parse(rejection('input[2].id', MAX_64))).toEqual({
      namedIndex: 2,
      maxLength: null,
    });
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
      expect(parse(rejection('input[1].id', message))).toEqual({
        namedIndex: 1,
        maxLength: expected,
      });
    });

    it('treats a missing message as no maximum', () => {
      expect(
        parse(body({ param: 'input[1].id', code: 'string_above_max_length' })),
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
        const wrapped = proxied(DIRECT_64, control);
        // A raw control character is precisely why the whole body cannot be
        // read with JSON.parse -- pin that, so a future "just parse it"
        // simplification fails here rather than in production.
        if (parsesAsJson) {
          expect(() => JSON.parse(wrapped)).not.toThrow();
        } else {
          expect(() => JSON.parse(wrapped)).toThrow(SyntaxError);
        }
        expect(parse(wrapped)).toEqual(MATCH_64);
      },
    );

    it('does not descend a second nesting level', () => {
      const once = DIRECT_64.replace(/"/g, '\\"');
      const twice = proxied(`{\\"relay\\":\\"${once}\\"}`);
      expect(parse(twice)).toBeUndefined();
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

  const frozen = (...items: ResponsesApiInputItem[]) =>
    Object.freeze(items) as ResponsesApiInputItem[];
  const downgrade = (
    items: ResponsesApiInputItem[],
    namedIndex: number,
    maxLength: number | null = 64,
  ) => downgradeRejectedReasoningItems(items, { namedIndex, maxLength });
  const assistant = (content: string) => ({
    type: 'message',
    role: 'assistant',
    content,
  });

  it.each<[string, ResponsesApiInputItem[], number]>([
    [
      'the named item is not reasoning',
      frozen(userItem('hi'), reasoningItem(LONG, ['thought'])),
      0,
    ],
    ['the named index is out of range', frozen(userItem('hi')), 9],
    [
      'the named id is within the maximum',
      frozen(reasoningItem('rs_short', ['thought'])),
      0,
    ],
  ])(
    'returns the original array by identity when %s',
    (_label, items, namedIndex) => {
      expect(downgrade(items, namedIndex)).toBe(items);
    },
  );

  it('preserves every untargeted item by object identity and position', () => {
    const first = userItem('hi');
    const keep = reasoningItem('rs_short', ['kept']);
    const last = userItem('bye');
    const items = frozen(first, reasoningItem(LONG, ['dropped']), keep, last);

    const result = downgrade(items, 1);

    expect(result).not.toBe(items);
    expect(result[0]).toBe(first);
    expect(result[2]).toBe(keep);
    expect(result[3]).toBe(last);
    expect(result[1]).toEqual(assistant('dropped'));
  });

  it('joins multiple non-empty summary texts with a newline and skips empty ones', () => {
    const items = frozen(reasoningItem(LONG, ['one', '', 'two']));
    expect(downgrade(items, 0)).toEqual([assistant('one\ntwo')]);
  });

  it('drops a targeted item whose summary carries no text', () => {
    const keep = userItem('hi');
    const items = frozen(
      keep,
      reasoningItem(LONG, []),
      reasoningItem(`rs_${'b'.repeat(80)}`, ['']),
    );
    expect(downgrade(items, 1)).toEqual([keep]);
  });

  it('downgrades every reasoning item when no maximum is reported', () => {
    const items = frozen(
      reasoningItem(LONG, ['long']),
      reasoningItem('rs_short', ['short']),
      userItem('bye'),
    );
    expect(downgrade(items, 0, null)).toEqual([
      assistant('long'),
      assistant('short'),
      items[2],
    ]);
  });

  it('never mutates the input array or its items', () => {
    const items = frozen(reasoningItem(LONG, ['thought']), userItem('bye'));
    const snapshot = JSON.stringify(items);

    downgrade(items, 0);
    downgrade(items, 0, null);

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

describe('isEncryptedReasoningRejection', () => {
  const error = {
    code: 'invalid_encrypted_content',
    type: 'invalid_request_error',
  };
  const direct = JSON.stringify({ error });
  const gateway = JSON.stringify({
    routify_response: { success: false, status: 400, error_detail: { error } },
  });

  it.each([direct, gateway, `data: ${gateway}\n\n`])(
    'recognizes an explicit encrypted-content rejection: %s',
    (body) => {
      expect(isEncryptedReasoningRejection(400, body)).toBe(true);
    },
  );

  it.each([
    ['wrong status', direct, 500],
    [
      'unknown code',
      JSON.stringify({
        error: {
          code: 'invalid_request_error',
          message: 'invalid_encrypted_content',
        },
      }),
      400,
    ],
    ['quoted request', JSON.stringify({ debug: { error } }), 400],
    ['contradictory gateway', gateway.replace('false', 'true'), 400],
    ['wrong gateway status', gateway.replace('400', '500'), 400],
    [
      'duplicate error key',
      `{"error":{},"error":${JSON.stringify(error)}}`,
      400,
    ],
    ['oversized', direct.padEnd(64001, ' '), 400],
    ['trailing garbage', direct + 'garbage', 400],
    ['multiple frames', `data: ${gateway}\n\ndata: ${gateway}\n\n`, 400],
    ['malformed', '{', 400],
    ['array', `[${direct}]`, 400],
  ])('does not recover on %s', (_label, body, status) => {
    expect(isEncryptedReasoningRejection(Number(status), String(body))).toBe(
      false,
    );
  });
});
