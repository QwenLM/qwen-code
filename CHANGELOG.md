# Changelog

All notable changes to [Qwen Code](https://github.com/QwenLM/qwen-code) are
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Only stable releases
are listed; nightly and preview pre-releases are intentionally omitted.

> **This file is generated automatically** from
> [GitHub Releases](https://github.com/QwenLM/qwen-code/releases). Do not edit it
> by hand — run `npm run changelog` to regenerate.

## [0.18.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.18.0) - 2026-06-12

### Added

- installer: verify release assets + switch public docs to standalone entrypoint ([#3855](https://github.com/QwenLM/qwen-code/pull/3855))
- ci: add @qwen /triage workflow for automated issue and PR triage ([#4768](https://github.com/QwenLM/qwen-code/pull/4768))
- cli: add standalone auto-update support ([#4629](https://github.com/QwenLM/qwen-code/pull/4629))
- telemetry: Phase 4b — retry visibility for qwen-code.llm_request (#3731) ([#4432](https://github.com/QwenLM/qwen-code/pull/4432))
- core: add user prompt expansion hooks ([#4377](https://github.com/QwenLM/qwen-code/pull/4377))
- telemetry: Phase 3 — qwen-code.subagent span with concurrent isolation (#3731) ([#4410](https://github.com/QwenLM/qwen-code/pull/4410))
- skills: /skills picker dialog — browse, search, toggle, pick (#4532) ([#4533](https://github.com/QwenLM/qwen-code/pull/4533))
- cli: enable /remember, /forget, /dream in ACP mode ([#4811](https://github.com/QwenLM/qwen-code/pull/4811))
- vscode: surface ACP background notifications ([#4358](https://github.com/QwenLM/qwen-code/pull/4358))
- cli: support /copy N to copy Nth-last AI message ([#4761](https://github.com/QwenLM/qwen-code/pull/4761))
- cli: prevent system sleep while running ([#4434](https://github.com/QwenLM/qwen-code/pull/4434))
- ci: add PR review workflow using bundled /review skill ([#4549](https://github.com/QwenLM/qwen-code/pull/4549))
- cli: add /fork background-agent command ([#4780](https://github.com/QwenLM/qwen-code/pull/4780))
- core: honor skill allowedTools by auto-approving declared tools ([#4704](https://github.com/QwenLM/qwen-code/pull/4704))
- skills: enforce auto-skill- directory prefix for auto-generated skills ([#4839](https://github.com/QwenLM/qwen-code/pull/4839))
- memory: add user-level auto-memory at ~/.qwen/memories/ (#4747) ([#4764](https://github.com/QwenLM/qwen-code/pull/4764))
- acp: support desktop qwen integration ([#4728](https://github.com/QwenLM/qwen-code/pull/4728))
- extension: add description field to ExtensionConfig ([#4857](https://github.com/QwenLM/qwen-code/pull/4857))
- telemetry: inject TRACEPARENT env var into shell child processes ([#4906](https://github.com/QwenLM/qwen-code/pull/4906))
- hooks: support terminal sequence notifications ([#4895](https://github.com/QwenLM/qwen-code/pull/4895))
- core: Workflow tool P1 — minimal node:vm sandbox + sequential agent() (#4721) ([#4732](https://github.com/QwenLM/qwen-code/pull/4732))
- ci: add auto-generated CHANGELOG.md synced from releases (#4872) ([#4881](https://github.com/QwenLM/qwen-code/pull/4881))
- stats: add interactive /stats dashboard with cross-session tracking ([#4779](https://github.com/QwenLM/qwen-code/pull/4779))
- core: enable loop/cron tools by default ([#4950](https://github.com/QwenLM/qwen-code/pull/4950))
- core: declarative agent frontmatter v1 — permissionMode bridge + maxTurns wiring + color allowlist (CC 2.1.168 parity) ([#4842](https://github.com/QwenLM/qwen-code/pull/4842))
- add Agent Team experimental feature for parallel sub-agent coordination ([#4844](https://github.com/QwenLM/qwen-code/pull/4844))
- desktop: Add desktop app package with Qwen ACP SDK integration ([#3778](https://github.com/QwenLM/qwen-code/pull/3778))
- daemon: merge daemon-mode feature batch into main ([#4490](https://github.com/QwenLM/qwen-code/pull/4490))
- core: layered tool-output truncation, per-message budget, per-tool limits ([#4880](https://github.com/QwenLM/qwen-code/pull/4880))
- telemetry: add runtime memory/CPU sampling with OTel metric reporting ([#4868](https://github.com/QwenLM/qwen-code/pull/4868))
- cli: add /compress-fast command for no-LLM rule-based context compression ([#4893](https://github.com/QwenLM/qwen-code/pull/4893))
- web-shell: add Option+Enter and Cmd+Enter newline shortcuts ([#5005](https://github.com/QwenLM/qwen-code/pull/5005))
- core: persist file history snapshots for cross-session /rewind (T2.1) ([#4897](https://github.com/QwenLM/qwen-code/pull/4897))
- core: port declarative-agent mcpServers + hooks (CC 2.1.168 parity follow-up) ([#4996](https://github.com/QwenLM/qwen-code/pull/4996))
- core: Workflow P2 — parallel() + pipeline() concurrent fan-out (#4721) ([#4947](https://github.com/QwenLM/qwen-code/pull/4947))
- core: add enter_plan_mode tool and Plan Approval Gate ([#4853](https://github.com/QwenLM/qwen-code/pull/4853))
- acp: broadcast session title updates to daemon clients ([#5035](https://github.com/QwenLM/qwen-code/pull/5035))

### Changed

- core: remove GitService, migrate /restore to FileHistoryService ([#4871](https://github.com/QwenLM/qwen-code/pull/4871))
- skills: remove redundant commands and sync e2e-testing skill ([#4992](https://github.com/QwenLM/qwen-code/pull/4992))

### Fixed

- cli: skip thought parts in copy output ([#4738](https://github.com/QwenLM/qwen-code/pull/4738))
- cli: Improve approval mode display text ([#4753](https://github.com/QwenLM/qwen-code/pull/4753))
- ui: display model name instead of id in statusline and startup banner ([#4741](https://github.com/QwenLM/qwen-code/pull/4741))
- ci: fix triage prompt variable expansion, bot identity, and model secret ([#4778](https://github.com/QwenLM/qwen-code/pull/4778))
- computer-use: auto-approve install in auto-approve modes (YOLO/AUTO_EDIT/AUTO) ([#4756](https://github.com/QwenLM/qwen-code/pull/4756))
- cli: implement --list-extensions flag handler (#4450) ([#4456](https://github.com/QwenLM/qwen-code/pull/4456))
- core: handle error variant in disabled skill command delegation ([#4804](https://github.com/QwenLM/qwen-code/pull/4804))
- cli: remove dead --list-extensions handler from #4456 ([#4800](https://github.com/QwenLM/qwen-code/pull/4800))
- core: recurse into submodule files when crawling git repos ([#4596](https://github.com/QwenLM/qwen-code/pull/4596))
- clipboard: use platform-native tools for image paste on Linux ([#4647](https://github.com/QwenLM/qwen-code/pull/4647))
- core: add multimodal support for qwen3.7-plus ([#4803](https://github.com/QwenLM/qwen-code/pull/4803))
- core: scope boolean coercion to boolean-typed schema fields ([#4618](https://github.com/QwenLM/qwen-code/pull/4618))
- cli: bundle extension examples ([#4719](https://github.com/QwenLM/qwen-code/pull/4719))
- cli: fix vim mode Esc leak, Enter submit, render lag and implement missing VIM commands ([#4677](https://github.com/QwenLM/qwen-code/pull/4677))
- core: allow intentional foreground sleep for backoff ([#4708](https://github.com/QwenLM/qwen-code/pull/4708))
- core: honor runtime output dir for auto memory ([#4715](https://github.com/QwenLM/qwen-code/pull/4715))
- tui: skip cross-group tool merge in <Static> mode to eliminate screen flash ([#4795](https://github.com/QwenLM/qwen-code/pull/4795))
- cli: prevent selection dialog flicker ([#4755](https://github.com/QwenLM/qwen-code/pull/4755))
- core: inject current date on every user query to prevent stale date ([#4798](https://github.com/QwenLM/qwen-code/pull/4798))
- ci: coordinate qwen triage and review automation ([#4570](https://github.com/QwenLM/qwen-code/pull/4570))
- core: add missing closing braces in formatDateForContext test block ([#4863](https://github.com/QwenLM/qwen-code/pull/4863))
- core: prevent OOM by compacting API history, UI history, and triggering under memory pressure ([#4824](https://github.com/QwenLM/qwen-code/pull/4824))
- core: don't kill a failed-spawn sleep inhibitor child (sandbox abort on tool use) ([#4865](https://github.com/QwenLM/qwen-code/pull/4865))
- skills: add bundled skill doc-index validation to docs skills ([#4851](https://github.com/QwenLM/qwen-code/pull/4851))
- sdk: correct npm package name in SDK install instructions ([#4860](https://github.com/QwenLM/qwen-code/pull/4860))
- strip runtime snapshot prefix before persisting model.name ([#4734](https://github.com/QwenLM/qwen-code/pull/4734))
- cli: handle background auto-update breaking cross-authType model switching ([#4760](https://github.com/QwenLM/qwen-code/pull/4760))
- core: preserve shared baseUrl on auth refresh ([#4828](https://github.com/QwenLM/qwen-code/pull/4828))
- ci: acknowledge queued qwen review requests ([#4847](https://github.com/QwenLM/qwen-code/pull/4847))
- core: fix qc-helper skill docs index and config categories ([#4848](https://github.com/QwenLM/qwen-code/pull/4848))
- ci: normalize dev launcher path assertions on Windows ([#4915](https://github.com/QwenLM/qwen-code/pull/4915))
- installer: correct broken (404) 'for more info' URL in post-install message ([#4916](https://github.com/QwenLM/qwen-code/pull/4916))
- core: isolate OpenAI SDK abort listener leak with per-request child controllers ([#4810](https://github.com/QwenLM/qwen-code/pull/4810))
- acp: prevent session/prompt hang when client ignores mid-turn drain requests ([#4925](https://github.com/QwenLM/qwen-code/pull/4925))
- core: remove greeting-responder example from agent tool prompt ([#4923](https://github.com/QwenLM/qwen-code/pull/4923))
- core: remove `env` from read-only shell command allowlist ([#4932](https://github.com/QwenLM/qwen-code/pull/4932))
- core: prevent cron scheduler from firing on creation minute ([#4946](https://github.com/QwenLM/qwen-code/pull/4946))
- core: ensure hard threshold always exceeds auto threshold ([#4949](https://github.com/QwenLM/qwen-code/pull/4949))
- installer: auto-detect SYSTEM account and default PATH scope to machine ([#4903](https://github.com/QwenLM/qwen-code/pull/4903))
- skills: use full YAML parser for frontmatter to support block scalars ([#4870](https://github.com/QwenLM/qwen-code/pull/4870))
- core: give complete intentional-sleep guidance on first rejection for sleep chains ([#4948](https://github.com/QwenLM/qwen-code/pull/4948))
- core: add qwen3.7-plus to Coding Plan model list ([#4953](https://github.com/QwenLM/qwen-code/pull/4953))
- openai: default splitToolMedia so tool-returned images reach strict OpenAI-compatible backends ([#4917](https://github.com/QwenLM/qwen-code/pull/4917))
- cli: fix cursor left-move stalling at hard-wrapped line boundary ([#4852](https://github.com/QwenLM/qwen-code/pull/4852))
- core: microcompact hook continuations ([#4840](https://github.com/QwenLM/qwen-code/pull/4840))
- core: preserve teammate identity when resuming a tool call after approval ([#4979](https://github.com/QwenLM/qwen-code/pull/4979))
- installer: print shell reload hint when new qwen is not picked up ([#4960](https://github.com/QwenLM/qwen-code/pull/4960))
- auth: time out Qwen OAuth refresh ([#4829](https://github.com/QwenLM/qwen-code/pull/4829))
- cli: route down-arrow straight to the live agent panel (#4907) ([#4911](https://github.com/QwenLM/qwen-code/pull/4911))
- core: harden experimental agent-team messaging ([#4988](https://github.com/QwenLM/qwen-code/pull/4988))
- cli: enable VP scroll at idle prompt and fix viewport height ([#4959](https://github.com/QwenLM/qwen-code/pull/4959))
- core: parse comma-separated tools/disallowedTools in agent frontmatter ([#4935](https://github.com/QwenLM/qwen-code/pull/4935))
- cli: make extensions new work when bundled examples are missing ([#5009](https://github.com/QwenLM/qwen-code/pull/5009))
- goal: persist iteration count across resume so MAX_GOAL_ITERATIONS bounds the whole session ([#5000](https://github.com/QwenLM/qwen-code/pull/5000))
- desktop: keep composer sendable after idle escape ([#4788](https://github.com/QwenLM/qwen-code/pull/4788))
- cli: avoid headless browser open crashes ([#4716](https://github.com/QwenLM/qwen-code/pull/4716))
- cli: debounce resize repaint and clear stale scrollback on settle ([#4919](https://github.com/QwenLM/qwen-code/pull/4919))
- core: add Tool Fallback rule to system prompt ([#4931](https://github.com/QwenLM/qwen-code/pull/4931))
- docs: correct stale settings keys, wrong defaults, and missing commands ([#4969](https://github.com/QwenLM/qwen-code/pull/4969))
- core: stabilize truncated tool retry keys ([#4970](https://github.com/QwenLM/qwen-code/pull/4970))
- core: stabilize prompt-cache prefix against MCP/skills churn ([#4896](https://github.com/QwenLM/qwen-code/pull/4896))
- core: fix Windows startup error caused by missing printf command ([#5012](https://github.com/QwenLM/qwen-code/pull/5012))
- desktop: allow unsigned Windows auto-updates ([#5028](https://github.com/QwenLM/qwen-code/pull/5028))
- cli: join previous line when Ctrl+U pressed at column 0 ([#5011](https://github.com/QwenLM/qwen-code/pull/5011))
- tui: Tighten message and tool spacing ([#4595](https://github.com/QwenLM/qwen-code/pull/4595))
- core: serialize team task claims per agent and add mailbox lock parity ([#4981](https://github.com/QwenLM/qwen-code/pull/4981))
- core: support .toml command files in extension command discovery ([#5017](https://github.com/QwenLM/qwen-code/pull/5017))
- stats: dedup usage records by sessionId and skip in-progress writes ([#4995](https://github.com/QwenLM/qwen-code/pull/4995))
- test: unbreak qwen serve integration suites after the daemon batch merge ([#5041](https://github.com/QwenLM/qwen-code/pull/5041))
- release: allow fzfWorker.js in standalone dist allowlist ([#5049](https://github.com/QwenLM/qwen-code/pull/5049))

### Performance

- filesearch: move AsyncFzf index construction to a worker thread ([#4621](https://github.com/QwenLM/qwen-code/pull/4621))
- desktop: add --cli-only flag to skip non-CLI packages during vendor build ([#5025](https://github.com/QwenLM/qwen-code/pull/5025))

### Documentation

- desktop: use main for brand builder skill ([#5021](https://github.com/QwenLM/qwen-code/pull/5021))

### Other

- ci(triage): Fix Qwen triage workflow prompt ([#4787](https://github.com/QwenLM/qwen-code/pull/4787))
- Revert "feat(cli): enable /remember, /forget, /dream in ACP mode" ([#4818](https://github.com/QwenLM/qwen-code/pull/4818))
- Harden auto mode self-modification checks ([#4572](https://github.com/QwenLM/qwen-code/pull/4572))
- Move startup context into system reminders ([#4053](https://github.com/QwenLM/qwen-code/pull/4053))
- Add InstructionsLoaded hook for instruction file loading ([#4665](https://github.com/QwenLM/qwen-code/pull/4665))
- Align automated PR review with bundled skill ([#4843](https://github.com/QwenLM/qwen-code/pull/4843))
- test(integration): drop tight 30s timeout in sleep-interception e2e tests ([#4878](https://github.com/QwenLM/qwen-code/pull/4878))
- test: cover rewind selector restore options ([#4784](https://github.com/QwenLM/qwen-code/pull/4784))
- ci: extend qwen PR review timeout to 90min and queue delay to 30min ([#4962](https://github.com/QwenLM/qwen-code/pull/4962))
- test: cover rewind selector fallback states ([#4905](https://github.com/QwenLM/qwen-code/pull/4905))
- test(integration): harden flaky sleep-interception e2e against skipped tool calls ([#4936](https://github.com/QwenLM/qwen-code/pull/4936))
- Fix release workspace test failures ([#4980](https://github.com/QwenLM/qwen-code/pull/4980))
- chore(daemon): remove dead code and simplify control flow ([#4789](https://github.com/QwenLM/qwen-code/pull/4789))
- Add /cd command ([#4890](https://github.com/QwenLM/qwen-code/pull/4890))
- ci(desktop): mac code-signing + App Store Connect API-key notarization ([#5013](https://github.com/QwenLM/qwen-code/pull/5013))
- test(i18n): raise timeout for slow must-translate locale suites on Windows CI ([#5024](https://github.com/QwenLM/qwen-code/pull/5024))

## [0.17.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.17.1) - 2026-06-03

### Added

- core: add memory pressure monitor ([#4403](https://github.com/QwenLM/qwen-code/pull/4403))
- cli: Add settings JSON corrupted warning dialog ([#4560](https://github.com/QwenLM/qwen-code/pull/4560))
- cli: add respectUserColors and hideContextIndicator options for statusline ([#4670](https://github.com/QwenLM/qwen-code/pull/4670))
- cli: notify when background shells finish ([#4355](https://github.com/QwenLM/qwen-code/pull/4355))
- core: add simplify bundled skill ([#3570](https://github.com/QwenLM/qwen-code/pull/3570))
- skills: add agent reproduction workflows ([#4118](https://github.com/QwenLM/qwen-code/pull/4118))
- cli: virtual viewport for long conversations on ink 7 ([#4146](https://github.com/QwenLM/qwen-code/pull/4146))
- cli: background housekeeping for stale file-history dirs ([#4414](https://github.com/QwenLM/qwen-code/pull/4414))
- core: inject context env vars (session/agent/prompt ID) into shell subprocesses ([#4649](https://github.com/QwenLM/qwen-code/pull/4649))
- core: auto-dump memory diagnostics to disk on pressure detection ([#4654](https://github.com/QwenLM/qwen-code/pull/4654))
- core: atomic write rollout for credentials, memory, config, JSONL (closes #3681, #4095 Phase 2) ([#4333](https://github.com/QwenLM/qwen-code/pull/4333))
- cli: Add searchable MiniMax-M3 model setup ([#4668](https://github.com/QwenLM/qwen-code/pull/4668))
- core,cli: auto-compact follow-up — /compress instructions, PreCompact hook plumb, plan/subagent attachments ([#4688](https://github.com/QwenLM/qwen-code/pull/4688))
- input: move physical cursor to visual cursor for IME input ([#4652](https://github.com/QwenLM/qwen-code/pull/4652))
- core: add post tool batch hooks ([#4454](https://github.com/QwenLM/qwen-code/pull/4454))
- prompt: deduplicate tool guidance between system prompt and tool descriptions ([#4569](https://github.com/QwenLM/qwen-code/pull/4569))
- cli: add CPU profiling support for Chrome DevTools analysis ([#4620](https://github.com/QwenLM/qwen-code/pull/4620))
- prompt: enhance system prompts with global reasoning discipline and iterative planning ([#4436](https://github.com/QwenLM/qwen-code/pull/4436))
- subagent: add fork subagent feature gate and "Don't peek / Don't race" prompt discipline ([#4574](https://github.com/QwenLM/qwen-code/pull/4574))
- core: strengthen system prompts for reading code before editing, dedicated tool priority, and step-by-step communication ([#4375](https://github.com/QwenLM/qwen-code/pull/4375))
- skills: add triage skill for issue/PR gatekeeping ([#4577](https://github.com/QwenLM/qwen-code/pull/4577))
- computer-use: use @qwen-code/open-computer-use fork (signed + notarized) ([#4726](https://github.com/QwenLM/qwen-code/pull/4726))

### Changed

- cli: rename "Default" approval mode to "Ask permissions" (#4625) ([#4674](https://github.com/QwenLM/qwen-code/pull/4674))

### Fixed

- rewind: false "compressed turn" error when mid-turn messages exist ([#4580](https://github.com/QwenLM/qwen-code/pull/4580))
- core: emit enable_thinking on DashScope when reasoning is disabled ([#4505](https://github.com/QwenLM/qwen-code/pull/4505))
- core: surface Anthropic empty stream provider errors ([#4540](https://github.com/QwenLM/qwen-code/pull/4540))
- core: guard oversized resumed history sends ([#4531](https://github.com/QwenLM/qwen-code/pull/4531))
- cli: stabilize statusline preset ordering ([#4634](https://github.com/QwenLM/qwen-code/pull/4634))
- config: load home .env vars before settings ${VAR} resolution (#4466) ([#4474](https://github.com/QwenLM/qwen-code/pull/4474))
- acp: drop discontinued Qwen OAuth method ([#4639](https://github.com/QwenLM/qwen-code/pull/4639))
- core: enforce adjacent tool results ([#4622](https://github.com/QwenLM/qwen-code/pull/4622))
- cli: hide completed sticky todos ([#4635](https://github.com/QwenLM/qwen-code/pull/4635))
- core: harden context error text collection ([#4632](https://github.com/QwenLM/qwen-code/pull/4632))
- core: apply output language to side queries ([#4636](https://github.com/QwenLM/qwen-code/pull/4636))
- cli: persist /memory toggle state across dialog reopen ([#4650](https://github.com/QwenLM/qwen-code/pull/4650))
- docs: Hide internal docs from docs site ([#4357](https://github.com/QwenLM/qwen-code/pull/4357))
- core: preserve uid in atomicWriteFile to avoid breaking shared-write files ([#4431](https://github.com/QwenLM/qwen-code/pull/4431))
- cli: use session channel when closing ACP sessions ([#4522](https://github.com/QwenLM/qwen-code/pull/4522))
- core,cli: replace full-history structuredClone with shallow/tail variants to prevent OOM on resume ([#4644](https://github.com/QwenLM/qwen-code/pull/4644))
- core: tolerate unsupported Streamable HTTP GET SSE ([#4521](https://github.com/QwenLM/qwen-code/pull/4521))
- insight: Harden insight facet normalization and empty qualitative handling ([#3557](https://github.com/QwenLM/qwen-code/pull/3557))
- core: loosen auto-mode classifier timeouts, disable stage-2 thinking ([#4680](https://github.com/QwenLM/qwen-code/pull/4680))
- core: coerce hostile-provider usage token counts (#4350 part 1) ([#4439](https://github.com/QwenLM/qwen-code/pull/4439))
- cli: honor list extensions flag ([#4673](https://github.com/QwenLM/qwen-code/pull/4673))
- ui: distinguish auto approval mode indicators ([#4600](https://github.com/QwenLM/qwen-code/pull/4600))
- core: disable undici 300s bodyTimeout for no-proxy Node.js path ([#4605](https://github.com/QwenLM/qwen-code/pull/4605))
- cli: suppress completion menu for history-restored text until edited ([#4558](https://github.com/QwenLM/qwen-code/pull/4558))
- cli: statusline not re-rendering when switching from preset to command type ([#4706](https://github.com/QwenLM/qwen-code/pull/4706))
- cli: avoid exit-time history deep clones ([#4717](https://github.com/QwenLM/qwen-code/pull/4717))
- telemetry: clear span dedup state after chat compression (#3731) ([#4660](https://github.com/QwenLM/qwen-code/pull/4660))
- core: remove proactive subagent system-reminder injection ([#4587](https://github.com/QwenLM/qwen-code/pull/4587))
- cli: fix Space key not working in Arena model selection dialog ([#4701](https://github.com/QwenLM/qwen-code/pull/4701))

### Documentation

- add /diff command and auto theme detection documentation ([#4699](https://github.com/QwenLM/qwen-code/pull/4699))

### Other

- Improve hooks matcher display ([#4545](https://github.com/QwenLM/qwen-code/pull/4545))
- Add AUTO mode denial observability and caps ([#4476](https://github.com/QwenLM/qwen-code/pull/4476))
- chore(deps): update @google/genai from 1.30.0 to 2.6.0 ([#4485](https://github.com/QwenLM/qwen-code/pull/4485))

## [0.17.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.17.0) - 2026-05-29

### Added

- channels: add Feishu (Lark) channel adapter ([#4379](https://github.com/QwenLM/qwen-code/pull/4379))
- telemetry: foundation for skill-based RT optimization (P0+P1) ([#4565](https://github.com/QwenLM/qwen-code/pull/4565))
- computer-use: zero-config built-in via open-computer-use MCP ([#4590](https://github.com/QwenLM/qwen-code/pull/4590))

### Changed

- **BREAKING** core: replace tail-preservation compaction with summary + restoration attachments ([#4599](https://github.com/QwenLM/qwen-code/pull/4599))

### Fixed

- cli: surface startup warnings on stderr before TUI render (#4448) ([#4461](https://github.com/QwenLM/qwen-code/pull/4461))
- telemetry: improve LogToSpan bridge error info and TUI handling ([#4482](https://github.com/QwenLM/qwen-code/pull/4482))
- cli: track model-sent slash command history ([#3826](https://github.com/QwenLM/qwen-code/pull/3826))
- core: use undici fetch for IDE proxy requests ([#4607](https://github.com/QwenLM/qwen-code/pull/4607))
- core,cli: label screenshot-triggered compaction accurately in the auto-compact notice ([#4623](https://github.com/QwenLM/qwen-code/pull/4623))

### Other

- Emit PermissionDenied hooks for AUTO classifier blocks ([#4376](https://github.com/QwenLM/qwen-code/pull/4376))

## [0.16.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.16.2) - 2026-05-27

### Added

- cli: do not append trailing space for directory completions (#4092) ([#4288](https://github.com/QwenLM/qwen-code/pull/4288))
- skills: add memory-leak-debug skill for heap snapshot diagnosis ([#4468](https://github.com/QwenLM/qwen-code/pull/4468))
- memory: load .qwen/QWEN.local.md as project-local context (#4091) ([#4394](https://github.com/QwenLM/qwen-code/pull/4394))
- core: limit background agent concurrency ([#4324](https://github.com/QwenLM/qwen-code/pull/4324))
- core: enable Token Plan cache control ([#4495](https://github.com/QwenLM/qwen-code/pull/4495))
- **BREAKING** core: redesign auto-compaction thresholds with three-tier ladder ([#4345](https://github.com/QwenLM/qwen-code/pull/4345))
- telemetry: client-side HTTP span + opt-in W3C traceparent propagation (#4384) ([#4390](https://github.com/QwenLM/qwen-code/pull/4390))
- cli: headless / non-interactive runaway-protection guardrails (#4103) ([#4502](https://github.com/QwenLM/qwen-code/pull/4502))
- cli: dense inline panel + keyboard navigation for parallel agent fan-out ([#4477](https://github.com/QwenLM/qwen-code/pull/4477))
- prompt: move new app prompt from system prompt to skills ([#4567](https://github.com/QwenLM/qwen-code/pull/4567))
- worktree: Phase D — startup --worktree flag + symlinkDirectories + PR refs ([#4381](https://github.com/QwenLM/qwen-code/pull/4381))
- cli: default auto-dream/auto-skill to on and add /memory toggle ([#4547](https://github.com/QwenLM/qwen-code/pull/4547))

### Fixed

- build: clean stale outputs before tsc --build to prevent TS5055 ([#4453](https://github.com/QwenLM/qwen-code/pull/4453))
- cli: resolve stale closure race in text buffer submit handler ([#4470](https://github.com/QwenLM/qwen-code/pull/4470))
- weixin: allow Windows image paths inside workspace ([#4465](https://github.com/QwenLM/qwen-code/pull/4465))
- weixin: send decryptable image payloads ([#4464](https://github.com/QwenLM/qwen-code/pull/4464))
- core: preserve duplicate object references in safeJsonStringify ([#4407](https://github.com/QwenLM/qwen-code/pull/4407))
- extension: redact credentialed source diagnostics ([#4426](https://github.com/QwenLM/qwen-code/pull/4426))
- core: strip additional dangerous interpreter rules ([#4371](https://github.com/QwenLM/qwen-code/pull/4371))
- cli: require whitespace before @ to trigger file completion ([#4487](https://github.com/QwenLM/qwen-code/pull/4487))
- auth: align Token Plan model defaults with ModelStudio ([#4478](https://github.com/QwenLM/qwen-code/pull/4478))
- extension: populate resources when Claude marketplace points at whole folder ([#4497](https://github.com/QwenLM/qwen-code/pull/4497))
- cli: align /context token breakdown with actual API request ([#4512](https://github.com/QwenLM/qwen-code/pull/4512))
- sdk: honor canUseTool timeout in CLI control requests ([#4491](https://github.com/QwenLM/qwen-code/pull/4491))
- core: stop AbortSignal listener leak in long sessions (MaxListenersExceededWarning) ([#4366](https://github.com/QwenLM/qwen-code/pull/4366))
- core: prevent auto-skill creation from overwriting existing skills (#4437) ([#4489](https://github.com/QwenLM/qwen-code/pull/4489))
- sdk: Include CLI chunks in SDK package ([#4541](https://github.com/QwenLM/qwen-code/pull/4541))
- cli: persist MCP server removals ([#4535](https://github.com/QwenLM/qwen-code/pull/4535))
- models: refresh raw model-derived defaults ([#4517](https://github.com/QwenLM/qwen-code/pull/4517))
- vscode-ide-companion: exclude workspace packages from NOTICES.txt generation ([#4455](https://github.com/QwenLM/qwen-code/pull/4455))
- telemetry: attach interaction span to session root context ([#4499](https://github.com/QwenLM/qwen-code/pull/4499))
- cli: auto-prepend @ when pasting or dropping multiple file paths ([#4544](https://github.com/QwenLM/qwen-code/pull/4544))
- permissions: make command substitution ask, not deny (#4093) ([#4386](https://github.com/QwenLM/qwen-code/pull/4386))

### Documentation

- tools: document monitor tool ([#4356](https://github.com/QwenLM/qwen-code/pull/4356))
- agents,pr-template: add Working Principles and restructure PR template ([#4496](https://github.com/QwenLM/qwen-code/pull/4496))

### Other

- ci: split Aliyun OSS sync into a separate post-release workflow ([#4492](https://github.com/QwenLM/qwen-code/pull/4492))

## [0.16.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.16.1) - 2026-05-23

### Added

- telemetry: Phase 4a — TTFT capture + GenAI semconv dual-emit (#3731) ([#4417](https://github.com/QwenLM/qwen-code/pull/4417))

### Fixed

- core,cli: close tool_use↔tool_result invariant across all failure paths ([#4176](https://github.com/QwenLM/qwen-code/pull/4176))
- vscode: skip redundant tsc build in prepackage to prevent TS5055 ([#4401](https://github.com/QwenLM/qwen-code/pull/4401))
- core: preserve tab-indented notebook formatting ([#4373](https://github.com/QwenLM/qwen-code/pull/4373))
- scripts: renormalize CRLF storage for install-qwen-standalone.bat ([#4427](https://github.com/QwenLM/qwen-code/pull/4427))
- build: tree-shake React reconciler dev build to prevent PerformanceMeasure leak ([#4462](https://github.com/QwenLM/qwen-code/pull/4462))
- cli: stabilize flaky sticky-todo remeasure test ([#4416](https://github.com/QwenLM/qwen-code/pull/4416))
- cli: gate mintty OSC 8 detection on TERM_PROGRAM_VERSION ≥ 3.3 (#4420) ([#4451](https://github.com/QwenLM/qwen-code/pull/4451))
- release: move constants above entry point to avoid TDZ error ([#4398](https://github.com/QwenLM/qwen-code/pull/4398))

### Other

- chore(deps): update express from 4.21.2 to 5.2.1 ([#4458](https://github.com/QwenLM/qwen-code/pull/4458))

## [0.16.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.16.0) - 2026-05-21

### Added

- cli: wrap markdown links in OSC 8 so wrapped URLs stay clickable ([#4037](https://github.com/QwenLM/qwen-code/pull/4037))
- cli: support batch deletion of sessions in /delete ([#3733](https://github.com/QwenLM/qwen-code/pull/3733))
- subagents: use fastModel for Explore subagent ([#4086](https://github.com/QwenLM/qwen-code/pull/4086))
- perf: progressive MCP availability — MCP no longer blocks first input ([#3994](https://github.com/QwenLM/qwen-code/pull/3994))
- core: strip inline media before chat compaction summary ([#4101](https://github.com/QwenLM/qwen-code/pull/4101))
- tools: add generic worktree support — EnterWorktree/ExitWorktree + Agent isolation ([#4073](https://github.com/QwenLM/qwen-code/pull/4073))
- cli: add ModelScope as a built-in third-party API provider ([#4150](https://github.com/QwenLM/qwen-code/pull/4150))
- core: add image+video support for Qwen3.6-35B-A3B quant variants ([#4106](https://github.com/QwenLM/qwen-code/pull/4106))
- hooks: Add TodoCreated and TodoCompleted hooks for todo lifecycle events ([#3378](https://github.com/QwenLM/qwen-code/pull/3378))
- hooks: add prompt hook type with LLM evaluation support ([#3388](https://github.com/QwenLM/qwen-code/pull/3388))
- core,cli: add generic atomicWriteFile, wire into Write/Edit tools, upgrade @types/node ([#4096](https://github.com/QwenLM/qwen-code/pull/4096))
- cli: warn users that rewind is disabled in IDE mode ([#4122](https://github.com/QwenLM/qwen-code/pull/4122))
- cli: argument hint + --auto completion for /rename ([#4048](https://github.com/QwenLM/qwen-code/pull/4048))
- cli: add baseline /doctor memory diagnostics ([#4180](https://github.com/QwenLM/qwen-code/pull/4180))
- cli: add session-scoped /goal command with judge-driven turn continuation ([#4123](https://github.com/QwenLM/qwen-code/pull/4123))
- rewind: add file restoration support to /rewind command ([#4064](https://github.com/QwenLM/qwen-code/pull/4064))
- skills: add /stuck diagnostic skill for frozen sessions ([#4133](https://github.com/QwenLM/qwen-code/pull/4133))
- telemetry: unify span creation paths for hierarchical trace tree ([#4126](https://github.com/QwenLM/qwen-code/pull/4126))
- cli: readline Ctrl+P/N for history and selection navigation ([#4082](https://github.com/QwenLM/qwen-code/pull/4082))
- cli: add built-in status line presets with interactive dialog ([#4120](https://github.com/QwenLM/qwen-code/pull/4120))
- cli: add fork-session resume flag ([#4159](https://github.com/QwenLM/qwen-code/pull/4159))
- telemetry: add interaction span and detailed sensitive attributes ([#4097](https://github.com/QwenLM/qwen-code/pull/4097))
- core: PR-2.5 — post-promote stream redirect + natural-exit registry settle (#3831 follow-up) ([#4102](https://github.com/QwenLM/qwen-code/pull/4102))
- cli: add configurable plansDirectory for Plan Mode ([#4062](https://github.com/QwenLM/qwen-code/pull/4062))
- cli: add structured memory diagnostics JSON ([#3785](https://github.com/QwenLM/qwen-code/pull/3785))
- core: fail impossible goals ([#4230](https://github.com/QwenLM/qwen-code/pull/4230))
- serve: add /demo debug page for qwen serve daemon ([#4132](https://github.com/QwenLM/qwen-code/pull/4132))
- worktree: Phase C — session persistence, hooksPath, Footer + WorktreeExitDialog, three-mode --resume restore ([#4174](https://github.com/QwenLM/qwen-code/pull/4174))
- core: extend cross-auth fast models to agents ([#4153](https://github.com/QwenLM/qwen-code/pull/4153))
- cli,core: add Auto approval mode with LLM classifier ([#4151](https://github.com/QwenLM/qwen-code/pull/4151))
- cli: per-turn /diff with interactive dialog ([#4277](https://github.com/QwenLM/qwen-code/pull/4277))
- cli: add session path status command ([#4124](https://github.com/QwenLM/qwen-code/pull/4124))
- core: inject git status into system prompt and refine Explore/git-log guidance ([#4110](https://github.com/QwenLM/qwen-code/pull/4110))
- core: add NotebookEdit tool for Jupyter notebooks ([#3900](https://github.com/QwenLM/qwen-code/pull/3900))
- cli: respect /editor preference in Ctrl+X external editor ([#4310](https://github.com/QwenLM/qwen-code/pull/4310))
- telemetry: Phase 2 — tool.blocked_on_user + hook spans (#3731) ([#4321](https://github.com/QwenLM/qwen-code/pull/4321))
- installer: add standalone hosted install and uninstall flow ([#3828](https://github.com/QwenLM/qwen-code/pull/3828))
- telemetry: support custom resource attributes and add metric cardinality controls ([#4367](https://github.com/QwenLM/qwen-code/pull/4367))
- skills: support priority field in SKILL.md for sorting skill display order ([#4155](https://github.com/QwenLM/qwen-code/pull/4155))

### Changed

- cli: revert dynamic slash command LLM translation ([#4145](https://github.com/QwenLM/qwen-code/pull/4145))
- core: TaskBase envelope + foreground subagent persistence ([#3970](https://github.com/QwenLM/qwen-code/pull/3970))
- auth: unify provider config in core, simplify /auth as "Connect a Provider" ([#4287](https://github.com/QwenLM/qwen-code/pull/4287))
- core: undo x-api-key + Authorization double-emit (#4342) — regresses IdeaLab-style proxies ([#4385](https://github.com/QwenLM/qwen-code/pull/4385))

### Fixed

- core: normalize cumulative OpenAI stream deltas to suffixes ([#3896](https://github.com/QwenLM/qwen-code/pull/3896))
- cli: auto-restore prompt and preserve queue on cancel ([#4023](https://github.com/QwenLM/qwen-code/pull/4023))
- core: tag subagent OpenAI JSON logs ([#4099](https://github.com/QwenLM/qwen-code/pull/4099))
- dashscope: use URL hostname check instead of regex to avoid ReDoS (CodeQL) ([#4112](https://github.com/QwenLM/qwen-code/pull/4112))
- core: improve runtime fetch options error handling and documentation ([#3997](https://github.com/QwenLM/qwen-code/pull/3997))
- telemetry: address PR #3847 review follow-ups for trace correlation ([#4058](https://github.com/QwenLM/qwen-code/pull/4058))
- search: make empty-query exit synchronous and normalize Windows Backspace ([#3981](https://github.com/QwenLM/qwen-code/pull/3981))
- anthropic: allow cache_control on tool_result blocks ([#4121](https://github.com/QwenLM/qwen-code/pull/4121))
- core: merge IDE context into user prompt ([#3980](https://github.com/QwenLM/qwen-code/pull/3980))
- cli: apply /language output to running session without restart ([#4143](https://github.com/QwenLM/qwen-code/pull/4143))
- core: correct context-usage Footer for prompt size and Anthropic caches ([#4109](https://github.com/QwenLM/qwen-code/pull/4109))
- core: support cross-auth fast side queries ([#4117](https://github.com/QwenLM/qwen-code/pull/4117))
- vscode: preserve thinking state and recover missing edit snapshots ([#4147](https://github.com/QwenLM/qwen-code/pull/4147))
- cli: handle MinTTY Ctrl+Backspace as delete-previous-word ([#4059](https://github.com/QwenLM/qwen-code/pull/4059))
- cli: preserve debug session across sandbox relaunch ([#4060](https://github.com/QwenLM/qwen-code/pull/4060))
- hooks: inject SessionStart additionalContext into chat context ([#4115](https://github.com/QwenLM/qwen-code/pull/4115))
- i18n: Correct zh-TW translations to match Traditional Chinese conventions ([#4129](https://github.com/QwenLM/qwen-code/pull/4129))
- core: refresh systemInstruction in setTools() so progressive MCP tools reach the model ([#4166](https://github.com/QwenLM/qwen-code/pull/4166))
- vscode-ide-companion: use existing editor group for diff instead of forcing a new one ([#4130](https://github.com/QwenLM/qwen-code/pull/4130))
- core: add heap-pressure auto-compaction safety net ([#4186](https://github.com/QwenLM/qwen-code/pull/4186))
- cli: pass rewind selector test props ([#4211](https://github.com/QwenLM/qwen-code/pull/4211))
- lsp: expose status and startup diagnostics ([#3649](https://github.com/QwenLM/qwen-code/pull/3649))
- rewind: restore upstream TOCTOU ordering + heal sticky failed marker ([#4216](https://github.com/QwenLM/qwen-code/pull/4216))
- test: clear boundedPromise timers to prevent unhandled rejections in abort-and-lifecycle test ([#4220](https://github.com/QwenLM/qwen-code/pull/4220))
- ui: trim background task results and show newest first (#4094) ([#4125](https://github.com/QwenLM/qwen-code/pull/4125))
- core: align shell tool description with configured shell ([#4170](https://github.com/QwenLM/qwen-code/pull/4170))
- cli: include skill base dir in slash commands ([#4224](https://github.com/QwenLM/qwen-code/pull/4224))
- cli: restore ACP prompt counter on resume ([#4233](https://github.com/QwenLM/qwen-code/pull/4233))
- core: extend DashScope provider detection with additional hostname rules ([#4157](https://github.com/QwenLM/qwen-code/pull/4157))
- core: apply tool name migrations at dispatch ([#4213](https://github.com/QwenLM/qwen-code/pull/4213))
- cli: record mid-turn queued user prompts ([#4215](https://github.com/QwenLM/qwen-code/pull/4215))
- add cache limits to prevent OOM during build/test ([#4188](https://github.com/QwenLM/qwen-code/pull/4188))
- core: preserve read-before-write state across idle microcompaction ([#4243](https://github.com/QwenLM/qwen-code/pull/4243))
- telemetry: Phase 1.5 polish — fallback order, abort-as-result, log/span consistency ([#4302](https://github.com/QwenLM/qwen-code/pull/4302))
- cli: /status preserves prior error history items (#4169) ([#4265](https://github.com/QwenLM/qwen-code/pull/4265))
- core: decouple auto-memory recall from main-agent request path ([#4172](https://github.com/QwenLM/qwen-code/pull/4172))
- core: apply defaultModalities() on env-var-only model config (#4219) ([#4262](https://github.com/QwenLM/qwen-code/pull/4262))
- cli: block Windows Tab approval-mode toggle when input has a Tab consumer ([#4308](https://github.com/QwenLM/qwen-code/pull/4308))
- core: mirror Qwen3 reasoning on outbound history ([#4294](https://github.com/QwenLM/qwen-code/pull/4294))
- test: count result messages instead of assistant messages in multi-model E2E test ([#4341](https://github.com/QwenLM/qwen-code/pull/4341))
- test: raise timeout for Windows installer end-to-end tests ([#4352](https://github.com/QwenLM/qwen-code/pull/4352))
- review: harden SKILL.md against weak-model rule skipping ([#4340](https://github.com/QwenLM/qwen-code/pull/4340))
- cli: remove QWEN_OAUTH gate from feedback dialog ([#4316](https://github.com/QwenLM/qwen-code/pull/4316))
- core: replace structuredClone with shallow copy to prevent OOM in long sessions ([#4286](https://github.com/QwenLM/qwen-code/pull/4286))
- core: align session hook matcher targets ([#4354](https://github.com/QwenLM/qwen-code/pull/4354))
- core: handle MiMo tool-result media ([#4281](https://github.com/QwenLM/qwen-code/pull/4281))
- core: deduplicate geminiChat recovery continuation text ([#3966](https://github.com/QwenLM/qwen-code/pull/3966))
- ci: resolve TS5055 release build failure since May 19 ([#4383](https://github.com/QwenLM/qwen-code/pull/4383))

### Performance

- cli: code-split lowlight to cut startup V8 parse cost ([#4070](https://github.com/QwenLM/qwen-code/pull/4070))

### Documentation

- auth: add custom API key wizard PRD ([#3583](https://github.com/QwenLM/qwen-code/pull/3583))
- user + design docs for --json-schema structured output ([#4051](https://github.com/QwenLM/qwen-code/pull/4051))

### Other

- ci(deps): bump docker/* actions to Node 24 majors (silences GitHub Node 20 deprecation warning) ([#4131](https://github.com/QwenLM/qwen-code/pull/4131))
- test(integration): pin simple-mcp-server to legacy MCP path until #4163 is fixed ([#4164](https://github.com/QwenLM/qwen-code/pull/4164))
- chore(deps): re-upgrade ink 6 → 7.0.3 (upstream Static remount fix landed) ([#4119](https://github.com/QwenLM/qwen-code/pull/4119))
- Add stop hook blocking cap ([#4208](https://github.com/QwenLM/qwen-code/pull/4208))
- [codex] Allow custom output directory for /export ([#4193](https://github.com/QwenLM/qwen-code/pull/4193))
- test(perf): skip daemon baseline harness under sandbox ([#4234](https://github.com/QwenLM/qwen-code/pull/4234))
- test: reduce wait-dependent UI test delays ([#3987](https://github.com/QwenLM/qwen-code/pull/3987))
- chore(vscode): run development ACP CLI from source ([#4283](https://github.com/QwenLM/qwen-code/pull/4283))
- Support active goal stream events and non-interactive goals ([#4273](https://github.com/QwenLM/qwen-code/pull/4273))
- Pin fetch to bundled undici for undici higher versions compatibility ([#4238](https://github.com/QwenLM/qwen-code/pull/4238))
- chore: add .github/release.yml to support skip-changelog label ([#4327](https://github.com/QwenLM/qwen-code/pull/4327))
- Expose active goal in stream JSON ([#4314](https://github.com/QwenLM/qwen-code/pull/4314))

## [0.15.11](https://github.com/QwenLM/qwen-code/releases/tag/v0.15.11) - 2026-05-13

### Added

- cli: core built-in i18n coverage ([#3871](https://github.com/QwenLM/qwen-code/pull/3871))
- core: write runtime.json sidecar for active sessions ([#3714](https://github.com/QwenLM/qwen-code/pull/3714))
- telemetry: inject traceId/spanId into debug log files for OTel correlation ([#3847](https://github.com/QwenLM/qwen-code/pull/3847))
- tools: defer low-frequency built-in tools to reduce initial prompt size ([#4022](https://github.com/QwenLM/qwen-code/pull/4022))
- installer: add standalone archive installation ([#3776](https://github.com/QwenLM/qwen-code/pull/3776))
- cli: Ctrl+B promote keybind (#3831 PR-3 of 3) ([#3969](https://github.com/QwenLM/qwen-code/pull/3969))
- cli: add --json-schema for structured output in headless mode ([#3598](https://github.com/QwenLM/qwen-code/pull/3598))
- skills: Add codegraph skill for PR review risk analysis and conflict detection ([#3910](https://github.com/QwenLM/qwen-code/pull/3910))
- tools: keep ask_user_question always-visible to surface clarification UX ([#4041](https://github.com/QwenLM/qwen-code/pull/4041))
- core: improve Anthropic proxy compatibility and enable global prompt cache scope ([#4020](https://github.com/QwenLM/qwen-code/pull/4020))
- cli: add tools.toolSearch.enabled setting for prefix-caching models ([#4069](https://github.com/QwenLM/qwen-code/pull/4069))
- core: replace fdir crawler with git ls-files + ripgrep fallback ([#3214](https://github.com/QwenLM/qwen-code/pull/3214))
- dashscope: support DASHSCOPE_PROXY_BASE_URL for prompt cache via API gateway ([#3991](https://github.com/QwenLM/qwen-code/pull/3991))
- telemetry: add hierarchical session tracing spans ([#4071](https://github.com/QwenLM/qwen-code/pull/4071))

### Changed

- cli: remove legacy `qwen auth` CLI subcommand, redirect to /auth TUI dialog ([#3959](https://github.com/QwenLM/qwen-code/pull/3959))
- core: route side-query LLM calls through runSideQuery chokepoint ([#3775](https://github.com/QwenLM/qwen-code/pull/3775))
- telemetry: remove dead useCollector setting and unreachable TelemetryTarget.QWEN ([#4061](https://github.com/QwenLM/qwen-code/pull/4061))
- deps: downgrade ink 7 → 6 to fix Static-remount TUI regression from #3860 ([#4083](https://github.com/QwenLM/qwen-code/pull/4083))

### Fixed

- cli: keep long model stats header on one line ([#4032](https://github.com/QwenLM/qwen-code/pull/4032))
- test: repair stale --json-schema integration assertion ([#4075](https://github.com/QwenLM/qwen-code/pull/4075))
- cli: improve rendering on narrow terminals ([#3968](https://github.com/QwenLM/qwen-code/pull/3968))
- channels: expand tilde in channel cwd config ([#4045](https://github.com/QwenLM/qwen-code/pull/4045))
- cli: preserve table ANSI color across wrapped lines ([#4050](https://github.com/QwenLM/qwen-code/pull/4050))
- core: log internal OpenAI JSON requests ([#4081](https://github.com/QwenLM/qwen-code/pull/4081))

### Performance

- core: bound session-list metadata reads to head/tail 64KB; pool buffer; lazy message count ([#3897](https://github.com/QwenLM/qwen-code/pull/3897))

### Documentation

- telemetry: align config and docs semantics for target, outfile, and CLI flags ([#4066](https://github.com/QwenLM/qwen-code/pull/4066))

### Other

- test: stabilize main e2e flakes ([#3992](https://github.com/QwenLM/qwen-code/pull/3992))
- ci: skip unnecessary release and SDK checks ([#3984](https://github.com/QwenLM/qwen-code/pull/3984))
- chore(deps): upgrade ink 6.2.3 → 7.0.2 + bump Node engine to 22 ([#3860](https://github.com/QwenLM/qwen-code/pull/3860))
- chore(core): runtime.json sidecar follow-ups from #3714 review ([#4030](https://github.com/QwenLM/qwen-code/pull/4030))
- Upgrade GitHub Actions for Node 24 compatibility ([#1876](https://github.com/QwenLM/qwen-code/pull/1876))
- doc[sdk-python] Expand Python SDK usage documentation ([#3995](https://github.com/QwenLM/qwen-code/pull/3995))
- ci(e2e): stabilize MCP/CLI flows and cancel stale main runs ([#4039](https://github.com/QwenLM/qwen-code/pull/4039))

## [0.15.10](https://github.com/QwenLM/qwen-code/releases/tag/v0.15.10) - 2026-05-10

### Added

- core: add reactive compression on context overflow ([#3879](https://github.com/QwenLM/qwen-code/pull/3879))
- memory: add autoSkill background project skill extraction ([#3673](https://github.com/QwenLM/qwen-code/pull/3673))
- cli: improve slash command discovery ([#3736](https://github.com/QwenLM/qwen-code/pull/3736))
- core: support QWEN_HOME env var to customize config directory ([#2953](https://github.com/QwenLM/qwen-code/pull/2953))
- vscode: add message edit/rewind and message metadata UI ([#3762](https://github.com/QwenLM/qwen-code/pull/3762))
- add /diff command and git diff statistics utility ([#3491](https://github.com/QwenLM/qwen-code/pull/3491))
- tools: add ToolSearch for on-demand loading of deferred tool schemas ([#3589](https://github.com/QwenLM/qwen-code/pull/3589))

### Fixed

- cli: validate /model command arguments ([#3963](https://github.com/QwenLM/qwen-code/pull/3963))
- core: log the OpenAI request actually sent on the wire ([#3767](https://github.com/QwenLM/qwen-code/pull/3767))
- core: drop disabled MCP server from health status registry ([#3916](https://github.com/QwenLM/qwen-code/pull/3916))
- core: filter Mistral reasoning content at request boundary ([#3882](https://github.com/QwenLM/qwen-code/pull/3882))
- cli: preserve comments and formatting in settings.json during migration write-back ([#3861](https://github.com/QwenLM/qwen-code/pull/3861))
- cli: unfreeze Ctrl+O compact-mode toggle on long conversations ([#3905](https://github.com/QwenLM/qwen-code/pull/3905))
- cli: replace clearTerminal with targeted repaint on resize ([#3967](https://github.com/QwenLM/qwen-code/pull/3967))
- core: harden reactive compression follow-ups ([#3985](https://github.com/QwenLM/qwen-code/pull/3985))
- core: throttle shell tool live text updates ([#3902](https://github.com/QwenLM/qwen-code/pull/3902))
- core: unify Edit/WriteFile prior-read with Claude Code; close #3964 + #3945 ([#4002](https://github.com/QwenLM/qwen-code/pull/4002))

### Other

- test(cli): drop wait-dependent SessionPicker search tests (closes #3977) ([#3978](https://github.com/QwenLM/qwen-code/pull/3978))
- [codex] fix monitor notifications for subagents ([#3933](https://github.com/QwenLM/qwen-code/pull/3933))
- feat(telemetry) suppress OpenTelemetry diagnostics from UI ([#3986](https://github.com/QwenLM/qwen-code/pull/3986))

## [0.15.9](https://github.com/QwenLM/qwen-code/releases/tag/v0.15.9) - 2026-05-08

### Added

- telemetry: add sensitive span attribute opt-in ([#3893](https://github.com/QwenLM/qwen-code/pull/3893))
- add commit attribution with per-file AI contribution tracking ([#3115](https://github.com/QwenLM/qwen-code/pull/3115))
- sdk-python: replace verbatim release notes inheritance with --generate-notes ([#3835](https://github.com/QwenLM/qwen-code/pull/3835))
- cli: add Idealab as third-party provider ([#3955](https://github.com/QwenLM/qwen-code/pull/3955))
- session: add /branch to fork the current conversation ([#3539](https://github.com/QwenLM/qwen-code/pull/3539))
- core: foreground → background promote integration (#3831 PR-2 of 3) ([#3894](https://github.com/QwenLM/qwen-code/pull/3894))
- cli: searchable /resume picker with focus-aware modes ([#3880](https://github.com/QwenLM/qwen-code/pull/3880))
- skills: reload slash commands when SkillManager fires change event ([#3923](https://github.com/QwenLM/qwen-code/pull/3923))

### Changed

- cli: provider-first auth registry with unified install pipeline ([#3864](https://github.com/QwenLM/qwen-code/pull/3864))

### Fixed

- core: per-agent ContentGenerator view via AsyncLocalStorage ([#3707](https://github.com/QwenLM/qwen-code/pull/3707))
- core: accept partial reads in prior-read enforcement ([#3932](https://github.com/QwenLM/qwen-code/pull/3932))
- cli,core: live-phase panel-ownership filter + post-delete statusChange emit ([#3919](https://github.com/QwenLM/qwen-code/pull/3919))
- core: close bound-tool gap on runForkedAgent's YOLO wrapper ([#3892](https://github.com/QwenLM/qwen-code/pull/3892))
- vscode: mark Qwen OAuth coder-model as Discontinued in model picker ([#3948](https://github.com/QwenLM/qwen-code/pull/3948))
- cli: show tool details in subagent approval banner ([#3956](https://github.com/QwenLM/qwen-code/pull/3956))
- cli: trim blank streaming tails from live preview ([#3965](https://github.com/QwenLM/qwen-code/pull/3965))
- core: route countSessionMessages through parseLineTolerant ([#3692](https://github.com/QwenLM/qwen-code/pull/3692))

### Other

- ci(release): keep skip-ci out of release PR titles ([#3950](https://github.com/QwenLM/qwen-code/pull/3950))
- chore: Add bilingual requirement to create-issue command ([#3952](https://github.com/QwenLM/qwen-code/pull/3952))
- [codex] Persist ACP model selection ([#3947](https://github.com/QwenLM/qwen-code/pull/3947))
- ci: reduce PR test matrix runtime ([#3962](https://github.com/QwenLM/qwen-code/pull/3962))

## [0.15.8](https://github.com/QwenLM/qwen-code/releases/tag/v0.15.8) - 2026-05-07

### Added

- web-templates: add light theme and toggle to /export HTML ([#3908](https://github.com/QwenLM/qwen-code/pull/3908))
- cli: replace inline AgentExecutionDisplay with always-on LiveAgentPanel ([#3909](https://github.com/QwenLM/qwen-code/pull/3909))

### Fixed

- skills: allow symlinks pointing outside the skills directory ([#3915](https://github.com/QwenLM/qwen-code/pull/3915))
- core: foreground agent entry lingering in status bar after completion ([#3921](https://github.com/QwenLM/qwen-code/pull/3921))
- cli: prevent ESC in background tasks dialog from cancelling running request ([#3922](https://github.com/QwenLM/qwen-code/pull/3922))
- memory: address code review feedback for auto-memory recall ([#3866](https://github.com/QwenLM/qwen-code/pull/3866))
- cli: use tmux-safe dots spinner to reduce redraw pressure ([#3903](https://github.com/QwenLM/qwen-code/pull/3903))

### Other

- test(sdk): align tool-control E2E with prior-read enforcement ([#3898](https://github.com/QwenLM/qwen-code/pull/3898))
- ci(issue-followup-bot): render bot comment newlines correctly ([#3918](https://github.com/QwenLM/qwen-code/pull/3918))
- ci(release): skip CI on the version-bump squash commit on main ([#3912](https://github.com/QwenLM/qwen-code/pull/3912))

## [0.15.7](https://github.com/QwenLM/qwen-code/releases/tag/v0.15.7) - 2026-05-07

### Added

- core: add FileReadCache and short-circuit unchanged Reads ([#3717](https://github.com/QwenLM/qwen-code/pull/3717))
- core: add shared permission flow for tool execution unification ([#3723](https://github.com/QwenLM/qwen-code/pull/3723))
- review: expand review pipeline + qwen review CLI subcommands ([#3754](https://github.com/QwenLM/qwen-code/pull/3754))
- telemetry: define HTTP OTLP endpoint behavior and signal routing ([#3779](https://github.com/QwenLM/qwen-code/pull/3779))
- core: event monitor tool with throttled stdout streaming (Phase C) ([#3684](https://github.com/QwenLM/qwen-code/pull/3684))
- cli: add MCP health pill to footer ([#3741](https://github.com/QwenLM/qwen-code/pull/3741))
- cli: wire Monitor entries into combined Background tasks dialog ([#3791](https://github.com/QwenLM/qwen-code/pull/3791))
- cli: include monitors in /tasks + add interactive-mode hint ([#3801](https://github.com/QwenLM/qwen-code/pull/3801))
- sdk-python: add PyPI release workflow ([#3685](https://github.com/QwenLM/qwen-code/pull/3685))
- core: support reasoning effort 'max' tier (DeepSeek extension) ([#3800](https://github.com/QwenLM/qwen-code/pull/3800))
- core: hint to background long-running foreground bash commands ([#3809](https://github.com/QwenLM/qwen-code/pull/3809))
- skills: parallelize loading + add path-conditional activation ([#3604](https://github.com/QwenLM/qwen-code/pull/3604))
- sdk-python: add network timeouts to release version helper ([#3833](https://github.com/QwenLM/qwen-code/pull/3833))
- cli: improve export format completion navigation ([#3701](https://github.com/QwenLM/qwen-code/pull/3701))
- cli: Add ability to switch models non-interactively from the cli ([#3783](https://github.com/QwenLM/qwen-code/pull/3783))
- weixin: add image sending support via CDN upload ([#3781](https://github.com/QwenLM/qwen-code/pull/3781))
- core,cli: surface and cancel auto-memory dream tasks ([#3836](https://github.com/QwenLM/qwen-code/pull/3836))
- cli: route foreground subagents through pill+dialog while running ([#3768](https://github.com/QwenLM/qwen-code/pull/3768))
- core: enforce prior read before Edit / WriteFile mutates a file ([#3774](https://github.com/QwenLM/qwen-code/pull/3774))
- cli: customize banner area (logo, title, hide) ([#3710](https://github.com/QwenLM/qwen-code/pull/3710))
- core: add signal.reason convention for ShellExecutionService (#3831 PR-1 of 3) ([#3842](https://github.com/QwenLM/qwen-code/pull/3842))
- cli: expand TUI markdown rendering ([#3680](https://github.com/QwenLM/qwen-code/pull/3680))

### Changed

- extract shared release helper utilities ([#3834](https://github.com/QwenLM/qwen-code/pull/3834))

### Fixed

- cli: honor proxy setting ([#3753](https://github.com/QwenLM/qwen-code/pull/3753))
- cli: restore SubAgent shortcut focus ([#3771](https://github.com/QwenLM/qwen-code/pull/3771))
- vscode-companion: align package eslint config with root and style cleanup ([#3782](https://github.com/QwenLM/qwen-code/pull/3782))
- test: restore abort-and-lifecycle stdin-close test to pre-#3723 version ([#3777](https://github.com/QwenLM/qwen-code/pull/3777))
- core: inject thinking blocks for DeepSeek anthropic-compatible provider ([#3788](https://github.com/QwenLM/qwen-code/pull/3788))
- cli: stop double-wrapping and double-printing API errors in non-interactive mode ([#3749](https://github.com/QwenLM/qwen-code/pull/3749))
- telemetry: suppress async resource attribute warning on startup ([#3807](https://github.com/QwenLM/qwen-code/pull/3807))
- core: address post-merge monitor tool and UI routing issues ([#3792](https://github.com/QwenLM/qwen-code/pull/3792))
- core: clear FileReadCache on every history rewrite path ([#3810](https://github.com/QwenLM/qwen-code/pull/3810))
- core: unescape shell-escaped file paths in Edit, WriteFile, and ReadFile tools ([#3820](https://github.com/QwenLM/qwen-code/pull/3820))
- openai: parse MiniMax thinking tags ([#3677](https://github.com/QwenLM/qwen-code/pull/3677))
- telemetry: add bounded shutdown timeout and fix service.version resource attribute ([#3813](https://github.com/QwenLM/qwen-code/pull/3813))
- acp: run auto compression before model sends ([#3698](https://github.com/QwenLM/qwen-code/pull/3698))
- core: coalesce MCP server rediscovery ([#3818](https://github.com/QwenLM/qwen-code/pull/3818))
- core: activate skills from discovered result paths ([#3852](https://github.com/QwenLM/qwen-code/pull/3852))
- core: use per-model settings for fast model side queries ([#3815](https://github.com/QwenLM/qwen-code/pull/3815))
- core: prevent auto-memory recall from blocking main request ([#3814](https://github.com/QwenLM/qwen-code/pull/3814))
- sdk-python: standardize TAG_PREFIX to include v suffix ([#3832](https://github.com/QwenLM/qwen-code/pull/3832))
- cli: prevent file paths from being treated as slash commands ([#3743](https://github.com/QwenLM/qwen-code/pull/3743))
- core: auto-compact subagent context to prevent overflow ([#3735](https://github.com/QwenLM/qwen-code/pull/3735))
- core: shrink file diff session records ([#3872](https://github.com/QwenLM/qwen-code/pull/3872))
- core: rebuild tool registry on subagent Config overrides so bound tools resolve to the subagent ([#3873](https://github.com/QwenLM/qwen-code/pull/3873))
- core: create temp dir before saving truncated shell output ([#3875](https://github.com/QwenLM/qwen-code/pull/3875))
- core: improve stream rate-limit retry handling ([#3790](https://github.com/QwenLM/qwen-code/pull/3790))
- core: address @tanzhenxin's PR-1 review notes (post-merge follow-up to #3842) ([#3886](https://github.com/QwenLM/qwen-code/pull/3886))
- core: stop per-subagent ToolRegistry on foreground-fork path ([#3887](https://github.com/QwenLM/qwen-code/pull/3887))
- cli: warn on ignored provider generation config ([#3883](https://github.com/QwenLM/qwen-code/pull/3883))

### Documentation

- core: point background-shell + monitor guidance at both /tasks and the dialog ([#3808](https://github.com/QwenLM/qwen-code/pull/3808))
- cli: document new banner customization settings ([#3885](https://github.com/QwenLM/qwen-code/pull/3885))

### Other

- chore: remove legacy Gemini workflows ([#3725](https://github.com/QwenLM/qwen-code/pull/3725))
- Add background agent resume and continuation ([#3739](https://github.com/QwenLM/qwen-code/pull/3739))
- Feat/stats model cost estimation rebase ([#3780](https://github.com/QwenLM/qwen-code/pull/3780))
- ci: add Qwen Code issue follow-up bot workflow ([#3854](https://github.com/QwenLM/qwen-code/pull/3854))

## [0.15.6](https://github.com/QwenLM/qwen-code/releases/tag/v0.15.6) - 2026-04-30

### Fixed

- memory: use project transcript path for dream ([#3722](https://github.com/QwenLM/qwen-code/pull/3722))
- cli: bound SubAgent display by visual height to prevent flicker ([#3721](https://github.com/QwenLM/qwen-code/pull/3721))
- cli: keep sticky todo panel compact ([#3647](https://github.com/QwenLM/qwen-code/pull/3647))
- core: replay DeepSeek reasoning_content on all assistant turns ([#3747](https://github.com/QwenLM/qwen-code/pull/3747))
- cli: correct model precedence — argv > settings > auth env vars ([#3645](https://github.com/QwenLM/qwen-code/pull/3645))
- core: preserve reasoning_content in rewind, compression, and merge paths (#3579) ([#3737](https://github.com/QwenLM/qwen-code/pull/3737))
- cli: persist directory add entries ([#3752](https://github.com/QwenLM/qwen-code/pull/3752))
- lsp: 修复 LSP 文档、isPathSafe 限制，并提升 LSP 工具调用率 ([#3615](https://github.com/QwenLM/qwen-code/pull/3615))
- vscode-companion: fill slash commands into input on Enter instead of auto-submitting ([#3618](https://github.com/QwenLM/qwen-code/pull/3618))
- ci: add merge-back PR for stable releases in release workflow ([#3764](https://github.com/QwenLM/qwen-code/pull/3764))

### Other

- chore(core): drop tool token usage tracking ([#3727](https://github.com/QwenLM/qwen-code/pull/3727))

## [0.15.5](https://github.com/QwenLM/qwen-code/releases/tag/v0.15.5) - 2026-04-29

### Added

- core: wire background shells into the task_stop tool ([#3687](https://github.com/QwenLM/qwen-code/pull/3687))
- skills: add tmux-real-user-testing skill for readable TUI test logs ([#3577](https://github.com/QwenLM/qwen-code/pull/3577))
- cli: wire background shells into combined Background tasks dialog ([#3720](https://github.com/QwenLM/qwen-code/pull/3720))

### Fixed

- cli: refresh static header on model switch ([#3667](https://github.com/QwenLM/qwen-code/pull/3667))
- core: inject reasoning_content on DeepSeek tool-call replays ([#3729](https://github.com/QwenLM/qwen-code/pull/3729))

### Other

- mcp config as cli ([#1279](https://github.com/QwenLM/qwen-code/pull/1279))

## [0.15.4](https://github.com/QwenLM/qwen-code/releases/tag/v0.15.4) - 2026-04-28

### Added

- Adds Catalan language support ([#3643](https://github.com/QwenLM/qwen-code/pull/3643))
- cli: add API preconnect to reduce first-call latency ([#3318](https://github.com/QwenLM/qwen-code/pull/3318))
- cli: Add argument-hint support for slash commands ([#3593](https://github.com/QwenLM/qwen-code/pull/3593))
- cli,core: LLM-generated summary labels for tool-call batches ([#3538](https://github.com/QwenLM/qwen-code/pull/3538))
- cli: add OSC notification support for iTerm2, Kitty, and Ghostty ([#3562](https://github.com/QwenLM/qwen-code/pull/3562))
- vscode: add tab dot indicator and notification system (#3106) ([#3661](https://github.com/QwenLM/qwen-code/pull/3661))
- core: model-facing agent control (task_stop, send_message, per-agent transcript) ([#3471](https://github.com/QwenLM/qwen-code/pull/3471))
- cli: background-agent UI — pill, combined dialog, detail view ([#3488](https://github.com/QwenLM/qwen-code/pull/3488))
- core: managed background shell pool with /tasks command ([#3642](https://github.com/QwenLM/qwen-code/pull/3642))

### Changed

- config: dedupe QWEN_CODE_API_TIMEOUT_MS env override logic ([#3653](https://github.com/QwenLM/qwen-code/pull/3653))

### Fixed

- vscode-companion: slash command completion not triggering after message submit ([#3609](https://github.com/QwenLM/qwen-code/pull/3609))
- cli: guard gradient rendering without colors ([#3640](https://github.com/QwenLM/qwen-code/pull/3640))
- config: support QWEN_CODE_API_TIMEOUT_MS across OAuth and non-OAuth paths ([#3629](https://github.com/QwenLM/qwen-code/pull/3629))
- cli: add API Key option to `qwen auth` interactive menu ([#3624](https://github.com/QwenLM/qwen-code/pull/3624))
- core: recover from `}{` glued records on session JSONL load (#3606) ([#3656](https://github.com/QwenLM/qwen-code/pull/3656))
- core: split tool-result media into follow-up user message for strict OpenAI compat ([#3617](https://github.com/QwenLM/qwen-code/pull/3617))
- core: handle shell line continuations in command splitting ([#3600](https://github.com/QwenLM/qwen-code/pull/3600))
- cli: recognize OpenAI-compatible providers in `qwen auth status` ([#3623](https://github.com/QwenLM/qwen-code/pull/3623))
- core,cli: stop stripping reasoning on model switch/history load ([#3682](https://github.com/QwenLM/qwen-code/pull/3682))
- ci: use squash merge for SDK release auto-merge ([#3690](https://github.com/QwenLM/qwen-code/pull/3690))
- cli: preserve description in subject-bearing thought chunks ([#3691](https://github.com/QwenLM/qwen-code/pull/3691))
- core: treat ask_user_question multiSelect as optional ([#3699](https://github.com/QwenLM/qwen-code/pull/3699))
- core: set DeepSeek V4 context to 1M and output to 384K ([#3693](https://github.com/QwenLM/qwen-code/pull/3693))
- ci: preserve preview version overrides ([#3705](https://github.com/QwenLM/qwen-code/pull/3705))

### Other

- chore(gitignore): add .codex directory ([#3665](https://github.com/QwenLM/qwen-code/pull/3665))
- Feat/openrouter auth ([#3576](https://github.com/QwenLM/qwen-code/pull/3576))
- test(cli): remove 8 flaky TUI input tests surfaced by CI history mining ([#3694](https://github.com/QwenLM/qwen-code/pull/3694))

## [0.15.3](https://github.com/QwenLM/qwen-code/releases/tag/v0.15.3) - 2026-04-26

### Added

- vscode: add native context menu copy actions for webview chat ([#3477](https://github.com/QwenLM/qwen-code/pull/3477))
- cli: add Traditional Chinese (zh-TW) as a UI language option ([#3569](https://github.com/QwenLM/qwen-code/pull/3569))
- vscode: expose /skills as slash command with secondary picker ([#2548](https://github.com/QwenLM/qwen-code/pull/2548))
- cli: add conversation rewind feature with double-ESC and /rewind command ([#3441](https://github.com/QwenLM/qwen-code/pull/3441))
- adds a Space-to-preview affordance to the /resume session picker ([#3605](https://github.com/QwenLM/qwen-code/pull/3605))
- cli: add sticky todo panel to app layouts ([#3507](https://github.com/QwenLM/qwen-code/pull/3507))

### Changed

- cli: undo OPENAI_MODEL precedence change in modelProviders lookup (#3567) ([#3633](https://github.com/QwenLM/qwen-code/pull/3633))

### Fixed

- cli: memoize useHistory() return to avoid unnecessary re-renders ([#3547](https://github.com/QwenLM/qwen-code/pull/3547))
- cli: respect OPENAI_MODEL precedence in CLI model resolution ([#3567](https://github.com/QwenLM/qwen-code/pull/3567))
- cli: add TUI flicker foundation fixes ([#3591](https://github.com/QwenLM/qwen-code/pull/3591))
- cli: drain runExitCleanup before process.exit in error handlers ([#3602](https://github.com/QwenLM/qwen-code/pull/3602))
- review: respect /language output setting for local reviews ([#3611](https://github.com/QwenLM/qwen-code/pull/3611))
- test: update rewind E2E Test 1 assertion after isRealUserTurn fix ([#3622](https://github.com/QwenLM/qwen-code/pull/3622))
- core: preserve settings-sourced apiKey when registry model envKey is absent ([#3495](https://github.com/QwenLM/qwen-code/pull/3495))
- telemetry: use safeJsonStringify in FileExporter to avoid circular reference crash ([#3630](https://github.com/QwenLM/qwen-code/pull/3630))
- core: match DeepSeek provider by model name for sglang/vllm (#3613) ([#3620](https://github.com/QwenLM/qwen-code/pull/3620))

### Performance

- core: cut runtime sync I/O on tool hot path by 91% ([#3581](https://github.com/QwenLM/qwen-code/pull/3581))

### Documentation

- github: tighten PR template validation guidance ([#3522](https://github.com/QwenLM/qwen-code/pull/3522))
- telemetry: clarify Alibaba Cloud console entry ([#3498](https://github.com/QwenLM/qwen-code/pull/3498))

### Other

- feat(SDK) Add Python SDK implementation for #3010 ([#3494](https://github.com/QwenLM/qwen-code/pull/3494))
- test(arena): cover select dialog key actions ([#3614](https://github.com/QwenLM/qwen-code/pull/3614))

## [0.15.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.15.2) - 2026-04-24

### Added

- session: auto-title sessions via fast model, add /rename --auto ([#3540](https://github.com/QwenLM/qwen-code/pull/3540))
- web-search: remove built-in web_search tool, replace with MCP-based approach ([#3502](https://github.com/QwenLM/qwen-code/pull/3502))
- docs: add qwen-code skills, agents, and updated AGENTS.md ([#3575](https://github.com/QwenLM/qwen-code/pull/3575))
- vscode-companion: support /export session command ([#2592](https://github.com/QwenLM/qwen-code/pull/2592))

### Changed

- core: make OpenAI converter stateless (follow-up to #3525) ([#3550](https://github.com/QwenLM/qwen-code/pull/3550))
- vscode-ide-companion: undo #3450 split-stream timestamp sharing ([#3573](https://github.com/QwenLM/qwen-code/pull/3573))

### Fixed

- core: treat empty 'pages' parameter as unset in ReadFile ([#3559](https://github.com/QwenLM/qwen-code/pull/3559))
- i18n: sync mismatched keys between en.js and zh.js ([#3534](https://github.com/QwenLM/qwen-code/pull/3534))
- cli: remove residual blank lines after MCP init completes ([#3509](https://github.com/QwenLM/qwen-code/pull/3509))
- sdk-java: pass custom env to CLI process ([#3543](https://github.com/QwenLM/qwen-code/pull/3543))
- cli: promote resubmitted history prompt to most recent ([#3531](https://github.com/QwenLM/qwen-code/pull/3531))
- Strengthen error handling in qwenOAuth2.ts to prevent unhandled 'error' event ([#3481](https://github.com/QwenLM/qwen-code/pull/3481))
- acp: support SSE and HTTP MCP servers in ACP mode ([#3574](https://github.com/QwenLM/qwen-code/pull/3574))
- cli: run ACP Agent tool calls concurrently (#2516) ([#3463](https://github.com/QwenLM/qwen-code/pull/3463))
- cli: disable Kitty keyboard protocol on SIGINT to prevent garbled 9;5u output ([#3544](https://github.com/QwenLM/qwen-code/pull/3544))
- cli: dispatch queued slash commands through the slash path ([#3523](https://github.com/QwenLM/qwen-code/pull/3523))
- core: preserve reasoning_content during session resume and active sessions (GH#3579) ([#3590](https://github.com/QwenLM/qwen-code/pull/3590))

## [0.15.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.15.1) - 2026-04-23

### Added

- cli: combine elapsed + timeout in shell time indicator ([#3512](https://github.com/QwenLM/qwen-code/pull/3512))

### Fixed

- core: scope StreamingToolCallParser per stream, not per Converter (#3516) ([#3525](https://github.com/QwenLM/qwen-code/pull/3525))
- cli: stop slash completion render loop ([#3533](https://github.com/QwenLM/qwen-code/pull/3533))

### Other

- chore: bump version to 0.15.1 ([#3541](https://github.com/QwenLM/qwen-code/pull/3541))

## [0.15.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.15.0) - 2026-04-22

### Added

- acp: add complete hooks support for ACP integration ([#3248](https://github.com/QwenLM/qwen-code/pull/3248))
- optimize compact mode UX — shortcuts, settings sync, and safety ([#3100](https://github.com/QwenLM/qwen-code/pull/3100))
- hooks: Add HTTP Hook, Function Hook and Async Hook support ([#2827](https://github.com/QwenLM/qwen-code/pull/2827))
- memory: managed auto-memory and auto-dream system ([#3087](https://github.com/QwenLM/qwen-code/pull/3087))
- cli: support multi-line status line output ([#3311](https://github.com/QwenLM/qwen-code/pull/3311))
- skills: add /batch skill for parallel batch operations ([#3079](https://github.com/QwenLM/qwen-code/pull/3079))
- background subagents with headless and SDK support ([#3076](https://github.com/QwenLM/qwen-code/pull/3076))
- core: add path-based context rule injection from .qwen/rules/ ([#3339](https://github.com/QwenLM/qwen-code/pull/3339))
- cli: add dual-output sidecar mode for TUI ([#3352](https://github.com/QwenLM/qwen-code/pull/3352))
- bind `M-d` to a reasonable (Emacs-like) default ([#3358](https://github.com/QwenLM/qwen-code/pull/3358))
- core: detect tool validation retry loops and inject stop directive ([#3178](https://github.com/QwenLM/qwen-code/pull/3178))
- mcp: add OSC 52 copy hotkey for OAuth authorization URL ([#3393](https://github.com/QwenLM/qwen-code/pull/3393))
- vscode-ide-companion: add dedicated agent execution display ([#2590](https://github.com/QwenLM/qwen-code/pull/2590))
- cli: add early input capture to prevent keystroke loss during startup ([#3319](https://github.com/QwenLM/qwen-code/pull/3319))
- cli: support refreshInterval in statusLine for periodic refresh ([#3383](https://github.com/QwenLM/qwen-code/pull/3383))
- core: add dynamic swarm worker tool ([#3433](https://github.com/QwenLM/qwen-code/pull/3433))
- tools: add Markdown for Agents support to WebFetch tool ([#2734](https://github.com/QwenLM/qwen-code/pull/2734))
- core: enhanced loop detection with stagnation + validation-retry checks ([#3236](https://github.com/QwenLM/qwen-code/pull/3236))
- cli: add /doctor diagnostic command ([#3404](https://github.com/QwenLM/qwen-code/pull/3404))
- vscode-companion: enable Plan Mode toggle and approval UI ([#2551](https://github.com/QwenLM/qwen-code/pull/2551))
- cli: add session recap with /recap and auto-show on return ([#3434](https://github.com/QwenLM/qwen-code/pull/3434))
- cli: add bare startup mode ([#3448](https://github.com/QwenLM/qwen-code/pull/3448))
- vscode-ide-companion: support /insight command ([#2593](https://github.com/QwenLM/qwen-code/pull/2593))
- cli: add slashCommands.disabled setting to gate slash commands ([#3445](https://github.com/QwenLM/qwen-code/pull/3445))
- core: PDF text extraction fallback and Jupyter notebook parsing ([#3160](https://github.com/QwenLM/qwen-code/pull/3160))
- cli: add OAuth configuration flags to `mcp add` ([#3442](https://github.com/QwenLM/qwen-code/pull/3442))
- cli: add tool execution progress messages ([#3155](https://github.com/QwenLM/qwen-code/pull/3155))
- cli: make ACP message rewrite timeout configurable ([#3475](https://github.com/QwenLM/qwen-code/pull/3475))
- cli: attribute /stats rows to the originating subagent ([#3229](https://github.com/QwenLM/qwen-code/pull/3229))
- webui: render markdown in generic and web-fetch tool outputs ([#3469](https://github.com/QwenLM/qwen-code/pull/3469))
- cli: display real-time token consumption during streaming (#2742) ([#3329](https://github.com/QwenLM/qwen-code/pull/3329))
- retry: add persistent retry mode for unattended CI/CD environments ([#3080](https://github.com/QwenLM/qwen-code/pull/3080))
- vscode: replace OAuth with Coding Plan / API Key provider setup ([#3398](https://github.com/QwenLM/qwen-code/pull/3398))
- arena: add comparison summary for agent results ([#3394](https://github.com/QwenLM/qwen-code/pull/3394))
- session: add rename, delete, and auto-title generation for session ([#3093](https://github.com/QwenLM/qwen-code/pull/3093))
- cli: cap inline shell output with configurable line limit ([#3508](https://github.com/QwenLM/qwen-code/pull/3508))
- cli: auto-detect terminal theme ('auto' or unset) ([#3460](https://github.com/QwenLM/qwen-code/pull/3460))
- cli: Phase 2 — slash command multi-mode expansion, ACP fixes, and UX improvements ([#3377](https://github.com/QwenLM/qwen-code/pull/3377))

### Changed

- core: move fork subagent params from execute() to construction time ([#3255](https://github.com/QwenLM/qwen-code/pull/3255))
- cli: replace slash command whitelist with capability-based filtering (Phase 1) ([#3283](https://github.com/QwenLM/qwen-code/pull/3283))

### Fixed

- sdk: avoid leaking process exit listeners in ProcessTransport ([#3295](https://github.com/QwenLM/qwen-code/pull/3295))
- cli: prevent statusline spawn EBADF from crashing CLI (#3264) ([#3310](https://github.com/QwenLM/qwen-code/pull/3310))
- cli: remember "Start new chat session" until summary changes ([#3308](https://github.com/QwenLM/qwen-code/pull/3308))
- cli: defer update notifications until model response completes ([#3321](https://github.com/QwenLM/qwen-code/pull/3321))
- core: limit skill watcher depth to prevent FD exhaustion ([#3320](https://github.com/QwenLM/qwen-code/pull/3320))
- core: strip thinking blocks from history on model switch ([#3315](https://github.com/QwenLM/qwen-code/pull/3315))
- core: add shell argument quoting guidance to prevent special char errors ([#3327](https://github.com/QwenLM/qwen-code/pull/3327))
- cli: reduce terminal redraw cursor movement ([#3381](https://github.com/QwenLM/qwen-code/pull/3381))
- dingtalk: only suffix '(cont.)' on continuation chunks, not the first ([#2977](https://github.com/QwenLM/qwen-code/pull/2977))
- dingtalk: preserve empty text after @mention strip instead of falling back ([#2978](https://github.com/QwenLM/qwen-code/pull/2978))
- dingtalk: remove reactionContext map to stop leak on blocked messages ([#2979](https://github.com/QwenLM/qwen-code/pull/2979))
- sandbox: fall back to 'latest' tag when image name has no colon ([#2962](https://github.com/QwenLM/qwen-code/pull/2962))
- scripts: remove duplicate bundle rmSync in clean script ([#2964](https://github.com/QwenLM/qwen-code/pull/2964))
- integration-tests: honor stdinDoesNotEnd option ([#2966](https://github.com/QwenLM/qwen-code/pull/2966))
- scripts: Fix `"undefined Options: ..."` in generated JSON schema for enum settings without descriptions. ([#2963](https://github.com/QwenLM/qwen-code/pull/2963))
- text-buffer: unify offset-to-position logic ([#2969](https://github.com/QwenLM/qwen-code/pull/2969))
- weixin: check full 4-byte PNG magic signature ([#2970](https://github.com/QwenLM/qwen-code/pull/2970))
- cli: re-arm disconnected listener on rebuilt AcpBridge after crash ([#2975](https://github.com/QwenLM/qwen-code/pull/2975))
- sdk: settle pending next() promise in Stream.return() to prevent hangs ([#2981](https://github.com/QwenLM/qwen-code/pull/2981))
- cli: auto-submit on number key press in AskUserQuestionDialog ([#3407](https://github.com/QwenLM/qwen-code/pull/3407))
- tool-registry: add lazy factory registration with inflight concurrency dedup ([#3297](https://github.com/QwenLM/qwen-code/pull/3297))
- cli: wait for dual output stream shutdown ([#3416](https://github.com/QwenLM/qwen-code/pull/3416))
- build: invoke tsx directly via node --import instead of npx ([#3237](https://github.com/QwenLM/qwen-code/pull/3237))
- core: support older Git during repository initialization ([#3436](https://github.com/QwenLM/qwen-code/pull/3436))
- cli: /clear dismisses active /btw side-question dialog ([#3431](https://github.com/QwenLM/qwen-code/pull/3431))
- cli: let /btw use live conversation context ([#3429](https://github.com/QwenLM/qwen-code/pull/3429))
- display ">100%" when context usage exceeds limit ([#2766](https://github.com/QwenLM/qwen-code/pull/2766))
- ui: constrain shell output width to prevent box overflow ([#2857](https://github.com/QwenLM/qwen-code/pull/2857))
- core: remove abort listener during cleanup ([#3438](https://github.com/QwenLM/qwen-code/pull/3438))
- vscode-ide-companion: preserve split stream message ordering ([#3450](https://github.com/QwenLM/qwen-code/pull/3450))
- core: normalize Windows PATH for MCP stdio servers ([#3451](https://github.com/QwenLM/qwen-code/pull/3451))
- core: prevent malformed permission rules from becoming tool-wide catch-alls ([#3467](https://github.com/QwenLM/qwen-code/pull/3467))
- cli: pin /recap above input and align defaults with fastModel ([#3478](https://github.com/QwenLM/qwen-code/pull/3478))
- cli: rework session recap rendering and add blur threshold setting ([#3482](https://github.com/QwenLM/qwen-code/pull/3482))
- mcp: make the OAuth authorization URL clickable when wrapped ([#3489](https://github.com/QwenLM/qwen-code/pull/3489))
- core: recover from truncated tool calls via multi-turn continuation ([#3313](https://github.com/QwenLM/qwen-code/pull/3313))
- editor: detect Zed.app on macOS when CLI is not in PATH ([#3303](https://github.com/QwenLM/qwen-code/pull/3303))
- openai: when samplingParams is set, pass it through verbatim ([#3458](https://github.com/QwenLM/qwen-code/pull/3458))
- Handle missing xdg-open (ENOENT) gracefully to prevent crash ([#1675](https://github.com/QwenLM/qwen-code/pull/1675))
- core: use empty string instead of null for reasoning-only assistant content ([#3499](https://github.com/QwenLM/qwen-code/pull/3499))
- cli: inject plan/subagent/arena system reminders in ACP (#1151) ([#3479](https://github.com/QwenLM/qwen-code/pull/3479))
- core: reject truncated subagent write_file calls ([#3505](https://github.com/QwenLM/qwen-code/pull/3505))

### Performance

- vscode: fix input lag in long conversations ([#2550](https://github.com/QwenLM/qwen-code/pull/2550))

### Documentation

- fix Windows install command to work in both CMD and PowerShell ([#3252](https://github.com/QwenLM/qwen-code/pull/3252))
- update authentication methods to reflect OAuth discontinuation ([#3325](https://github.com/QwenLM/qwen-code/pull/3325))

### Other

- test(core): stabilize glob truncation tests ([#3322](https://github.com/QwenLM/qwen-code/pull/3322))
- test(integration): match new cron notification format in interactive tests ([#3402](https://github.com/QwenLM/qwen-code/pull/3402))
- Fix typo in class name ([#2189](https://github.com/QwenLM/qwen-code/pull/2189))
- test(core): update scheduler registry mock ([#3415](https://github.com/QwenLM/qwen-code/pull/3415))
- ci(stale): enable 60+30 stale/close policy for pull requests ([#3375](https://github.com/QwenLM/qwen-code/pull/3375))
- Revert "feat(core): add dynamic swarm worker tool" ([#3468](https://github.com/QwenLM/qwen-code/pull/3468))
- test(integration): switch settings-migration probe from --help to mcp list ([#3486](https://github.com/QwenLM/qwen-code/pull/3486))

## [0.14.5](https://github.com/QwenLM/qwen-code/releases/tag/v0.14.5) - 2026-04-15

### Added

- cli/sdk: expose /context usage data in non-interactive mode and SDK API ([#2916](https://github.com/QwenLM/qwen-code/pull/2916))
- cli: add startup performance profiler ([#3232](https://github.com/QwenLM/qwen-code/pull/3232))
- core: implement fork subagent for context sharing ([#2936](https://github.com/QwenLM/qwen-code/pull/2936))
- vscode-ide-companion: add /account for account display ([#2984](https://github.com/QwenLM/qwen-code/pull/2984))
- acp: LLM-based message rewrite middleware with custom prompts ([#3191](https://github.com/QwenLM/qwen-code/pull/3191))
- auth: discontinue Qwen OAuth free tier (2026-04-15 cutoff) ([#3291](https://github.com/QwenLM/qwen-code/pull/3291))

### Fixed

- core: detect rate-limit errors from streamed SSE frames ([#3246](https://github.com/QwenLM/qwen-code/pull/3246))
- vscode: limit session tab title length to prevent tab bar overflow ([#3249](https://github.com/QwenLM/qwen-code/pull/3249))
- core: respect custom Gemini baseUrl from modelProviders ([#3212](https://github.com/QwenLM/qwen-code/pull/3212))
- core: allow thought-only responses in GeminiChat stream validation ([#3251](https://github.com/QwenLM/qwen-code/pull/3251))
- cli: make /bug easier to open in terminals without hyperlink support ([#3257](https://github.com/QwenLM/qwen-code/pull/3257))
- cli: ignore literal Tab input in BaseTextInput ([#3270](https://github.com/QwenLM/qwen-code/pull/3270))
- channels/dingtalk: prioritize senderStaffId over senderId for allowedUsers matching ([#3294](https://github.com/QwenLM/qwen-code/pull/3294))
- cli: block discontinued qwen-oauth model selection in ModelDialog ([#3299](https://github.com/QwenLM/qwen-code/pull/3299))

## [0.14.4](https://github.com/QwenLM/qwen-code/releases/tag/v0.14.4) - 2026-04-13

### Added

- cli: CJK word segmentation and Ctrl+arrow navigation optimization ([#2942](https://github.com/QwenLM/qwen-code/pull/2942))
- replace text input with model picker for Fast Model in /settings ([#3120](https://github.com/QwenLM/qwen-code/pull/3120))
- show description for active setting in /settings dialog ([#3116](https://github.com/QwenLM/qwen-code/pull/3116))
- i18n: add French (fr-FR) locale support ([#3126](https://github.com/QwenLM/qwen-code/pull/3126))
- cli: queue input editing — pop queued messages for editing via ↑/ESC ([#2871](https://github.com/QwenLM/qwen-code/pull/2871))
- channels: add voice message support in TelegramAdapter ([#3150](https://github.com/QwenLM/qwen-code/pull/3150))
- cli: support tools.sandboxImage in settings ([#3146](https://github.com/QwenLM/qwen-code/pull/3146))
- cli: warn when workspace overrides global modelProviders ([#3148](https://github.com/QwenLM/qwen-code/pull/3148))
- hooks: Add StopFailure and PostCompact hook events ([#2825](https://github.com/QwenLM/qwen-code/pull/2825))
- core: intelligent tool parallelism with Kind-based batching and shell read-only detection ([#2864](https://github.com/QwenLM/qwen-code/pull/2864))
- add contextual tips system with post-response context awareness ([#2904](https://github.com/QwenLM/qwen-code/pull/2904))
- subagents: propagate approval mode to sub-agents ([#3066](https://github.com/QwenLM/qwen-code/pull/3066))
- skills: add model override support via skill frontmatter ([#2949](https://github.com/QwenLM/qwen-code/pull/2949))
- cli: support bare exit/quit commands to exit the CLI ([#3201](https://github.com/QwenLM/qwen-code/pull/3201))
- subagents: add disallowedTools field to agent definitions ([#3064](https://github.com/QwenLM/qwen-code/pull/3064))
- core: add microcompaction for idle context cleanup ([#3006](https://github.com/QwenLM/qwen-code/pull/3006))

### Changed

- merge test-utils package into core ([#3200](https://github.com/QwenLM/qwen-code/pull/3200))

### Fixed

- vscode: force fresh ACP session on new-session action ([#2874](https://github.com/QwenLM/qwen-code/pull/2874))
- cli: prioritize slash command completions ([#3104](https://github.com/QwenLM/qwen-code/pull/3104))
- cli: improve markdown table rendering in terminal ([#2914](https://github.com/QwenLM/qwen-code/pull/2914))
- prevent statusline script from corrupting settings.json ([#3091](https://github.com/QwenLM/qwen-code/pull/3091))
- cli: check NEWLINE before SUBMIT in TextInput multiline mode ([#3094](https://github.com/QwenLM/qwen-code/pull/3094))
- input: preserve tab characters in pasted content ([#3045](https://github.com/QwenLM/qwen-code/pull/3045))
- use latest assistant token count on resume instead of stale compression checkpoint ([#3109](https://github.com/QwenLM/qwen-code/pull/3109))
- upgrade normalize-package-data to 7.0.1 (fixes DEP0169 warning) ([#2865](https://github.com/QwenLM/qwen-code/pull/2865))
- core: cap recursive file crawler at 100k entries to prevent OOM ([#3138](https://github.com/QwenLM/qwen-code/pull/3138))
- channels: apply proxy settings to channel start command ([#3136](https://github.com/QwenLM/qwen-code/pull/3136))
- lazy-load channel plugins to eliminate DEP0040 startup warning ([#3134](https://github.com/QwenLM/qwen-code/pull/3134))
- core: fall back to CLI confirmation when IDE diff open fails ([#3031](https://github.com/QwenLM/qwen-code/pull/3031))
- core: handle empty OAuth refresh response body ([#3123](https://github.com/QwenLM/qwen-code/pull/3123))
- followup: fix follow-up suggestions not working on OpenAI-compatible providers ([#3151](https://github.com/QwenLM/qwen-code/pull/3151))
- cli: recover from stuck bracketed-paste mode and keep Ctrl+C reachable ([#3181](https://github.com/QwenLM/qwen-code/pull/3181))
- cli: set qwen3.5-plus as default model for Coding Plan ([#3193](https://github.com/QwenLM/qwen-code/pull/3193))
- core: respect respectGitIgnore setting in @file injection path ([#3197](https://github.com/QwenLM/qwen-code/pull/3197))
- core: show clear error when MCP server cwd does not exist ([#3192](https://github.com/QwenLM/qwen-code/pull/3192))
- cli: honor --openai-api-key in non-interactive auth validation ([#3187](https://github.com/QwenLM/qwen-code/pull/3187))
- cli: stop refilling input with prior prompt on cancel ([#3208](https://github.com/QwenLM/qwen-code/pull/3208))
- core: allow Unicode characters in agent names ([#3194](https://github.com/QwenLM/qwen-code/pull/3194))

### Documentation

- readme: Add announcement for Qwen OAuth free tier policy adjustment ([#3207](https://github.com/QwenLM/qwen-code/pull/3207))
- update quota exceeded alternatives to OpenRouter and Fireworks ([#3217](https://github.com/QwenLM/qwen-code/pull/3217))

### Other

- chore: remove legacy directories (.gcp, .aoneci, hello, .allstar) ([#3199](https://github.com/QwenLM/qwen-code/pull/3199))
- ci(release): parallelize release validation ([#3132](https://github.com/QwenLM/qwen-code/pull/3132))
- chore: bump version to 0.14.4 ([#3209](https://github.com/QwenLM/qwen-code/pull/3209))

## [0.14.3](https://github.com/QwenLM/qwen-code/releases/tag/v0.14.3) - 2026-04-10

### Added

- plan: add "Yes, restore previous mode" option when exiting plan mode ([#3008](https://github.com/QwenLM/qwen-code/pull/3008))
- review: enhance /review with deterministic analysis, autofix, and security hardening ([#2932](https://github.com/QwenLM/qwen-code/pull/2932))
- ui: add customizable status line with /statusline command ([#2923](https://github.com/QwenLM/qwen-code/pull/2923))

### Changed

- centralize IDE diff interaction in CoreToolScheduler ([#2728](https://github.com/QwenLM/qwen-code/pull/2728))
- rename verboseMode to compactMode for better UX clarity ([#3075](https://github.com/QwenLM/qwen-code/pull/3075))

### Fixed

- ui: Remove dead dirs state and unused hook parameter from InputPrompt ([#2891](https://github.com/QwenLM/qwen-code/pull/2891))
- followup: prevent tool call UI leak and Enter accept buffer race ([#2872](https://github.com/QwenLM/qwen-code/pull/2872))
- core: add getDefaultPermission and allowExternalPaths to ripGrep tool ([#2948](https://github.com/QwenLM/qwen-code/pull/2948))
- webui: fix chat input scrollbar not draggable in VS Code plugin ([#3038](https://github.com/QwenLM/qwen-code/pull/3038))
- bundle: inline tree-sitter WASM for bundled installs ([#2985](https://github.com/QwenLM/qwen-code/pull/2985))
- cli: serialize subagent confirmation focus to prevent concurrent input conflicts ([#2930](https://github.com/QwenLM/qwen-code/pull/2930))
- permissions: match env-prefixed shell commands against saved permission rules ([#2850](https://github.com/QwenLM/qwen-code/pull/2850))
- prevent Shift+Tab from accepting prompt placeholder suggestion ([#3060](https://github.com/QwenLM/qwen-code/pull/3060))
- weixin: add missing iLink headers to QR code login flow ([#3044](https://github.com/QwenLM/qwen-code/pull/3044))
- improve /model --fast description clarity ([#3077](https://github.com/QwenLM/qwen-code/pull/3077))
- cli: add 'detail' subcommand to /context command ([#3042](https://github.com/QwenLM/qwen-code/pull/3042))
- persist ProceedAlways permission outcome in compact mode ([#3069](https://github.com/QwenLM/qwen-code/pull/3069))
- add --fast hint to /model description for discoverability ([#3086](https://github.com/QwenLM/qwen-code/pull/3086))

### Other

- chore: remove outdated pr-review skill ([#3028](https://github.com/QwenLM/qwen-code/pull/3028))
- test: add tests for confirmation-bus, prompt-registry, and cli/core modules ([#2272](https://github.com/QwenLM/qwen-code/pull/2272))
- [codex] fix checkpointing init in non-repo directories ([#3041](https://github.com/QwenLM/qwen-code/pull/3041))
- chore: bump version to 0.14.3 ([#3112](https://github.com/QwenLM/qwen-code/pull/3112))

## [0.14.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.14.2) - 2026-04-08

### Added

- cli: implement /plan command for plan mode ([#2921](https://github.com/QwenLM/qwen-code/pull/2921))
- core: thinking block cross-turn retention with idle cleanup ([#2897](https://github.com/QwenLM/qwen-code/pull/2897))
- core: adaptive output token escalation (8K default + 64K retry) ([#2898](https://github.com/QwenLM/qwen-code/pull/2898))
- add bugfix workflow, test-engineer agent, and debugging skills ([#2881](https://github.com/QwenLM/qwen-code/pull/2881))
- add qwen3.6-plus model to ModelStudio Coding Plan ([#3015](https://github.com/QwenLM/qwen-code/pull/3015))

### Fixed

- vscode-ide-companion: fix blank screen in VS Code 0.14.1 webview ([#2959](https://github.com/QwenLM/qwen-code/pull/2959))
- hooks: preserve null exit code from signal kills instead of collapsing to 0 ([#2976](https://github.com/QwenLM/qwen-code/pull/2976))
- cli: disable follow-up suggestions by default ([#2954](https://github.com/QwenLM/qwen-code/pull/2954))
- cli: fix csiUPrefix error in Linux/Wayland ([#2995](https://github.com/QwenLM/qwen-code/pull/2995))
- cli: sync packages/cli version and sandboxImageUri to 0.14.2 ([#3026](https://github.com/QwenLM/qwen-code/pull/3026))

### Other

- bump version to 0.14.2 ([#3020](https://github.com/QwenLM/qwen-code/pull/3020))

## [0.14.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.14.1) - 2026-04-07

### Added

- cli: enhance /btw side question with improved prompt and Ctrl+C/D cancel ([#2776](https://github.com/QwenLM/qwen-code/pull/2776))
- cli, webui: add follow-up suggestions feature ([#2525](https://github.com/QwenLM/qwen-code/pull/2525))
- webui: unify remaining tool display labels ([#2595](https://github.com/QwenLM/qwen-code/pull/2595))
- allow Ctrl+Y to skip rate-limit retry delay immediately ([#2420](https://github.com/QwenLM/qwen-code/pull/2420))
- prompt: add dangerous actions behavior guidance in system prompt ([#2889](https://github.com/QwenLM/qwen-code/pull/2889))
- core: implement mid-turn queue drain for agent execution ([#2854](https://github.com/QwenLM/qwen-code/pull/2854))
- to #2767, support verbose and compact mode swither with ctrl-o ([#2770](https://github.com/QwenLM/qwen-code/pull/2770))

### Changed

- tools: remove duplicate proxy setup in WebFetchTool ([#2888](https://github.com/QwenLM/qwen-code/pull/2888))

### Fixed

- hooks: clean up abort listener in error handler ([#2841](https://github.com/QwenLM/qwen-code/pull/2841))
- cli: commit pending AI response before adding hook system message ([#2848](https://github.com/QwenLM/qwen-code/pull/2848))
- subagents: preserve session subagents during cache refresh ([#2895](https://github.com/QwenLM/qwen-code/pull/2895))
- telegram: send only failed chunk as plaintext fallback ([#2894](https://github.com/QwenLM/qwen-code/pull/2894))
- auth: only release token refresh lock if it was acquired ([#2893](https://github.com/QwenLM/qwen-code/pull/2893))
- extensions: handle individual extension update check failures ([#2892](https://github.com/QwenLM/qwen-code/pull/2892))
- mcp: clear OAuth callback timeout on all completion paths ([#2890](https://github.com/QwenLM/qwen-code/pull/2890))
- mcp: clean up directory listener on connect failure ([#2896](https://github.com/QwenLM/qwen-code/pull/2896))
- permissions: allow non-core tools to bypass coreTools allowlist ([#2843](https://github.com/QwenLM/qwen-code/pull/2843))
- prevent output-language.md from being overwritten on startup ([#2842](https://github.com/QwenLM/qwen-code/pull/2842))
- cli: restore ? shortcuts in vim normal mode ([#2884](https://github.com/QwenLM/qwen-code/pull/2884))
- cli: prevent ideCommand failure from breaking all slash commands… ([#2822](https://github.com/QwenLM/qwen-code/pull/2822))
- improve ACP connection reliability with spawn retry and auto-reconnect ([#2804](https://github.com/QwenLM/qwen-code/pull/2804))
- vscode: inherit model selection for new chat tabs ([#2802](https://github.com/QwenLM/qwen-code/pull/2802))
- hooks: parse JSON output on exit code 2 to preserve hook additionalContext ([#2815](https://github.com/QwenLM/qwen-code/pull/2815))
- cli: remove quote-based drag detection to prevent input lag ([#2837](https://github.com/QwenLM/qwen-code/pull/2837))
- cli: restore previous theme on /theme cancel (refs #2833) ([#2834](https://github.com/QwenLM/qwen-code/pull/2834))
- extensions: await async calls in extension refresh chain ([#2835](https://github.com/QwenLM/qwen-code/pull/2835))
- cli: preserve runtime-added models when saving settings ([#2455](https://github.com/QwenLM/qwen-code/pull/2455))
- tools: exit_plan_mode now exits correctly in YOLO mode ([#2586](https://github.com/QwenLM/qwen-code/pull/2586))
- vscode: remove @vscode/vsce from devDependencies to fix local build ([#2824](https://github.com/QwenLM/qwen-code/pull/2824))
- webui: remove @qwen-code/qwen-code-core dependency ([#2902](https://github.com/QwenLM/qwen-code/pull/2902))
- core: coerce stringified JSON values for anyOf/oneOf MCP tool schemas ([#2858](https://github.com/QwenLM/qwen-code/pull/2858))
- weixin: add missing iLink-App-Id and iLink-App-ClientVersion headers ([#2943](https://github.com/QwenLM/qwen-code/pull/2943))

### Other

- chore: bump version to 0.14.1 ([#2849](https://github.com/QwenLM/qwen-code/pull/2849))
- Fix Markdown table cell separator escaping in MarkdownDisplay.tsx ([#2463](https://github.com/QwenLM/qwen-code/pull/2463))
- Remove CODEOWNERS file ([#2937](https://github.com/QwenLM/qwen-code/pull/2937))

## [0.14.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.14.0) - 2026-04-03

### Added

- hooks: remove experimental flag and add disabled state UI ([#2781](https://github.com/QwenLM/qwen-code/pull/2781))
- vscode: add retry logic and auto-reconnect for ACP connection ([#2666](https://github.com/QwenLM/qwen-code/pull/2666))
- add cross-provider model selection for subagents ([#2698](https://github.com/QwenLM/qwen-code/pull/2698))
- extension: Add npm registry support for extension installation ([#2719](https://github.com/QwenLM/qwen-code/pull/2719))
- cron: add in-session loop scheduling with cron tools ([#2731](https://github.com/QwenLM/qwen-code/pull/2731))
- channels: add extensible Channels platform with plugin system and Telegram/WeChat/DingTalk channels ([#2628](https://github.com/QwenLM/qwen-code/pull/2628))
- mcp: add reconnect command and implement auto-reconnect logic ([#2428](https://github.com/QwenLM/qwen-code/pull/2428))

### Changed

- ui: improve hook event handling with dedicated history items ([#2696](https://github.com/QwenLM/qwen-code/pull/2696))
- PR #2666 ACP retry/reconnect logic ([#2792](https://github.com/QwenLM/qwen-code/pull/2792))

### Fixed

- add .qwen path replacement in markdown files during extension install ([#2769](https://github.com/QwenLM/qwen-code/pull/2769))
- normalize proxy URLs to support addresses without protocol prefix ([#2745](https://github.com/QwenLM/qwen-code/pull/2745))
- make /compress handle tool-heavy conversations correctly ([#2659](https://github.com/QwenLM/qwen-code/pull/2659))
- core: robustly resolve tree-sitter WASM path for symlinked CLI installations ([#2764](https://github.com/QwenLM/qwen-code/pull/2764))
- prevent subagent telemetry from overwriting main agent footer context ([#2765](https://github.com/QwenLM/qwen-code/pull/2765))
- upgrade @lydell/node-pty to 1.2.0-beta.10 to fix PTY FD leak on macOS ([#2777](https://github.com/QwenLM/qwen-code/pull/2777))
- allow web fetch approvals in plan mode ([#2763](https://github.com/QwenLM/qwen-code/pull/2763))
- prevent orphan ACP processes on tab close and clean up MCP subprocesses on shutdown ([#2662](https://github.com/QwenLM/qwen-code/pull/2662))
- cli: enhance KeypressProvider with kitty sequence timeout manage… ([#2612](https://github.com/QwenLM/qwen-code/pull/2612))
- delete design doc ([#2789](https://github.com/QwenLM/qwen-code/pull/2789))
- resolve punycode to userland package and skip env var test in sandbox ([#2796](https://github.com/QwenLM/qwen-code/pull/2796))
- hide skills with cron allowedTools when cron is disabled ([#2811](https://github.com/QwenLM/qwen-code/pull/2811))

### Other

- Enhance /review: add verification, false positive control, and PR comments ([#2687](https://github.com/QwenLM/qwen-code/pull/2687))
- chore(channels): make plugin-example private and remove from release workflow ([#2801](https://github.com/QwenLM/qwen-code/pull/2801))
- 🎉 feat: add Qwen3.6-Plus model support ([#2820](https://github.com/QwenLM/qwen-code/pull/2820))

## [0.13.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.13.2) - 2026-03-30

### Added

- add bundled qc-helper skill, qwen-code-claw reference, and README claw guide ([#2623](https://github.com/QwenLM/qwen-code/pull/2623))

### Fixed

- docs: update references from Bailian to ModelStudio in README an… ([#2714](https://github.com/QwenLM/qwen-code/pull/2714))
- shell: resolve Git Bash path for node-pty on Windows ([#2733](https://github.com/QwenLM/qwen-code/pull/2733))
- resolve /clear command and ESC key lag caused by hooks system ([#2656](https://github.com/QwenLM/qwen-code/pull/2656))
- preserve original line endings (CRLF/LF) when editing files ([#2707](https://github.com/QwenLM/qwen-code/pull/2707))
- core: resolve tree-sitter wasm path for symlinked CLI ([#2744](https://github.com/QwenLM/qwen-code/pull/2744))
- cli: prevent terminal response leakage on high-latency SSH ([#2718](https://github.com/QwenLM/qwen-code/pull/2718))
- shell: remove command substitution deny check from getDefaultPermission ([#2747](https://github.com/QwenLM/qwen-code/pull/2747))
- make list_directory integration test more deterministic ([#2752](https://github.com/QwenLM/qwen-code/pull/2752))

### Documentation

- clarify envKey usage and add env field examples ([#2715](https://github.com/QwenLM/qwen-code/pull/2715))

### Other

- chore: bump version to 0.13.1 ([#2716](https://github.com/QwenLM/qwen-code/pull/2716))
- chore: release v0.13.2 ([#2750](https://github.com/QwenLM/qwen-code/pull/2750))

## [0.13.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.13.1) - 2026-03-27

### Added

- hooks: Add comprehensive hook execution telemetry ([#2421](https://github.com/QwenLM/qwen-code/pull/2421))
- hooks ui: refactor ui for Qwen Code hooks ([#2602](https://github.com/QwenLM/qwen-code/pull/2602))
- human-readable permission labels, deny rule feedback, and multi-dir search improvements ([#2637](https://github.com/QwenLM/qwen-code/pull/2637))
- auth: implement Alibaba Cloud Standard API Key support ([#2668](https://github.com/QwenLM/qwen-code/pull/2668))

### Fixed

- extensions: support non-GitHub git URLs for extension installation ([#2539](https://github.com/QwenLM/qwen-code/pull/2539))
- cli: `/memory show --project` and `--global` now display all configured context files ([#2368](https://github.com/QwenLM/qwen-code/pull/2368))
- mcp: restore trust+isTrustedFolder permission check in getDefaultPermission ([#2642](https://github.com/QwenLM/qwen-code/pull/2642))
- cli: preserve selected auth type on startup auth failure ([#2080](https://github.com/QwenLM/qwen-code/pull/2080))
- vscode-ide-companion: improve ACP error handling to prevent silent loading hangs ([#2546](https://github.com/QwenLM/qwen-code/pull/2546))
- vscode-ide-companion: silence secondary sidebar warning on older VS Code versions ([#2545](https://github.com/QwenLM/qwen-code/pull/2545))
- lsp: improve C++/Java/Python language server support ([#2547](https://github.com/QwenLM/qwen-code/pull/2547))
- vscode-ide-companion: preserve model metadata on switch ([#2591](https://github.com/QwenLM/qwen-code/pull/2591))
- windows: support git bash/MSYS2 shell detection on Windows ([#2645](https://github.com/QwenLM/qwen-code/pull/2645))
- shell: handle PTY race condition errors gracefully ([#2611](https://github.com/QwenLM/qwen-code/pull/2611))
- acp-integration/agent: clear stale subagent diff confirmation after IDE accept ([#2631](https://github.com/QwenLM/qwen-code/pull/2631))
- use config working directory for OpenAI logger path resolution in ACP mode ([#2675](https://github.com/QwenLM/qwen-code/pull/2675))
- @ file search stops working after selecting a slash command ([#2694](https://github.com/QwenLM/qwen-code/pull/2694))
- acp: align permission flow across clients ([#2690](https://github.com/QwenLM/qwen-code/pull/2690))

### Documentation

- add hooks documentation and fix JSON schema ([#2679](https://github.com/QwenLM/qwen-code/pull/2679))

### Other

- test(sdk): improve tool control docs and add pattern matching tests ([#2644](https://github.com/QwenLM/qwen-code/pull/2644))
- test(sdk): improve permission message pattern matching ([#2712](https://github.com/QwenLM/qwen-code/pull/2712))

## [0.13.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.13.0) - 2026-03-23

### Added

- add system prompt customization options in SDK and CLI ([#2400](https://github.com/QwenLM/qwen-code/pull/2400))
- hooks: implement hooks extension mechanism ([#2352](https://github.com/QwenLM/qwen-code/pull/2352))
- core: execute task tools concurrently for improved performance ([#2434](https://github.com/QwenLM/qwen-code/pull/2434))
- arena: Add agent collaboration arena with multi-model competitive execution ([#1912](https://github.com/QwenLM/qwen-code/pull/1912))
- ui: Display token usage in the loading/progress indicator ([#2445](https://github.com/QwenLM/qwen-code/pull/2445))
- vscode-ide-companion: add Tab key fill-only behavior for completions ([#2431](https://github.com/QwenLM/qwen-code/pull/2431))
- add /context command to display context window token usage breakdown ([#1835](https://github.com/QwenLM/qwen-code/pull/1835))
- support skills in .agents directory and other provider directories ([#2202](https://github.com/QwenLM/qwen-code/pull/2202))
- add `auth` CLI command and Qwen Code Claw skill ([#2440](https://github.com/QwenLM/qwen-code/pull/2440))
- export: add metadata and statistics tracking ([#2328](https://github.com/QwenLM/qwen-code/pull/2328))
- hooks: Implement 10 core event hooks for session lifecycle and tool execution ([#2203](https://github.com/QwenLM/qwen-code/pull/2203))
- support permission ([#2283](https://github.com/QwenLM/qwen-code/pull/2283))
- add .agents/skills as a skill provider directory ([#2476](https://github.com/QwenLM/qwen-code/pull/2476))
- vscode-ide-companion: add image paste support ([#1978](https://github.com/QwenLM/qwen-code/pull/1978))
- storage: support configurable runtime output directory ([#2127](https://github.com/QwenLM/qwen-code/pull/2127))
- core: add Explore agent and rename TaskTool to AgentTool ([#2489](https://github.com/QwenLM/qwen-code/pull/2489))
- hooks: use extension dir files instead of tmp dir files ([#2478](https://github.com/QwenLM/qwen-code/pull/2478))
- cli: add /btw slash command for ephemeral side questions ([#2371](https://github.com/QwenLM/qwen-code/pull/2371))

### Changed

- core: improve error handling and quota detection ([#2458](https://github.com/QwenLM/qwen-code/pull/2458))
- Refactors the VS Code file completion system to use fuzzy search ([#2437](https://github.com/QwenLM/qwen-code/pull/2437))

### Fixed

- pipeline: handle duplicate finish_reason chunks from OpenRouter ([#2403](https://github.com/QwenLM/qwen-code/pull/2403))
- cli: show newest-first history for Ctrl+R command search ([#2425](https://github.com/QwenLM/qwen-code/pull/2425))
- Ensure message_start and message_stop events are paired in SDK streaming ([#2448](https://github.com/QwenLM/qwen-code/pull/2448))
- core: add truncation support for MCP tool output ([#2446](https://github.com/QwenLM/qwen-code/pull/2446))
- vscode-ide-companion: update URI handling for Windows paths ([#2457](https://github.com/QwenLM/qwen-code/pull/2457))
- test: update LoadingIndicator snapshot for correct output alignment ([#2469](https://github.com/QwenLM/qwen-code/pull/2469))
- correct token limits for MiniMax-M2.5 and GLM models ([#2470](https://github.com/QwenLM/qwen-code/pull/2470))
- update TOS link in VS Code extension README ([#2495](https://github.com/QwenLM/qwen-code/pull/2495))
- preserve modalities during OpenAI logging request conversion ([#2473](https://github.com/QwenLM/qwen-code/pull/2473))
- clean up ACP connection state when child process exits ([#2472](https://github.com/QwenLM/qwen-code/pull/2472))
- vscode-ide-companion: pass proxy configuration to CLI ([#2501](https://github.com/QwenLM/qwen-code/pull/2501))
- include bundled skills directory in published package ([#2521](https://github.com/QwenLM/qwen-code/pull/2521))
- update Discord invite link to permanent URL ([#2535](https://github.com/QwenLM/qwen-code/pull/2535))
- web-fetch: add simplified system instruction to prevent AI greeting responses ([#2610](https://github.com/QwenLM/qwen-code/pull/2610))
- hooks: terminate hook child processes when user exits CLI ([#2607](https://github.com/QwenLM/qwen-code/pull/2607))

### Documentation

- rename QWEN.md to AGENTS.md to follow community best practices ([#2527](https://github.com/QwenLM/qwen-code/pull/2527))
- add Screenshots/Video Demo section to PR template ([#2533](https://github.com/QwenLM/qwen-code/pull/2533))

### Other

- chore: bump version to 0.13.0 ([#2451](https://github.com/QwenLM/qwen-code/pull/2451))
- Fix shell permission parsing and test-created debug artifacts ([#2536](https://github.com/QwenLM/qwen-code/pull/2536))

## [0.12.6](https://github.com/QwenLM/qwen-code/releases/tag/v0.12.6) - 2026-03-17

### Fixed

- improve max_tokens handling with conservative defaults ([#2438](https://github.com/QwenLM/qwen-code/pull/2438))

### Other

- chore: bump version to 0.12.6 ([#2442](https://github.com/QwenLM/qwen-code/pull/2442))

## [0.12.5](https://github.com/QwenLM/qwen-code/releases/tag/v0.12.5) - 2026-03-16

### Fixed

- shell: resolve Windows encoding issues for non-ASCII output ([#2423](https://github.com/QwenLM/qwen-code/pull/2423))

### Other

- test(sdk): simplify integration tests for reliability ([#2410](https://github.com/QwenLM/qwen-code/pull/2410))
- chore: bump version to 0.12.5 ([#2422](https://github.com/QwenLM/qwen-code/pull/2422))

## [0.12.4](https://github.com/QwenLM/qwen-code/releases/tag/v0.12.4) - 2026-03-16

### Added

- skills: add bundled /review skill for out-of-the-box code review ([#2348](https://github.com/QwenLM/qwen-code/pull/2348))
- skills: add docs audit and update helpers ([#2397](https://github.com/QwenLM/qwen-code/pull/2397))

### Fixed

- insight: handle individual LLM failures in qualitative insights (#2341) ([#2361](https://github.com/QwenLM/qwen-code/pull/2361))
- core: add deepseek-r1 to output token limit patterns ([#2362](https://github.com/QwenLM/qwen-code/pull/2362))
- i18n: localize slash command descriptions ([#2333](https://github.com/QwenLM/qwen-code/pull/2333))
- core: guard against empty choices in convertOpenAIResponseToGemini ([#2364](https://github.com/QwenLM/qwen-code/pull/2364))
- extension: disable symlinks on Windows during git clone to fix install failure ([#2286](https://github.com/QwenLM/qwen-code/pull/2286))
- core: reject PDF files to prevent session corruption (fixes #2020) ([#2024](https://github.com/QwenLM/qwen-code/pull/2024))
- cli: allow /dev/ptmx and /dev/ttys* in macOS permissive sandbox ([#2391](https://github.com/QwenLM/qwen-code/pull/2391))
- correct hooks JSON schema type definition ([#2280](https://github.com/QwenLM/qwen-code/pull/2280))
- core: strip orphaned user entries before retry to prevent API errors ([#2367](https://github.com/QwenLM/qwen-code/pull/2367))
- core: correctly capture rapid pty outputs in interactive shell mode ([#2389](https://github.com/QwenLM/qwen-code/pull/2389))
- vscode: prevent race conditions in prompt cancellation and streaming ([#2374](https://github.com/QwenLM/qwen-code/pull/2374))
- core: improve shell tool truncation, simplify tool output handling, and remove summarization ([#2388](https://github.com/QwenLM/qwen-code/pull/2388))
- remove redundant plan files ([#2407](https://github.com/QwenLM/qwen-code/pull/2407))
- core: normalize Windows PATH-like env keys for shell execution ([#1904](https://github.com/QwenLM/qwen-code/pull/1904))
- auto-detect max_tokens from model when not set by provider ([#2356](https://github.com/QwenLM/qwen-code/pull/2356))

### Documentation

- explain Docker sandbox runtime and Java usage ([#1642](https://github.com/QwenLM/qwen-code/pull/1642))
- integration: add ACP Registry for Zed and JetBrains integration docs ([#2372](https://github.com/QwenLM/qwen-code/pull/2372))

### Other

- Docs/subagent system prompt limits ([#2001](https://github.com/QwenLM/qwen-code/pull/2001))
- Keep rejected plan content visible in plan mode ([#2157](https://github.com/QwenLM/qwen-code/pull/2157))
- chore(CODEOWNERS): remove required reviewers for vscode-ide-companion and webui packages ([#2408](https://github.com/QwenLM/qwen-code/pull/2408))
- Increase DEFAULT_OUTPUT_TOKEN_LIMIT from 8K to 16K ([#2411](https://github.com/QwenLM/qwen-code/pull/2411))

## [0.12.3](https://github.com/QwenLM/qwen-code/releases/tag/v0.12.3) - 2026-03-13

### Added

- mcp: improve OAuth auth UX - post-auth feedback, i18n, clear auth, and bug fixes ([#2327](https://github.com/QwenLM/qwen-code/pull/2327))

### Fixed

- ide: resolve IDE connection issues in some VSCode clients and optimize connection config lookup ([#2322](https://github.com/QwenLM/qwen-code/pull/2322))
- core: correct GPT-5.x input token limit to 272K ([#2345](https://github.com/QwenLM/qwen-code/pull/2345))
- shell: pass args as string on Windows to prevent quoting issues ([#2347](https://github.com/QwenLM/qwen-code/pull/2347))
- core: disable node-pty on older Windows builds with broken ConPTY ([#2349](https://github.com/QwenLM/qwen-code/pull/2349))
- improve qwen mcp add option handling for arrays ([#2245](https://github.com/QwenLM/qwen-code/pull/2245))
- cli: prevent Ctrl+F from leaking to PTY as ^F artifact ([#2350](https://github.com/QwenLM/qwen-code/pull/2350))
- core: remove duplicate exports in packages/core/src/index.ts ([#2265](https://github.com/QwenLM/qwen-code/pull/2265))
- cli: remove unused debug log session setup in loadSettings ([#2355](https://github.com/QwenLM/qwen-code/pull/2355))

### Other

- Refactors `FileSystemService` interface to use ACP-aligned request/response objects ([#2344](https://github.com/QwenLM/qwen-code/pull/2344))

## [0.12.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.12.2) - 2026-03-12

### Added

- core: add truncation support to LS tool ([#2324](https://github.com/QwenLM/qwen-code/pull/2324))

### Fixed

- export command should use current session ID instead of loadLastSession ([#2268](https://github.com/QwenLM/qwen-code/pull/2268))
- webui: add Tab key support to CompletionMenu ([#2308](https://github.com/QwenLM/qwen-code/pull/2308))
- core: convert array content to string for DeepSeek API ([#2320](https://github.com/QwenLM/qwen-code/pull/2320))
- improve ACP file operation error handling ([#2298](https://github.com/QwenLM/qwen-code/pull/2298))
- remove QR code from OAuth authentication UI to prevent screen flickering ([#2315](https://github.com/QwenLM/qwen-code/pull/2315))
- clear retry error messages promptly after auto-retry succeeds ([#2326](https://github.com/QwenLM/qwen-code/pull/2326))

### Other

- chore: add yiliang114 as code owner for vscode-ide-companion and webui ([#2312](https://github.com/QwenLM/qwen-code/pull/2312))
- chore: Release v0.12.2 ([#2307](https://github.com/QwenLM/qwen-code/pull/2307))

## [0.12.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.12.1) - 2026-03-11

### Added

- cli: change temporary filename prefix to qwen-edit- ([#2045](https://github.com/QwenLM/qwen-code/pull/2045))
- vscode-ide-companion: add sidebar view and multi-position chat layout ([#2188](https://github.com/QwenLM/qwen-code/pull/2188))

### Fixed

- mcp: use scopes from protected resource metadata (RFC 9728) ([#2212](https://github.com/QwenLM/qwen-code/pull/2212))
- cli: clear static error message when starting new query ([#2110](https://github.com/QwenLM/qwen-code/pull/2110))
- clean up MCP server display and add CONCAT merge strategy for mcp allowed/excluded lists ([#2219](https://github.com/QwenLM/qwen-code/pull/2219))
- hooks: Fix failing hook integration tests by updating hook scripts to create hook_invoke_count.txt ([#2230](https://github.com/QwenLM/qwen-code/pull/2230))
- hooks: Remove useless expect ([#2238](https://github.com/QwenLM/qwen-code/pull/2238))
- core: skip openDiff in YOLO mode to prevent VS Code editor from opening ([#2221](https://github.com/QwenLM/qwen-code/pull/2221))
- cli: suppress Windows pty resize race condition ([#2289](https://github.com/QwenLM/qwen-code/pull/2289))
- vscode-ide-companion: map ENOENT errors to ACP RESOURCE_NOT_FOUND in readTextFile ([#2291](https://github.com/QwenLM/qwen-code/pull/2291))

### Other

- improve readability of context compression description ([#2224](https://github.com/QwenLM/qwen-code/pull/2224))
- refactore: Start qwen after installation ([#2290](https://github.com/QwenLM/qwen-code/pull/2290))

## [0.12.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.12.0) - 2026-03-09

### Added

- add tabWidth support for code highlighting and replace tabs with spaces in CodeColorizer ([#2077](https://github.com/QwenLM/qwen-code/pull/2077))
- export-html: viewer for tool call results ([#2085](https://github.com/QwenLM/qwen-code/pull/2085))
- terminal-capture: add streaming capture with GIF generation ([#2116](https://github.com/QwenLM/qwen-code/pull/2116))
- commands: add custom QC commands for GitHub workflows ([#2117](https://github.com/QwenLM/qwen-code/pull/2117))
- add support for printable CSI-u keys in KeypressContext ([#1827](https://github.com/QwenLM/qwen-code/pull/1827))
- add JSON Schema validation for VS Code settings ([#1830](https://github.com/QwenLM/qwen-code/pull/1830))
- hooks: Implement hooks system infrastructure with CLI and UI management ([#1988](https://github.com/QwenLM/qwen-code/pull/1988))
- shell: enable PTY by default and various enhancements ([#2108](https://github.com/QwenLM/qwen-code/pull/2108))
- Enhance MCP Management TUI with dynamic enable/disable and runtime updates ([#1831](https://github.com/QwenLM/qwen-code/pull/1831))
- Add interactive TUI for extension management ([#2008](https://github.com/QwenLM/qwen-code/pull/2008))
- Implement AskUserQuestionTool for interactive user queries ([#1828](https://github.com/QwenLM/qwen-code/pull/1828))

### Changed

- cli: consolidate message components and fix leading icon display issues ([#2120](https://github.com/QwenLM/qwen-code/pull/2120))
- unify sandbox configuration naming and improve telemetry config ([#1793](https://github.com/QwenLM/qwen-code/pull/1793))
- acp: migrate ACP integration to @agentclientprotocol/sdk ([#2063](https://github.com/QwenLM/qwen-code/pull/2063))

### Fixed

- cli: parse markdown command frontmatter on Windows CRLF/BOM ([#2078](https://github.com/QwenLM/qwen-code/pull/2078))
- cli: ignore stream-json input format in TTY mode to prevent hanging ([#2047](https://github.com/QwenLM/qwen-code/pull/2047))
- core: prevent duplicate function-call yields from trailing stream chunks ([#2125](https://github.com/QwenLM/qwen-code/pull/2125))
- ide: add async DNS check for host.docker.internal in container environments ([#1817](https://github.com/QwenLM/qwen-code/pull/1817))
- handle symlinks during extension installation ([#2056](https://github.com/QwenLM/qwen-code/pull/2056))
- preserve original encoding when reading/writing non-UTF-8 files ([#2073](https://github.com/QwenLM/qwen-code/pull/2073))
- install: Add tips and fix installation issues for installation scripts ([#2118](https://github.com/QwenLM/qwen-code/pull/2118))
- core: add independent retry budget for transient stream anomalies ([#2126](https://github.com/QwenLM/qwen-code/pull/2126))
- windows: resolve silent failures caused by CRLF line endings (#1868) ([#1890](https://github.com/QwenLM/qwen-code/pull/1890))
- cli: keep AGENTS.md enabled by default context reset ([#2082](https://github.com/QwenLM/qwen-code/pull/2082))
- core: remove LLM-based loop detection and enable skipLoopDetection by default ([#2092](https://github.com/QwenLM/qwen-code/pull/2092))
- keyboard: handle Kitty keypad private-use keycodes ([#2137](https://github.com/QwenLM/qwen-code/pull/2137))
- hooks: fix result aggregator for userPromptSubmit and fix enable for integration test ([#2139](https://github.com/QwenLM/qwen-code/pull/2139))
- hooks: Move enable from hooks to hookConfig and add max turns ([#2156](https://github.com/QwenLM/qwen-code/pull/2156))
- Hooks online integration test failed ([#2183](https://github.com/QwenLM/qwen-code/pull/2183))
- improve MCP Management & Extension Management TUI based on 0.12.0 feedback ([#2208](https://github.com/QwenLM/qwen-code/pull/2208))
- test: use toContain instead of toBe for file content assertion ([#2218](https://github.com/QwenLM/qwen-code/pull/2218))

### Other

- chore: bump version to 0.12.0 ([#2090](https://github.com/QwenLM/qwen-code/pull/2090))
- Refactor settings migration to sequential framework with atomic file writes ([#2037](https://github.com/QwenLM/qwen-code/pull/2037))
- chore: add @DragonnZhang to CODEOWNERS ([#2138](https://github.com/QwenLM/qwen-code/pull/2138))

## [0.11.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.11.1) - 2026-03-03

### Added

- support AGENTS.md as default context file ([#2018](https://github.com/QwenLM/qwen-code/pull/2018))
- cli: add Ctrl+Y shortcut to retry failed requests ([#2011](https://github.com/QwenLM/qwen-code/pull/2011))
- cli: improve auth dialog UX with clearer three-option layout ([#2030](https://github.com/QwenLM/qwen-code/pull/2030))
- i18n: strengthen output-language.md template to enforce language compliance ([#2005](https://github.com/QwenLM/qwen-code/pull/2005))

### Changed

- core: extract single tool-call execution path ([#1999](https://github.com/QwenLM/qwen-code/pull/1999))

### Fixed

- subagent: append output-language.md to subagent system prompt and prioritize project-level settings ([#1993](https://github.com/QwenLM/qwen-code/pull/1993))
- core/rateLimit: add support for rate limit error code 1305 and custom retry error codes ([#1995](https://github.com/QwenLM/qwen-code/pull/1995))
- logging: reduce excessive streaming output in session history logs ([#2041](https://github.com/QwenLM/qwen-code/pull/2041))
- add modality defaults to prevent API errors when reading PDFs and other media ([#1982](https://github.com/QwenLM/qwen-code/pull/1982))
- detect and protect against truncated tool call output ([#2021](https://github.com/QwenLM/qwen-code/pull/2021))
- acp: add session/set_config_option method to enable config option updates from Zed UI ([#2059](https://github.com/QwenLM/qwen-code/pull/2059))
- dashscope: support subdomain URL patterns for DashScope provider detection ([#2060](https://github.com/QwenLM/qwen-code/pull/2060))

### Documentation

- update installation instructions ([#1994](https://github.com/QwenLM/qwen-code/pull/1994))

### Other

- chore: bump version to 0.11.1 ([#2026](https://github.com/QwenLM/qwen-code/pull/2026))
- Fix ACP protocol compatibility issues with Zed editor ([#2017](https://github.com/QwenLM/qwen-code/pull/2017))

## [0.11.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.11.0) - 2026-02-28

### Added

- Add clipboard image support and attachment UI to CLI ([#1612](https://github.com/QwenLM/qwen-code/pull/1612))
- support MCP readOnlyHint annotation in plan mode (#1826) ([#1837](https://github.com/QwenLM/qwen-code/pull/1837))
- Add insight command for personalized programming insights ([#1593](https://github.com/QwenLM/qwen-code/pull/1593))
- auth: add automatic backup of settings.json before auth modification ([#1952](https://github.com/QwenLM/qwen-code/pull/1952))
- cli: Increase /insight feature exposure via weighted tips ([#2019](https://github.com/QwenLM/qwen-code/pull/2019))

### Fixed

- Installation script permission check for arch os and add sudo check ([#1877](https://github.com/QwenLM/qwen-code/pull/1877))
- normalize Windows paths to lowercase for case-insensitive session matching ([#1768](https://github.com/QwenLM/qwen-code/pull/1768))
- enforce plan mode restrictions in ACP sessions ([#1812](https://github.com/QwenLM/qwen-code/pull/1812))
- test: keep plan mode active during ACP integration test ([#1956](https://github.com/QwenLM/qwen-code/pull/1956))
- change workspaceFolders capability to boolean for LSP servers ([#1929](https://github.com/QwenLM/qwen-code/pull/1929))
- unblock input after ESC cancel ([#1796](https://github.com/QwenLM/qwen-code/pull/1796))

### Documentation

- enhance modelProviders documentation with comprehensive examples and behavior clarifications ([#1927](https://github.com/QwenLM/qwen-code/pull/1927))
- fix documentation errors in commands and model-providers ([#1962](https://github.com/QwenLM/qwen-code/pull/1962))

### Other

- 📸 terminal-capture: CLI Terminal Screenshot Automation ([#1840](https://github.com/QwenLM/qwen-code/pull/1840))
- chore: bump version to 0.11.0 ([#1953](https://github.com/QwenLM/qwen-code/pull/1953))
- Merge coder-model and qwen3.5-plus, remove vision auto-switching ([#1852](https://github.com/QwenLM/qwen-code/pull/1852))
- Rename GEMINI_CLI_INTEGRATION_TEST to QWEN_CODE_INTEGRATION_TEST and refactor sandbox user handling ([#1966](https://github.com/QwenLM/qwen-code/pull/1966))

## [0.10.6](https://github.com/QwenLM/qwen-code/releases/tag/v0.10.6) - 2026-02-24

### Added

- add third-party models (glm-4.7, kimi-k2.5, qwen3-coder-next) to Coding Plan ([#1907](https://github.com/QwenLM/qwen-code/pull/1907))
- runner: support auth_type for model configuration ([#1874](https://github.com/QwenLM/qwen-code/pull/1874))
- update bailian coding plan models ([#1931](https://github.com/QwenLM/qwen-code/pull/1931))

### Fixed

- fs: Improve BOM detection with length check and codePointAt ([#1857](https://github.com/QwenLM/qwen-code/pull/1857))
- update security vulnerability reporting channel ([#1921](https://github.com/QwenLM/qwen-code/pull/1921))

### Other

- chore: bump version to 0.10.5 ([#1886](https://github.com/QwenLM/qwen-code/pull/1886))
- Fix release workflows: standardize notes generation and add prerelease labels ([#1885](https://github.com/QwenLM/qwen-code/pull/1885))
- chore: exclude .qwen/commands/ and .qwen/skills/ from gitignore ([#1847](https://github.com/QwenLM/qwen-code/pull/1847))

## [0.10.5](https://github.com/QwenLM/qwen-code/releases/tag/v0.10.5) - 2026-02-18

### Added

- add qwen3.5-plus model support for Coding Plan ([#1867](https://github.com/QwenLM/qwen-code/pull/1867))

### Other

- chore: bump version to 0.10.4 ([#1864](https://github.com/QwenLM/qwen-code/pull/1864))

## [0.10.4](https://github.com/QwenLM/qwen-code/releases/tag/v0.10.4) - 2026-02-18

### Documentation

- add news banner about Qwen3.5-Plus launch ([#1854](https://github.com/QwenLM/qwen-code/pull/1854))

### Other

- Fix sandbox user permission in integration tests ([#1843](https://github.com/QwenLM/qwen-code/pull/1843))
- Add Coding Plan Global/Intl region support ([#1860](https://github.com/QwenLM/qwen-code/pull/1860))
- chore: bump version to 0.10.3 ([#1863](https://github.com/QwenLM/qwen-code/pull/1863))

## [0.10.3](https://github.com/QwenLM/qwen-code/releases/tag/v0.10.3) - 2026-02-16

### Added

- update readme ([#1853](https://github.com/QwenLM/qwen-code/pull/1853))

### Documentation

- improve settings.json configuration guide with quick setup examples ([#1850](https://github.com/QwenLM/qwen-code/pull/1850))

### Other

- chore: bump version to 0.10.2 ([#1844](https://github.com/QwenLM/qwen-code/pull/1844))

## [0.10.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.10.2) - 2026-02-14

### Added

- add TPM throttling error handling with 1-minute retry delay ([#1791](https://github.com/QwenLM/qwen-code/pull/1791))

### Changed

- cli: unify Escape key handling in AppContainer ([#1824](https://github.com/QwenLM/qwen-code/pull/1824))

### Fixed

- Fix node installation permission issue in shell script ([#1819](https://github.com/QwenLM/qwen-code/pull/1819))
- prevent AbortSignal listener memory leak ([#1811](https://github.com/QwenLM/qwen-code/pull/1811))
- correct showLineNumbers default value to true ([#1813](https://github.com/QwenLM/qwen-code/pull/1813))
- support JSON Schema draft-2020-12 for MCP tools (fixes #1818) ([#1821](https://github.com/QwenLM/qwen-code/pull/1821))

### Documentation

- update authentication documentation with Coding Plan setup guide ([#1800](https://github.com/QwenLM/qwen-code/pull/1800))

### Other

- chore: bump version to 0.10.1 ([#1808](https://github.com/QwenLM/qwen-code/pull/1808))
- Add dev launch config and preserve existing NODE_OPTIONS ([#1784](https://github.com/QwenLM/qwen-code/pull/1784))
- Fix abort listener accumulation in subagent while loop ([#1825](https://github.com/QwenLM/qwen-code/pull/1825))
- Fix auth UI to use semantic theme colors and correct selection sync ([#1823](https://github.com/QwenLM/qwen-code/pull/1823))
- Add --session-id support for CLI and SDK ([#1822](https://github.com/QwenLM/qwen-code/pull/1822))

## [0.10.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.10.1) - 2026-02-11

### Added

- add MCP tool progress update support in TUI and SDK mode ([#1756](https://github.com/QwenLM/qwen-code/pull/1756))
- add Coding Plan authentication mode with unified AuthDialog ([#1788](https://github.com/QwenLM/qwen-code/pull/1788))
- coding-plan: implement Coding Plan configuration management and update prompts ([#1805](https://github.com/QwenLM/qwen-code/pull/1805))

### Fixed

- Warning in installation shell script ([#1771](https://github.com/QwenLM/qwen-code/pull/1771))
- ui: resolve model not updating in top-right corner ([#1662](https://github.com/QwenLM/qwen-code/pull/1662))
- cli: use PowerShell Get-Command for Windows sandbox detection ([#1604](https://github.com/QwenLM/qwen-code/pull/1604))
- prioritize local path detection in extension installation ([#1770](https://github.com/QwenLM/qwen-code/pull/1770))
- auth-model-login-ui: prevent Enter key from triggering empty message submission ([#1773](https://github.com/QwenLM/qwen-code/pull/1773))

### Other

- Fix SDK MCP integration tests by updating hardcoded tool names to use constants ([#1769](https://github.com/QwenLM/qwen-code/pull/1769))

## [0.10.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.10.0) - 2026-02-09

### Added

- query: add support for resuming sessions with session ID ([#1714](https://github.com/QwenLM/qwen-code/pull/1714))
- Remove Smart Edit tool and ClearcutLogger ([#1684](https://github.com/QwenLM/qwen-code/pull/1684))
- sdk: add resume, continue options and extend authType support ([#1726](https://github.com/QwenLM/qwen-code/pull/1726))
- debug mode output refactor — route console calls to logfile-first debugLogger ([#1610](https://github.com/QwenLM/qwen-code/pull/1610))
- paste: add large paste placeholder and fix enter-submit on macOS ([#1713](https://github.com/QwenLM/qwen-code/pull/1713))
- promote Agent Skills from experimental to stable ([#1738](https://github.com/QwenLM/qwen-code/pull/1738))
- add source information tracking in telemetry logs ([#1653](https://github.com/QwenLM/qwen-code/pull/1653))
- settings: add settings.env field for environment variable configuration ([#1751](https://github.com/QwenLM/qwen-code/pull/1751))

### Changed

- i18n: translate Agent as 智能体 ([#1718](https://github.com/QwenLM/qwen-code/pull/1718))
- remove read_many_files tool, add readManyFiles utility for user @-commands ([#1673](https://github.com/QwenLM/qwen-code/pull/1673))

### Fixed

- docker: fix build error and enable manual version builds ([#1722](https://github.com/QwenLM/qwen-code/pull/1722))
- settings: rename negative settings to positive naming (disable* -> enable*) ([#1330](https://github.com/QwenLM/qwen-code/pull/1330))
- clarify is_background parameter is required in docs and examples ([#1716](https://github.com/QwenLM/qwen-code/pull/1716))
- vscode-ide-companion: Fix UI display issues with server-side timestamp and file path extraction ([#1682](https://github.com/QwenLM/qwen-code/pull/1682))
- ui: resolve auth not updating in top-right corner ([#1670](https://github.com/QwenLM/qwen-code/pull/1670))
- use openai model instead of index=0 in acp integration test ([#1733](https://github.com/QwenLM/qwen-code/pull/1733))
- cli: route sandbox diagnostic messages to stderr ([#1735](https://github.com/QwenLM/qwen-code/pull/1735))
- cli: prevent Tab key from cycling approval mode when autocomplete is active on Windows ([#1736](https://github.com/QwenLM/qwen-code/pull/1736))
- mcp: improve MCP server management and authentication ([#1752](https://github.com/QwenLM/qwen-code/pull/1752))
- core: properly handle MCP multi-part tool results in OpenAI converter ([#1755](https://github.com/QwenLM/qwen-code/pull/1755))
- integration-tests: correct MCP tool name in simple-mcp-server test ([#1763](https://github.com/QwenLM/qwen-code/pull/1763))

### Documentation

- Update Linux/Mac installation commands in README ([#1739](https://github.com/QwenLM/qwen-code/pull/1739))

### Other

- ci(sdk-release): use stable CLI tags for SDK releases ([#1710](https://github.com/QwenLM/qwen-code/pull/1710))
- add hint for installing external source extensions ([#1694](https://github.com/QwenLM/qwen-code/pull/1694))
- Feat/javasdk alpha 202501 ([#1717](https://github.com/QwenLM/qwen-code/pull/1717))
- Add export command for session history with markdown and HTML formats ([#1515](https://github.com/QwenLM/qwen-code/pull/1515))
- Add FORK_MODE support to ProcessTransport for Electron IPC integration ([#1719](https://github.com/QwenLM/qwen-code/pull/1719))
- Fix ACP model selection to handle all configured authentication types ([#1555](https://github.com/QwenLM/qwen-code/pull/1555))
- chore: Reduce Qwen OAuth free quota from 2000 to 1000 requests per day ([#1730](https://github.com/QwenLM/qwen-code/pull/1730))
- Add CLI source selection for SDK releases and fix subagent output handler ([#1732](https://github.com/QwenLM/qwen-code/pull/1732))
- Fix CLI argument parsing for /dist/cli/cli.js entry point ([#1758](https://github.com/QwenLM/qwen-code/pull/1758))

## [0.9.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.9.1) - 2026-02-05

### Added

- core: add symlink support for skill manager ([#1690](https://github.com/QwenLM/qwen-code/pull/1690))
- Preserve UTF-8 BOM when editing files ([#1680](https://github.com/QwenLM/qwen-code/pull/1680))

### Fixed

- core: properly cleanup MCP server subprocesses on exit ([#1285](https://github.com/QwenLM/qwen-code/pull/1285))
- cli: expand MCP @server: resource references ([#1531](https://github.com/QwenLM/qwen-code/pull/1531))
- core: auto-enable WebFetch and WebSearch tools in Plan mode ([#1686](https://github.com/QwenLM/qwen-code/pull/1686))
- normalize skill file content in extensions to handle BOM and CRLF ([#1667](https://github.com/QwenLM/qwen-code/pull/1667))
- ci: honor manual preview version input ([#1665](https://github.com/QwenLM/qwen-code/pull/1665))
- core: handle heredoc in command substitution guard ([#1701](https://github.com/QwenLM/qwen-code/pull/1701))
- core: Preserve trailing whitespace in newString during edits ([#1688](https://github.com/QwenLM/qwen-code/pull/1688))
- enable Shift+Tab shortcut in Windows PowerShell ([#1607](https://github.com/QwenLM/qwen-code/pull/1607))
- core: enforce tool restrictions in subagents ([#1691](https://github.com/QwenLM/qwen-code/pull/1691))

### Other

- test(cli): stabilize AuthDialog ESC assertion ([#1535](https://github.com/QwenLM/qwen-code/pull/1535))
- build: Improve build efficiency and add dev mode ([#1681](https://github.com/QwenLM/qwen-code/pull/1681))
- [AnthropicContentGenerator] optimize: ADD cache_control for system and last user text message ([#1613](https://github.com/QwenLM/qwen-code/pull/1613))

## [0.9.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.9.0) - 2026-02-03

### Added

- core: improve error message when skill is invoked as tool ([#1623](https://github.com/QwenLM/qwen-code/pull/1623))
- core: improve retry logic for better 429/5xx error handling ([#1628](https://github.com/QwenLM/qwen-code/pull/1628))
- add extra_body support for OpenAI-compatible providers ([#1654](https://github.com/QwenLM/qwen-code/pull/1654))
- add multi-modal input support (image, PDF, audio) across all content generators ([#1564](https://github.com/QwenLM/qwen-code/pull/1564))
- clarify output formats for non-interactive mode ([#1579](https://github.com/QwenLM/qwen-code/pull/1579))
- add concurrent runner for batch CLI execution ([#1640](https://github.com/QwenLM/qwen-code/pull/1640))
- webui: implement unified UI architecture with shared component library ([#1543](https://github.com/QwenLM/qwen-code/pull/1543))

### Fixed

- Use resolved authType to initialize ACP agent ([#1622](https://github.com/QwenLM/qwen-code/pull/1622))
- acp: stream subagent text + reasoning chunks ([#1626](https://github.com/QwenLM/qwen-code/pull/1626))
- ensure output-language.md is created before config initialization ([#1637](https://github.com/QwenLM/qwen-code/pull/1637))
- security: prevent command injection via newline bypass in shell command validation ([#1638](https://github.com/QwenLM/qwen-code/pull/1638))
- React/React-DOM version inconsistency in package.json and lockfile ([#1659](https://github.com/QwenLM/qwen-code/pull/1659))
- core: avoid passing undici agent to Anthropic SDK ([#1663](https://github.com/QwenLM/qwen-code/pull/1663))
- vscode-ide-companion: fix race conditions and improve @ file completion search ([#1676](https://github.com/QwenLM/qwen-code/pull/1676))

### Other

- chore: bump version to 0.8.2 ([#1632](https://github.com/QwenLM/qwen-code/pull/1632))
- Add parentToolCallId and subagentType for ACP subagent tracking ([#1620](https://github.com/QwenLM/qwen-code/pull/1620))
- Fix Claude plugin resource collection to respect marketplace config ([#1639](https://github.com/QwenLM/qwen-code/pull/1639))
- Support model selection through ACP in vscode ide companion ([#1582](https://github.com/QwenLM/qwen-code/pull/1582))
- Add Zed extension for Qwen Code agent server ([#1630](https://github.com/QwenLM/qwen-code/pull/1630))
- Add experimental LSP support for code intelligence ([#1401](https://github.com/QwenLM/qwen-code/pull/1401))
- chore: bump version to 0.9.0 ([#1661](https://github.com/QwenLM/qwen-code/pull/1661))
- Add contextWindowSize Configuration Support ([#1539](https://github.com/QwenLM/qwen-code/pull/1539))

## [0.8.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.8.2) - 2026-01-30

_See [GitHub release](https://github.com/QwenLM/qwen-code/releases/tag/v0.8.2) for details._

## [0.8.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.8.1) - 2026-01-27

### Added

- i18n: Add Japanese language support and fix menu labels in other languages ([#1392](https://github.com/QwenLM/qwen-code/pull/1392))
- Add Portuguese (pt-BR) language support with complete translations and refactor i18n architecture for better language management. ([#1616](https://github.com/QwenLM/qwen-code/pull/1616))
- add skills and agents display to extension list with i18n support ([#1629](https://github.com/QwenLM/qwen-code/pull/1629))

### Fixed

- replace EnvHttpProxyAgent with ProxyAgent to suppress experimental warning ([#1624](https://github.com/QwenLM/qwen-code/pull/1624))

### Other

- test: improve SDK integration test reliability with createResultWaiter and ProcessTransport error handling ([#1627](https://github.com/QwenLM/qwen-code/pull/1627))
- chore: bump version to 0.8.1 ([#1631](https://github.com/QwenLM/qwen-code/pull/1631))

## [0.8.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.8.0) - 2026-01-27

### Added

- cli: use dim colors for YOLO/auto-accept mode borders ([#1476](https://github.com/QwenLM/qwen-code/pull/1476))
- Redesign CLI welcome screen and settings dialog ([#1513](https://github.com/QwenLM/qwen-code/pull/1513))
- extensions: add detail command and improve extension validation ([#1580](https://github.com/QwenLM/qwen-code/pull/1580))
- add runtime-aware fetch options for Anthropic and OpenAI providers ([#1516](https://github.com/QwenLM/qwen-code/pull/1516))
- extensions: add plugin selection UI for Claude marketplace ([#1592](https://github.com/QwenLM/qwen-code/pull/1592))
- make DiffRenderer respect ui.showLineNumbers setting ([#1561](https://github.com/QwenLM/qwen-code/pull/1561))
- Implement temporary dismissal for feedback dialogs with persistent prompting ([#1590](https://github.com/QwenLM/qwen-code/pull/1590))

### Fixed

- replace spawn shell option with explicit shell args to avoid Node.js DEP0190 warning ([#1234](https://github.com/QwenLM/qwen-code/pull/1234))
- skip non-existent file imports instead of warning (ENOENT) ([#1563](https://github.com/QwenLM/qwen-code/pull/1563))
- correct schema field name for context.loadFromIncludeDirectories ([#1609](https://github.com/QwenLM/qwen-code/pull/1609))
- vscode-ide-companion: platform-specific builds with optimized VSIX packaging ([#1586](https://github.com/QwenLM/qwen-code/pull/1586))
- cli: pass paths to read_many_files in ACP ([#1614](https://github.com/QwenLM/qwen-code/pull/1614))
- Add toolName metadata for ACP tool call messages ([#1615](https://github.com/QwenLM/qwen-code/pull/1615))
- cli input stream handling and error management ([#1588](https://github.com/QwenLM/qwen-code/pull/1588))

### Documentation

- add Trendshift badge to README ([#1553](https://github.com/QwenLM/qwen-code/pull/1553))

### Other

- chore: remove tiktoken dependency and use API-reported token counts ([#1526](https://github.com/QwenLM/qwen-code/pull/1526))
- Add /bug command to non-interactive mode ([#1552](https://github.com/QwenLM/qwen-code/pull/1552))
- Feat/extension ([#1534](https://github.com/QwenLM/qwen-code/pull/1534))
- fix dependences of core pkg ([#1574](https://github.com/QwenLM/qwen-code/pull/1574))
- fix github pkg dependence ([#1576](https://github.com/QwenLM/qwen-code/pull/1576))
- fix prompts denpendence ([#1578](https://github.com/QwenLM/qwen-code/pull/1578))
- Add VSCode IDE Companion Release Workflow ([#1542](https://github.com/QwenLM/qwen-code/pull/1542))
- Update command usage in add.ts to reflect new name ([#1572](https://github.com/QwenLM/qwen-code/pull/1572))
- Security: Fix awk/sed Command Injection in READ_ONLY_ROOT_COMMANDS ([#1601](https://github.com/QwenLM/qwen-code/pull/1601))
- Simplify permission response handling and fix edit failure and VSCode diff issues ([#1581](https://github.com/QwenLM/qwen-code/pull/1581))

## [0.7.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.7.2) - 2026-01-20

### Added

- cli: add settings support for experimental skills ([#1497](https://github.com/QwenLM/qwen-code/pull/1497))
- Improve QWEN. md file loading by filtering system files and limiting scope ([#1486](https://github.com/QwenLM/qwen-code/pull/1486))
- add user feedback dialog ([#1465](https://github.com/QwenLM/qwen-code/pull/1465))

### Fixed

- include --acp flag in tool exclusion check ([#1499](https://github.com/QwenLM/qwen-code/pull/1499))
- vscode-ide-companion: simplify ELECTRON_RUN_AS_NODE detection and improve README ([#1496](https://github.com/QwenLM/qwen-code/pull/1496))
- mistranslation of token ([#1508](https://github.com/QwenLM/qwen-code/pull/1508))
- unable to remove MCP server when only one element exists ([#1490](https://github.com/QwenLM/qwen-code/pull/1490))
- core: parse skills frontmatter with CRLF/BOM ([#1528](https://github.com/QwenLM/qwen-code/pull/1528))
- cli: relocate skills setting to experimental namespace ([#1538](https://github.com/QwenLM/qwen-code/pull/1538))
- acp: implement session/set_model method for JetBrains compatibility ([#1521](https://github.com/QwenLM/qwen-code/pull/1521))
- resolve arrow key navigation conflict between history and completion ([#1519](https://github.com/QwenLM/qwen-code/pull/1519))
- cli: isolate modelConfigUtils tests from system env vars ([#1545](https://github.com/QwenLM/qwen-code/pull/1545))
- acp: propagate ENOENT errors correctly and centralize error codes ([#1550](https://github.com/QwenLM/qwen-code/pull/1550))
- Update Qwen OAuth model information ([#1548](https://github.com/QwenLM/qwen-code/pull/1548))

### Documentation

- auth: add Coding Plan documentation ([#1509](https://github.com/QwenLM/qwen-code/pull/1509))

### Other

- Fix credential management and authentication flows with improved generation config preservation ([#1510](https://github.com/QwenLM/qwen-code/pull/1510))

## [0.7.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.7.1) - 2026-01-14

### Fixed

- docs ([#1485](https://github.com/QwenLM/qwen-code/pull/1485))

### Other

- Reduce slow quit by trimming skills watchers ([#1489](https://github.com/QwenLM/qwen-code/pull/1489))
- Fix timing issue in LoggingContentGenerator initialization ([#1492](https://github.com/QwenLM/qwen-code/pull/1492))
- chore: bump version to 0.7.1 ([#1494](https://github.com/QwenLM/qwen-code/pull/1494))

## [0.7.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.7.0) - 2026-01-14

### Added

- Modify the selection order of user Settings and workspace Settings ([#1433](https://github.com/QwenLM/qwen-code/pull/1433))
- multi-provider models config support ([#1291](https://github.com/QwenLM/qwen-code/pull/1291))
- skills: add experimental /skills command + hot reload ([#1436](https://github.com/QwenLM/qwen-code/pull/1436))
- shell: add optional timeout for foreground commands ([#1469](https://github.com/QwenLM/qwen-code/pull/1469))
- Customizing the sandbox environment ([#1473](https://github.com/QwenLM/qwen-code/pull/1473))

### Changed

- convert IDE context from JSON to plain text format ([#1424](https://github.com/QwenLM/qwen-code/pull/1424))

### Fixed

- core: ensure OAuth URL always displayed in headless mode ([#1426](https://github.com/QwenLM/qwen-code/pull/1426))
- multi provider cold start issue ([#1439](https://github.com/QwenLM/qwen-code/pull/1439))
- cli: /memory show respects context.fileName ([#1428](https://github.com/QwenLM/qwen-code/pull/1428))
- resolve external editor launch failure on macOS and Windows ([#1351](https://github.com/QwenLM/qwen-code/pull/1351))
- core: handle missing delta in OpenAI stream chunks ([#1448](https://github.com/QwenLM/qwen-code/pull/1448))
- cli: default sandbox UID/GID mapping on Linux ([#1453](https://github.com/QwenLM/qwen-code/pull/1453))
- shell: prevent console window flash on Windows for foreground tasks ([#1464](https://github.com/QwenLM/qwen-code/pull/1464))
- cli: warn on deprecated/unknown settings keys ([#1427](https://github.com/QwenLM/qwen-code/pull/1427))
- core: improve OAuth fetch-failed diagnostics ([#1457](https://github.com/QwenLM/qwen-code/pull/1457))
- SDK release workflow and stability improvements ([#1462](https://github.com/QwenLM/qwen-code/pull/1462))
- vscode-ide-companion: Fix cross-platform CLI terminal execution ([#1474](https://github.com/QwenLM/qwen-code/pull/1474))
- cli: improve error message display for object errors ([#1386](https://github.com/QwenLM/qwen-code/pull/1386))
- Improve qwen-oauth fallback message display ([#1480](https://github.com/QwenLM/qwen-code/pull/1480))
- docs errors and add community contacts ([#1484](https://github.com/QwenLM/qwen-code/pull/1484))

### Documentation

- vscode-ide-companion: update vscode extension readme ([#1472](https://github.com/QwenLM/qwen-code/pull/1472))
- add integration guide for JetBrains IDEs ([#1411](https://github.com/QwenLM/qwen-code/pull/1411))

### Other

- chore: bump version to 0.7.0 ([#1434](https://github.com/QwenLM/qwen-code/pull/1434))
- Support Jupyter Notebook (.ipynb) File Code Selection ([#1460](https://github.com/QwenLM/qwen-code/pull/1460))
- Feature/add custom headers support ([#1447](https://github.com/QwenLM/qwen-code/pull/1447))
- Fix auth type switching and model persistence issues ([#1478](https://github.com/QwenLM/qwen-code/pull/1478))
- Skip flaky permission control test ([#1482](https://github.com/QwenLM/qwen-code/pull/1482))

## [0.6.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.6.2) - 2026-01-12

_See [GitHub release](https://github.com/QwenLM/qwen-code/releases/tag/v0.6.2) for details._

## [0.6.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.6.1) - 2026-01-07

### Added

- i18n: auto-detect LLM output language from system locale ([#1247](https://github.com/QwenLM/qwen-code/pull/1247))
- i18n: update Russian translation with new strings ([#1293](https://github.com/QwenLM/qwen-code/pull/1293))
- i18n: add German language support ([#1378](https://github.com/QwenLM/qwen-code/pull/1378))
- graduate `--experimental-acp` to stable `--acp` flag ([#1355](https://github.com/QwenLM/qwen-code/pull/1355))
- cli: add direct argument support for /approval-mode command ([#1391](https://github.com/QwenLM/qwen-code/pull/1391))
- Optimize the issue where an error message indicating unfriendli… ([#1282](https://github.com/QwenLM/qwen-code/pull/1282))

### Fixed

- core: coerce string boolean values in schema validation ([#1284](https://github.com/QwenLM/qwen-code/pull/1284))
- cli: skip update check when disableUpdateNag is true ([#1397](https://github.com/QwenLM/qwen-code/pull/1397))
- improve tool execution feedback in non-interactive mode ([#1383](https://github.com/QwenLM/qwen-code/pull/1383))
- exit with non-zero code on API errors in text mode ([#1376](https://github.com/QwenLM/qwen-code/pull/1376))
- preserve whitespace in thinking content for stream-json output format ([#1365](https://github.com/QwenLM/qwen-code/pull/1365))
- improve windows background process handling and cleanup ([#1146](https://github.com/QwenLM/qwen-code/pull/1146))
- cli,core: honor `tools.core` / `tools.allowed` in non-interactive runs ([#1406](https://github.com/QwenLM/qwen-code/pull/1406))
- core: don’t force reasoning/topP defaults for OpenAI-compatible APIs ([#1415](https://github.com/QwenLM/qwen-code/pull/1415))

### Documentation

- add AionUi to ecosystem section ([#1360](https://github.com/QwenLM/qwen-code/pull/1360))

### Other

- Fix multi-language and documentation related issues. ([#1332](https://github.com/QwenLM/qwen-code/pull/1332))
- support merge ChatCompletionContentPart && add filterEmptyMessages ([#1288](https://github.com/QwenLM/qwen-code/pull/1288))
- Feat/javasdk ([#1412](https://github.com/QwenLM/qwen-code/pull/1412))
- Doc/qwencode java ([#1414](https://github.com/QwenLM/qwen-code/pull/1414))
- Fix resume command broken after new chat ([#1374](https://github.com/QwenLM/qwen-code/pull/1374))
- chore: bump version to 0.6.1 ([#1423](https://github.com/QwenLM/qwen-code/pull/1423))
- [OpenaiContentGenerate] convertOpenAIResponseToGemini record thoughtsTokenCount ([#1393](https://github.com/QwenLM/qwen-code/pull/1393))

## [0.6.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.6.0) - 2025-12-26

### Added

- add a link to Gemini CLI Desktop for Qwen Code users who prefer desktop UIs ([#286](https://github.com/QwenLM/qwen-code/pull/286))
- add Anthropic provider, normalize auth/env config, and centralize logging ([#1331](https://github.com/QwenLM/qwen-code/pull/1331))
- vscode-ide-companion: in/output part in the bash toolcall can be clicked to open a temporary file ([#1345](https://github.com/QwenLM/qwen-code/pull/1345))
- support /compress and /summary commands for non-interactive & ACP ([#1322](https://github.com/QwenLM/qwen-code/pull/1322))

### Fixed

- cli path parsing issue in Windows ([#1321](https://github.com/QwenLM/qwen-code/pull/1321))
- mcp: update OAuth client name for Figma MCP server compatibility ([#1302](https://github.com/QwenLM/qwen-code/pull/1302))

### Documentation

- readme: clarify value props, usage modes ([#1312](https://github.com/QwenLM/qwen-code/pull/1312))

### Other

- Add Gemini provider, remove legacy Google OAuth, and tune generation … ([#1297](https://github.com/QwenLM/qwen-code/pull/1297))
- Add experimental Skills feature ([#1314](https://github.com/QwenLM/qwen-code/pull/1314))
- chore: revert sdk-typescript version to 0.1.0 and update release workflow ([#1325](https://github.com/QwenLM/qwen-code/pull/1325))
- Follow up on pr #1331 ([#1340](https://github.com/QwenLM/qwen-code/pull/1340))
- fix one flaky integration test ([#1343](https://github.com/QwenLM/qwen-code/pull/1343))
- Enhance VS Code extension description with download link ([#1341](https://github.com/QwenLM/qwen-code/pull/1341))
- fix one flaky integration test ([#1349](https://github.com/QwenLM/qwen-code/pull/1349))
- chore: improve release-sdk workflow ([#1334](https://github.com/QwenLM/qwen-code/pull/1334))
- context left on vscode ide companion ([#1327](https://github.com/QwenLM/qwen-code/pull/1327))

## [0.5.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.5.2) - 2025-12-22

### Other

- pump version to 0.6.0 ([#1309](https://github.com/QwenLM/qwen-code/pull/1309))
- Improve robustness of getProcessInfo with try-catch and empty output fallback ([#1310](https://github.com/QwenLM/qwen-code/pull/1310))
- fix e2e workflow ([#1311](https://github.com/QwenLM/qwen-code/pull/1311))

## [0.5.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.5.1) - 2025-12-19

### Added

- expose gitCoAuthor setting in settings.json and document it ([#1228](https://github.com/QwenLM/qwen-code/pull/1228))
- ui: add /resume slash command to switch between sessions ([#1239](https://github.com/QwenLM/qwen-code/pull/1239))

### Fixed

- handle case-insensitive path comparison in glob tool on Windows ([#1174](https://github.com/QwenLM/qwen-code/pull/1174))
- ide: rename Gemini references to Qwen and fix IDE connection path ([#1205](https://github.com/QwenLM/qwen-code/pull/1205))
- add configurable OpenAPI 3.0 schema compliance for Gemini compatibility (#1186) ([#1214](https://github.com/QwenLM/qwen-code/pull/1214))
- cli: handle PAT tokens and credentials in git remote URL parsing ([#1225](https://github.com/QwenLM/qwen-code/pull/1225))
- cli: add -r and -C aliases for --resume and --continue options ([#1286](https://github.com/QwenLM/qwen-code/pull/1286))
- default values of sampling params ([#1269](https://github.com/QwenLM/qwen-code/pull/1269))
- vscode-ide-companion: Optimize stream termination handling and fix style layering issues ([#1261](https://github.com/QwenLM/qwen-code/pull/1261))
- optimize windows process tree retrieval to prevent hang ([#1231](https://github.com/QwenLM/qwen-code/pull/1231))

### Documentation

- add comprehensive MCP Quick Start guides and examples ([#796](https://github.com/QwenLM/qwen-code/pull/796))
- restructure docs to follow the Claude Code organization ([#1260](https://github.com/QwenLM/qwen-code/pull/1260))

### Other

- Add chat recording toggle (CLI + settings) and disable recording in tests ([#1254](https://github.com/QwenLM/qwen-code/pull/1254))
- pump version to 0.5.1 ([#1259](https://github.com/QwenLM/qwen-code/pull/1259))
- remove one flaky integration test ([#1275](https://github.com/QwenLM/qwen-code/pull/1275))
- docs：Fix the errors in the document ([#1266](https://github.com/QwenLM/qwen-code/pull/1266))
- Bundle CLI into SDK package and separate CLI & SDK E2E tests ([#1265](https://github.com/QwenLM/qwen-code/pull/1265))
- chore(vscode-ide-companion): update vscode engine version from ^1.99.0 to ^1.85.0 ([#1262](https://github.com/QwenLM/qwen-code/pull/1262))
- IDE companion discovery: switch to ~/.qwen/ide lock files ([#1257](https://github.com/QwenLM/qwen-code/pull/1257))

## [0.5.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.5.0) - 2025-12-13

### Added

- i18n: add Russian language support ([#1238](https://github.com/QwenLM/qwen-code/pull/1238))
- show session resume command on exit ([#1219](https://github.com/QwenLM/qwen-code/pull/1219))
- add terminal bell setting to enable/disable audio notifications ([#1194](https://github.com/QwenLM/qwen-code/pull/1194))

### Changed

- vscode-ide-companion: optimize CLI detection and version management ([#1248](https://github.com/QwenLM/qwen-code/pull/1248))

### Fixed

- remove redundant if-check and add tests for OpenAI converter ([#1235](https://github.com/QwenLM/qwen-code/pull/1235))
- vscode-ide-companion: improve cross-platform compatibility in prepackage script ([#1249](https://github.com/QwenLM/qwen-code/pull/1249))

### Other

- test(cli): add tests for /language command and fix LLM output language parsing ([#1236](https://github.com/QwenLM/qwen-code/pull/1236))
- Add ACP authenticate update message ([#1240](https://github.com/QwenLM/qwen-code/pull/1240))
- Remove obsolete “corgi mode” ([#1245](https://github.com/QwenLM/qwen-code/pull/1245))
- Fix/vscode ide companion completion menu content ([#1243](https://github.com/QwenLM/qwen-code/pull/1243))
- Bundle CLI into VSCode release package ([#1246](https://github.com/QwenLM/qwen-code/pull/1246))

## [0.4.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.4.1) - 2025-12-12

### Added

- ui: remove vertical borders from input prompt for easier copy/paste ([#1191](https://github.com/QwenLM/qwen-code/pull/1191))
- VSCode Extension Implementation ([#1059](https://github.com/QwenLM/qwen-code/pull/1059))
- update references from Gemini to Qwen in setup commands and gitignore handling ([#1156](https://github.com/QwenLM/qwen-code/pull/1156))
- Add channel field support for client identification ([#1226](https://github.com/QwenLM/qwen-code/pull/1226))

### Fixed

- prefer UTF-8 encoding for shell output on Windows when detected ([#1157](https://github.com/QwenLM/qwen-code/pull/1157))
- update vulnerable dependencies (glob, jws, tar, js-yaml) ([#1189](https://github.com/QwenLM/qwen-code/pull/1189))
- 修复在docker环境中无法连接ide的问题 ([#1230](https://github.com/QwenLM/qwen-code/pull/1230))
- vscode-ide-companion/auth: deduplicate concurrent authentication calls ([#1223](https://github.com/QwenLM/qwen-code/pull/1223))

### Other

- pump versionm to 0.4.1 ([#1177](https://github.com/QwenLM/qwen-code/pull/1177))
- Feat/acp usage metadata ([#1176](https://github.com/QwenLM/qwen-code/pull/1176))
- pump version to 0.5.0 ([#1233](https://github.com/QwenLM/qwen-code/pull/1233))

## [0.4.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.4.0) - 2025-12-06

### Added

- basic TypeScript SDK ([#1103](https://github.com/QwenLM/qwen-code/pull/1103))

### Fixed

- shell-utils: resolve command detection on Ubuntu by using shell for builtins ([#1123](https://github.com/QwenLM/qwen-code/pull/1123))
- update timeout settings and default logging level in SDK ([#1165](https://github.com/QwenLM/qwen-code/pull/1165))

### Other

- Session-Level Conversation History Management ([#1113](https://github.com/QwenLM/qwen-code/pull/1113))
- pump version to 0.4.0 ([#1132](https://github.com/QwenLM/qwen-code/pull/1132))
- skip one flaky integration test ([#1137](https://github.com/QwenLM/qwen-code/pull/1137))
- Skip acp integration test in sandbox environment ([#1141](https://github.com/QwenLM/qwen-code/pull/1141))
- test: skip qwen-oauth test in containerized environments ([#1150](https://github.com/QwenLM/qwen-code/pull/1150))
- Remove `/quit-confirm` flow ([#1148](https://github.com/QwenLM/qwen-code/pull/1148))
- DeepSeek V3.2 Thinking Mode Integration ([#1134](https://github.com/QwenLM/qwen-code/pull/1134))
- Custom tools support via SDK controlled MCP servers ([#1147](https://github.com/QwenLM/qwen-code/pull/1147))
- test: separating integration tests for the CLI and SDK ([#1161](https://github.com/QwenLM/qwen-code/pull/1161))
- test: skip unstable e2e test ([#1166](https://github.com/QwenLM/qwen-code/pull/1166))

## [0.3.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.3.0) - 2025-11-28

### Added

- i18n: Add Internationalization Support for UI and LLM Output ([#1058](https://github.com/QwenLM/qwen-code/pull/1058))

### Fixed

- ci: remove non-existent label from release failure issue creation ([#1097](https://github.com/QwenLM/qwen-code/pull/1097))
- reset authType settings ([#1091](https://github.com/QwenLM/qwen-code/pull/1091))

### Other

- Headless enhancement: add  `stream-json` as `input-format`/`output-format` to support programmatically use ([#926](https://github.com/QwenLM/qwen-code/pull/926))
- chore: pump version to 0.3.0 ([#1085](https://github.com/QwenLM/qwen-code/pull/1085))
- Improve Usage Statistics by Moving Key Snapshot Fields into Properties ([#1090](https://github.com/QwenLM/qwen-code/pull/1090))

## [0.2.3](https://github.com/QwenLM/qwen-code/releases/tag/v0.2.3) - 2025-11-20

### Changed

- auth: enhance useAuthCommand to include history management … ([#1077](https://github.com/QwenLM/qwen-code/pull/1077))

### Fixed

- character encoding corruption when executing the /copy command on Windows. ([#1069](https://github.com/QwenLM/qwen-code/pull/1069))
- remove broken link ([#1074](https://github.com/QwenLM/qwen-code/pull/1074))

### Other

- chore: pump version to 0.2.3 ([#1073](https://github.com/QwenLM/qwen-code/pull/1073))
- Disable Prompt Completion Feature ([#1076](https://github.com/QwenLM/qwen-code/pull/1076))
- Replace spawn with execFile for memory-safe command execution ([#1068](https://github.com/QwenLM/qwen-code/pull/1068))

## [0.2.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.2.2) - 2025-11-19

### Added

- openApi configurable window ([#1019](https://github.com/QwenLM/qwen-code/pull/1019))
- add support for alternative cached_tokens format in OpenAI conv… ([#1035](https://github.com/QwenLM/qwen-code/pull/1035))
- add support for Trae editor ([#1037](https://github.com/QwenLM/qwen-code/pull/1037))

### Changed

- auth: save authType after successfully authenticated ([#1036](https://github.com/QwenLM/qwen-code/pull/1036))

### Fixed

- core: add modelscope provider to handle stream_options ([#848](https://github.com/QwenLM/qwen-code/pull/848))
- Improve ripgrep binary detection and cross-platform compatibility ([#1060](https://github.com/QwenLM/qwen-code/pull/1060))
- skip problematic integration test ([#1065](https://github.com/QwenLM/qwen-code/pull/1065))

### Other

- chore: pump version to 0.2.2 ([#1027](https://github.com/QwenLM/qwen-code/pull/1027))
- 🎯 Enhance QwenLogger with OS Platform and Version Metadata ([#1053](https://github.com/QwenLM/qwen-code/pull/1053))
- Add Terminal Attention Notifications for User Alerts ([#1052](https://github.com/QwenLM/qwen-code/pull/1052))
- Add (limited) slash command support for ACP integration. ([#1020](https://github.com/QwenLM/qwen-code/pull/1020))
- Fix integration tests ([#1062](https://github.com/QwenLM/qwen-code/pull/1062))

## [0.2.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.2.1) - 2025-11-13

### Added

- enhance zed integration with TodoWriteTool and TaskTool support ([#992](https://github.com/QwenLM/qwen-code/pull/992))

### Fixed

- Stream parsing for Windows Zed integration ([#996](https://github.com/QwenLM/qwen-code/pull/996))
- print request errors for logging only in debug mode ([#1006](https://github.com/QwenLM/qwen-code/pull/1006))

### Other

- chore: pump version to 0.2.1 ([#1005](https://github.com/QwenLM/qwen-code/pull/1005))
- 🔧 Refactor: Standardize Tool Naming and Configuration System ([#1004](https://github.com/QwenLM/qwen-code/pull/1004))
- Fix incorrect tools list format in subagent template documentation ([#1026](https://github.com/QwenLM/qwen-code/pull/1026))
- 🎯 PR: Improve Edit Tool Reliability with Fuzzy Matching Pipeline ([#1025](https://github.com/QwenLM/qwen-code/pull/1025))
- Add Interactive Approval Mode Dialog ([#1012](https://github.com/QwenLM/qwen-code/pull/1012))
- Change deepseek token limits regex patterns for deepseek-chat ([#817](https://github.com/QwenLM/qwen-code/pull/817))

## [0.2.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.2.0) - 2025-11-07

### Added

- Simplify and Improve Search Tools (glob, grep, ripgrep) ([#969](https://github.com/QwenLM/qwen-code/pull/969))

### Changed

- Unifying the system information display between `/about` and `/bug` commands ([#977](https://github.com/QwenLM/qwen-code/pull/977))

### Fixed

- VSCode detection null check and debug message optimization ([#983](https://github.com/QwenLM/qwen-code/pull/983))

### Other

- chore: pump version to 0.1.5 ([#974](https://github.com/QwenLM/qwen-code/pull/974))
- 🎯 Feature: Customizable Model Training and Tool Output Management ([#981](https://github.com/QwenLM/qwen-code/pull/981))
- chore: pump version to 0.2.0 ([#991](https://github.com/QwenLM/qwen-code/pull/991))

## [0.1.5](https://github.com/QwenLM/qwen-code/releases/tag/v0.1.5) - 2025-11-07

### Added

- Simplify and Improve Search Tools (glob, grep, ripgrep) ([#969](https://github.com/QwenLM/qwen-code/pull/969))

### Changed

- Unifying the system information display between `/about` and `/bug` commands ([#977](https://github.com/QwenLM/qwen-code/pull/977))

### Fixed

- VSCode detection null check and debug message optimization ([#983](https://github.com/QwenLM/qwen-code/pull/983))

### Other

- chore: pump version to 0.1.5 ([#974](https://github.com/QwenLM/qwen-code/pull/974))
- 🎯 Feature: Customizable Model Training and Tool Output Management ([#981](https://github.com/QwenLM/qwen-code/pull/981))
- chore: pump version to 0.2.0 ([#991](https://github.com/QwenLM/qwen-code/pull/991))

## [0.1.4](https://github.com/QwenLM/qwen-code/releases/tag/v0.1.4) - 2025-11-05

### Added

- support for custom OpenAI logging directory configuration ([#972](https://github.com/QwenLM/qwen-code/pull/972))

### Fixed

- handle AbortError gracefully when loading commands ([#936](https://github.com/QwenLM/qwen-code/pull/936))

### Other

- chore: pump version to 0.1.4 ([#962](https://github.com/QwenLM/qwen-code/pull/962))
- chore: Web Search Tool Refactoring with Multi-Provider Support ([#885](https://github.com/QwenLM/qwen-code/pull/885))
- Fix kimi2 token limits ([#970](https://github.com/QwenLM/qwen-code/pull/970))

## [0.1.3](https://github.com/QwenLM/qwen-code/releases/tag/v0.1.3) - 2025-11-04

### Fixed

- Include macOS Seatbelt Sandbox Files in NPM Package ([#949](https://github.com/QwenLM/qwen-code/pull/949))

### Other

- chore: pump version to 0.1.3 ([#939](https://github.com/QwenLM/qwen-code/pull/939))
- 🐛 Fix: `/ide install` command fails on Windows ([#957](https://github.com/QwenLM/qwen-code/pull/957))
- Fix unhandled promise rejection on connecting to VSCode companion ([#958](https://github.com/QwenLM/qwen-code/pull/958))

## [0.1.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.1.2) - 2025-10-31

### Fixed

- Use runtime session ID in /bug command ([#927](https://github.com/QwenLM/qwen-code/pull/927))
- update tool name from Gemini to Qwen Code in ToolsList component… ([#933](https://github.com/QwenLM/qwen-code/pull/933))
- settings: add version field to prevent partial migration corruption ([#937](https://github.com/QwenLM/qwen-code/pull/937))

### Other

- chore: pump version to v0.1.2 ([#907](https://github.com/QwenLM/qwen-code/pull/907))
- fixbug: fix qwen help des ([#915](https://github.com/QwenLM/qwen-code/pull/915))
- 🔍 Refactor and Enhance Ripgrep Tool ([#930](https://github.com/QwenLM/qwen-code/pull/930))
- change Launch Gemini CLI to Qwen Code CLI in help information ([#929](https://github.com/QwenLM/qwen-code/pull/929))
- Fix Chat Compression System Instruction and Empty Summary Edge Case ([#935](https://github.com/QwenLM/qwen-code/pull/935))

## [0.1.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.1.1) - 2025-10-29

### Fixed

- e2e test ([#905](https://github.com/QwenLM/qwen-code/pull/905))

### Other

- chore: pump version to 0.1.1 ([#883](https://github.com/QwenLM/qwen-code/pull/883))
- fix input filter ([#892](https://github.com/QwenLM/qwen-code/pull/892))
- 🐛 Bug Fixes Release v0.1.1 ([#898](https://github.com/QwenLM/qwen-code/pull/898))
- [to #12345678] docs: update excludeTools documentation in extensions … ([#904](https://github.com/QwenLM/qwen-code/pull/904))

## [0.1.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.1.0) - 2025-10-27

### Fixed

- Invalid Tool Calls Due to Improper Request Cancellation ([#790](https://github.com/QwenLM/qwen-code/pull/790))
- remove unavailable options ([#685](https://github.com/QwenLM/qwen-code/pull/685))
- token limits for qwen3-max ([#724](https://github.com/QwenLM/qwen-code/pull/724))
- add missing trace info and cancellation events ([#791](https://github.com/QwenLM/qwen-code/pull/791))
- unable to quit when auth dialog is opened ([#804](https://github.com/QwenLM/qwen-code/pull/804))

### Documentation

- add /model command documentation ([#872](https://github.com/QwenLM/qwen-code/pull/872))

### Other

- chore: remove default topp & temperature value ([#785](https://github.com/QwenLM/qwen-code/pull/785))
- Fix and update the token limits handling ([#754](https://github.com/QwenLM/qwen-code/pull/754))
- chore: re-organize labels for better triage results ([#819](https://github.com/QwenLM/qwen-code/pull/819))
- Sync upstream Gemini-CLI v0.8.2 ([#838](https://github.com/QwenLM/qwen-code/pull/838))
- chore: Adjusted docs directory structure ([#864](https://github.com/QwenLM/qwen-code/pull/864))
- 📦 Release qwen-code CLI as a Standalone Bundled Package ([#866](https://github.com/QwenLM/qwen-code/pull/866))
- Standardize Tool Output Format for Better LLM Communication ([#881](https://github.com/QwenLM/qwen-code/pull/881))

## [0.0.14](https://github.com/QwenLM/qwen-code/releases/tag/v0.0.14) - 2025-09-29

### Added

- Implement Plan Mode for Safe Code Planning ([#658](https://github.com/QwenLM/qwen-code/pull/658))
- Add Qwen3-VL-Plus token limits (256K input, 32K output) ([#720](https://github.com/QwenLM/qwen-code/pull/720))

### Fixed

- TaskTool Dynamic Updates ([#697](https://github.com/QwenLM/qwen-code/pull/697))

### Other

- chore: bump version to 0.0.13 ([#695](https://github.com/QwenLM/qwen-code/pull/695))
- 🐛 Remove unreliable editCorrector that injects extra escape characters ([#713](https://github.com/QwenLM/qwen-code/pull/713))
- Fix/qwen3 vl plus highres ([#721](https://github.com/QwenLM/qwen-code/pull/721))
- 🚀 feat: DashScope cache control enhancement ([#735](https://github.com/QwenLM/qwen-code/pull/735))

## [0.0.13](https://github.com/QwenLM/qwen-code/releases/tag/v0.0.13) - 2025-09-24

### Added

- add OpenAI and Qwen OAuth auth support to Zed ACP integration ([#678](https://github.com/QwenLM/qwen-code/pull/678))
- add yolo mode support to auto vision model switch ([#652](https://github.com/QwenLM/qwen-code/pull/652))

### Fixed

- output token limit for qwen ([#664](https://github.com/QwenLM/qwen-code/pull/664))
- auth hang when select qwen-oauth in Zed ([#684](https://github.com/QwenLM/qwen-code/pull/684))
- ripgrep load issue ([#676](https://github.com/QwenLM/qwen-code/pull/676))

### Other

- chore: bump version to 0.0.12 ([#662](https://github.com/QwenLM/qwen-code/pull/662))
- 🐛 Fix: Resolve Markdown list display issues on Windows ([#693](https://github.com/QwenLM/qwen-code/pull/693))

## [0.0.12](https://github.com/QwenLM/qwen-code/releases/tag/v0.0.12) - 2025-09-19

### Added

- Enhance /init command with confirmation prompt ([#624](https://github.com/QwenLM/qwen-code/pull/624))

### Fixed

- Windows Multi-line Paste Handling with Debounced Data Processing ([#627](https://github.com/QwenLM/qwen-code/pull/627))
- subagent system improvements and UI fixes ([#638](https://github.com/QwenLM/qwen-code/pull/638))
- reset is_background ([#644](https://github.com/QwenLM/qwen-code/pull/644))
- switch system prompt to avoid malformed tool_calls ([#650](https://github.com/QwenLM/qwen-code/pull/650))
- missing tool call chunks for openai logging ([#657](https://github.com/QwenLM/qwen-code/pull/657))
- arrow keys on windows ([#661](https://github.com/QwenLM/qwen-code/pull/661))

### Other

- chore: bump version to 0.0.11 ([#622](https://github.com/QwenLM/qwen-code/pull/622))
- Add `skipLoopDetection` Configuration Option ([#610](https://github.com/QwenLM/qwen-code/pull/610))
- Chore/sync gemini cli v0.3.4 ([#605](https://github.com/QwenLM/qwen-code/pull/605))
- Enable tool call type coersion ([#477](https://github.com/QwenLM/qwen-code/pull/477))
- Vision model support for Qwen-OAuth ([#525](https://github.com/QwenLM/qwen-code/pull/525))

## [0.0.11](https://github.com/QwenLM/qwen-code/releases/tag/v0.0.11) - 2025-09-12

### Added

- Update the multilingual documentation links in the README ([#536](https://github.com/QwenLM/qwen-code/pull/536))
- Add Welcome Back Dialog, Project Summary, and Enhanced Quit Options ([#553](https://github.com/QwenLM/qwen-code/pull/553))
- Replace all Gemini CLI brand references with Qwen Code. ([#588](https://github.com/QwenLM/qwen-code/pull/588))

### Changed

- cli: update OpenAI API key prompt with Bailian URL ([#50](https://github.com/QwenLM/qwen-code/pull/50))
- openaiContentGenerator ([#501](https://github.com/QwenLM/qwen-code/pull/501))

### Fixed

- update OpenAIKeyPrompt test to expect Alibaba Cloud API URL ([#560](https://github.com/QwenLM/qwen-code/pull/560))
- resolve EditTool naming inconsistency causing agent confusion loops ([#513](https://github.com/QwenLM/qwen-code/pull/513))
- unexpected re-auth when auth-token is expired ([#549](https://github.com/QwenLM/qwen-code/pull/549))
- relax chunk validation to avoid unnecessary retry ([#584](https://github.com/QwenLM/qwen-code/pull/584))
- clear saved creds when switching authType ([#587](https://github.com/QwenLM/qwen-code/pull/587))
- tool calls ui issues ([#590](https://github.com/QwenLM/qwen-code/pull/590))

### Other

- chore: add configurable cache control ([#498](https://github.com/QwenLM/qwen-code/pull/498))
- chore: pump version to 0.0.10 ([#502](https://github.com/QwenLM/qwen-code/pull/502))
- Terminal Bench Integration Test ([#521](https://github.com/QwenLM/qwen-code/pull/521))
- Fix E2E caused by Terminal Bench test ([#529](https://github.com/QwenLM/qwen-code/pull/529))
- Re-implement tokenLimits class to make it work correctly for Qwen and… ([#542](https://github.com/QwenLM/qwen-code/pull/542))
- Fix packages/cli/src/config/config.test.ts ([#562](https://github.com/QwenLM/qwen-code/pull/562))
- 🎯 Subagents Feature ([#573](https://github.com/QwenLM/qwen-code/pull/573))
- Make the ReadManyFiles tool share the "DEFAULT_MAX_LINES_TEXT_FILE" limit across files. ([#563](https://github.com/QwenLM/qwen-code/pull/563))
- Fix performance issues with SharedTokenManager causing 20-minute delays ([#586](https://github.com/QwenLM/qwen-code/pull/586))

## [0.0.10](https://github.com/QwenLM/qwen-code/releases/tag/v0.0.10) - 2025-09-02

### Documentation

- Add homebrew install ([#474](https://github.com/QwenLM/qwen-code/pull/474))

### Other

- chore: bump version to 0.0.9 ([#468](https://github.com/QwenLM/qwen-code/pull/468))
- 🚀 Add Todo Write Tool for Task Management and Progress Tracking ([#478](https://github.com/QwenLM/qwen-code/pull/478))
- # 🚀 Sync Gemini CLI v0.2.1 - Major Feature Update ([#483](https://github.com/QwenLM/qwen-code/pull/483))

## [0.0.9](https://github.com/QwenLM/qwen-code/releases/tag/v0.0.9) - 2025-08-27

### Added

- update /docs link ([#438](https://github.com/QwenLM/qwen-code/pull/438))

### Fixed

- add explicit is_background param for shell tool ([#445](https://github.com/QwenLM/qwen-code/pull/445))
- sync token among multiple qwen sessions ([#443](https://github.com/QwenLM/qwen-code/pull/443))
- ambiguous literals ([#461](https://github.com/QwenLM/qwen-code/pull/461))

### Other

- chore: pump version to 0.0.8 ([#421](https://github.com/QwenLM/qwen-code/pull/421))
- Sync upstream gemini-cli v0.1.21 ([#398](https://github.com/QwenLM/qwen-code/pull/398))
- Fix GitHub Workflows Configuration Issues ([#451](https://github.com/QwenLM/qwen-code/pull/451))
- Fix parallel tool use ([#400](https://github.com/QwenLM/qwen-code/pull/400))
- Fix race condition in submitQuery preventing tool response continuations ([#458](https://github.com/QwenLM/qwen-code/pull/458))
- use sub-command to switch between project and global memory ops ([#450](https://github.com/QwenLM/qwen-code/pull/450))
- 🔧 Miscellaneous Improvements and Refactoring ([#466](https://github.com/QwenLM/qwen-code/pull/466))

## [0.0.8](https://github.com/QwenLM/qwen-code/releases/tag/v0.0.8) - 2025-08-22

### Added

- use .geminiignore in grep tool ([#349](https://github.com/QwenLM/qwen-code/pull/349))
- Add deterministic cache control ([#411](https://github.com/QwenLM/qwen-code/pull/411))

### Fixed

- revert trimEnd on LLM response content ([#397](https://github.com/QwenLM/qwen-code/pull/397))
- Critical Issues in v0.0.8-nightly.7 ([#419](https://github.com/QwenLM/qwen-code/pull/419))

### Documentation

- Update security policy with Alibaba contact information ([#390](https://github.com/QwenLM/qwen-code/pull/390))

### Other

- Chore/release 0.0.7 ([#343](https://github.com/QwenLM/qwen-code/pull/343))
- support: project/global save location option. ([#368](https://github.com/QwenLM/qwen-code/pull/368))
- doc: Add links to translated README versions ([#171](https://github.com/QwenLM/qwen-code/pull/171))
- Sync upstream gemini-cli v0.1.19 ([#364](https://github.com/QwenLM/qwen-code/pull/364))
- 🚀 Enhance Release Notes Generation with Previous Tag Detection ([#394](https://github.com/QwenLM/qwen-code/pull/394))
- Update Documentation Branding from Gemini CLI to Qwen Code ([#391](https://github.com/QwenLM/qwen-code/pull/391))
- Fix prompt re-submission ([#392](https://github.com/QwenLM/qwen-code/pull/392))
- Fix GitHub Workflows for Issue Triage ([#396](https://github.com/QwenLM/qwen-code/pull/396))
- Limit grep result ([#407](https://github.com/QwenLM/qwen-code/pull/407))

## [0.0.7](https://github.com/QwenLM/qwen-code/releases/tag/v0.0.7) - 2025-08-15

### Added

- sandbox: add GHA to build sandbox image ([#262](https://github.com/QwenLM/qwen-code/pull/262))
- prevent concurrent query submissions in useGeminiStream hook ([#322](https://github.com/QwenLM/qwen-code/pull/322))
- refactor web-fetch tool to remove google genai dependency ([#340](https://github.com/QwenLM/qwen-code/pull/340))

### Fixed

- qwen logger exit handler setup ([#325](https://github.com/QwenLM/qwen-code/pull/325))
- seperate static QR code and dynamic spin components ([#327](https://github.com/QwenLM/qwen-code/pull/327))
- OpenAI tools ([#328](https://github.com/QwenLM/qwen-code/pull/328))
- custom API's trailing space and empty tool id issues ([#326](https://github.com/QwenLM/qwen-code/pull/326))

### Other

- chore: add api request logger ([#313](https://github.com/QwenLM/qwen-code/pull/313))
- Sync with upstream gemini-cli v0.1.18 ([#309](https://github.com/QwenLM/qwen-code/pull/309))
- chore: bump version to 0.0.6 ([#323](https://github.com/QwenLM/qwen-code/pull/323))
- Migrate web search from Google/Gemini to Tavily API ([#329](https://github.com/QwenLM/qwen-code/pull/329))
- Update qwen-code-pr-review.yml ([#342](https://github.com/QwenLM/qwen-code/pull/342))

## [0.0.6](https://github.com/QwenLM/qwen-code/releases/tag/v0.0.6) - 2025-08-12

### Added

- add usage statistics logging for Qwen integration ([#284](https://github.com/QwenLM/qwen-code/pull/284))

### Fixed

- rename make run-npx from gemini to qwen ([#242](https://github.com/QwenLM/qwen-code/pull/242))
- terminal flicker when waiting for login ([#248](https://github.com/QwenLM/qwen-code/pull/248))
- openaiContentGenerator ([#283](https://github.com/QwenLM/qwen-code/pull/283))
- 🐛 fix EPERM error when run `qwen --sandbox` in macOS ([#293](https://github.com/QwenLM/qwen-code/pull/293))

### Other

- rename GEMINI.md to QWEN.md across the codebase ([#235](https://github.com/QwenLM/qwen-code/pull/235))
- Fix README.md: Replace /status command with /stats command in documen… ([#266](https://github.com/QwenLM/qwen-code/pull/266))
- Make `/init` respect configured context filename and align docs with QWEN.md ([#274](https://github.com/QwenLM/qwen-code/pull/274))
- chore: adjust workflow to run PR review ([#297](https://github.com/QwenLM/qwen-code/pull/297))
- Chore/pkg version ([#298](https://github.com/QwenLM/qwen-code/pull/298))

## [0.0.5](https://github.com/QwenLM/qwen-code/releases/tag/v0.0.5) - 2025-08-08

### Added

- Add systemPromptMappings Configuration Feature ([#108](https://github.com/QwenLM/qwen-code/pull/108))
- update /bug command to point to Qwen-Code repo ([#154](https://github.com/QwenLM/qwen-code/pull/154))
- add qwencoder as co-author ([#207](https://github.com/QwenLM/qwen-code/pull/207))
- oauth: add Qwen OAuth integration ([#225](https://github.com/QwenLM/qwen-code/pull/225))

### Fixed

- resolve RadioButtonSelect array bounds crash and auth dialog navigation ([#46](https://github.com/QwenLM/qwen-code/pull/46))
- streaming token usage ([#102](https://github.com/QwenLM/qwen-code/pull/102))
- Enhanced OpenAI Usage Logging and Response Metadata Handling ([#141](https://github.com/QwenLM/qwen-code/pull/141))

### Other

- pre-release: fix ci ([#1](https://github.com/QwenLM/qwen-code/pull/1))
- fix login preflight & sync with npm version ([#55](https://github.com/QwenLM/qwen-code/pull/55))
- add star history ([#109](https://github.com/QwenLM/qwen-code/pull/109))
- update: add info about modelscope-api ([#116](https://github.com/QwenLM/qwen-code/pull/116))
- Fix Default Model Configuration and Fallback Behavior ([#142](https://github.com/QwenLM/qwen-code/pull/142))
- Update: shrink/hard constrained token usage ([#136](https://github.com/QwenLM/qwen-code/pull/136))
- Fix E2E ([#156](https://github.com/QwenLM/qwen-code/pull/156))
- Fix Sandbox docker mode ([#160](https://github.com/QwenLM/qwen-code/pull/160))
- Support openrouter ([#162](https://github.com/QwenLM/qwen-code/pull/162))
- Update: add telemetry service ([#161](https://github.com/QwenLM/qwen-code/pull/161))
- Update README.md to clarify the requirement for using Modelscope inference API ([#131](https://github.com/QwenLM/qwen-code/pull/131))
- fix config ([#163](https://github.com/QwenLM/qwen-code/pull/163))
- fix release workflow ([#172](https://github.com/QwenLM/qwen-code/pull/172))
- sync gemini cli 0.1.15 ([#175](https://github.com/QwenLM/qwen-code/pull/175))
- fix e2e ([#185](https://github.com/QwenLM/qwen-code/pull/185))
- fix system md ([#189](https://github.com/QwenLM/qwen-code/pull/189))
- sync gemini cli 0.1.17 ([#206](https://github.com/QwenLM/qwen-code/pull/206))
- chore: remove google registry ([#227](https://github.com/QwenLM/qwen-code/pull/227))

## [0.0.4](https://github.com/QwenLM/qwen-code/releases/tag/v0.0.4) - 2025-08-03

### Other

- sync gemini cli 0.1.15 ([#175](https://github.com/QwenLM/qwen-code/pull/175))
- fix e2e ([#185](https://github.com/QwenLM/qwen-code/pull/185))
- fix system md ([#189](https://github.com/QwenLM/qwen-code/pull/189))

## [0.0.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.0.2) - 2025-08-01

_See [GitHub release](https://github.com/QwenLM/qwen-code/releases/tag/v0.0.2) for details._
