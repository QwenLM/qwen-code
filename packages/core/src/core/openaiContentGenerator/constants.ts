export const DEFAULT_TIMEOUT = 120000;
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Inactivity (read) timeout for streaming responses, in milliseconds.
 *
 * The OpenAI SDK's `timeout` only bounds time-to-headers: once the response
 * headers arrive it clears its watchdog (client `fetchWithTimeout` clears the
 * timer in `finally`), so a provider that opens a stream and then stalls
 * mid-flight — headers received, SSE body goes silent — is no longer bounded
 * by anything and the consuming `for await` suspends forever. This value caps
 * the gap between two consecutive chunks; exceeding it aborts the request so
 * the stall surfaces as a retryable error instead of a permanent hang.
 *
 * It is an *inactivity* budget (reset on every chunk), not a total-duration
 * budget, so long-but-live streams are unaffected. Override via the
 * `QWEN_CODE_STREAM_IDLE_TIMEOUT_MS` env var or `contentGenerator.streamIdleTimeoutMs`;
 * a value `<= 0` disables the watchdog.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT = 120000;

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_DASHSCOPE_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_OPEN_ROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DASHSCOPE_PROXY_BASE_URL = process.env['DASHSCOPE_PROXY_BASE_URL'];
