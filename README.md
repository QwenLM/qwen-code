# MCP App local regression evidence — #11945

These are unedited browser screenshots from the local PR build of Qwen Code,
using a local MCP fixture and mock model. The data is synthetic, not real
Amplitude analytics.

- Before: default 1 MiB policy rejects 1,048,577-byte HTML.
- After: explicit 2 MiB policy renders the same resource; its button works.
- Replay: cold daemon restart, recorded App renders and remains interactive.

The fixture accepts FIXTURE_BYTES and FIXTURE_DELAY (milliseconds). Start the
mock model with PORT=18765 node amplitude-mock-model.mjs. Configure a stdio MCP
server named amplitude-fixture that runs node with the absolute fixture path,
then compare default settings with appResourceMaxBytes: 2097152 and
appResourceTimeoutMs: 30000. Use the local model at http://127.0.0.1:18765/v1,
model mock-model and dummy API key sk-mock. No real credentials are needed.

This branch contains test evidence only; it is separate from the product PR.
