# PR 8607 — runtime validation figures

Evidence for https://github.com/QwenLM/qwen-code/pull/8607
(`fix(core): include full filePath alongside fileName in edit/write-file diff results`).

Both arms are real builds of the PR head worktree: **AFTER** = PR head
(`983ff5e276`), **BEFORE** = the same head with only the 9 production files
reverted to the merge base (`413b6d15d3`), rebuilt through
`npm run build --workspace core|acp-bridge` + `npm run bundle`.

| figure | what it shows |
| --- | --- |
| `fig1-acp-wire-ab.png` | `content[].type="diff"` paths captured off a live `qwen --acp` JSON-RPC wire; permission-request vs result inconsistency on the base build; the 4-way `session/load` replay matrix; what lands in the persisted session JSONL |
| `fig2-file-link-ab.png` | the same two real sessions rendered by the shipped `@qwen-code/webui` `ChatViewer` in headless Chromium, with the file link clicked in each pane |
| `fig3-companion-openfile.png` | the shipped `FileMessageHandler.handleOpenFile()` from `packages/vscode-ide-companion`, driven with each arm's wire path |
| `fig4-mutation-teeth.png` | one PR hunk reverted per run, against the suite that should catch it |
