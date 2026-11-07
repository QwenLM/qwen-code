/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ContextLengthExceededInfo {
  isExceeded: boolean;
  message: string;
  actualTokens?: number;
  limitTokens?: number;
  /**
   * What `limitTokens` bounds. `'input'` when the matched wording names the
   * prompt/input allowance (DashScope's input range, an input token-count
   * maximum), `'total'` when it names the context window itself (`maximum
   * context length`, llama.cpp's available context size). Unset when the
   * wording does not say (a bare `N tokens > M`), so a consumer that needs a
   * window can treat "unknown" as "not an input bound" and keep its previous
   * behavior.
   */
  limitKind?: 'input' | 'total';
  /**
   * The rejected prompt's own size, read only from wording that states it
   * apart from the output budget. `actualTokens` keeps the figure the
   * reactive path has always read, which for "you requested N tokens" counts
   * the requested output too.
   */
  promptTokens?: number;
  /**
   * A "you requested N tokens" total with no breakdown: the prompt plus the
   * output budget the request asked for, which can be more than the
   * transport sent. Read it as an upper bound on the prompt; subtracting the
   * requested budget can undercount the prompt.
   */
  requestedTokens?: number;
}

const MAX_COLLECT_DEPTH = 4;

/**
 * Wordings that state the prompt's own size, each matched within a single
 * fragment so a number from a sibling field is never paired with it.
 */
