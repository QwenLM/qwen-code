# Export Collapsible Tool Output

## Scope

Verify that long shell output and long `think` tool content keep their full
text in the shared WebUI while remaining collapsed by default. This covers the
HTML export viewer and the other consumers of `@qwen-code/webui`.

## Baseline

A released global `qwen` executable was not available in this environment, so
the before-change `/export` dry-run could not be performed. Source inspection
on `upstream/main` reproduces the loss: `ShellToolCall` and `ThinkToolCall`
replace content after 500 characters with an ellipsis.

## Manual Scenario

1. Export a session containing a successful Bash or Execute tool call whose
   output is longer than 500 characters and ends with a unique marker.
2. Open the exported HTML and find the tool call.
3. Confirm the output is collapsed and has a `Show more` control.
4. Expand it and confirm the unique tail marker is visible, then collapse it
   again.
5. Repeat with a `think` tool call longer than 500 characters.

## Regression Checks

- Content of exactly 500 characters has no new toggle.
- Both Bash and Execute variants preserve the full output.
- A long single-line Shell result remains horizontally scrollable after it is
  expanded.
- A collapsible Shell result does not widen the enclosing message container,
  and its toggle remains inside the visible message bounds.
- Clicking a shell toggle does not invoke the surrounding OUT-row action.
- Clicking the shell OUT row still opens the complete output.
- Error, empty-output, and short-thinking paths remain unchanged.
- Toggle buttons expose their expanded state to assistive technology.

## Automated Verification

```bash
cd packages/webui
npx vitest run \
  src/components/toolcalls/shared/CollapsibleOutput.test.tsx \
  src/components/toolcalls/GenericToolCall.test.tsx \
  src/components/toolcalls/ShellToolCall.test.tsx \
  src/components/toolcalls/ThinkToolCall.test.tsx
npm test
npm run typecheck
npm run lint
npm run build

cd ../sdk-typescript
npm run build

cd ../web-shell
npm run lint
npm run typecheck
npm run test:e2e:smoke
```

## Results

- Failure-first run: 3 long-output cases failed because their tail markers
  were absent; the 500-character boundary and short-thinking cases passed.
- Focused component regression run: 4 files and 9 tests passed.
- Failure-first Playwright run: both Bash and Execute failed because their
  output boxes expanded to roughly 5.7k pixels, leaving no internal horizontal
  overflow to scroll.
- Post-fix Playwright run: both Bash and Execute passed in real Chromium. The
  output scroll width exceeds its client width in collapsed and expanded
  states, the enclosing message has no horizontal overflow, the toggle remains
  visible, and the output accepts a non-zero horizontal scroll position.
- Full web-shell Playwright smoke run: 26 tests passed, including both new
  WebUI layout cases.
- Full WebUI run: 31 files and 400 tests passed with Node.js 24.
- WebUI lint, typecheck, and production build passed.
- Web-shell lint and typecheck passed; the latter was run after generating the
  SDK declarations required by that package. All changed files pass Prettier.
- A normal local `/export` smoke test was not used as proof because the
  generated page loads the published WebUI package from unpkg rather than the
  worktree bundle. Component tests and the local WebUI build cover this change
  until a release build is available for the manual scenario.
