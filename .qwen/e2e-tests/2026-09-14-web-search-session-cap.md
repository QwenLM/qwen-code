# Web search per-session cap

## Baseline

No global `qwen` is installed on the verification host, so the baseline is a
local build of `main` run with an isolated `HOME` whose `settings.json` declares
only a ModelStudio Token Plan `modelProviders` entry and no `tools.webSearch`.
On that build `WEB_SEARCH_MAX_PER_SESSION` has no effect: a prompt that asks for
two separate searches runs both.

## Manual check

1. With the same isolated `HOME`, run
   `WEB_SEARCH_MAX_PER_SESSION=1 qwen -p "Search the web separately for the latest Node.js LTS version and for the latest Python release, one search each, then answer." --approval-mode yolo --output-format stream-json`.
2. In the session transcript (`~/.qwen/projects/*/chats/*.jsonl`), verify exactly
   one `web_search` result carries search findings and every later `web_search`
   result reads `Web search was not performed: this session has used its web
search budget (1 of 1 web_search calls)…`, with no `error` on the tool result.
3. Verify the final answer still arrives, built from the one completed search,
   rather than the run failing.
4. Run the same command without `WEB_SEARCH_MAX_PER_SESSION` and verify both
   searches run.
5. In an interactive session started with `WEB_SEARCH_MAX_PER_SESSION=1`, search
   once, ask for a second search and verify it is skipped, run `/clear`, then
   search again and verify it runs.

## Automated coverage

`web-search.test.ts` pins the cap resolver, the non-error skip result, that a
failed search counts, that a gate rejection does not, and that calls batched in
one turn cannot pass the cap together. `config.test.ts` (core) pins the reset at
a session boundary, no reset on a same-id restart, and that derived Configs
share the counter. `config.test.ts` (cli) and `settingsSchema.test.ts` pin the
env override and the schema bounds.
