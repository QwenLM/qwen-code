## CLI 1.0.0-preview.2

- Add Qwen4-Max to the Qwen subscription catalog (1M context window, image and video input).
- Show a reset countdown when Qwen subscription credits run out, and add an `/upgrade` command that opens the subscription plans page.
- Qwen subscription requests now carry the QwenCode user agent and gateway request id for easier troubleshooting, and Qwen subscription OAuth requests honor `Retry-After` before retrying when rate limited (429).
- Give Qoder limited-free models more accurate paid-confirmation messages based on the error code.

## CLI 1.0.0-preview.1

- Fix Qwen subscription accounts being unable to use subscription models after sign-in. The model catalog now follows your sign-in state automatically, with no manual provider configuration needed.
- Sync the subscription model catalog and thinking-budget mapping with Qwen Code 0.27.x, with clearer error messages.
- Qoder models support parallel tool calls, so multi-tool tasks no longer run strictly sequentially and complete faster.

## CLI 1.0.0-preview

- Introduce Qwen Code 1.0 Preview, bringing together the agent capabilities of Qoder and Qwen Code for code understanding, implementation, debugging, and testing.
- Connect with Qwen or Qoder accounts, supported model providers, or custom compatible endpoints.
- Install natively on macOS, Linux, and Windows without a separate Node.js installation.
- Resume saved sessions and run non-interactive requests for scripting and automation.

Some interfaces, configuration options, and behaviors may change during Preview.