const PROMPT_TOKEN_PATTERNS = [
  // Anthropic, Fireworks: "prompt is too long: 210000 tokens > 200000 maximum"
  /\bprompt is too long:\s*(\d[\d,]*)/i,
  // OpenAI: "your messages resulted in 135000 tokens"
  /\bresulted in\s+(\d[\d,]*)\s+tokens?\b/i,
  // vLLM, Mistral: "your prompt contains 25000 input tokens". The digits must
  // follow directly: vLLM's "contains at least N" is a tokenization cut-off.
  /\bprompt contains\s+(\d[\d,]*)\s+(?:input\s+)?tokens?\b/i,
  // vLLM: "your request has 10000 input tokens"
  /\brequest has\s+(\d[\d,]*)\s+input tokens?\b/i,
  // Gemini: "The input token count (1196265) exceeds ...", also seen with
  // "length", which the limit parse below reads too
  /\binput token (?:count|length)\s*\(\s*(\d[\d,]*)\s*\)/i,
  // llama.cpp: "request (279935 tokens) exceeds the available context size"
  /\brequest\s*\(\s*(\d[\d,]*)\s*tokens?\s*\)\s*exceeds\b/i,
  // SGLang: "36000 tokens from the input messages"
  /\b(\d[\d,]*)\s+tokens?\s+from the input messages\b/i,
  // TGI: "Given: 23362 `inputs` tokens and 12629 `max_new_tokens`"
  /\bGiven:\s*(\d[\d,]*)\s*`?inputs`?\s+tokens\b/i,
  // TGI: "`inputs` must have less than 32000 tokens. Given: 40000"
  /\binputs`?\s+must have less than\s+\d[\d,]*\s+tokens\.?\s*Given:\s*(\d[\d,]*)/i,
  // vLLM: "Input length (40000) exceeds model's maximum context length". The
  // verb must follow, as in the next one: "maximum input length (N)" is a limit.
  /\binput length\s*\(\s*(\d[\d,]*)\s*\)\s*exceeds?\b/i,
  // Bedrock: "prompt tokens (40000) exceed model maximum (32768)"
  /\bprompt tokens\s*\(\s*(\d[\d,]*)\s*\)\s*exceeds?\b/i,
];

/**
 * A word just before a count's wording that makes its number a limit:
 * "maximum prompt tokens (32768)" is what the server takes, not what the
 * request held (#15936 R3-2).
 */
const LIMIT_QUALIFIER =
  /\b(?:max(?:imum)?|limit|allowed|permitted|capacity|up to|at most|no more than|less than)\b/i;

/** The last three words before `index`, within its clause. */
function wordsBefore(text: string, index: number): string {
  const clause =
    text
      .slice(0, index)
      .split(/[.;:!?\n]/)
      .pop() ?? '';
  return clause.split(/\s+/).filter(Boolean).slice(-3).join(' ');
}

/**
 * OpenAI and the servers that copy its wording: "you requested 131329 tokens
 * (123137 in the messages, 8192 in the completion)". The total includes the
 * output budget; the parenthesis, when present, says how much of it. The
 * rest of the clause after "tokens" is captured so a total that is only the
 * output budget ("in the completion", "in your completion") is passed over.
 */
const REQUESTED_TOKENS_PATTERN =
  /\byou requested\s+(?:about\s+)?(\d[\d,]*)\s+tokens?\b([^.(\n]*)(?:\(([^)]*)\))?/i;
const OUTPUT_WORDING = /\b(?:completion|output)\b/i;
const OUTPUT_SHARE_PATTERN =
  /(\d[\d,]*)\s+(?:in|for)\s+the\s+(?:completion|output)\b/i;

const TIMEOUT_PATTERNS = [
  /\bcontext deadline exceeded\b/i,
  /\bdeadline exceeded\b/i,
  /\b(?:request|connection|read|context)\s+timed out\b/i,
  /\b(?:request|connection|read|context)\s+timeout\b/i,
  /\b(?:timeout|timed out)\s+(?:after|while|during)\b/i,
];

const CONTEXT_LENGTH_PATTERNS = [
  /\bcontext[_\s-]?length[_\s-]?exceeded\b/i,
  /\bmaximum context length\b/i,
  /\bprompt\s+(?:is\s+)?too long\b/i,
  /\binput\s+(?:token\s+)?(?:count\s+|length\s+)?(?:is\s+)?too long\b/i,
  /\brange of input length should be\b/i,
  // Hugging Face TGI: "Input validation error: `inputs` tokens +
  // `max_new_tokens` must be <= 32768. Given: 40000 `inputs` tokens and 1000
  // `max_new_tokens`" and "`inputs` must have less than 32768 tokens. Given:
  // 40000".
  /\binputs`?\s+tokens\s*\+\s*`?max_new_tokens`?\s+must be\s*<=/i,
  /\binputs`?\s+must have less than\s+\d[\d,]*\s+tokens\b/i,
  /\btoo many tokens\b/i,
  /\btokens?\s*>\s*[\d,]+\s*(?:maximum|max|limit)\b/i,
  /\b(?:input|prompt|messages?|context)\b[^\n]{0,120}\btokens?\b[^\n]{0,120}\bexceed(?:s|ed|ing)?\b/i,
  // llama.cpp: "request (279935 tokens) exceeds the available context size
  // (262144 tokens), try increasing it" (#13415).
  /\bexceeds the available context size\b/i,
];

function parseInteger(value: string): number {
  return Number.parseInt(value.replace(/,/g, ''), 10);
}

function parseTokenCounts(text: string): {
  actualTokens?: number;
  limitTokens?: number;
  limitKind?: 'input' | 'total';
} {
  const greaterThanMatch = text.match(/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i);
  if (greaterThanMatch) {
    return {
      actualTokens: parseInteger(greaterThanMatch[1]!),
      limitTokens: parseInteger(greaterThanMatch[2]!),
    };
  }

  const openAiMatch = text.match(
    /maximum context length is\s*(\d[\d,]*)\s*tokens?[\s\S]*?(?:resulted in|requested|used)\s*(\d[\d,]*)\s*tokens?/i,
  );
  if (openAiMatch) {
    return {
      actualTokens: parseInteger(openAiMatch[2]!),
      limitTokens: parseInteger(openAiMatch[1]!),
      limitKind: 'total',
    };
  }

  // SGLang states the window as "maximum context length of N tokens".
  const maxContextLimitMatch = text.match(
    /maximum context length (?:is|of)\s*(\d[\d,]*)\s*tokens?/i,
  );
  if (maxContextLimitMatch) {
    return {
      limitTokens: parseInteger(maxContextLimitMatch[1]!),
      limitKind: 'total',
    };
  }

  const inputExceedsMatch = text.match(
    /input\s+token\s+(?:count|length)[^\d]*(\d[\d,]*)[\s\S]*?exceed(?:s|ed)?[\s\S]*?(?:maximum|limit)[^\d]*(\d[\d,]*)/i,
  );
  if (inputExceedsMatch) {
    return {
      actualTokens: parseInteger(inputExceedsMatch[1]!),
      limitTokens: parseInteger(inputExceedsMatch[2]!),
      limitKind: 'input',
    };
  }

  // DashScope: "Range of input length should be [1, 196608]" — the upper
  // bound is the server's REAL input ceiling (observed to differ from the
  // configured context window), so parse it out for the retry paths. It
  // bounds the prompt, not the window: `prompt + max_tokens` may exceed it.
  const rangeMatch = text.match(
    /range of input length should be\s*\[\s*\d[\d,]*\s*,\s*(\d[\d,]*)\s*\]/i,
  );
  if (rangeMatch) {
    return {
      limitTokens: parseInteger(rangeMatch[1]!),
      limitKind: 'input',
    };
  }

  // TGI bounds `inputs + max_new_tokens` by `max_total_tokens`, the server's
  // real window, and the prompt alone by `max_input_tokens`. Either way the
  // `inputs` count is the prompt size compaction should start from.
  const tgiTotalMatch = text.match(
    /must be\s*<=\s*(\d[\d,]{0,31})\.?\s*Given:\s*(\d[\d,]{0,31})\s*`?inputs`?\s+tokens/i,
  );
  if (tgiTotalMatch) {
    return {
      actualTokens: parseInteger(tgiTotalMatch[2]!),
      limitTokens: parseInteger(tgiTotalMatch[1]!),
      limitKind: 'total',
    };
  }
  const tgiInputMatch = text.match(
    /must have less than\s+(\d[\d,]{0,31})\s+tokens\.?\s*Given:\s*(\d[\d,]{0,31})/i,
  );
  if (tgiInputMatch) {
    return {
      actualTokens: parseInteger(tgiInputMatch[2]!),
      limitTokens: parseInteger(tgiInputMatch[1]!),
      limitKind: 'input',
    };
  }

  // llama.cpp: "request (279935 tokens) exceeds the available context size
  // (262144 tokens), try increasing it" — the SECOND number is the server's
  // real ceiling (its `-c` / model `n_ctx`), which routinely differs from the
  // window we inferred from the model id. The reactive-compaction anchor
  // consumes `actualTokens`; a `limitKind` of `'total'` makes `limitTokens`
  // eligible as `observedServerCeiling` for reactive compaction sizing
  // (#13432).
  const llamaCppMatch = text.match(
    /\(\s*(\d[\d,]*)\s*tokens?\s*\)\s*exceeds the available context size\s*\(\s*(\d[\d,]*)\s*tokens?\s*\)/i,
  );
  if (llamaCppMatch) {
    return {
      actualTokens: parseInteger(llamaCppMatch[1]!),
      limitTokens: parseInteger(llamaCppMatch[2]!),
      limitKind: 'total',
    };
  }

  // vLLM: "Input length (40000) exceeds model's maximum context length
  // (32768)"; Bedrock: "prompt tokens (40000) exceed model maximum (32768)".
  // The bound follows the count in the same sentence. "Context length" names
  // the window; a bare "maximum" leaves its kind unsaid (#15936 R3-2).
  const boundAfterCountMatch = text.match(
    /\(\s*(\d[\d,]{0,31})\s*\)\s*exceeds?\b([^()\n]{0,80}?\bmax(?:imum)?\b[^()\n]{0,40}?)\(\s*(\d[\d,]{0,31})\s*\)/i,
  );
  if (boundAfterCountMatch) {
    return {
      actualTokens: parseInteger(boundAfterCountMatch[1]!),
      limitTokens: parseInteger(boundAfterCountMatch[3]!),
      ...(/\bcontext (?:length|window|size)\b/i.test(boundAfterCountMatch[2]!)
        ? { limitKind: 'total' as const }
        : {}),
    };
  }

  return {};
}

/**
 * The prompt's own size as one fragment states it. A match whose wording a
 * limit word qualifies is passed over: "maximum prompt tokens (32768)" names
 * what the server takes (#15936 R3-2).
 */
function parsePromptTokens(
  fragment: string,
): Pick<ContextLengthExceededInfo, 'promptTokens' | 'requestedTokens'> {
  for (const pattern of PROMPT_TOKEN_PATTERNS) {
    for (const match of fragment.matchAll(new RegExp(pattern, 'gi'))) {
      if (!LIMIT_QUALIFIER.test(wordsBefore(fragment, match.index))) {
        return { promptTokens: parseInteger(match[1]!) };
      }
    }
  }
  const match = REQUESTED_TOKENS_PATTERN.exec(fragment);
  if (!match || OUTPUT_WORDING.test(match[2]!)) return {};
  const total = parseInteger(match[1]!);
  const output = match[3] ? OUTPUT_SHARE_PATTERN.exec(match[3]) : null;
  if (!output) return { requestedTokens: total };
  const prompt = total - parseInteger(output[1]!);
  return prompt > 0 ? { promptTokens: prompt } : {};
}

type TokenCounts = Omit<ContextLengthExceededInfo, 'isExceeded' | 'message'>;

/**
 * Every figure comes from one rejection fragment, so a limit is never paired
 * with another fragment's count. The first fragment that states the prompt's
 * size wins: collection order puts the error's own message before the fields
 * and causes it carries, such as an earlier attempt's rejection (#15936
 * R3-2). Without a stated size, the first fragment that states any figure
 * supplies it.
 */
function parseCounts(overflowFragments: string[]): TokenCounts {
  let figuresOnly: TokenCounts | undefined;
  const texts = overflowFragments.flatMap(ownTexts).filter(isOverflowText);
  for (const fragment of texts) {
    const counts = parseTokenCounts(fragment);
    const prompt = parsePromptTokens(fragment);
    if (
      prompt.promptTokens !== undefined ||
      prompt.requestedTokens !== undefined
    ) {
      return { ...counts, ...prompt };
    }
    if (
      figuresOnly === undefined &&
      (counts.actualTokens !== undefined || counts.limitTokens !== undefined)
    ) {
      figuresOnly = counts;
    }
  }
  return figuresOnly ?? {};
}

/** A JSON document in `text` and where it sits: all of it, or an embedded object. */
function findEmbeddedJson(
  text: string,
): { value: unknown; start: number; end: number } | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return {
        value: JSON.parse(trimmed) as unknown,
        start: 0,
        end: text.length,
      };
    } catch {
      // Fall through to embedded-object parsing.
    }
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return undefined;
  }

  try {
    return {
      value: JSON.parse(text.slice(start, end + 1)) as unknown,
      start,
      end: end + 1,
    };
  } catch {
    return undefined;
  }
}

function tryParseEmbeddedJson(text: string): unknown | undefined {
  return findEmbeddedJson(text)?.value;
}

/**
 * The texts a fragment states, in order. An embedded JSON body is replaced by
 * its own fields: read whole, the body would put a sibling field's rejection
 * beside this one (#15936 R3-2).
 */
function ownTexts(fragment: string): string[] {
  const json = findEmbeddedJson(fragment);
  if (!json) return [fragment];
  return [
    `${fragment.slice(0, json.start)}\n${fragment.slice(json.end)}`,
    ...collectStrings(json.value, new Set<object>(), 1).flatMap(ownTexts),
  ];
}

/** A fragment that names a context-length failure and is not a timeout. */
function isOverflowText(fragment: string): boolean {
  return (
    CONTEXT_LENGTH_PATTERNS.some((pattern) => pattern.test(fragment)) &&
    !TIMEOUT_PATTERNS.some((pattern) => pattern.test(fragment))
  );
}

function safeReadProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function enumerableValues(value: object): unknown[] {
  try {
    return Object.values(value);
  } catch {
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      return Object.values(descriptors)
        .filter(
          (descriptor): descriptor is PropertyDescriptor & { value: unknown } =>
            'value' in descriptor && descriptor.enumerable === true,
        )
        .map((descriptor) => descriptor.value);
    } catch {
      return [];
    }
  }
}

function collectStrings(
  value: unknown,
  seen: Set<object>,
  depth = 0,
): string[] {
  if (depth > MAX_COLLECT_DEPTH || value === null || value === undefined) {
    return [];
  }

  if (typeof value === 'string') {
    const parsed = tryParseEmbeddedJson(value);
    if (parsed === undefined) {
      return [value];
    }
    return [value, ...collectStrings(parsed, seen, depth + 1)];
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }

  if (typeof value !== 'object') {
    return [];
  }

  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const strings: string[] = [];
  if (value instanceof Error) {
    const name = safeReadProperty(value, 'name');
    const message = safeReadProperty(value, 'message');

    if (typeof name === 'string') {
      strings.push(name);
    }
    if (typeof message === 'string') {
      strings.push(message);
    }
    strings.push(
      ...collectStrings(safeReadProperty(value, 'cause'), seen, depth + 1),
    );
  }

  for (const nested of enumerableValues(value)) {
    strings.push(...collectStrings(nested, seen, depth + 1));
  }

  return strings;
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function getContextLengthExceededInfo(
  error: unknown,
): ContextLengthExceededInfo {
  const fragments = uniqueNonEmpty(collectStrings(error, new Set<object>()));
  const message = fragments.join('\n');
  // The timeout veto is applied per fragment, alongside the context-length
  // test it is vetoing. Testing it against the joined message instead let a
  // timeout phrase anywhere in the error object suppress detection for the
  // whole error -- and provider SDKs routinely attach retry/attempt metadata,
  // so an overflow arriving with `previous attempt: request timed out` in a
  // sibling field was reported as not-an-overflow and never reached the
  // compaction path. A fragment counts as evidence only if it names a
  // context-length failure and is not itself a timeout message.
  const overflowFragments = fragments.filter(isOverflowText);
  const isExceeded = overflowFragments.length > 0;
  const counts = isExceeded ? parseCounts(overflowFragments) : {};

  return {
    isExceeded,
    message,
    ...counts,
  };
}

export function isContextLengthExceededError(error: unknown): boolean {
  return getContextLengthExceededInfo(error).isExceeded;
}
