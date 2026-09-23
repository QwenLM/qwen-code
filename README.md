# PR #12258 F1/F2 verification

Source fix: 23c0e1bd90. Baseline: 5f17519bf2. macOS, headless WebKit 26.5, actual bundled Qwen WebShell / daemon / ACP / stdio MCP and official App SDK. Model selection and vendor responses are synthetic; MOCK-NOT-A-TOKEN values are fixture text, not credentials. No real Tableau authentication or remote instance validation in this run.

Before: five App calls plus session events fill the browser HTTP/1.1 connections; clicked approval remains pending and server executions remain zero after 11 seconds. This bounded reproduction stops before the five-minute timeout.

After: all five calls are approved and complete in 2.09–4.25 seconds, with only two initial requests dispatched. After killing only the fixture MCP process, the first approved call fails once while restarting the connection; the next two separately approved calls succeed in 124 / 132 ms. The failed call is not replayed.

The queue is shared across cards within one page, not across tabs. These screenshots prove synthetic App call/approval/recovery behavior, not Tableau chart rendering. No security attack probes were executed in this verification.
