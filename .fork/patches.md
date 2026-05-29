# Fork Patch Manifest

This file records the internal fork changes that exist in `alishu/qwen-code`
but are not part of the upstream `QwenLM/qwen-code` history. It is used as the
audit source for upstream sync reviews: when `upstream/main` is merged into the
fork, these entries should either still be present, be intentionally migrated,
or be explicitly retired because upstream now contains an equivalent change.

## Snapshot

> 由 `scripts/regen-fork-patches.sh --write` 自动维护。修改 SNAPSHOT 区段内容
> 不会被保留，请改脚本而非手改。

<!-- AUTO:SNAPSHOT BEGIN -->

- generated_at: 2026-05-23
- fork_ref: `origin/main`
- fork_head: `c6b168ec0`
- upstream_ref: `upstream/main`
- upstream_head: `0cb9ff0a2`
- patch_base: `cc800d013`
- diff_range: `cc800d013..origin/main`
- first_parent_landing_commits: 48
- patch_bearing_commits: 175

<!-- AUTO:SNAPSHOT END -->

Commands used for this snapshot:

```bash
git fetch origin main
git fetch upstream main --tags
PATCH_BASE_REF=$(git merge-base origin/main upstream/main)
git diff --name-status "$PATCH_BASE_REF..origin/main"
git log --first-parent --reverse --format='%h %s' "$PATCH_BASE_REF..origin/main"
git log --reverse --no-merges --format='%h %s' "$PATCH_BASE_REF..origin/main"
git cherry -v "$PATCH_BASE_REF" origin/main
node .fork/generate-patches.js --write
```

Do not use the current `upstream/main` head directly as the diff base for patch
generation. `patch_base` is the last shared upstream sync point for the fork
main branch; using it avoids mixing future upstream commits into fork patches.

## Maintenance Rules

- Add a new entry after every internal fork MR is merged into `main`.
- Keep `sync` entries for audit context, but do not use them as guard targets.
- Keep `release` entries separate from functional fork changes; version bumps
  can be retired or replaced when the next release bump lands.
- If upstream later contains an equivalent patch, mark the commit as retired
  before deleting it from this manifest.
- During upstream sync, review this file together with the generated sync MR
  diff. Any guard-relevant entry that disappears from the fork must be restored,
  migrated, or explicitly retired in the sync MR description.

## PR/MR Landing Commits

These are the first-parent commits by which internal fork changes landed on
`origin/main`. They are the audit layer for Code Review / MR history.

> 由 `scripts/regen-fork-patches.sh --write` 自动维护。Type 列由 commit subject
> 启发式分类（fork / sync / sync-fix / release / upstream-equivalent）；如需
> 覆盖（如 test、upstream-equivalent），请改脚本中的 `classify_subject()`。

<!-- AUTO:LANDING BEGIN -->

