# Python SDK shared initialization cancellation

## Behavior

- Cancelling one public control call while initialization is pending cancels that caller only.
- An unrelated waiting call and a later call still receive their own responses after initialization succeeds.
- Both a single string prompt and an asynchronous input stream still send their input once.
- Closing the query, or receiving an initialization error, terminates waiting calls without writing new prompts or controls after shutdown.

## Local verification

Use the SDK's in-memory protocol fixture to withhold the initialize reply, cancel one caller, then deliver the reply. Include uncancelled controls and query-owned shutdown cases. The original independent reproduction must pass against the exact production head.

These tests exercise Python task ownership without running an external CLI. They do not establish official CLI end-to-end coverage or completion of the repository-wide build, bundle or preflight.
