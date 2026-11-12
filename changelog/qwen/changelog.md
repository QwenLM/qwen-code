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