| Commit | Type | CR | Title |
| --- | --- | --- | --- |
| `8c8151af6` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26585259 | feat: customize branding for DataWorks DataAgent |
| `34165d8ec` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26585513 | fix: remove trailing space in header |
| `20b06f215` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26585642 | publish dataworks scope npm |
| `19f048a0d` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26585660 | feat: update ASCII logo for DataWorks branding |
| `f87780bf3` | sync | - | Merge commit '73042e3e68cfb9098e0db1a9af9de26a0cfe1ba7' into 'main' |
| `3a240e41a` | sync | - | Merge commit '9034663bbc7080b85b627029537b6394ea90de89' into 'main' |
| `b57ec053f` | sync | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26819487 | chore: sync upstream QwenLM/qwen-code to latest (399 commits - 0.14.3) |
| `67ee5fc8d` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26767752 | [to #80958901] fix(vscode-ide-companion): unblock test suite (postcss ESM + Storage deep-path mock) |
| `34b328af0` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26837934 | fix(core): fallback after empty stream retries |
| `488ce5444` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26741792 | 恢复部分合并丢失的 qwen-code支持双输出模式 代码 |
| `fc1e209a2` | fork | - | 恢复部分合并丢失的 qwen code cli 代码 |
| `0ce14f9de` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26881335 | 构建 qwen code 打包的二进制脚本 * wip: 构建二进制压缩包 |
| `0b8ed080f` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26843438 | build: add npm publish workflow for CI/CD pipeline |
| `116f798d3` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26889902 | fix(dingtalk): prioritize senderStaffId over senderId and add debug log |
| `ca172b61e` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26907000 | fix(i18n): restore DataWorks input placeholder and usage example tips * fix(i18n): restore DataWorks input placeholder and usage example tips |
| `be2e07469` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26904912 | refactor: clean up bundle-publish branch * chore: bump version to 0.14.6 across multiple package.json files |
| `7f7648125` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26921615 | fix(core): allow thought-only responses in GeminiChat stream   validation * fix(core): auto-continue on mid-stream cut-off; classify empty streams as EMPTY_STREAM |
| `be928ad95` | sync | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26938960 | chore: sync upstream QwenLM/qwen-code to latest (56 commits — 0.14.5) |
| `683d7d7bf` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26940966 | refactor(mcp-oauth): move copy hint directly under the auth URL * feat(mcp): rewrite OAuth redirect URI for DSW proxy environment |
| `405901d78` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26940867 | feat(core): integrate upstream agent features with retry mechanism |
| `98695c409` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26959860 | feat(cli): Add OAuth flags to mcp add command * feat(mcp): rewrite OAuth redirect URI for DSW proxy environment |
| `124cd12bb` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26819585 | style: quote workflow job names and actions for consistency * feat: add feature flags for DataWorks branding and upstream sync automation |
| `4fc49738d` | sync-fix | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26974885 | fix: align StreamJsonOutputAdapter, DingtalkAdapter, WebViewProvider.test with upstream |
| `e3566cb10` | sync-fix | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26741792 | fix: align DualOutputBridge and RemoteInputWatcher with upstream (PR #3352) |
| `99d0ba4cb` | sync-fix | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26974885 | fix: align cli/config.ts and PanelManager.ts with upstream |
| `aeb95e37d` | sync-fix | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26976368 | fix: align gemini.tsx and DualOutputBridge.test.ts with upstream |
| `a7ddd8500` | sync-fix | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26976669 | fix: align mcp/add.test.ts type cast and core/config.ts JSDoc with upstream |
| `a49ee09fa` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26978689 | feat(ui): 在 Header 信息面板中展示当前 model 名称 |
| `0d064548f` | sync | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26977267 | chore: sync upstream QwenLM/qwen-code 2026-04-20 (48 commits, conflicts resolved) |
| `6fccf403b` | fork | https://code.alibaba-inc.com/alishu/opencode/codereview/26975666 | fix(build): bundle i18n locales and extension examples into dist/ |
| `54d3a11d3` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/26996251 | fix(mcp): make the OAuth authorization URL clickable when wrapped * fix(mcp): make the OAuth authorization URL clickable when wrapped |
| `8ed429500` | release | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27016717 | chore(release): bump version to 0.14.7 across all packages * chore(release): bump version to 0.14.7 across all packages |
| `d939701be` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27071384 | refactor: add BFF endpoint logic for OAuth redirect URI generation * refactor: add BFF endpoint logic for OAuth redirect URI generation |
| `91125d478` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27074746 | fix(cli): stabilize startup tip across Static remounts |
| `340070331` | release | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27202215 | chore(release): bump version to 0.14.8 |
| `3ce1b1b8e` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27202180 | test(cli): 精简 CLI 定制测试修复 |
| `7073c3460` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27240813 | test(cli): pre-resolve AppContainer sync conflict |
| `d4cbb7c11` | sync | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27382776 | Merge branch sync/upstream-20260511 into dataworks-20260511 Title: Sync QwenLM/qwen-code main 20260511 |
| `4ca5a58aa` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27384835 | feat(cli): wrap markdown links in OSC 8 so wrapped URLs stay clickable (#4037) * feat(cli): wrap markdown links in OSC 8 so wrapped URLs stay clickable (#4037) |
| `bc3703a37` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27386500 | ⚠️ chore: upstream sync 2026-05-14 (40 commits, 12 conflicts) |
| `bc3152001` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27399741 | 优化发布脚本 * chore(ci): remove deprecated Aone CI pipelines and optimize remaining ones |
| `aa94e5194` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27385182 | fix:update card bug and add stop btn with new module * fix:update card bug and add stop btn with new module |
| `c2bf54e8e` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27413710 | feat: add default OAuth redirect URI builder * feat: add default OAuth redirect URI builder |
| `6b37a472c` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27416044 | fix(cli): restore alishu / internal-deployment OSC 8 signals * fix(cli): restore alishu / internal-deployment OSC 8 signals |
| `498267a86` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27523343 | fix(ci): add always:true to schedule trigger for upstream sync pipeline |
| `f607af2d9` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27524077 | fix: remove built-in web_search tool, align with upstream MCP-based approach |
| `9e4b33fe7` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27532149 | feishu channel * fix(ci): add package scope to standalone artifact |
| `c6b168ec0` | fork | https://code.alibaba-inc.com/alishu/qwen-code/codereview/27524072 | fix(core): extend DashScope provider detection & remove broken remoteInput test |
<!-- AUTO:LANDING END -->

## Patch-Bearing Commit Inventory

These are the non-merge commits reachable from `origin/main` but not from
`upstream/main` at the snapshot above. This is the raw commit inventory used to
avoid losing fork-side patches during upstream sync.

<!-- AUTO:INVENTORY BEGIN -->

```text
2fa50a88c feat: customize branding for DataWorks DataAgent
27a44cbd9 feat: add DataWorks DataAgent branding in header
b8585686a fix: remove trailing space in header
62a2cbaf7 build: update package names and versions for publishing
129f91840 feat: update ASCII logo for DataWorks branding
ae0c47f06 build: bump cli package version to 0.0.3
800506010 docs: add verbose/compact mode implementation plan
64862a9f5 feat: add VerboseModeContext for compact/verbose toggle
1577d4491 feat: add VerboseModeContext for compact/verbose toggle
1d9fc0ec4 feat: add TOGGLE_VERBOSE_MODE command and Ctrl+O key binding
90fe1fbce feat: add ui.verboseMode setting to schema
124d8065b feat: hide tool result display in compact mode
ce4d70be9 feat: hide thinking chain in compact mode
7eddfa4ed feat: wire VerboseModeContext into AppContainer with Ctrl+O toggle and settings persistence
836f8e174 feat: add verbose mode indicator to Footer
c1d22b6dc feat: add i18n keys for verbose/compact mode messages
6d4a8eaeb docs: update Ctrl+O keyboard shortcut description for verbose mode
b7e208d71 docs: add verbose design doc
593abf62e refactor: update verbose mode and docks
b1ed0ab71 build: sync package versions to 0.13.2 and fix repository URLs
791a6b28b refactor: update intl messages
879c6e896 build: bump versions to 0.13.2-dataworks.1
f1ead3634 chore: remove package-lock.json from git tracking (already in .gitignore)
8c566af14 refactor: fix cr comments
f1b34290f build: bump versions to 0.13.2-dataworks.2
0ecd5bd6c docs: capitalize Ctrl+O in settings schema description
b621fe82d feat: dataworks tips
f0a84ee0e feat: powered by
e7f251d3e build: bump versions to 0.13.2-dataworks.3
aa99b2a40 refactor: fix build error
0b25af94e build: bump versions to 0.13.2-dataworks.4
bdbe67c9f refactor: compact tool group display
a159cbc63 ci: puhlish v0.13.2-dataworks.5
f316099e2 refactor: update tips message Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/26675235 * refactor: update tips message
aa41e6000 update message folding style
2a8f3fa75 refactor: update tool call label
8f92fa373 ci: publish v0.13.2-dataworks.6
a72d6fe66 ci: publish v0.13.2-dataworks.6
ca924796d feat: squash merge QwenLM/qwen-code#2525
017b556fc build: bump cli package version to 0.13.2-dataworks.7
9dcb52787 chore(channels): update package names and publish config for dataworks
a54bec143 chore(core,cli): bump version to 0.13.2-dataworks.7/8
9266b3633 feat(vscode-ide-companion): add fastModel config and core dist alias
3e2ab7e92 fix(webui): update types path and add css module declaration
a35c97106 fix(core): filter thinking/reasoning parts from followup suggestion text
8d65b63ac chore(core,cli): bump versions and publish
ef4328ec2 build: bump cli package version to 0.13.2-dataworks.10
1e554bf28 feat(cli): keep user shell commands expanded in compact mode
0d11c073b build: fix build error
286e862b9 fix(core): support dedicated fast model generator and streaming for followup suggestions
eaea0b98f bump cli package version to 0.14.0-dataworks.2
074af7baf feat(core): implement mid-turn queue drain for agent execution
e34d3f270 feat(cli): add mid-turn queue drain to main session
cd212672b fix: address Copilot review feedback on mid-turn drain
2f7792289 refactor: scope mid-turn drain to main session only
92a14fa8f fix: address Copilot review on main session mid-turn drain
bcf44c821 fix: guard mid-turn drain against cancelled turns
725ca9918 fix(permissions): match env-prefixed shell commands against saved permission rules Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/26706519 * fix(permissions): match env-prefixed shell commands
1d7b246b9 build: bump cli package version to 0.14.0-dataworks.4
845f6ef09 feat: delele model show
0fc44d466 refactor: remove unused imports and props in Header component
47a8ec3d2 [to #80958901] fix(cli): get all packages/cli unit tests passing
a5440168a refactor: update copy script path structure and timestamps Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/26744727 * chore(packages): mark docs site and vscode companion private
1d687e21b [to #80958901] fix(core): convert brittle vi.mock factories to importOriginal mode
ff83fd967 fix(cli): cherry-pick verbose/compact mode improvements from QwenLM/qwen-code#2770
1098cec72 【Github DDAR】 feat(cli): add queue input editing via Up arrow key
9e5a2ee57 【Github DDAR】 feat(core): intelligent tool parallelism with Kind-based batching and shell read-only detection
e0841ec0b fix(core): accept partial stream content when finish reason is missing
53e839b1e 【Github DDAR】 feat(core): implement mid-turn queue drain for agent execution
950589ca9 【Github DDAR】 fix(followup): prevent tool call UI leak and Enter accept buffer race
d3873ae00 【Github DDAR】 feat(prompt): add dangerous actions behavior guidance in system prompt
be73fba0e docs(core): add root cause analysis comments to stream validation logic
3afd17382 fix: guard mid-turn drain against cancelled turns Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/26710182 * feat(core): implement mid-turn queue drain for agent execution
8e22c2371 fix: restore verbose/compact mode i18n keys for future use
cfbf53852 feat(core): add retry logic for subagent transient stream errors
f735292f8 qwen-code支持双输出模式 Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/26741792 * chore(packages): mark docs site and vscode companion private
c9216139c fix: remove duplicate imports and exports causing build failure
2b162d5e2 fix(core): increase retry backoff to survive DashScope degradation storms
209a380cf fix(core): increase GeminiChat internal stream retries from 2 to 3
fdfbb51e7 fix(build): fix webui types resolution and eslint no-internal-modules errors
81267f196 fix(build): fix webui types resolution and eslint no-internal-modules errors
73042e3e6 fix(build): fix webui dist/index.d.ts empty export for NodeNext consumers
9ce415280 [to #80958901] fix(core): import ApprovalMode directly to bypass barrel load-order race
b77d4e811 [to #80958901] fix(cli): regenerate Footer/HistoryItemDisplay snapshots after verboseMode default flip
2dc0799ec [to #80958901] fix(vscode-ide-companion): unblock test suite (postcss ESM + Storage deep-path mock)
625c0b376 refactor: enhance release mode logic in copy script
95b00eb56 修复 compact mode 下选择 "Allow always" 后权限不持久化的 bug
7cee461e3 build: switch package dependencies from npm to local file references
e3edf05ef chore: bump package versions to 0.14.2 across multiple packages
9d105025a chore: bump package versions to 0.14.2
4d8a56153 build: update package dependencies to use npm registry instead of file references
accea6aee fix(webui): restore rolled-up type declarations
3ab9f838f fix(core): fallback after empty stream retries
dee9dcecb test: add verification for telemetry events in geminiChat test case
d2c25bb44 fix(build): restore workspace file deps and add lockfile
4a52f3266 refactor: remove unused fs import and cleanup vite config comments
a4c6fb376 refactor(vite.config): remove unused imports and simplify path handling
1f149c764 Revert "refactor(vite.config): remove unused imports and simplify path handling"
a15d8ca88 build: add npm publish workflow for CI/CD pipeline
fde65e74e fix: sync package-lock.json with @alife workspace package names
5540ac3b3 fix: resolve 3 CI test failures and add skip_tests option to publish workflow
e982bd532 ci: rename parameters to
ee428592d ci: update npm publish config parameters format
af7459161 fix: correct skip_tests condition syntax for AoneCI
33ce472f2 fix(sdk): clean up process exit listeners in ProcessTransport tests
a627407ee fix: use shell-level check for skip_tests instead of step if
d1bac6589 ci: comment out test step in npm publish workflow
f632f8f74 build: update package.json workspaces list
a7cde18cc test: remove unnecessary mocks and skips in tests
8351df2f3 build: add publishConfig.registry to all @alife packages
45967da30 build: pass npm token from secrets to npm-publisher
e2fa1f8a6 build: update package names and ci config for publishing
3ac560deb build: update package names and ci config for publishing
a7f362e82 ci: update npm publish config with new token format
68408a72f build: write .npmrc with auth token before npm publish
0729cd353 fix: simplify .npmrc to single line with registry + authToken
77c8ceaf3 ci: update npm publish config with new token format
0ba10b8ec fix: write .npmrc to project directory instead of home
353353a55 ci: enable npm publish token in ci config
87605a317 chore: bump version to 0.14.4 across multiple package.json files
488ce5444 恢复部分合并丢失的 qwen-code支持双输出模式 代码
af8684ce0 ci: update npm publish config for internal registry
5d0b4feaa ci: comment out npm publish trigger branches
fc1e209a2 恢复部分合并丢失的 qwen code cli 代码
0ce14f9de 构建 qwen code 打包的二进制脚本 Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/26881335 * wip: 构建二进制压缩包
b1f64553e fix(dingtalk): prioritize senderStaffId over senderId and add debug log
ca172b61e fix(i18n): restore DataWorks input placeholder and usage example tips Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/26907000 * fix(i18n): restore DataWorks input placeholder and usage example tips
be2e07469 refactor: clean up bundle-publish branch Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/26904912 * chore: bump version to 0.14.6 across multiple package.json files
7f7648125 fix(core): allow thought-only responses in GeminiChat stream   validation Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/26921615 * fix(core): auto-continue on mid-stream cut-off; classify empty streams as EMPTY_STREAM
a8f9a4f3e feat(subagents): propagate approval mode to sub-agents (#3066)
f33e231c0 feat(core): implement fork subagent for context sharing (#2936)
5274e8e07 fix(core): add retry mechanism for subagent stream errors + retryNote
683d7d7bf refactor(mcp-oauth): move copy hint directly under the auth URL Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/26940966 * feat(mcp): rewrite OAuth redirect URI for DSW proxy environment
98695c409 feat(cli): Add OAuth flags to mcp add command Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/26959860 * feat(mcp): rewrite OAuth redirect URI for DSW proxy environment
124cd12bb style: quote workflow job names and actions for consistency Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/26819585 * feat: add feature flags for DataWorks branding and upstream sync automation
4fc49738d fix: align StreamJsonOutputAdapter, DingtalkAdapter, WebViewProvider.test with upstream
e3566cb10 fix: align DualOutputBridge and RemoteInputWatcher with upstream (PR #3352)
99d0ba4cb fix: align cli/config.ts and PanelManager.ts with upstream
aeb95e37d fix: align gemini.tsx and DualOutputBridge.test.ts with upstream
a7ddd8500 fix: align mcp/add.test.ts type cast and core/config.ts JSDoc with upstream
a49ee09fa feat(ui): 在 Header 信息面板中展示当前 model 名称
6fccf403b fix(build): bundle i18n locales and extension examples into dist/
54d3a11d3 fix(mcp): make the OAuth authorization URL clickable when wrapped Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/26996251 * fix(mcp): make the OAuth authorization URL clickable when wrapped
8ed429500 chore(release): bump version to 0.14.7 across all packages Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/27016717 * chore(release): bump version to 0.14.7 across all packages
d939701be refactor: add BFF endpoint logic for OAuth redirect URI generation Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/27071384 * refactor: add BFF endpoint logic for OAuth redirect URI generation
91125d478 fix(cli): stabilize startup tip across Static remounts
340070331 chore(release): bump version to 0.14.8
3ce1b1b8e test(cli): 精简 CLI 定制测试修复
7073c3460 test(cli): pre-resolve AppContainer sync conflict
b71663197 fix(cli): validate model slash command arguments Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/27270879 * fix(cli): validate model slash command arguments
ffebdd3a8 fix(cli): unfreeze Ctrl+O compact-mode toggle on long conversations
369af25d3 Merge branch 'dataworks-20260508' of gitlab.alibaba-inc.com:alishu/qwen-code into feat/test-release Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/27272361 * fix(ci): 修复上游同步合并中的历史追溯和定制校验问题
40f349f8b fix(core): restore internal web search tool glue
be160f699 fix(cli): stabilize remote input bridge tests
cecd29374 test(cli): stabilize auth and theme CI tests
7f474d83d test(core): avoid cold import timeout in skill activation
279f76bf7 fix(build): restore dataworks npm publish metadata
6db7947a4 ci: update OSS endpoint and bucket config
ffa135639 ci: update oss secrets in ci workflows
74325e428 ci: remove oss upload smoke workflow
fc3bb356b fix(ci): publish qwen oss channel metadata
4a2524062 fix:put ding talk card
ab0edd331 fix(cli): restore DataWorks DataAgent branding lost during upstream sync
07246a1bd fix(cli): restore DataWorks tips and i18n translations lost during upstream sync
1b9d1b288 fix(cli): prioritize DataWorks tips over qwen-code native tips
f4b624da1 fix(cli): fix failing test assertions for DataWorks branding
4ca5a58aa feat(cli): wrap markdown links in OSC 8 so wrapped URLs stay clickable (#4037) Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/27384835 * feat(cli): wrap markdown links in OSC 8 so wrapped URLs stay clickable (#4037)
bc3152001 优化发布脚本 Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/27399741 * chore(ci): remove deprecated Aone CI pipelines and optimize remaining ones
aa94e5194 fix:update card bug and add stop btn with new module Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/27385182 * fix:update card bug and add stop btn with new module
c2bf54e8e feat: add default OAuth redirect URI builder Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/27413710 * feat: add default OAuth redirect URI builder
6b37a472c fix(cli): restore alishu / internal-deployment OSC 8 signals Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/27416044 * fix(cli): restore alishu / internal-deployment OSC 8 signals
498267a86 fix(ci): add always:true to schedule trigger for upstream sync pipeline
f607af2d9 fix: remove built-in web_search tool, align with upstream MCP-based approach
9e4b33fe7 feishu channel Link: https://code.alibaba-inc.com/alishu/qwen-code/codereview/27532149 * fix(ci): add package scope to standalone artifact
c6b168ec0 fix(core): extend DashScope provider detection & remove broken remoteInput test
```

<!-- AUTO:INVENTORY END -->
