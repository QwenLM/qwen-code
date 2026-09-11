# Web search source titles

## Baseline

No global `qwen` is installed on the verification host, so the baseline is a
local build of `main` (`2f426a64f4`) run with an isolated `HOME` whose
`settings.json` declares only a ModelStudio Token Plan `modelProviders` entry
and no `tools.webSearch`. On that build the `web_search` tool result lists every
opened page and candidate as a bare `- <url>` line.

## Manual check

1. With the same isolated `HOME`, run
   `qwen -p "Search the web for the current Node.js Active LTS version, then answer with sources." --approval-mode yolo --output-format stream-json`.
2. Open the newest `~/.qwen/projects/*/chats/*.jsonl` and find the `web_search`
   `functionResponse`.
3. Verify the narration at the top is unmodified and opens with the search
   agent's own `Sources:` list.
4. Verify that pages named in that list whose title and URL are usable as a
   link are listed as `- [title](url)`, that every other page is listed as
   `- <url>`, and that no page appears in both page lists.
5. Verify the model's final answer cites those pages with the same titles.
6. Repeat with
   `Search the web for the orbital period of Mercury (planet) on Wikipedia, then answer with sources.`
   and verify parenthesized Wikipedia URLs render as links such as
   `- [Mercury (planet)](https://en.wikipedia.org/wiki/Mercury_(planet))`.

## Automated coverage

`web-search-dashscope.test.ts` covers `sourceKey` identity rules and every
`readSideModelTitles` rule, including code fences, unbulleted entries, untitled
entries, unreturned URLs, cleaning, and adversarial-length lines.
`web-search.test.ts` covers titled rendering with the narration unchanged,
response titles and precedence, no titles from salvaged extractor text,
de-duplication across tiers, link-text sanitizing, destination-naming titles,
parenthesized URLs, and truncation; the existing execute tests pass unchanged.
