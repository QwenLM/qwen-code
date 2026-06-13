/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Idle-suggestions (proposal `add-idle-suggestions`) generates next-step
 * suggestions with the GATEWAY's OWN model call — never by injecting a synthetic
 * prompt into the live daemon session (which would permanently pollute the
 * transcript, broadcast to viewers, and steer the model's later replies). This
 * module resolves the model endpoint and provides the chat transport.
 *
 * SECURITY POSTURE — "the workstation owns the context": a suggestion call ships
 * recent transcript content (prompts, code, tool output) to an LLM endpoint, so
 * the `(apiKey, baseUrl, model)` triple is resolved as a COHERENT SET from a
 * SINGLE source. We NEVER pair a key from one source with a host from another (a
 * key + a guessed default host would leak the user's content + key to a host
 * they never chose). With no resolvable key+host, the feature is INERT — no
 * calls, ever (which also matches the spec's opt-in `enabled` default).
 */

/** A resolved, coherent model endpoint for suggestion generation. */
export interface SuggestConfig {
  apiKey: string;
  /** OpenAI-compatible base (no trailing slash); `/chat/completions` is appended. */
  baseUrl: string;
  model: string;
}

/** A chat message in the OpenAI-compatible shape. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Sends chat messages and resolves the assistant's reply text. Throws on a
 * non-2xx / network / timeout / abort (the caller maps that to "no suggestions",
 * never letting it escape). */
export type ChatTransport = (
  messages: ChatMessage[],
  opts?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<string>;

const DASHSCOPE_COMPATIBLE =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen-turbo';
const DEFAULT_TIMEOUT_MS = 15_000;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Resolve the suggestion endpoint from env as a COHERENT (key, host) set, in
 * precedence order:
 *
 *  1. `QWEN_RC_SUGGEST_API_KEY` + `QWEN_RC_SUGGEST_BASE_URL` — the dedicated
 *     override pair (both required together).
 *  2. `OPENAI_API_KEY` + `OPENAI_BASE_URL` — reuse the user's OpenAI-compatible
 *     config (both required together; a key WITHOUT an explicit base is NOT used
 *     against a guessed host).
 *  3. `DASHSCOPE_API_KEY` alone — the dashscope compatible-mode host is the
 *     unambiguous home of a dashscope key, so the default base is safe here.
 *
 * The model may be overridden by `QWEN_RC_SUGGEST_MODEL` (then `OPENAI_MODEL`)
 * since the model name is not host-sensitive. Returns `null` when no coherent
 * key+host can be formed → the feature stays inert.
 */
export function resolveSuggestConfig(
  env: Record<string, string | undefined> = process.env,
): SuggestConfig | null {
  const modelOverride = env['QWEN_RC_SUGGEST_MODEL'] || env['OPENAI_MODEL'];

  const sk = env['QWEN_RC_SUGGEST_API_KEY'];
  const sb = env['QWEN_RC_SUGGEST_BASE_URL'];
  if (sk && sb) {
    return {
      apiKey: sk,
      baseUrl: trimSlash(sb),
      model: env['QWEN_RC_SUGGEST_MODEL'] || modelOverride || DEFAULT_MODEL,
    };
  }

  const ok = env['OPENAI_API_KEY'];
  const ob = env['OPENAI_BASE_URL'];
  if (ok && ob) {
    return {
      apiKey: ok,
      baseUrl: trimSlash(ob),
      model: modelOverride || DEFAULT_MODEL,
    };
  }

  const dk = env['DASHSCOPE_API_KEY'];
  if (dk) {
    return {
      apiKey: dk,
      baseUrl: DASHSCOPE_COMPATIBLE,
      model: modelOverride || DEFAULT_MODEL,
    };
  }

  return null; // No coherent (key, host) → inert; never guess where to send content.
}

/**
 * Build an OpenAI-compatible chat transport over the resolved config. Bounded by
 * a hard timeout (default 15 s) composed with any caller signal via
 * `AbortSignal.any`, so a hung endpoint can never wedge the caller (the pump in
 * a later slice reuses this exact transport). `fetchImpl` is injectable for
 * tests; production uses the global `fetch`.
 */
export function createChatTransport(
  cfg: SuggestConfig,
  deps: { fetchImpl?: typeof fetch } = {},
): ChatTransport {
  const doFetch = deps.fetchImpl ?? fetch;
  return async (messages, opts = {}) => {
    const signals: AbortSignal[] = [
      AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ];
    if (opts.signal) signals.push(opts.signal);
    const res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0.3,
        max_tokens: 256,
      }),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) {
      throw new Error(`chat completions HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = json?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  };
}
