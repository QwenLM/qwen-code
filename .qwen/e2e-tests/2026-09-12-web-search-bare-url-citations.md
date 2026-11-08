# Web search bare URL citations

## Baseline

No global `qwen` is installed on the verification host, so the baseline is a
local build of `main` run with an isolated `HOME` whose `settings.json` declares
only a ModelStudio Token Plan `modelProviders` entry and no `tools.webSearch`.
On that build the citation policy asks for markdown links while the tool result
lists bare URLs, and the model's `Sources:` section uses URL paths as link text
or titles it wrote itself.

## Manual check

1. With the same isolated `HOME`, run
   `qwen -p "Search the web for the current Node.js Active LTS version, then answer with sources." --approval-mode yolo --output-format stream-json`.
2. In the final answer, verify the `Sources:` section lists bare URLs, one per
   line, with no markdown link syntax and no titles.
3. Verify every listed URL appears in the `web_search` tool result's page lists
   (the `functionResponse` in `~/.qwen/projects/*/chats/*.jsonl`).
4. In an interactive session on a terminal that supports OSC 8, verify the bare
   URLs render as clickable links to themselves.

## Automated coverage

`web-search.test.ts` pins the citation policy wording in the tool result and the
bare URL example in the tool description; the existing execute tests cover the
result sections themselves.
