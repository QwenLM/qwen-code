export const DEFAULT_TIMEOUT = 120000;
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
// delays to 1ms, which would make the watchdog fire almost immediately, so an
// idle timeout above this is treated as invalid.
export const MAX_STREAM_IDLE_TIMEOUT_MS = 2_147_483_647;
export const DEFAULT_MAX_RETRIES = 3;

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_DASHSCOPE_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_OPEN_ROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DASHSCOPE_PROXY_BASE_URL = process.env['DASHSCOPE_PROXY_BASE_URL'];
