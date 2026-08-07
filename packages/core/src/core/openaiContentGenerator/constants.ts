export const DEFAULT_TIMEOUT = 120000;
/**
 * Sentinel request timeout (ms) representing a *disabled* timeout.
 *
 * The OpenAI and Anthropic SDKs treat `timeout: 0` as an immediate abort rather
 * than "no timeout", so a configured `0` (disable — matching the
 * `QWEN_STREAM_IDLE_TIMEOUT_MS=0` convention) is mapped to the maximum JS timer
 * delay (2^31 − 1 ms ≈ 24.8 days). `setTimeout` silently compresses larger
 * delays to 1ms, so this is the effective ceiling.
 */
export const DISABLED_REQUEST_TIMEOUT_MS = 2_147_483_647;

/**
 * Resolve the request timeout (ms) to pass to a provider SDK client.
 *
 * - `undefined` / `null` → {@link DEFAULT_TIMEOUT}
 * - `0` or negative → disabled ({@link DISABLED_REQUEST_TIMEOUT_MS})
 * - otherwise → the configured value
 */
export function resolveRequestTimeout(
  timeout: number | null | undefined,
): number {
  if (timeout === undefined || timeout === null) {
    return DEFAULT_TIMEOUT;
  }
  return timeout <= 0 ? DISABLED_REQUEST_TIMEOUT_MS : timeout;
}
// Inactivity (no-chunk) timeout for streaming responses. The SDK `timeout`
// only bounds connect + first response, so a stream that returns 200 then
// goes silent is otherwise unbounded. The 4-minute default gives large-prompt
// ingest and long thinking phases room while staying below
// LoggingContentGenerator's stream-span idle timer, so this watchdog fires first.
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 240000;
// Env override (deployment knob) for the streaming inactivity timeout, so a
// daemon deployment can tune it without code — the same way the QWEN_SERVE_*
// params are set. An explicit ContentGeneratorConfig.streamIdleTimeoutMs still
// takes precedence; a malformed value is ignored (falls back to the default).
export const QWEN_STREAM_IDLE_TIMEOUT_MS_ENV = 'QWEN_STREAM_IDLE_TIMEOUT_MS';
// Maximum JS timer delay (~24.8 days). setTimeout silently compresses larger
// delays to 1ms, which would make a watchdog fire almost immediately, so a
// stream-guard timeout above this is treated as invalid.
export const MAX_STREAM_GUARD_TIMEOUT_MS = 2_147_483_647;

// Total-lifetime cap for a single streaming response, measured from the
// stream's first iteration (when the response wrapper starts consuming it)
// and NOT refreshed by chunk arrival. The idle watchdog above cannot see
// a drip-fed stream — an upstream delivering one tiny chunk per window keeps
// resetting it while the message never completes (issue #8597: CI review runs
// burned 2.5–4.5 h on such a stream and died by the outer kill). 15 minutes
// gives even a slow, oversized single response ample room, and a false trip
// is bounded and visible: a text-only generation cut by the cap resumes via
// the transport-continuation recovery, while a turn that already streamed a
// functionCall (the tool-heavy common case, where continuation is excluded
// and replay needs no prior content) ends in a classified ETIMEDOUT the
// caller sees and can retry — never hours of silence. Note the cap bounds
// ONE attempt — each replay/continuation the recovery earns gets a fresh
// stream (TRANSPORT_STREAM_RETRY_CONFIG), so a pathological upstream's
// wall-clock bound per request is a small multiple of this value, not this
// value alone.
export const DEFAULT_STREAM_MAX_LIFETIME_MS = 900000;
// Env override (deployment knob) for the stream lifetime cap — same
// conventions as QWEN_STREAM_IDLE_TIMEOUT_MS: an explicit
// ContentGeneratorConfig.streamMaxLifetimeMs wins, `0` disables, a malformed
// value falls back to the default with a warning.
export const QWEN_STREAM_MAX_LIFETIME_MS_ENV = 'QWEN_STREAM_MAX_LIFETIME_MS';
export const DEFAULT_MAX_RETRIES = 3;

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_DASHSCOPE_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_OPEN_ROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DASHSCOPE_PROXY_BASE_URL = process.env['DASHSCOPE_PROXY_BASE_URL'];
