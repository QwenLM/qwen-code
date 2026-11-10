# E2E test plan: output speed over the full request (#16714)

Build: `npm run build && npm run bundle` on this branch. Baseline: a main build (same telemetry and stats code as 30e71d37e6).
Harness: the interactive CLI in tmux with an isolated `HOME`, `--auth-type openai`. Send one prompt, wait for idle, run `/stats`, capture the pane.

## Cases

| # | Provider | Scenario | Expected (main) | Expected (branch) | Result |
| - | -------- | -------- | --------------- | ----------------- | ------ |
| 1 | Mock SSE server | 8 s silence, then 200 answer tokens over 2 s. Usage reports 1000 output tokens, 800 of them reasoning (hidden reasoning). | Session TPS ≈ 500 (tokens over the 2 s window) | Session TPS ≈ 100 (tokens over about 10 s) | main 513.6, branch 94.1 ✅ |
| 2 | Mock SSE server | Follow-up request with 1 token in one chunk, TTFT ≈ 360 ms | Latest TPS `—` (window 0) | Latest TPS = 1 / TTFT ≈ 2.8 | main —, branch 2.8 ✅ |
| 3 | Model Studio Token Plan, qwen3.8-flash | Write a file with 5 unit tests, run them, reply | n/a | Latest TPS = output tokens / (TTFT + Generation Time) as shown | 101 / (0.638 + 0.682) = 76.5, shown 76.5 ✅ |
| 4 | Any | Request without reported usage | n/a | Counts towards TTFT, adds nothing to Session TPS; latest TPS `—` | covered by unit tests (core, CLI) |
| 5 | Web Shell + older daemon (no `totalOutputSpeedDurationMs`) | Token Usage model grid, timeline and spread | n/a | Cards, overview, timeline and spread all use tokens / generation window (that daemon's own rate) | covered by the Web Shell unit tests |
| 6 | Older client + this daemon | Client divides `totalThroughputOutputTokens` by `totalGenerationDurationMs` | n/a | Same values as main: both still leave out windows under 100 ms | covered by the core unit tests |
| 7 | Gemini thinking model | 800 reasoning tokens reported apart from 200 visible ones; 8 s TTFT, 2 s generation | n/a | Speed counts 1000 tokens over 10 s ≈ 100 tok/s, not 20 | covered by the core unit test |
| 8 | Any | Timed requests without reported usage | n/a | Web Shell model card shows First token and Generation, no Output speed | covered by the Web Shell unit test |

## Notes

- The mock server sends the main scenario only to the first streaming request that carries tools. Other requests, such as the memory side query and the follow-ups, get a one-token reply.
- Cases 1–3 were run on Linux, Node 24, at 651fdec20b. The later change that keeps the older fields and counts reasoning once does not change OpenAI-compatible output counts, so their expected values stay the same.
