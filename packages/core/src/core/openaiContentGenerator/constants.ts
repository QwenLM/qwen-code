export const DEFAULT_TIMEOUT = 120000;
// Inactivity (no-chunk) timeout for streaming responses. The SDK `timeout`
// only bounds connect + first response, so a stream that returns 200 then
// goes silent is otherwise unbounded; this watchdog aborts it.
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120000;
export const DEFAULT_MAX_RETRIES = 3;

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_DASHSCOPE_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_OPEN_ROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DASHSCOPE_PROXY_BASE_URL = process.env['DASHSCOPE_PROXY_BASE_URL'];
