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

## [0.23.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.23.0) - 2026-09-03

### Highlights

_See the complete change list below._

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- The branch picker now displays git state hints like '↓3 · origin/main' or 'Up to date' beside Update Project, Commit, and Push actions to help users judge status before clicking. ([#10397](https://github.com/QwenLM/qwen-code/pull/10397)) by @wenshao
- Adds the qwen review emit-workflow subcommand to generate a deterministic script that executes Review Step 3A's agent fan-out using parallel() instead of manual orchestration. ([#10119](https://github.com/QwenLM/qwen-code/pull/10119)) by @qqqys
- The Web Shell 'Add workspace' dialog now hides the Browse button on headless daemon hosts that lack native directory picker capabilities like zenity or osascript. ([#9406](https://github.com/QwenLM/qwen-code/pull/9406)) by @qqqys
- Adds support for scoped workspace memory tasks with project or user targets, enforcing strict filesystem permission boundaries between stores during remember and forget operations. ([#9895](https://github.com/QwenLM/qwen-code/pull/9895)) by @qqqys
- Added a QR code button to the Web Shell header for quick Local Control pairing, with direct navigation to Settings if the feature is disabled. ([#10432](https://github.com/QwenLM/qwen-code/pull/10432)) by @wenshao
- Enables the takeover loop to consume review convergence signals via a new ledger marker containing matched recommendation codes. ([#10122](https://github.com/QwenLM/qwen-code/pull/10122)) by @wenshao
- Optimizes the Session Overview table with responsive columns, sorting, filtering, and improved handling for session management actions. ([#10115](https://github.com/QwenLM/qwen-code/pull/10115)) by @ytahdn
- Adds per-run scheduled task sessions in Web Shell, creating fresh child conversations with unique timestamps for each execution. ([#10233](https://github.com/QwenLM/qwen-code/pull/10233)) by @qqqys
- Removes the public-only network policy restriction in qwen serve, allowing extension installs from enterprise-private Git hosts. ([#10156](https://github.com/QwenLM/qwen-code/pull/10156)) by @callmeYe
- feat(core): address other sessions by name from send_message and list_agents ([#10158](https://github.com/QwenLM/qwen-code/pull/10158)) by @qqqys
- Added explicit daemon session contexts for workspace, standalone, and Live conversations to improve routing and runtime resolution. ([#10418](https://github.com/QwenLM/qwen-code/pull/10418)) by @doudouOUC
- feat(core): report compression API failures distinctly ([#9119](https://github.com/QwenLM/qwen-code/pull/9119)) by @xianjianlf2
- Automatically assigns exactly one accountable maintainer to new PRs touching mapped areas and resolves a single owner when automated triage defers a PR. ([#9813](https://github.com/QwenLM/qwen-code/pull/9813)) by @yiliang114
- Forwards bounded MCP tool arguments and server annotations to the AUTO-mode classifier to improve decision accuracy beyond tool names alone. ([#10352](https://github.com/QwenLM/qwen-code/pull/10352)) by @qqqys
- Enabled full operator API access on trusted loopback interfaces for qwen serve when no bearer token is configured and authentication is not explicitly required. ([#10403](https://github.com/QwenLM/qwen-code/pull/10403)) by @doudouOUC
- Named Channel tasks now include source attribution labels like [task] or [sender · task] in their output for better delivery correlation. ([#10420](https://github.com/QwenLM/qwen-code/pull/10420)) by @doudouOUC
- Enhanced the Web Shell sidebar to display workspace session counts, full paths, and detailed chips for MCP servers, skills, extensions, and context files. ([#10407](https://github.com/QwenLM/qwen-code/pull/10407)) by @wenshao
- Exposed Workflow execution controls via the daemon, allowing clients to inspect, cancel, pause, resume, retry, and delete runs while preserving legacy task contracts. ([#10411](https://github.com/QwenLM/qwen-code/pull/10411)) by @qqqys
- Lays the foundation for OpenTUI migration by adding new renderer modules for themes, accessibility, clipboard, key mapping, and dialog scaffolding. ([#10146](https://github.com/QwenLM/qwen-code/pull/10146)) by @chiga0
- Enables concurrent named task control in Channels, allowing background tasks to run while users switch contexts, and adds /session cancel support. ([#10574](https://github.com/QwenLM/qwen-code/pull/10574)) by @doudouOUC
- Web Shell terminal error messages now include a Copy action that copies the exact rendered error text with a visual confirmation. ([#10001](https://github.com/QwenLM/qwen-code/pull/10001)) by @Wkewen
- Workspace runtime ownership is now established as the daemon lifecycle boundary, ensuring runtime activity persists through workspace removal and shutdown. ([#10593](https://github.com/QwenLM/qwen-code/pull/10593)) by @ytahdn
- Workspace-scoped Extension skill state can now be managed via a batch API, allowing independent overrides while keeping parent Extension settings authoritative. ([#10600](https://github.com/QwenLM/qwen-code/pull/10600)) by @callmeYe
- Operators can now configure or disable the Goal token budget using the model.goalTokenBudget setting, with support for values from 1 to 300,000,000 or -1 for unlimited. ([#10543](https://github.com/QwenLM/qwen-code/pull/10543)) by @qqqys
- The model now receives a per-turn reminder about the active output style to ensure concise responses when non-default styles are enabled. ([#10282](https://github.com/QwenLM/qwen-code/pull/10282)) by @qqqys
- Enables the external-context-mem0 Extension to load administrator-owned Mem0 dialects via absolute paths in InstanceConfigV2. ([#10634](https://github.com/QwenLM/qwen-code/pull/10634)) by @doudouOUC
- Added a sessionless POST /language route to synchronize user-level language preferences across all runtimes before any session exists. ([#10554](https://github.com/QwenLM/qwen-code/pull/10554)) by @doudouOUC
- Sessions bound to GitHub PRs now display linked issues closed by those PRs in the Web Shell tooltip and support searching sessions by issue number. ([#10425](https://github.com/QwenLM/qwen-code/pull/10425)) by @wenshao
- feat(serve): allow relocating session attachment storage via env var ([#10066](https://github.com/QwenLM/qwen-code/pull/10066)) by @ytahdn
- Adds the live-session stream, input layer, and composer to the OpenTUI migration, enabling streaming markdown, tool runs, and unified-diff rendering. ([#10368](https://github.com/QwenLM/qwen-code/pull/10368)) by @chiga0
- Improves channel fallback permission prompts with specific tool details and hides internal error data in DingTalk failure messages. ([#10614](https://github.com/QwenLM/qwen-code/pull/10614)) by @qqqys
- Allows the Web Shell Update Project action to proceed on dirty working trees by offering options to stash or discard local changes. ([#10390](https://github.com/QwenLM/qwen-code/pull/10390)) by @wenshao
- Lets DWS channels customize the start and end reaction emojis shown during task execution and completion states. ([#10610](https://github.com/QwenLM/qwen-code/pull/10610)) by @qqqys
- feat(cli): select an output style via general.outputStyle or --output-style ([#10283](https://github.com/QwenLM/qwen-code/pull/10283)) by @qqqys
- feat(qwen-live): standalone voice daemon package — M1 + M2 ([#10367](https://github.com/QwenLM/qwen-code/pull/10367)) by @LaZzyMan
- feat(cli): OpenTUI migration batch 4 — dialogs, commands, and session-rewind ([#10383](https://github.com/QwenLM/qwen-code/pull/10383)) by @chiga0
- feat(goal): let the model propose a Goal the user approves in a dialog ([#10171](https://github.com/QwenLM/qwen-code/pull/10171)) by @qqqys
- feat(web-shell): Add standalone chats ([#10514](https://github.com/QwenLM/qwen-code/pull/10514)) by @doudouOUC
- feat(cli): hot-reload modelProviders without session restart ([#10582](https://github.com/QwenLM/qwen-code/pull/10582)) by @yiliang114
- feat(web-shell): add an experimental session workflow cockpit ([#8583](https://github.com/QwenLM/qwen-code/pull/8583)) by @yiliang114
- feat(web-shell): search conversation content in the sidebar session search ([#10612](https://github.com/QwenLM/qwen-code/pull/10612)) by @wenshao
- feat(opentui): Add the backend composition root (Batch 5) ([#10696](https://github.com/QwenLM/qwen-code/pull/10696)) by @chiga0
- feat(web-shell): add a Workspaces overview panel ([#10589](https://github.com/QwenLM/qwen-code/pull/10589)) by @wenshao
- feat(review): prebuild the review worktree before any agent runs ([#10423](https://github.com/QwenLM/qwen-code/pull/10423)) by @wenshao
- feat(web-shell): declutter the workspace sidebar and add loopback open actions ([#10606](https://github.com/QwenLM/qwen-code/pull/10606)) by @wenshao
- feat(external-context): Publish the Mem0 Extension package ([#10653](https://github.com/QwenLM/qwen-code/pull/10653)) by @doudouOUC
- feat(core): bind PRs created via gh pr create in the session shell ([#9739](https://github.com/QwenLM/qwen-code/pull/9739)) by @wenshao
- feat(web-shell): group scheduled task run sessions ([#10611](https://github.com/QwenLM/qwen-code/pull/10611)) by @qqqys
- feat(cli): add /output-style command with picker and mid-session switching ([#10683](https://github.com/QwenLM/qwen-code/pull/10683)) by @qqqys
- feat(ipc): authenticate cross-session inbox connections with per-session tokens ([#10636](https://github.com/QwenLM/qwen-code/pull/10636)) by @qqqys
- feat(qwen-live): ACP backend adaptor and multi-backend routing — M4 ([#10617](https://github.com/QwenLM/qwen-code/pull/10617)) by @LaZzyMan
- feat(opentui): Activate the OpenTUI backend behind QWEN_TUI_RENDERER ([#10739](https://github.com/QwenLM/qwen-code/pull/10739)) by @chiga0
- feat(ipc): give the session's own processes a child token the inbound gate recognizes ([#10764](https://github.com/QwenLM/qwen-code/pull/10764)) by @qqqys
- feat(opentui): bundle assets, CI matrix and parity tooling (Batch 7) ([#10770](https://github.com/QwenLM/qwen-code/pull/10770)) by @chiga0
- feat(daemon): name the saturated NDJSON budget in channel-teardown diagnostics ([#10727](https://github.com/QwenLM/qwen-code/pull/10727)) by @yiliang114
- feat(qwen-live): protocol v7 playback receipts and interactive init — M5 ([#10769](https://github.com/QwenLM/qwen-code/pull/10769)) by @LaZzyMan
- feat(release): add gated bun/OpenTUI preview flavor to standalone releases ([#10814](https://github.com/QwenLM/qwen-code/pull/10814)) by @chiga0
- feat(channels): expose BTW through agent bridges ([#10712](https://github.com/QwenLM/qwen-code/pull/10712)) by @qqqys
- feat(serve): add workspace-scoped MCP management ([#10679](https://github.com/QwenLM/qwen-code/pull/10679)) by @ytahdn
- feat(channels): add BTW side questions to Channel conversations ([#10713](https://github.com/QwenLM/qwen-code/pull/10713)) by @qqqys
- feat(web-shell): expose session artifact snapshots ([#10747](https://github.com/QwenLM/qwen-code/pull/10747)) by @dreamWB
- feat(dingtalk): support outbound file delivery ([#10893](https://github.com/QwenLM/qwen-code/pull/10893)) by @qqqys

#### Bug Fixes

- fix(core): keep the ask_user_question dialog behind allow rules and auto-approval ([#10160](https://github.com/QwenLM/qwen-code/pull/10160)) by @qqqys
- Updates qwen --help to derive output from shared option definitions, ensuring it accurately lists all accepted flags like --approval-mode and --auth-type instead of a stale subset. ([#8902](https://github.com/QwenLM/qwen-code/pull/8902)) by @yiliang114
- Applies idle and maximum-lifetime watchdogs to Anthropic streams to prevent indefinite hanging, ensuring they abort with ETIMEDOUT similar to OpenAI-compatible providers. ([#9945](https://github.com/QwenLM/qwen-code/pull/9945)) by @yiliang114
- Autofix now reports which guard refused thread resolution in round reports and waits for head propagation to prevent silent failures. ([#10117](https://github.com/QwenLM/qwen-code/pull/10117)) by @wenshao
- Agent tools now display the runtime-resolved execution mode to correctly distinguish foreground and background tasks regardless of model arguments. ([#9955](https://github.com/QwenLM/qwen-code/pull/9955)) by @DragonnZhang
- The older-Git archive fallback now accepts safe contained symlinks while continuing to reject absolute paths, drive letters, and escape attempts. ([#9969](https://github.com/QwenLM/qwen-code/pull/9969)) by @harjothkhara
- Fixed debug logging to prevent daemon Configs and background work from leaking session logs into unrelated debug files. ([#9930](https://github.com/QwenLM/qwen-code/pull/9930)) by @tomsen02
- Fixes session branching to correctly detect duplicate titles by scanning both active and archived sessions. ([#10032](https://github.com/QwenLM/qwen-code/pull/10032)) by @harjothkhara
- Ensures named Agent Team teammates resolve the same model provider route as ordinary subagents defined in the same agent file. ([#10092](https://github.com/QwenLM/qwen-code/pull/10092)) by @yiliang114
- Routes non-publishing Linux release pipeline jobs to the ECS runner pool while keeping publishing jobs on ubuntu-latest. ([#10036](https://github.com/QwenLM/qwen-code/pull/10036)) by @yiliang114
- fix(core): propagate filesystem cleanup failures in team_delete ([#10213](https://github.com/QwenLM/qwen-code/pull/10213)) by @yiliang114
- fix(test): probe the native directory picker once at daemon spawn time ([#10456](https://github.com/QwenLM/qwen-code/pull/10456)) by @yiliang114
- fix(serve): advertise the native directory picker during bootstrap ([#10471](https://github.com/QwenLM/qwen-code/pull/10471)) by @wenshao
- Cancelled workflows now terminate immediately instead of waiting for the clock to expire, and the execution window is sized by usable CPUs. ([#10468](https://github.com/QwenLM/qwen-code/pull/10468)) by @qqqys
- Web Shell tabs now display a recoverable error message instead of a blank white screen when boot failures occur before React mounts. ([#10215](https://github.com/QwenLM/qwen-code/pull/10215)) by @harjothkhara
- Recovers protected .qwen state after abrupt job termination by repairing permissions or quarantining files to ensure successful checkout. ([#10214](https://github.com/QwenLM/qwen-code/pull/10214)) by @yiliang114
- Ensures fire-and-forget hooks like MessageDisplay and SessionDelete complete execution with full supervision even after the Qwen process exits. ([#10288](https://github.com/QwenLM/qwen-code/pull/10288)) by @doudouOUC
- Keeps pinned sessions visible within their original sidebar group sections while maintaining their presence in the dedicated Pinned section. ([#10416](https://github.com/QwenLM/qwen-code/pull/10416)) by @yiliang114
- Increases the Python SDK subprocess stream reader limit to 4 MiB to support large stream-json messages without errors. ([#9337](https://github.com/QwenLM/qwen-code/pull/9337)) by @lwind233
- Fixes test infrastructure to correctly render AppContainer and observe post-mount state updates during queued-submission drain tests. ([#10436](https://github.com/QwenLM/qwen-code/pull/10436)) by @yiliang114
- Fixed a Ruff linting error in the Python SDK tests by removing a stray blank line in the import block. ([#10505](https://github.com/QwenLM/qwen-code/pull/10505)) by @qwen-code-dev-bot
- Scoped startup warning files to individual npm start sessions to prevent conflicts between concurrent development environments. ([#8456](https://github.com/QwenLM/qwen-code/pull/8456)) by @xianjianlf2
- Prevented the system from incorrectly claiming a question host in stream-json direct mode when the control system is inactive. ([#9414](https://github.com/QwenLM/qwen-code/pull/9414)) by @tonydzi
- Enforced strict timeout limits for daemon session initialization, ensuring timed-out sessions are cancelled and cleaned up properly. ([#10268](https://github.com/QwenLM/qwen-code/pull/10268)) by @doudouOUC
- Fixed an issue where failed concurrent teammate spawns left ghost members in the persisted team roster file. ([#10223](https://github.com/QwenLM/qwen-code/pull/10223)) by @yiliang114
- Made category tabs in the @ completion picker clickable via mouse when terminal mouse tracking is active. ([#8395](https://github.com/QwenLM/qwen-code/pull/8395)) by @destire-mio
- Anchored the VS Code companion model selector dropdown to the input form to prevent it from floating over the message list. ([#9702](https://github.com/QwenLM/qwen-code/pull/9702)) by @yiliang114
- Fixes Windows IME composition visibility by rendering the software cursor as an underline without a fixed background, preventing Pinyin text from becoming invisible. ([#9803](https://github.com/QwenLM/qwen-code/pull/9803)) by @bluefateludi
- Enables relative daemon base URLs for six workspace file helpers including readWorkspaceFile and glob, fixing Invalid URL errors in Web Shell integrations. ([#9817](https://github.com/QwenLM/qwen-code/pull/9817)) by @shoemoney
- Prevents stale abort handlers and misleading logs by cleaning up the shell abort listener when ShellExecutionService.execute() throws synchronous errors. ([#9849](https://github.com/QwenLM/qwen-code/pull/9849)) by @AaronZ345
- fix(cli): infer keyless Vertex AI auth ([#9045](https://github.com/QwenLM/qwen-code/pull/9045)) by @KXHXK
- Provider update prompts now instruct users to manually select a new model with /model instead of promising an automatic switch. ([#9023](https://github.com/QwenLM/qwen-code/pull/9023)) by @rbalachandar
- Removed the non-functional general.dynamicCommandTranslation setting from CLI, VS Code schemas, and documentation to prevent user confusion. ([#8754](https://github.com/QwenLM/qwen-code/pull/8754)) by @destire-mio
- Removed the unsupported npm --parallel flag from scripts to ensure test commands run successfully on npm version 12 and newer. ([#8725](https://github.com/QwenLM/qwen-code/pull/8725)) by @imrehg
- Fixed Windows unit tests by normalizing unverifiable file IDs to zero while maintaining strict path and device checks for workspace isolation. ([#10440](https://github.com/QwenLM/qwen-code/pull/10440)) by @yiliang114
- Serve workspace checks now correctly allow subdirectories starting with .. while still rejecting actual parent directory traversal. ([#9848](https://github.com/QwenLM/qwen-code/pull/9848)) by @AaronZ345
- fix(cli): reject symlinked screenshot paths on win32 in capture_screen_context ([#9847](https://github.com/QwenLM/qwen-code/pull/9847)) by @zhou2024NAU
- Removes a schema length constraint to prevent LM Studio grammar parsing errors and allow new conversations to start successfully. ([#10275](https://github.com/QwenLM/qwen-code/pull/10275)) by @mredbishop
- Route-scopes the session token-limit cache to prevent stale counts from triggering limits when switching models between different routes. ([#9862](https://github.com/QwenLM/qwen-code/pull/9862)) by @yiliang114
- Preserves sourceType and sourceId metadata during daemon channel session restores to ensure consistent attribution for legacy sessions. ([#10257](https://github.com/QwenLM/qwen-code/pull/10257)) by @AaronZ345
- Stops forcing temperature 0 for DeepSeek models, allowing them to use default sampling behavior unless explicitly configured by the user. ([#9879](https://github.com/QwenLM/qwen-code/pull/9879)) by @AaronZ345
- fix(core): disambiguate send_message destinations ([#10083](https://github.com/QwenLM/qwen-code/pull/10083)) by @Sumire-no-kai
- Delivers teammate messages to the leader at tool-round boundaries instead of waiting for the entire multi-round task to finish. ([#9638](https://github.com/QwenLM/qwen-code/pull/9638)) by @yiliang114
- Optimizes repeated inline image rendering by adding a negative cache for invalid decodes and correcting height allocation for image-only messages. ([#8789](https://github.com/QwenLM/qwen-code/pull/8789)) by @zjunothing
- The serve command now prefers a valid TLS issuer over an expired one with the same subject to prevent handshake failures during CA renewal. ([#10042](https://github.com/QwenLM/qwen-code/pull/10042)) by @qqqys
- Session cleanup operations now strictly preserve daemon writer-lease ownership to ensure data integrity during delete, archive, and repair actions. ([#10300](https://github.com/QwenLM/qwen-code/pull/10300)) by @doudouOUC
- The serve command now supports hot-reloading model providers and refreshing session registries without disrupting active turns or switching current models. ([#10269](https://github.com/QwenLM/qwen-code/pull/10269)) by @doudouOUC
- Fixed MCP connection stability by tolerating HTTP 404 responses during the optional Streamable HTTP GET SSE probe and preventing body-read hangs. ([#10091](https://github.com/QwenLM/qwen-code/pull/10091)) by @harjothkhara
- Improved TypeScript SDK error reporting by surfacing specific daemon JSON-RPC error details from data fields instead of showing generic Internal error messages. ([#10571](https://github.com/QwenLM/qwen-code/pull/10571)) by @doudouOUC
- fix(serve): surface provider error detail in turn_error messages ([#10569](https://github.com/QwenLM/qwen-code/pull/10569)) by @doudouOUC
- Increases the browser daemon bundle budget to 216KB to accommodate recent error-detail surfacing changes and fix CI install failures. ([#10602](https://github.com/QwenLM/qwen-code/pull/10602)) by @chiga0
- Fixes the Release workflow by moving runner-environment mapping to specific steps, resolving GitHub parsing errors caused by invalid job-level context usage. ([#10598](https://github.com/QwenLM/qwen-code/pull/10598)) by @yiliang114
- fix(ci): run /resolve without the container sandbox and pin its CLI version ([#10428](https://github.com/QwenLM/qwen-code/pull/10428)) by @wenshao
- Coordinates Docker sandbox workloads on shared ECS hosts using a reader/writer lock to allow concurrent test shards without reducing concurrency. ([#10605](https://github.com/QwenLM/qwen-code/pull/10605)) by @yiliang114
- Aligns non-Linux Vitest unit suites to treat unhandled errors as non-fatal on macOS and Windows, ensuring consistent cross-platform test behavior. ([#10443](https://github.com/QwenLM/qwen-code/pull/10443)) by @qwen-code-dev-bot
- The /resolve workflow now recovers lost requests caused by moved heads, fork pushes, 503 errors, and draft states by replaying merges safely. ([#10429](https://github.com/QwenLM/qwen-code/pull/10429)) by @wenshao
- fix(core): keep no-follow reads protected where O_NOFOLLOW is missing ([#10007](https://github.com/QwenLM/qwen-code/pull/10007)) by @yiliang114
- The daemon browser bundle size limit is now advisory, emitting a warning instead of failing the build when exceeding 216 KiB. ([#10630](https://github.com/QwenLM/qwen-code/pull/10630)) by @yiliang114
- Fixes container startup failures when using image IDs by shortening the hostname to comply with Linux 64-character limits while keeping full container names. ([#10624](https://github.com/QwenLM/qwen-code/pull/10624)) by @yiliang114
- Adds disk capacity checks to the no-credential integration job on self-hosted runners to prevent installations when insufficient space is detected. ([#10539](https://github.com/QwenLM/qwen-code/pull/10539)) by @yiliang114
- Ensures disk pressure samples are captured and retained during npm install failures to improve debugging of transient disk issues. ([#10517](https://github.com/QwenLM/qwen-code/pull/10517)) by @yiliang114
- Prevents loss of existing skills during reinstall failures on Windows by using a backup-and-restore strategy instead of delete-then-rename. ([#10189](https://github.com/QwenLM/qwen-code/pull/10189)) by @yiliang114
- Fixes Web Shell footer rendering delays by ensuring background agent notifications correctly resolve pending tool rows before final output. ([#10503](https://github.com/QwenLM/qwen-code/pull/10503)) by @dreamWB
- Restores native VS Code diff approval flows for WebShell edit permissions, allowing Accept/Reject commands to resolve pending tools correctly. ([#10534](https://github.com/QwenLM/qwen-code/pull/10534)) by @yiliang114
- Adds an opt-in grace period for poll-based SSE clients to reconnect after prompt settlement without triggering event stream resync errors. ([#10344](https://github.com/QwenLM/qwen-code/pull/10344)) by @chiga0
- fix(tools): treat blank task_list filters as absent ([#10159](https://github.com/QwenLM/qwen-code/pull/10159)) by @yiliang114
- Restores the web-shell composer input functionality after closing the MCP plugin panel to prevent the interface from becoming stuck. ([#10232](https://github.com/QwenLM/qwen-code/pull/10232)) by @AaronZ345
- Improved /review presubmit to detect overlapping multi-line comment ranges by checking closed-interval intersections instead of only end lines. ([#9801](https://github.com/QwenLM/qwen-code/pull/9801)) by @bluefateludi
- Fixed a memory leak by clearing pending copy-feedback timers on unmount for all copy buttons in the Web Shell and core tests. ([#10655](https://github.com/QwenLM/qwen-code/pull/10655)) by @wenshao
- Edit-class tools now display change diffs in the approval prompt when a PreToolUse hook returns an ask decision. ([#9441](https://github.com/QwenLM/qwen-code/pull/9441)) by @yiliang114
- The Java SDK now correctly reads control response status from the nested response.subtype field to properly detect and log control errors. ([#9924](https://github.com/QwenLM/qwen-code/pull/9924)) by @AaronZ345
- Model requests rejected with HTTP 413 now automatically trigger one-shot compaction and retry, or surface a clear error to start a new session if compression fails. ([#10408](https://github.com/QwenLM/qwen-code/pull/10408)) by @yiliang114
- fix(core): make loop detection result-aware for task_list polls ([#9492](https://github.com/QwenLM/qwen-code/pull/9492)) by @yiliang114
- Channel initialization timeouts now return a structured HTTP 504 response with Retry-After headers instead of a generic 500 error. ([#10404](https://github.com/QwenLM/qwen-code/pull/10404)) by @chiga0
- Review disclosures for lint deferrals now display clean, accurate bilingual messages in both English and Simplified Chinese without stuttering or untranslated text. ([#10587](https://github.com/QwenLM/qwen-code/pull/10587)) by @wenshao
- HTTP hooks now strictly disable redirects to prevent repository-controlled configurations from exposing session data to arbitrary internal or metadata addresses. ([#10427](https://github.com/QwenLM/qwen-code/pull/10427)) by @wenshao
- fix(core): keep image views working with sharp releases older than 0.34 ([#10633](https://github.com/QwenLM/qwen-code/pull/10633)) by @MingyaWang
- Enables DingTalk status cards to recover from network failures via exponential backoff retries and periodic heartbeat content republishing. ([#10357](https://github.com/QwenLM/qwen-code/pull/10357)) by @qqqys
- Displays the Goal objective as the label for Goal-only sessions in the resume picker and search instead of showing empty prompt. ([#10295](https://github.com/QwenLM/qwen-code/pull/10295)) by @qqqys
- fix(core): make the failed-spawn compensating-write gate commit-aware ([#10522](https://github.com/QwenLM/qwen-code/pull/10522)) by @yiliang114
- fix(cua): harden Node REPL and Windows UIAccess ([#10666](https://github.com/QwenLM/qwen-code/pull/10666)) by @LaZzyMan
- fix(cua): publish unsigned Windows UIAccess worker ([#10680](https://github.com/QwenLM/qwen-code/pull/10680)) by @LaZzyMan
- fix(ci): make shared ECS Vitest concurrency tunable ([#10667](https://github.com/QwenLM/qwen-code/pull/10667)) by @yiliang114
- fix(web-shell): persist model reasoning preferences ([#10489](https://github.com/QwenLM/qwen-code/pull/10489)) by @callmeYe
- fix(ci): keep web-shell visuals comment on upload failure ([#10253](https://github.com/QwenLM/qwen-code/pull/10253)) by @AaronZ345
- fix(permissions): never let the AUTO-mode classifier auto-approve out-of-workspace writes; always fall back to manual approval ([#8744](https://github.com/QwenLM/qwen-code/pull/8744)) by @PratikWayase
- fix(review): gate decided stops on a composed re-rule verdict ([#10310](https://github.com/QwenLM/qwen-code/pull/10310)) by @wenshao
- fix(sdk): stop emitting a duplicated hashbang in the serve-mcp bin ([#10485](https://github.com/QwenLM/qwen-code/pull/10485)) by @wenshao
- fix(cli): keep hardware cursor aligned after layout changes ([#10417](https://github.com/QwenLM/qwen-code/pull/10417)) by @liujiayi771
- fix(cli): Defer provisional standalone reasoning options ([#10706](https://github.com/QwenLM/qwen-code/pull/10706)) by @doudouOUC
- fix(cli): abort subagent generation on unmount ([#9937](https://github.com/QwenLM/qwen-code/pull/9937)) by @AaronZ345
- fix(web-shell): remove duplicate language declaration in ChatEditor.test.tsx ([#10729](https://github.com/QwenLM/qwen-code/pull/10729)) by @yiliang114
- fix(autofix): clamp gate test load explicitly instead of via RUNNER_NAME ([#10671](https://github.com/QwenLM/qwen-code/pull/10671)) by @qqqys
- fix(java): make SDK worker threads daemon ([#9925](https://github.com/QwenLM/qwen-code/pull/9925)) by @AaronZ345
- fix(core): support hybrid thinking streams for Qwen3 ([#9607](https://github.com/QwenLM/qwen-code/pull/9607)) by @yiliang114
- fix(web-shell): reconcile queued prompts across clients ([#10704](https://github.com/QwenLM/qwen-code/pull/10704)) by @ytahdn
- fix(ci): retry transient sandbox:none E2E shard failures once (#10566) ([#10572](https://github.com/QwenLM/qwen-code/pull/10572)) by @qwen-code-dev-bot
- fix(web-shell): proxy standalone/live daemon routes in vite dev ([#10748](https://github.com/QwenLM/qwen-code/pull/10748)) by @wenshao
- fix(core): validate git pull option combinations and detached HEAD ([#10752](https://github.com/QwenLM/qwen-code/pull/10752)) by @wenshao
- fix(channels): apply approval mode to standalone sessions ([#10715](https://github.com/QwenLM/qwen-code/pull/10715)) by @qqqys
- fix(cli): route the /output-style dialog in the OpenTUI registry ([#10763](https://github.com/QwenLM/qwen-code/pull/10763)) by @wenshao
- fix(serve): keep prompt-turn failure logs from degrading to [object Object] ([#10732](https://github.com/QwenLM/qwen-code/pull/10732)) by @yiliang114
- fix(acp-bridge): backpressure ACP NDJSON queue saturation instead of tearing down the channel ([#10731](https://github.com/QwenLM/qwen-code/pull/10731)) by @yiliang114
- fix(ci): isolate and bound release validation workloads ([#10765](https://github.com/QwenLM/qwen-code/pull/10765)) by @yiliang114
- fix(workflow): tighten multi-workspace state boundaries ([#10772](https://github.com/QwenLM/qwen-code/pull/10772)) by @yiliang114
- fix(vscode): stop webview bundle test timing out under CI contention (#10665) ([#10672](https://github.com/QwenLM/qwen-code/pull/10672)) by @qwen-code-dev-bot
- fix(release): raise prepared package size budget to 112 MiB (#10774) ([#10781](https://github.com/QwenLM/qwen-code/pull/10781)) by @qwen-code-dev-bot
- fix(core): skip non-regular files in usage history transcript replay ([#10681](https://github.com/QwenLM/qwen-code/pull/10681)) by @qqqys
- fix(cli): stop the ctrl+s hint advertising shell-cap hidden lines ([#10657](https://github.com/QwenLM/qwen-code/pull/10657)) by @yiliang114
- fix(web-shell): keep the sidebar New task on a workspace ([#10777](https://github.com/QwenLM/qwen-code/pull/10777)) by @wenshao
- fix(serve): keep the Conversations runtime outside the workspace registration limit ([#10759](https://github.com/QwenLM/qwen-code/pull/10759)) by @wenshao
- fix(cua): restore legacy Windows installer compatibility ([#10792](https://github.com/QwenLM/qwen-code/pull/10792)) by @LaZzyMan
- fix(triage): make Stage 1-pre subsumption check large-file safe ([#10396](https://github.com/QwenLM/qwen-code/pull/10396)) by @yiliang114
- fix(web-shell): Load models for fresh standalone sessions ([#10719](https://github.com/QwenLM/qwen-code/pull/10719)) by @doudouOUC
- fix(core): recover from gateway 400 on media-bearing OpenAI requests by degrading the media ([#10699](https://github.com/QwenLM/qwen-code/pull/10699)) by @yiliang114
- fix(ci): keep worker tests responsive under ECS contention ([#10813](https://github.com/QwenLM/qwen-code/pull/10813)) by @yiliang114
- fix(ci): classify the CI profile from the trusted base SHA ([#10799](https://github.com/QwenLM/qwen-code/pull/10799)) by @yiliang114
- fix(cli): align OpenTUI output-style behavior ([#10806](https://github.com/QwenLM/qwen-code/pull/10806)) by @qqqys
- fix(cli): show active scheduled tasks at session start ([#10053](https://github.com/QwenLM/qwen-code/pull/10053)) by @yiliang114
- fix(ci): stop stable releases from disabling per-workspace test retries ([#10803](https://github.com/QwenLM/qwen-code/pull/10803)) by @yiliang114
- fix(release): stop hiding sandbox build failures and check the prepared package early ([#10784](https://github.com/QwenLM/qwen-code/pull/10784)) by @yiliang114
- fix(core): craft the hard-link tar fixture instead of packing it ([#10801](https://github.com/QwenLM/qwen-code/pull/10801)) by @yiliang114
- fix(release): cap Vitest workers in the quality_scripts lane (#10755) ([#10760](https://github.com/QwenLM/qwen-code/pull/10760)) by @qwen-code-dev-bot
- fix(web-shell): keep a manual session name across /clear (#8977) ([#9260](https://github.com/QwenLM/qwen-code/pull/9260)) by @yiliang114
- fix(ci): Take the OpenTUI interactive e2e leg out of CI ([#10829](https://github.com/QwenLM/qwen-code/pull/10829)) by @chiga0
- fix(live-host-release): correct setup-node action SHA ([#10827](https://github.com/QwenLM/qwen-code/pull/10827)) by @LaZzyMan
- fix(web-shell): Reload models for repeated new tasks ([#10824](https://github.com/QwenLM/qwen-code/pull/10824)) by @doudouOUC
- fix(goal): stop exporting the unreachable propose_goal decline message ([#10787](https://github.com/QwenLM/qwen-code/pull/10787)) by @qqqys
- fix(ci): stop heartbeat mint-skip test racing loop startup ([#10527](https://github.com/QwenLM/qwen-code/pull/10527)) by @qwen-code-dev-bot
- fix(dws): isolate direct-message ingestion across conversations ([#10691](https://github.com/QwenLM/qwen-code/pull/10691)) by @qqqys
- fix(web-shell): preserve slash command attachments ([#10730](https://github.com/QwenLM/qwen-code/pull/10730)) by @ytahdn
- fix(channels): prune selections when workspaces are removed ([#10796](https://github.com/QwenLM/qwen-code/pull/10796)) by @qqqys
- fix(ci): stop sandbox image prep from waiting on another run's tests ([#10843](https://github.com/QwenLM/qwen-code/pull/10843)) by @yiliang114
- fix(test): give the serve routes daemon a CI-sized ACP handshake budget ([#10846](https://github.com/QwenLM/qwen-code/pull/10846)) by @yiliang114
- fix(cli): rate-limit interim monitor notification turns (#10818) ([#10848](https://github.com/QwenLM/qwen-code/pull/10848)) by @yiliang114
- fix(channels): route daemon permission votes by session ([#10793](https://github.com/QwenLM/qwen-code/pull/10793)) by @qqqys
- fix(live-host-release): build sdk before qwen-live in publish job ([#10836](https://github.com/QwenLM/qwen-code/pull/10836)) by @LaZzyMan
- fix(ci): read the CI patrol's status rollup one PR at a time ([#10861](https://github.com/QwenLM/qwen-code/pull/10861)) by @yiliang114
- fix(cli): close OpenTUI submit-path gaps, restore its E2E leg ([#10831](https://github.com/QwenLM/qwen-code/pull/10831)) by @chiga0
- fix(release): stop one flaky test from failing a stable release ([#10842](https://github.com/QwenLM/qwen-code/pull/10842)) by @yiliang114
- fix(ci): retry a contended unit attempt and bound a hung one ([#10868](https://github.com/QwenLM/qwen-code/pull/10868)) by @yiliang114
- fix(cli): resolve the sessionCd folder-trust gate from the session workspace, not the stale this.settings cache ([#10470](https://github.com/QwenLM/qwen-code/pull/10470)) by @tomsen02
- fix(cli): remove duplicate folder trust mock ([#10874](https://github.com/QwenLM/qwen-code/pull/10874)) by @yiliang114
- fix(acp-bridge): deflake the exhaustive UTF-16 byte-estimate test (#10529) ([#10532](https://github.com/QwenLM/qwen-code/pull/10532)) by @qwen-code-dev-bot
- fix(workflow): classify Critical feedback by leading marker ([#10361](https://github.com/QwenLM/qwen-code/pull/10361)) by @Sumire-no-kai
- fix(release): report a workspace test run that fails with nothing failing ([#10805](https://github.com/QwenLM/qwen-code/pull/10805)) by @yiliang114
- fix(cli): Align OpenTUI mid-turn submit and exit with ink ([#10883](https://github.com/QwenLM/qwen-code/pull/10883)) by @chiga0

#### Performance

- Added a pre-verify dedup step to the review pipeline that skips candidates matching the carried ledger to save verification resources. ([#10121](https://github.com/QwenLM/qwen-code/pull/10121)) by @wenshao
- perf(ci): shard release quality checks ([#10619](https://github.com/QwenLM/qwen-code/pull/10619)) by @yiliang114

#### Documentation

- Adds a design document detailing the architecture, batching plan, and verification strategy for migrating the TUI from ink to OpenTUI. ([#10343](https://github.com/QwenLM/qwen-code/pull/10343)) by @chiga0
- Corrects Java SDK documentation to replace the nonexistent SessionClosedException with SessionControlException for closed or unavailable session errors. ([#9859](https://github.com/QwenLM/qwen-code/pull/9859)) by @AaronZ345
- Added an evidence-based conclusions recipe to common workflows documentation with a copy-pasteable QWEN.md verification policy template. ([#8702](https://github.com/QwenLM/qwen-code/pull/8702)) by @Dmatut7
- Documented how to configure a trusted tool PATH for qwen serve daemons managed by systemd or launchd to ensure user-installed tools remain resolvable. ([#10576](https://github.com/QwenLM/qwen-code/pull/10576)) by @doudouOUC
- docs(design): Align OpenTUI migration notes with the landed batches ([#10724](https://github.com/QwenLM/qwen-code/pull/10724)) by @chiga0
- docs(readme): add versioned SWE-bench scores ([#10808](https://github.com/QwenLM/qwen-code/pull/10808)) by @DennisYu07
- docs(goals): sync the Goal docs with the current runtime ([#10785](https://github.com/QwenLM/qwen-code/pull/10785)) by @qqqys
- docs(design): Define relaxed standalone daemon ownership ([#10828](https://github.com/QwenLM/qwen-code/pull/10828)) by @doudouOUC

#### Internal Changes

- Automated PR evidence images are now uploaded to Aliyun OSS instead of cluttering the Git repository with thousands of asset branches. ([#9985](https://github.com/QwenLM/qwen-code/pull/9985)) by @yiliang114
- Refactored SDK authentication to remove a runtime module cycle by importing HTTP errors directly from their owning module. ([#10039](https://github.com/QwenLM/qwen-code/pull/10039)) by @DragonnZhang
- Centralizes JSON tag-character escaping to prevent untrusted content from breaking HTML or XML envelopes across all model-facing outputs. ([#9917](https://github.com/QwenLM/qwen-code/pull/9917)) by @AaronZ345
- Removes the unused MemoryUsageDisplay component from the CLI status bar as it is no longer referenced in the codebase. ([#10238](https://github.com/QwenLM/qwen-code/pull/10238)) by @qqqys
- Goal messages now respect the caller's recursion budget by applying boundedTurns limits, while other specific carve-outs remain with updated documentation. ([#10259](https://github.com/QwenLM/qwen-code/pull/10259)) by @qqqys
- Java SDK test fixtures now properly close connections for body-less responses to prevent intermittent HTTP header parser errors during session teardown. ([#10472](https://github.com/QwenLM/qwen-code/pull/10472)) by @wenshao
- Removed a circular dependency between the ACP route table and transport utility layer by localizing the route parameter extraction predicate. ([#10040](https://github.com/QwenLM/qwen-code/pull/10040)) by @DragonnZhang
- No user-facing changes; this release refactors internal MCP server configuration into a dedicated module without altering functionality. ([#9496](https://github.com/QwenLM/qwen-code/pull/9496)) by @DragonnZhang
- Migrates VS Code IDE Companion chat to WebShell backed by a workspace-scoped qwen serve daemon, separating transcript management from VS Code-specific lifecycle tasks. ([#9811](https://github.com/QwenLM/qwen-code/pull/9811)) by @yiliang114
- Integration tests now use condition-based polling instead of a fixed one-second sleep to reliably wait for ACP command update notifications. ([#10516](https://github.com/QwenLM/qwen-code/pull/10516)) by @yiliang114
- Fixed the web-shell boot test by correcting the mock path for the daemon React SDK to match the current module structure. ([#10526](https://github.com/QwenLM/qwen-code/pull/10526)) by @wenshao
- Updated the Web Shell boot regression test to mock the daemon SDK from its current package entrypoint, resolving CI failures caused by moved modules. ([#10545](https://github.com/QwenLM/qwen-code/pull/10545)) by @yiliang114
- Stabilized the session deadline boundary test by using a safe integer value that avoids intermittent failures near Node.js timer limits. ([#10556](https://github.com/QwenLM/qwen-code/pull/10556)) by @yiliang114
- ci: stabilize tests under shared ECS host contention ([#10552](https://github.com/QwenLM/qwen-code/pull/10552)) by @yiliang114
- Applied shared-runner integration limits to Release jobs by passing the GitHub runner environment to enforce single-fork limits on ECS hosts. ([#10592](https://github.com/QwenLM/qwen-code/pull/10592)) by @yiliang114
- Hardens timing-sensitive waits in Agent View supervisor and Web Shell pagination tests to prevent intermittent nightly release failures. ([#10615](https://github.com/QwenLM/qwen-code/pull/10615)) by @yiliang114
- CI tests now measure CPU time instead of wall-clock time for performance guards and wait for a second marker to validate cron interactive checks. ([#10648](https://github.com/QwenLM/qwen-code/pull/10648)) by @yiliang114
- Added regression tests to ensure tools.eager configuration tolerates Object.prototype keys without crashing the PermissionManager at startup. ([#10479](https://github.com/QwenLM/qwen-code/pull/10479)) by @yiliang114
- Stabilizes the picker hang-up abort test by replacing fixed timeouts with vi.waitFor polling to reliably detect signal abortion. ([#10664](https://github.com/QwenLM/qwen-code/pull/10664)) by @yiliang114
- test(core): close the deferred test gaps recorded in #9930's review rounds ([#10465](https://github.com/QwenLM/qwen-code/pull/10465)) by @tomsen02
- test(integration): remove flaky ACP recall timing check ([#10703](https://github.com/QwenLM/qwen-code/pull/10703)) by @yiliang114
- ci(ecs): file an issue when the runner fleet update fails ([#10445](https://github.com/QwenLM/qwen-code/pull/10445)) by @wenshao
- test(ci): make web-shell visuals publish stub module-safe (#10736) ([#10738](https://github.com/QwenLM/qwen-code/pull/10738)) by @qwen-code-dev-bot
- test(core): rescale the shell-safety CPU budget to the metric it measures ([#10735](https://github.com/QwenLM/qwen-code/pull/10735)) by @TianYuan1024
- chore(deps): bump fast-uri to 3.1.7 to clear the high-severity audit gate ([#10862](https://github.com/QwenLM/qwen-code/pull/10862)) by @wenshao
- chore(vscode): refresh NOTICES for the fast-uri bump ([#10863](https://github.com/QwenLM/qwen-code/pull/10863)) by @yiliang114
- ci: split lint and static checks out of the Test job ([#10756](https://github.com/QwenLM/qwen-code/pull/10756)) by @wenshao
- test(review): stamp the ledger entries when the test runs, not when it loads ([#10878](https://github.com/QwenLM/qwen-code/pull/10878)) by @yiliang114
- ci: collect coverage only on the post-merge run and run cli tests under node ([#10890](https://github.com/QwenLM/qwen-code/pull/10890)) by @wenshao
- test(cli): stamp the background-work duration fixture when the test runs, not when it loads (#10881) ([#10889](https://github.com/QwenLM/qwen-code/pull/10889)) by @qwen-code-dev-bot
- test: stop millisecond budgets from measuring the shared pool ([#10870](https://github.com/QwenLM/qwen-code/pull/10870)) by @yiliang114

### New Contributors

- @lwind233 made their first contribution in [#9337](https://github.com/QwenLM/qwen-code/pull/9337)
- @tonydzi made their first contribution in [#9414](https://github.com/QwenLM/qwen-code/pull/9414)
- @bluefateludi made their first contribution in [#9803](https://github.com/QwenLM/qwen-code/pull/9803)
- @shoemoney made their first contribution in [#9817](https://github.com/QwenLM/qwen-code/pull/9817)
- @KXHXK made their first contribution in [#9045](https://github.com/QwenLM/qwen-code/pull/9045)
- @imrehg made their first contribution in [#8725](https://github.com/QwenLM/qwen-code/pull/8725)
- @Dmatut7 made their first contribution in [#8702](https://github.com/QwenLM/qwen-code/pull/8702)
- @mredbishop made their first contribution in [#10275](https://github.com/QwenLM/qwen-code/pull/10275)
- @Sumire-no-kai made their first contribution in [#10083](https://github.com/QwenLM/qwen-code/pull/10083)
- @Wkewen made their first contribution in [#10001](https://github.com/QwenLM/qwen-code/pull/10001)
- @MingyaWang made their first contribution in [#10633](https://github.com/QwenLM/qwen-code/pull/10633)
- @liujiayi771 made their first contribution in [#10417](https://github.com/QwenLM/qwen-code/pull/10417)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.22.3...v0.23.0

## [0.22.3](https://github.com/QwenLM/qwen-code/releases/tag/v0.22.3) - 2026-08-28

### Highlights

- Added owner-scoped named sessions in Channels to manage up to eight persistent tasks per chat. ([#10198](https://github.com/QwenLM/qwen-code/pull/10198))
- Enabled daemon Extension installs to accept absolute local paths while rejecting relative paths and unsupported options. ([#10131](https://github.com/QwenLM/qwen-code/pull/10131))
- Updated Web Shell sidebar to display GitHub-style colored state icons for sessions bound to pull requests. ([#10258](https://github.com/QwenLM/qwen-code/pull/10258))
- Added an opt-in composer add menu in Web Shell grouping attachments, files, extensions, MCP servers, and skills. ([#10379](https://github.com/QwenLM/qwen-code/pull/10379))
- Restored bold text visibility in assistant messages and prevented sidebar session names from being truncated. ([#10157](https://github.com/QwenLM/qwen-code/pull/10157))
- Ensured tool summaries are consistently collapsible and separated MCP Apps from other aggregations. ([#10231](https://github.com/QwenLM/qwen-code/pull/10231))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- Added a private OpenTelemetry span attribute to report detailed LLM context usage metrics including input categories and remaining capacity. ([#10016](https://github.com/QwenLM/qwen-code/pull/10016)) by @doudouOUC
- Enabled daemon Extension installs to accept absolute local paths while rejecting relative paths and unsupported options like ref. ([#10131](https://github.com/QwenLM/qwen-code/pull/10131)) by @callmeYe
- Backfills PR bindings for existing sessions and adds merge-state snapshots to track whether linked pull requests are open, merged, or closed. ([#9729](https://github.com/QwenLM/qwen-code/pull/9729)) by @wenshao
- Adds an opt-in setting for embedded Web Shell hosts to hide the session source switch, pinning all sidebar catalogs to ordinary task conversations. ([#10079](https://github.com/QwenLM/qwen-code/pull/10079)) by @dreamWB
- Implements safe projection for reserved [FILE: ...] output markers by redacting malformed or oversized inline markers without uploading files. ([#9991](https://github.com/QwenLM/qwen-code/pull/9991)) by @qqqys
- Updates Goal prompts to notify the model exactly once when the objective changes, while continuing to assert the current objective on every turn. ([#10013](https://github.com/QwenLM/qwen-code/pull/10013)) by @qqqys
- Added support for owner-scoped named sessions in Channels, allowing users to manage up to eight persistent named tasks per chat. ([#10198](https://github.com/QwenLM/qwen-code/pull/10198)) by @doudouOUC
- Updated Web Shell sidebar to display GitHub-style colored state icons for sessions bound to pull requests based on their open, merged, or closed status. ([#10258](https://github.com/QwenLM/qwen-code/pull/10258)) by @wenshao
- Made deferred review suggestions recoverable by external tooling via a stable invisible marker in the review body artifact. ([#9761](https://github.com/QwenLM/qwen-code/pull/9761)) by @wenshao
- The /review command now warns when a subsystem's Critical issues repeatedly regrow across rounds by detecting successor chains. ([#10010](https://github.com/QwenLM/qwen-code/pull/10010)) by @wenshao
- Restored the desktop brand builder skill for the Tauri shell to generate branded packages using brandId and logo inputs. ([#10164](https://github.com/QwenLM/qwen-code/pull/10164)) by @yiliang114
- Added a standalone daemon session API supporting create, list, resume, archive, and delete operations for top-level sessions. ([#10179](https://github.com/QwenLM/qwen-code/pull/10179)) by @doudouOUC
- The /review command now remembers the last explicitly used --effort level per project for subsequent runs without arguments. ([#9883](https://github.com/QwenLM/qwen-code/pull/9883)) by @tlysanhuo
- Long-running review rounds now update their status comment every 10 minutes with elapsed time and last agent activity to distinguish active work from stalled processes. ([#9771](https://github.com/QwenLM/qwen-code/pull/9771)) by @wenshao
- Local review-fix loops now anchor incremental rounds to working tree content changes instead of commits, reducing token usage by avoiding full tree re-reviews. ([#9659](https://github.com/QwenLM/qwen-code/pull/9659)) by @wenshao
- Review findings now support an optional fixConstraint field to specify existing facts or limits that suggested fixes must not violate during the repair process. ([#10168](https://github.com/QwenLM/qwen-code/pull/10168)) by @wenshao
- feat(sdk): Add standalone session APIs ([#10294](https://github.com/QwenLM/qwen-code/pull/10294)) by @doudouOUC
- feat(cli): OpenTUI migration infra batch — locked deps, dependency-direction arch check, framework-neutral streaming model ([#10134](https://github.com/QwenLM/qwen-code/pull/10134)) by @chiga0
- Added a configurable Mem0 extension skeleton providing a retrieval-only external-context-mem0 stdio Extension with bounded HTTP request support. ([#10149](https://github.com/QwenLM/qwen-code/pull/10149)) by @doudouOUC
- Added a new triage gate that automatically identifies and closes duplicate PRs when their changes are already fully resolved by merged fixes. ([#10292](https://github.com/QwenLM/qwen-code/pull/10292)) by @yiliang114
- Added an opt-in composer add menu to Web Shell that groups attachments, files, extensions, MCP servers, and skills for easier pointer-oriented selection. ([#10379](https://github.com/QwenLM/qwen-code/pull/10379)) by @ytahdn
- Added an opt-in interactive browser terminal to Web Shell that manages independent PTY sessions per tab with persistent scrollback and state handling. ([#9984](https://github.com/QwenLM/qwen-code/pull/9984)) by @ytahdn
- Adds the qwen review ab-drive subcommand to run execution-grade verification scripts against PR and base trees with shared or fresh instances. ([#9740](https://github.com/QwenLM/qwen-code/pull/9740)) by @wenshao
- Confirmed Critical issues now include direction and baseline axes to distinguish between false certifications, failures, regressions, and new surfaces. ([#10301](https://github.com/QwenLM/qwen-code/pull/10301)) by @wenshao
- Makes Aone a first-class platform for session PR bindings, enabling automatic branch-to-MR mapping and state refresh via the a1 CLI. ([#10287](https://github.com/QwenLM/qwen-code/pull/10287)) by @wenshao

#### Bug Fixes

- Fixed Web Shell to correctly restore saved session diffs with accurate line counts even when file bodies were previously truncated. ([#10093](https://github.com/QwenLM/qwen-code/pull/10093)) by @ytahdn
- Ensured DingTalk rich-text messages preserve all images as ordered attachments across sessions and handle upload failures gracefully. ([#9922](https://github.com/QwenLM/qwen-code/pull/9922)) by @BenGuanRan
- fix: repair the Windows test lane's standing failures ([#10064](https://github.com/QwenLM/qwen-code/pull/10064)) by @wenshao
- fix(core): report broadcast delivery failures in send_message ([#10081](https://github.com/QwenLM/qwen-code/pull/10081)) by @yiliang114
- Moved the autofix scan lane to the persistent self-hosted runner pool to prevent GitHub-hosted runner backlogs from blocking routing. ([#10055](https://github.com/QwenLM/qwen-code/pull/10055)) by @wenshao
- Restores bold text visibility in assistant messages and prevents session names in the sidebar from being truncated by attention pills. ([#10157](https://github.com/QwenLM/qwen-code/pull/10157)) by @wenshao
- Prevents large transcript turns from collapsing automatically after pagination completes, ensuring content remains visible until manually closed. ([#10086](https://github.com/QwenLM/qwen-code/pull/10086)) by @ytahdn
- Makes the delta-resume reconnect test deterministic by waiting for the resumed chunk instead of using a fixed time delay. ([#10203](https://github.com/QwenLM/qwen-code/pull/10203)) by @qwen-code-dev-bot
- Verifies the previous release tag exists in git before anchoring release notes, falling back to the latest stable tag if missing. ([#10167](https://github.com/QwenLM/qwen-code/pull/10167)) by @yiliang114
- Exempts off-Linux E2E shards from fatal unhandled vitest RPC-timeout errors while maintaining strict error handling on Linux. ([#10112](https://github.com/QwenLM/qwen-code/pull/10112)) by @qwen-code-dev-bot
- Ensures tool summaries are consistently collapsible, prevents child tools from opening automatically, and separates MCP Apps from other aggregations. ([#10231](https://github.com/QwenLM/qwen-code/pull/10231)) by @ytahdn
- Ensures tool results in headless and ACP hosts are stamped with Goal turn permits so they can serve as citable evidence for Goal reasoning. ([#10175](https://github.com/QwenLM/qwen-code/pull/10175)) by @qqqys
- Removes a duplicate getToolRegistry mock property in telemetry-swap tests to fix TypeScript build errors caused by duplicate object keys. ([#10252](https://github.com/QwenLM/qwen-code/pull/10252)) by @wenshao
- Fixes TypeScript build failure by removing a duplicate getToolRegistry property from the telemetry swap test configuration mock. ([#10243](https://github.com/QwenLM/qwen-code/pull/10243)) by @AaronZ345
- Adds qwen3.8-flash and qwen3.8-plus to modality patterns to enable native image and video handling instead of routing through the vision bridge. ([#10195](https://github.com/QwenLM/qwen-code/pull/10195)) by @yiliang114
- Bounds the goal-runtime startup wait to 5 seconds to prevent hanging and skips unnecessary memory relaunch steps when running under Bun. ([#10128](https://github.com/QwenLM/qwen-code/pull/10128)) by @chiga0
- Implemented robust process tree reaping for ACP child processes on POSIX and Windows to prevent orphaned processes during shutdown or errors. ([#10142](https://github.com/QwenLM/qwen-code/pull/10142)) by @doudouOUC
- Ensured model-specific reasoning controls remain available and correctly synchronized for qwen3.8-max before, during, and after session execution. ([#10244](https://github.com/QwenLM/qwen-code/pull/10244)) by @callmeYe
- Fixed command hook cleanup to reliably reclaim entire process trees on POSIX and Windows when hooks time out or are cancelled. ([#10100](https://github.com/QwenLM/qwen-code/pull/10100)) by @doudouOUC
- Auto-detection now correctly identifies deepseek-v4-flash-vision-exp, glm-4.6v, glm-5v-turbo, and glm-5.3-flash as vision-capable models. ([#10278](https://github.com/QwenLM/qwen-code/pull/10278)) by @yiliang114
- Increased autofix agent time budgets to 60 minutes for repair passes and 90 minutes for the runner default to prevent premature task termination. ([#10217](https://github.com/QwenLM/qwen-code/pull/10217)) by @wenshao
- Updated stream idle timeout error messages to guide users to both environment variables and explicit settings for resolution. ([#9896](https://github.com/QwenLM/qwen-code/pull/9896)) by @yu-xin-c
- The Web Shell new-session welcome header now features improved typography, spacing, a fade-in animation, and a brand-aligned gradient matching the Qwen logo. ([#10230](https://github.com/QwenLM/qwen-code/pull/10230)) by @wenshao
- Artifact updatedAt timestamps and sizeBytes now update immediately when content changes, ensuring Web Shell previews and caches reflect the latest file state. ([#9929](https://github.com/QwenLM/qwen-code/pull/9929)) by @zjgzx1988
- Extension Skills now separate canonical identity from display names, ensuring consistent matching while showing friendly localized labels in the CLI and Web Shell. ([#10296](https://github.com/QwenLM/qwen-code/pull/10296)) by @callmeYe
- Agent View now preserves queued follow-up messages in shared context across tab switches, preventing data loss when teammates switch views while an agent is busy. ([#10102](https://github.com/QwenLM/qwen-code/pull/10102)) by @yiliang114
- Stale team reclamation is now generation-safe, aborting deletion if the team configuration has changed since the staleness check to prevent accidental data loss. ([#10236](https://github.com/QwenLM/qwen-code/pull/10236)) by @yiliang114
- fix(core): report teammate result settled before event bridge attach ([#10245](https://github.com/QwenLM/qwen-code/pull/10245)) by @yiliang114
- fix(cli): restore goal-less startup broken by the goal-runtime wait refactor ([#10290](https://github.com/QwenLM/qwen-code/pull/10290)) by @yiliang114
- fix(test): mount channel plugin fixture in Docker ([#10318](https://github.com/QwenLM/qwen-code/pull/10318)) by @yiliang114
- fix(ci): stop shared-pool hosts exiting all-green E2E runs red (#10325) ([#10329](https://github.com/QwenLM/qwen-code/pull/10329)) by @qwen-code-dev-bot
- Integration tests now run with an isolated global qwen dir to prevent host configuration and saved memories from affecting test results. ([#10337](https://github.com/QwenLM/qwen-code/pull/10337)) by @wenshao
- E2E workflows now include a bounded retry for transient sandbox image build failures in the Linux docker leg to improve CI stability. ([#10359](https://github.com/QwenLM/qwen-code/pull/10359)) by @qwen-code-dev-bot
- Moved the archive action to the session dropdown and disabled it for running sessions to prevent UI overlap and accidental archiving. ([#10302](https://github.com/QwenLM/qwen-code/pull/10302)) by @wenshao
- Skill toggle endpoints now persist requested names directly to workspace settings without validating against the runtime Skill catalog. ([#10077](https://github.com/QwenLM/qwen-code/pull/10077)) by @callmeYe
- fix(test): isolate tool-control E2E from shared state ([#10340](https://github.com/QwenLM/qwen-code/pull/10340)) by @yiliang114
- Wind-down hand-off markers are now stamped only when the turn is successfully delivered to the model to ensure correct budget handling. ([#10260](https://github.com/QwenLM/qwen-code/pull/10260)) by @qqqys
- Direct DWS final responses now use standard direct-message delivery and recovery paths to ensure messages are not silently dropped. ([#10274](https://github.com/QwenLM/qwen-code/pull/10274)) by @qqqys
- Fixed an intermittent Java 11 test failure by ensuring HTTP connections close properly after cancel and detach responses in the concurrency test fixture. ([#10365](https://github.com/QwenLM/qwen-code/pull/10365)) by @yiliang114
- Updated the ACP cron test fixture to route responses based on prompt content instead of request order, preventing failures caused by parallel test interference. ([#10374](https://github.com/QwenLM/qwen-code/pull/10374)) by @yiliang114
- Configured Linux E2E shards to use isolated disk-backed temporary directories under /var/tmp to prevent /tmp exhaustion errors during test execution. ([#10376](https://github.com/QwenLM/qwen-code/pull/10376)) by @yiliang114
- Updated the triage workflow to silently exit when a PR is closed during a re-run, preventing unnecessary warnings about missing bot reviews. ([#10334](https://github.com/QwenLM/qwen-code/pull/10334)) by @yiliang114
- Updated the triage workflow to correctly fail the check step when the response indicates a model-layer API error instead of treating it as success. ([#10333](https://github.com/QwenLM/qwen-code/pull/10333)) by @yiliang114
- The ack-review-request job now reposts acknowledgements directly under the triggering command and adds reactions to improve visibility. ([#10381](https://github.com/QwenLM/qwen-code/pull/10381)) by @qqqys
- Hardens Computer Use sessions with real AbortSignal timeouts, typed errors, authorization reconnection, and consistent foreground delivery. ([#10319](https://github.com/QwenLM/qwen-code/pull/10319)) by @LaZzyMan
- Decouples permissions.allow from tool registration by introducing settings.tools.eager to control schema visibility without affecting auto-approval. ([#10098](https://github.com/QwenLM/qwen-code/pull/10098)) by @yiliang114

#### Documentation

- Removes redundant and non-operational text from agent context files to reduce token usage without altering project rules or commands. ([#10137](https://github.com/QwenLM/qwen-code/pull/10137)) by @DragonnZhang
- docs(external-context): Design a configurable Mem0 provider extension ([#10113](https://github.com/QwenLM/qwen-code/pull/10113)) by @doudouOUC

#### Internal Changes

- Fixed telemetry-swap tests by adding the missing getToolRegistry method to the Config mock to prevent initialization errors. ([#10220](https://github.com/QwenLM/qwen-code/pull/10220)) by @wenshao
- Removed stale references to the deleted packages/desktop directory from CI tooling and documentation following the Electron removal. ([#10021](https://github.com/QwenLM/qwen-code/pull/10021)) by @yiliang114
- Renamed internal identifiers containing legacy Gemini prefixes to generic names while maintaining deprecated aliases for backward compatibility. ([#9900](https://github.com/QwenLM/qwen-code/pull/9900)) by @yiliang114
- Centralized worktree configuration derivation to ensure consistent handling of workspace paths and context across all launch paths. ([#9915](https://github.com/QwenLM/qwen-code/pull/9915)) by @yiliang114
- refactor(core,cli): rename generic Gemini identifiers to Llm ([#10124](https://github.com/QwenLM/qwen-code/pull/10124)) by @yiliang114
- Fixes the release classifier test stub to work correctly when Node interprets extensionless executables as either CommonJS or ESM. ([#10402](https://github.com/QwenLM/qwen-code/pull/10402)) by @ytahdn

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.22.2...v0.22.3

## [0.22.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.22.2) - 2026-08-26

### Highlights

_See the complete change list below._

### Breaking Changes

- refactor(node-repl)!: deliver the persistent Node REPL as a standalone MCP server ([#9499](https://github.com/QwenLM/qwen-code/pull/9499)) by @LaZzyMan

### Complete Change List

#### Features

- Added temporal-reachability and incident-replay lenses to review briefs to analyze whether values exist at the correct moments to steer decisions. ([#9708](https://github.com/QwenLM/qwen-code/pull/9708)) by @wenshao
- Review findings now include specific test acceptance criteria for their fixes and explicitly rule on non-convergence to reduce review-fix loops. ([#9596](https://github.com/QwenLM/qwen-code/pull/9596)) by @wenshao
- Daemon sessions now restore to their last selected model across restarts and detaches, while new sessions continue to use the current settings default. ([#9687](https://github.com/QwenLM/qwen-code/pull/9687)) by @doudouOUC
- Validates inline anchors for /review --comment on Aone targets before posting, relocating Critical findings to the summary body and discarding Suggestions if anchors are invalid. ([#9634](https://github.com/QwenLM/qwen-code/pull/9634)) by @wenshao
- Adds a tokensUsed field to GoalRecord to report the total tokens consumed by a Goal alongside its turn count in the lastGoal summary. ([#9583](https://github.com/QwenLM/qwen-code/pull/9583)) by @qqqys
- Enables dynamic workflows via the tools.workflowsEnabled user setting, replacing the previous undocumented environment variable method. ([#9098](https://github.com/QwenLM/qwen-code/pull/9098)) by @qqqys
- Enables PR context fetching for Aone Code targets in the /review command, restoring full review capabilities including native approval and issue fidelity. ([#9621](https://github.com/QwenLM/qwen-code/pull/9621)) by @wenshao
- Web Shell now correctly refreshes composer skills after toggles, preventing disabled skills from reappearing and surfacing failed refreshes instead of stale suggestions. ([#9131](https://github.com/QwenLM/qwen-code/pull/9131)) by @samuelhsin
- The review skill now supports comment-status and presubmit flows for Aone Code targets, generating the same JSON report schema as GitHub for merge-gate and CI state checks. ([#9627](https://github.com/QwenLM/qwen-code/pull/9627)) by @wenshao
- feat(models): support dual-role image generation models ([#9650](https://github.com/QwenLM/qwen-code/pull/9650)) by @callmeYe
- Review compose now surfaces a land-with-residual-risk advisory when critical findings persist across rounds, signaling that manual risk acceptance is required to exit the loop. ([#9526](https://github.com/QwenLM/qwen-code/pull/9526)) by @wenshao
- The Computer Use SDK for Node.js is now updated to v0.20.0, providing versioned accessibility observations and stable element tokens across macOS, Windows, and Linux platforms. ([#9587](https://github.com/QwenLM/qwen-code/pull/9587)) by @LaZzyMan
- Added support for MCP 2026 core protocol and introduced an MCP Apps host for rendering inline applications in daemon-backed WebShell sessions. ([#8992](https://github.com/QwenLM/qwen-code/pull/8992)) by @samuelhsin
- Adds a do-not-refute list and constructible rejection bar to the /review skill verifier to prevent invalid rejections of speculative findings. ([#9799](https://github.com/QwenLM/qwen-code/pull/9799)) by @wenshao
- feat(core): declare create_sub_session only under qwen serve ([#9425](https://github.com/QwenLM/qwen-code/pull/9425)) by @DragonnZhang
- Added support for creating scheduled tasks that reuse an existing live session by providing an optional sessionId. ([#9361](https://github.com/QwenLM/qwen-code/pull/9361)) by @yiliang114
- Compact mode now folds adjacent thinking, tool activity, and parallel agents into a single expandable summary row in the web shell. ([#9657](https://github.com/QwenLM/qwen-code/pull/9657)) by @ytahdn
- Kimi (Moonshot AI) is added as a built-in third-party provider with support for international and China endpoints and editable model catalogs. ([#9814](https://github.com/QwenLM/qwen-code/pull/9814)) by @TianYuan1024
- The Workflow tool now displays a detailed approval dialog showing the script's name, phases, and arguments before execution. ([#9837](https://github.com/QwenLM/qwen-code/pull/9837)) by @qqqys
- WebShell now exposes an optional callback to report the active session's complete subagent task snapshot for embedding hosts. ([#9637](https://github.com/QwenLM/qwen-code/pull/9637)) by @callmeYe
- Added an optional async prepareSubmit callback for Web Shell hosts to resolve context dynamically before submission. ([#9802](https://github.com/QwenLM/qwen-code/pull/9802)) by @dreamWB
- Adds four built-in output styles (Concise, Proactive, Explanatory, Learning) to control how the agent reports work throughout a session. ([#9565](https://github.com/QwenLM/qwen-code/pull/9565)) by @qqqys
- Introduces qwen serve --open-with-auth to open a loopback Web Shell with bearer authentication using a provided or auto-generated token. ([#9738](https://github.com/QwenLM/qwen-code/pull/9738)) by @doudouOUC
- Adopts the shared WebShell transcript renderer as the default and only conversation timeline in the VS Code companion, replacing the legacy renderer. ([#9719](https://github.com/QwenLM/qwen-code/pull/9719)) by @yiliang114
- Replaced built-in Computer Use tools with a bundled skill that automatically configures the external Node REPL MCP server and CUA SDK on first use. ([#9856](https://github.com/QwenLM/qwen-code/pull/9856)) by @LaZzyMan
- Promoted language-pitfall and wrapper/proxy checks from Agent 1a to dedicated high-effort Step 3A roles for more thorough code review. ([#9805](https://github.com/QwenLM/qwen-code/pull/9805)) by @wenshao
- The /review command now adds an advisory note when the overall approach, rather than the current patch, is identified as the primary open question. ([#9340](https://github.com/QwenLM/qwen-code/pull/9340)) by @qqqys
- Added a new find-simplifications sweep skill that identifies dead code and orphaned resources, generating evidence-backed proposals for maintainer review. ([#9384](https://github.com/QwenLM/qwen-code/pull/9384)) by @qqqys
- Required explicit user opt-in before launching workflows by defining five specific triggers to prevent unintended multi-agent orchestration. ([#9806](https://github.com/QwenLM/qwen-code/pull/9806)) by @qqqys
- Review executions now run the repository's own commands inside a container boundary defined by operator policy instead of relying on local installation. ([#9723](https://github.com/QwenLM/qwen-code/pull/9723)) by @wenshao
- feat(core): add a per-project outside-repo artifact landing ([#9776](https://github.com/QwenLM/qwen-code/pull/9776)) by @wenshao
- feat(review): report findings to clients as a typed contract ([#9794](https://github.com/QwenLM/qwen-code/pull/9794)) by @wenshao
- Engages the critical severity floor immediately after two consecutive rounds of sustained finding rates instead of waiting for the fixed round-6 schedule. ([#9938](https://github.com/QwenLM/qwen-code/pull/9938)) by @wenshao
- Removed the Electron desktop package and related sync scripts since the code has been forked to the OpenWork repository. ([#9085](https://github.com/QwenLM/qwen-code/pull/9085)) by @yiliang114
- Adds an opt-in liveness check for daemon child processes using ACP channels, with retries and timeouts to detect failures without false positives from host suspension. ([#9976](https://github.com/QwenLM/qwen-code/pull/9976)) by @doudouOUC
- Introduces a built-in DingTalk Workspace channel supporting direct messages, mentions, document notifications, and todo tracking using authenticated DWS CLI profiles. ([#9394](https://github.com/QwenLM/qwen-code/pull/9394)) by @qqqys
- feat(review): add a --topology minimal single-pass A/B arm ([#9919](https://github.com/QwenLM/qwen-code/pull/9919)) by @wenshao
- feat(cli): Manage agent view session lifecycle ([#9986](https://github.com/QwenLM/qwen-code/pull/9986)) by @ZijianZhang989
- feat(goal): make get_goal's default view a summary instead of the whole catalog ([#9973](https://github.com/QwenLM/qwen-code/pull/9973)) by @qqqys
- feat(goal): stop a Goal whose checkpoints stall three times in a row ([#9975](https://github.com/QwenLM/qwen-code/pull/9975)) by @qqqys
- feat(web-shell): make compact view the only mode ([#9993](https://github.com/QwenLM/qwen-code/pull/9993)) by @ytahdn
- feat(daemon): Support current-session scheduled tasks ([#9838](https://github.com/QwenLM/qwen-code/pull/9838)) by @doudouOUC
- feat(core): trust a generated-scripts root for workflow scriptPath loads ([#9987](https://github.com/QwenLM/qwen-code/pull/9987)) by @qqqys
- feat(providers): load model recommendations before editing ([#9980](https://github.com/QwenLM/qwen-code/pull/9980)) by @qqqys
- feat(goal): stop autonomous continuation at a token budget the user re-arms ([#9891](https://github.com/QwenLM/qwen-code/pull/9891)) by @qqqys
- feat(acp): enable managed auto-memory lifecycle ([#9992](https://github.com/QwenLM/qwen-code/pull/9992)) by @zgxkbtl
- feat(cli): Add standalone sessions for projectless tasks ([#9978](https://github.com/QwenLM/qwen-code/pull/9978)) by @doudouOUC
- feat(web-shell): add session token usage panel ([#9988](https://github.com/QwenLM/qwen-code/pull/9988)) by @ytahdn
- feat(core): accept cross-session messages behind an inbound gate ([#9576](https://github.com/QwenLM/qwen-code/pull/9576)) by @qqqys
- feat(goal): let a Goal stop early when its objective is infeasible ([#10125](https://github.com/QwenLM/qwen-code/pull/10125)) by @qqqys
- feat(goal): grant one hand-off turn before a spent budget stops the Goal ([#10132](https://github.com/QwenLM/qwen-code/pull/10132)) by @qqqys
- feat(core): add a bundled goal-draft skill that writes verifier-judgeable Goals ([#10002](https://github.com/QwenLM/qwen-code/pull/10002)) by @qqqys

#### Bug Fixes

- Clicking a session in the Session Overview panel now correctly opens it within its original workspace directory instead of defaulting to the primary workspace. ([#9730](https://github.com/QwenLM/qwen-code/pull/9730)) by @wenshao
- Web Shell now automatically retries messages via the ordinary prompt path if a mid-turn insertion is rejected while the stream is idle, preventing unnecessary error toasts. ([#9732](https://github.com/QwenLM/qwen-code/pull/9732)) by @ytahdn
- The review pipeline no longer posts fallback comments when a run is cancelled because a newer superseding run started, while still commenting on job-level timeouts. ([#9716](https://github.com/QwenLM/qwen-code/pull/9716)) by @wenshao
- Pinned sessions in the Web Shell sidebar now maintain a stable order based on pinning time and provide instant visual feedback when pinned or unpinned. ([#9560](https://github.com/QwenLM/qwen-code/pull/9560)) by @yiliang114
- Updates the workflow size baseline for qwen-autofix.yml to 397656 bytes to match the actual shipped file size and unblock CI checks. ([#9747](https://github.com/QwenLM/qwen-code/pull/9747)) by @wenshao
- fix(ci): gate the fork signal on fields the review payload delivers ([#9469](https://github.com/QwenLM/qwen-code/pull/9469)) by @qqqys
- Rejects session titles that exactly match the prompt's example strings, triggering the existing fallback behavior for auto-title and /rename --auto. ([#9709](https://github.com/QwenLM/qwen-code/pull/9709)) by @yiliang114
- Replaces VM evaluation of workflow meta literals with a static parser to prevent hangs or unbounded allocation caused by malicious model-generated code. ([#9325](https://github.com/QwenLM/qwen-code/pull/9325)) by @qqqys
- Enables workspace artifact downloads using relative daemon base URLs to fix Invalid URL errors in Web Shell integrations configured with same-origin paths. ([#9734](https://github.com/QwenLM/qwen-code/pull/9734)) by @ytahdn
- Increases the repair attempt agent budget to 45 minutes and adjusts related step caps to prevent opaque check failures during deterministic rejections. ([#9691](https://github.com/QwenLM/qwen-code/pull/9691)) by @qqqys
- Extends the workflow stall watchdog window from 60s to 180s to prevent false timeouts during long transport retries or slow model responses. ([#9397](https://github.com/QwenLM/qwen-code/pull/9397)) by @qqqys
- Gates skill announcements on whether the model explicitly declared the Skill tool, preventing wasted turns for subagents with restricted tool lists. ([#9718](https://github.com/QwenLM/qwen-code/pull/9718)) by @wenshao
- Counts fix-induced re-reports as new work in review statistics, distinguishing them from simple re-posts of existing findings. ([#9744](https://github.com/QwenLM/qwen-code/pull/9744)) by @wenshao
- Enables previewing for Markdown, HTML, and raster images in Web Shell by correctly classifying them before generic document handling. ([#9760](https://github.com/QwenLM/qwen-code/pull/9760)) by @ytahdn
- fix(daemon): keep restored ask_user_question valid after load ([#9763](https://github.com/QwenLM/qwen-code/pull/9763)) by @doudouOUC
- Public GitHub extensions now work on systems with Git older than 2.37 by resolving refs to immutable commits and downloading via the secure archive path instead of native Git. ([#9690](https://github.com/QwenLM/qwen-code/pull/9690)) by @yiliang114
- The review workflow now repairs permissions and retries before failing to clean up leftover worktrees, ensuring jobs do not fail due to removal errors. ([#9748](https://github.com/QwenLM/qwen-code/pull/9748)) by @wenshao
- Session title echo comparisons now use symmetric normalization for both candidate and example titles to prevent false mismatches. ([#9809](https://github.com/QwenLM/qwen-code/pull/9809)) by @yiliang114
- Fixed a React dev-mode memory leak in Web Shell by capping performance.measure accumulation and clearing the timeline every 16,384 entries. ([#9770](https://github.com/QwenLM/qwen-code/pull/9770)) by @wenshao
- The DingTalk channel now correctly parses forwarded chat records and includes their titles and summaries in the agent's context. ([#9339](https://github.com/QwenLM/qwen-code/pull/9339)) by @qqqys
- Web Shell now renders bold text correctly when emphasis markers are adjacent to CJK punctuation by adding the remark-cjk-friendly plugin. ([#9457](https://github.com/QwenLM/qwen-code/pull/9457)) by @cactuser-Lu
- Updates the settings schema to accept prompt hooks with prompt and model fields, aligning VS Code validation with runtime behavior. ([#8779](https://github.com/QwenLM/qwen-code/pull/8779)) by @zjunothing
- Adds a read-only reasoning effort preview for the qwen3.8-max model in WebShell welcome state before session creation. ([#9599](https://github.com/QwenLM/qwen-code/pull/9599)) by @callmeYe
- Enables Vertex AI authentication using Application Default Credentials when a Google Cloud project is configured without an API key. ([#9017](https://github.com/QwenLM/qwen-code/pull/9017)) by @axiom-of-choice
- Updates the workflow size baseline for cd-cua-driver.yml to prevent CI failures caused by its increased shipped file size. ([#9822](https://github.com/QwenLM/qwen-code/pull/9822)) by @wenshao
- Clears the tool display list immediately before invoking the completion callback to prevent duplicate rendering in the TUI. ([#9602](https://github.com/QwenLM/qwen-code/pull/9602)) by @qwen-code-dev-bot
- Normalizes Windows drive-letter casing in MCP approval keys to ensure consistent server recognition between CLI and VS Code. ([#9779](https://github.com/QwenLM/qwen-code/pull/9779)) by @zhou2024NAU
- File reading now validates image content via magic bytes before trusting extensions, preventing text files with image extensions from being misclassified. ([#9113](https://github.com/QwenLM/qwen-code/pull/9113)) by @rbalachandar
- Session exports on Windows now correctly preserve drive-letter paths in file links, allowing them to open locally instead of failing in the browser. ([#8953](https://github.com/QwenLM/qwen-code/pull/8953)) by @yefuyou
- The CLI input box border now adapts to terminal resizing by truncating long titles, preventing layout overflow and row jitter. ([#8991](https://github.com/QwenLM/qwen-code/pull/8991)) by @tlysanhuo
- Background agent notifications now include counts of remaining active agents for the same owner to improve coordination status visibility. ([#9018](https://github.com/QwenLM/qwen-code/pull/9018)) by @tao943
- Reasoning effort tiers are now automatically capped to the maximum level supported by each specific model endpoint to prevent request errors. ([#9501](https://github.com/QwenLM/qwen-code/pull/9501)) by @harjothkhara
- Microphone permission checks now occur only when recording starts rather than during voice warmup, preventing unnecessary early permission prompts. ([#8912](https://github.com/QwenLM/qwen-code/pull/8912)) by @Nas01010101
- Fixed loop detection to halt turns when the model repeats long verbatim blocks in content or reasoning streams. ([#9668](https://github.com/QwenLM/qwen-code/pull/9668)) by @yiliang114
- Secured the review process by ensuring the verified git identity remains consistent across all residue probe commands. ([#9742](https://github.com/QwenLM/qwen-code/pull/9742)) by @wenshao
- Fixed an issue where nested sub-agent approval requests were not surfaced to the UI, causing background agents to hang. ([#9793](https://github.com/QwenLM/qwen-code/pull/9793)) by @wenshao
- Ensured agent launch failures now correctly populate the error field to be reported as failed tool calls. ([#9519](https://github.com/QwenLM/qwen-code/pull/9519)) by @yiliang114
- Prevented ghost shutdown pending states by gating task assignment during teammate shutdown request processing. ([#9550](https://github.com/QwenLM/qwen-code/pull/9550)) by @AaronZ345
- Cached fork snapshots are now isolated by session ID to prevent cross-session data leakage during background reads. ([#9471](https://github.com/QwenLM/qwen-code/pull/9471)) by @tomsen02
- Evidence catalog previews are now capped at 240 UTF-8 bytes instead of characters to prevent Goal failures in non-ASCII languages. ([#9835](https://github.com/QwenLM/qwen-code/pull/9835)) by @qqqys
- Fixed text duplication in WSL terminals by skipping the redraw optimizer when running under ConPTY. ([#7897](https://github.com/QwenLM/qwen-code/pull/7897)) by @C0d3N1nja97342
- Fixed token count tracking to invalidate data when the active model route changes, ensuring accurate session limits and compression banners. ([#9506](https://github.com/QwenLM/qwen-code/pull/9506)) by @yiliang114
- Bounded conditional-close refusal holds to a 1,024-hold per-Session limit to prevent oversized responses from breaking cache retention. ([#9820](https://github.com/QwenLM/qwen-code/pull/9820)) by @doudouOUC
- Enabled workflow reapproval after hook bounces by making approval handling incarnation-aware and preventing stale events from affecting newer instances. ([#9547](https://github.com/QwenLM/qwen-code/pull/9547)) by @AaronZ345
- Fixed debug log routing in daemon mode to use async-local session IDs, preventing logs from different sessions being written to the same file. ([#9538](https://github.com/QwenLM/qwen-code/pull/9538)) by @tomsen02
- Added support for per-provider streamIdleTimeoutMs settings to handle varying latency requirements across different model providers. ([#9795](https://github.com/QwenLM/qwen-code/pull/9795)) by @yu-xin-c
- Fixes memory management by allowing forget operations to scan the same uncapped document universe as recall, preventing stale entries from persisting. ([#9530](https://github.com/QwenLM/qwen-code/pull/9530)) by @harjothkhara
- fix(core): make team shutdown a leader-only tool ([#9401](https://github.com/QwenLM/qwen-code/pull/9401)) by @yiliang114
- CI now moves undeletable workspace residue aside via rename instead of failing when standard deletion methods encounter permission issues. ([#9868](https://github.com/QwenLM/qwen-code/pull/9868)) by @wenshao
- Live task bridge operations now consistently use canonical lowercase UUIDs to prevent session lookup failures caused by case mismatches. ([#9819](https://github.com/QwenLM/qwen-code/pull/9819)) by @doudouOUC
- fix(core): map OpenAI-compatible finish_reason case-insensitively ([#9884](https://github.com/QwenLM/qwen-code/pull/9884)) by @yiliang114
- After retry exhaustion, the system now accepts quiet model completions following a tool result instead of aborting the run with an API error. ([#9196](https://github.com/QwenLM/qwen-code/pull/9196)) by @yiliang114
- Added stream-json to the allowed values for the output.format setting in the schema, ensuring VS Code settings match the CLI runtime capabilities. ([#8966](https://github.com/QwenLM/qwen-code/pull/8966)) by @harjothkhara
- The system now validates completed Anthropic tool arguments as strict JSON objects, rejecting malformed inputs to prevent execution of invalid calls. ([#9013](https://github.com/QwenLM/qwen-code/pull/9013)) by @tlysanhuo
- Fixed CI to wipe only A/B checkout directories instead of the entire workspace, preventing 900 MB git history re-downloads and runner hangs. ([#9228](https://github.com/QwenLM/qwen-code/pull/9228)) by @qwen-code-dev-bot
- Disabled the default permission-response timeout so requests remain pending until user decision, while still supporting explicit timeouts via --permission-response-timeout-ms. ([#9933](https://github.com/QwenLM/qwen-code/pull/9933)) by @doudouOUC
- Removed unsupported uniqueItems constraints from function schemas for OpenAI-compatible requests to prevent DashScope endpoint rejections. ([#9869](https://github.com/QwenLM/qwen-code/pull/9869)) by @qqqys
- Unified Goal continuation prompts across all interfaces with a guarded JSON block to prevent prompt injection and ensure objective consistency. ([#9834](https://github.com/QwenLM/qwen-code/pull/9834)) by @qqqys
- Banned unexecuted mutation claims in coverage briefs, requiring unrun mutations to be labeled as hypotheses with witness notes. ([#9923](https://github.com/QwenLM/qwen-code/pull/9923)) by @wenshao
- Downgraded workflow-size ratchet failures to warnings when the PR did not modify the grown file, preventing false positives from baseline changes. ([#9931](https://github.com/QwenLM/qwen-code/pull/9931)) by @wenshao
- Reduces rendering jank in Web Shell by keeping streamed thinking text out of the top-level render path and unmounting collapsed tool details. ([#9914](https://github.com/QwenLM/qwen-code/pull/9914)) by @ytahdn
- Neutralizes both modern ::name:: and legacy ##[name] workflow commands in autofix stdout echoes to prevent injection attacks in job logs. ([#9871](https://github.com/QwenLM/qwen-code/pull/9871)) by @wenshao
- Compiles workflow scripts before registering runs to ensure invalid scripts fail cleanly without creating phantom rows or telemetry events. ([#9873](https://github.com/QwenLM/qwen-code/pull/9873)) by @qqqys
- Repairs persisted session lifecycle operations to handle empty, malformed, or orphaned transcript files while returning conflicts as per-session errors. ([#9626](https://github.com/QwenLM/qwen-code/pull/9626)) by @doudouOUC
- The CLI now gracefully handles unreadable prompt files by logging a warning and using the default rewrite prompt instead of crashing. ([#9753](https://github.com/QwenLM/qwen-code/pull/9753)) by @yiliang114
- Goal ownership now hydrates independently from session metadata, allowing Slash commands to load faster without waiting for slower metadata requests. ([#9977](https://github.com/QwenLM/qwen-code/pull/9977)) by @ytahdn
- The /goal resume command now correctly resumes evidence-limited Goals by resetting the evidence cursor while preserving objective and revision data. ([#9840](https://github.com/QwenLM/qwen-code/pull/9840)) by @qqqys
- Restricts Git credential configuration to scoped operations initiated by Qwen Code, ensuring credentials remain isolated from URLs, logs, and environment variables. ([#9870](https://github.com/QwenLM/qwen-code/pull/9870)) by @callmeYe
- Ensures branched sessions inherit the source session's display name with numeric suffixes instead of random UUIDs, improving session recognition and consistency. ([#9764](https://github.com/QwenLM/qwen-code/pull/9764)) by @water-in-stone
- Fixes telemetry aggregation errors during failed session swaps by using explicit transactions to prevent inflated usage records from replayed history. ([#9844](https://github.com/QwenLM/qwen-code/pull/9844)) by @yiliang114
- Corrects QQ Bot cron message handling by tracking active prompts in a dedicated set instead of relying on unreliable stream state indicators. ([#9971](https://github.com/QwenLM/qwen-code/pull/9971)) by @yiliang114
- fix(cli): mark estimated compression token counts in banners ([#9568](https://github.com/QwenLM/qwen-code/pull/9568)) by @yiliang114
- Ensures OpenRouter requests explicitly disable reasoning features when configured off, by emitting the native reasoning parameter in the API payload. ([#9758](https://github.com/QwenLM/qwen-code/pull/9758)) by @yiliang114
- fix(core): validate skill commands against the live provider to survive late attach ([#9824](https://github.com/QwenLM/qwen-code/pull/9824)) by @yiliang114
- fix(cli): keep in-flight tool calls pending during live session replay ([#9705](https://github.com/QwenLM/qwen-code/pull/9705)) by @yiliang114
- fix(core): reject unverifiable validated read inodes ([#9857](https://github.com/QwenLM/qwen-code/pull/9857)) by @AaronZ345
- fix(review): the sandbox default named an image that does not exist ([#9972](https://github.com/QwenLM/qwen-code/pull/9972)) by @wenshao
- fix(web-shell): localize vision bridge notices ([#10003](https://github.com/QwenLM/qwen-code/pull/10003)) by @ytahdn
- fix(web-shell): allow reasoning selection before session creation ([#10008](https://github.com/QwenLM/qwen-code/pull/10008)) by @callmeYe
- fix(core): subordinate the coordinate skill's teammate count to the configured cap ([#9403](https://github.com/QwenLM/qwen-code/pull/9403)) by @yiliang114
- fix: repair the Windows and macOS test lane failures ([#9728](https://github.com/QwenLM/qwen-code/pull/9728)) by @wenshao
- fix(ci): give the macOS and Windows lanes a trigger again ([#9370](https://github.com/QwenLM/qwen-code/pull/9370)) by @wenshao
- fix(core): make permissions.allow restrict the tool schemas sent to the model ([#9829](https://github.com/QwenLM/qwen-code/pull/9829)) by @yiliang114
- fix(webui): preserve hydrated Goal state during event startup ([#10012](https://github.com/QwenLM/qwen-code/pull/10012)) by @ytahdn
- fix(cli): graft the review anchor forward across fail-closed rounds ([#9932](https://github.com/QwenLM/qwen-code/pull/9932)) by @wenshao
- fix(live): restore Live Host after desktop removal ([#9994](https://github.com/QwenLM/qwen-code/pull/9994)) by @yiliang114
- fix(goal): cite this turn's delivered output instead of refusing over it ([#9880](https://github.com/QwenLM/qwen-code/pull/9880)) by @qqqys
- fix(serve): let channel workers reach TLS-enabled daemons ([#9392](https://github.com/QwenLM/qwen-code/pull/9392)) by @qqqys
- fix(cli): drop duplicate fake properties breaking the main build ([#10022](https://github.com/QwenLM/qwen-code/pull/10022)) by @yiliang114
- fix(core): register report_findings in the permission alias table ([#10033](https://github.com/QwenLM/qwen-code/pull/10033)) by @yiliang114
- fix(cli): preserve bridge timeouts for mid-turn media ([#9995](https://github.com/QwenLM/qwen-code/pull/9995)) by @ytahdn
- fix(mcp): recover restarted HTTP MCP servers in-session and in CLI ([#9962](https://github.com/QwenLM/qwen-code/pull/9962)) by @yiliang114
- fix(core): sync loaded-skill state with history eviction ([#9500](https://github.com/QwenLM/qwen-code/pull/9500)) by @ZijianZhang989
- fix(core): preserve images for multimodal DeepSeek ([#9854](https://github.com/QwenLM/qwen-code/pull/9854)) by @shenyankm
- fix(ci): yield the event loop between script tests to avoid vitest RPC timeouts (#10037) ([#10050](https://github.com/QwenLM/qwen-code/pull/10050)) by @qwen-code-dev-bot
- fix(vscode): sync companion token limits ([#9850](https://github.com/QwenLM/qwen-code/pull/9850)) by @AaronZ345
- fix(ui): suppress duplicate identical TodoList panels in a single turn ([#9692](https://github.com/QwenLM/qwen-code/pull/9692)) by @PratikWayase
- fix(ci): retry sandbox image builds and file an issue when a release build fails ([#9916](https://github.com/QwenLM/qwen-code/pull/9916)) by @yiliang114
- fix(web-shell): constrain responsive sidebar drawer ([#10020](https://github.com/QwenLM/qwen-code/pull/10020)) by @dreamWB
- fix(core): dedupe hierarchical memory files by canonical identity ([#9600](https://github.com/QwenLM/qwen-code/pull/9600)) by @yiliang114
- fix(cua-driver): support sandboxed Windows SDK clients ([#10120](https://github.com/QwenLM/qwen-code/pull/10120)) by @LaZzyMan
- fix(node-repl): make package verification idempotent ([#10133](https://github.com/QwenLM/qwen-code/pull/10133)) by @LaZzyMan
- fix(review): give cancelled runs an accurate fallback body instead of the failure comment ([#10114](https://github.com/QwenLM/qwen-code/pull/10114)) by @wenshao
- fix(cua-driver): synchronize release version marker ([#10135](https://github.com/QwenLM/qwen-code/pull/10135)) by @LaZzyMan
- fix(core): keep allowlist-uncovered tools registered as deferred instead of removing them (#10075) ([#10082](https://github.com/QwenLM/qwen-code/pull/10082)) by @yiliang114
- fix(daemon): Persist empty sessions before scheduled-task binding ([#10144](https://github.com/QwenLM/qwen-code/pull/10144)) by @doudouOUC
- fix(channels): Make same-chat delivery session-aware ([#10145](https://github.com/QwenLM/qwen-code/pull/10145)) by @doudouOUC

#### Performance

- Terminal virtual scrolling now renders at up to 60 FPS, eliminating choppiness and improving scroll smoothness in large PTY windows compared to the previous 30 FPS cap. ([#9681](https://github.com/QwenLM/qwen-code/pull/9681)) by @DragonnZhang

#### Documentation

- Clarifies documentation by explicitly naming axes when referring to "rank 3" to resolve ambiguity between trimming and keeping operations. ([#9759](https://github.com/QwenLM/qwen-code/pull/9759)) by @wenshao
- docs(agent): clarify parameter preconditions ([#9580](https://github.com/QwenLM/qwen-code/pull/9580)) by @tao943
- Corrected the VS Code extension README to state the actual minimum required version of 1.96.0 instead of 1.85.0. ([#9852](https://github.com/QwenLM/qwen-code/pull/9852)) by @AaronZ345
- docs(core): fix goal judge timeout unit ([#9861](https://github.com/QwenLM/qwen-code/pull/9861)) by @AaronZ345
- Updated the ReadFile tool documentation to reference the truncateToolOutputLines setting for the default paging limit instead of a hardcoded line count. ([#9863](https://github.com/QwenLM/qwen-code/pull/9863)) by @AaronZ345
- Fixed TypeScript SDK timeout examples to use the correct query({ prompt, options }) factory signature instead of the outdated positional argument format. ([#9867](https://github.com/QwenLM/qwen-code/pull/9867)) by @AaronZ345
- docs: consolidate assorted documentation corrections ([#9855](https://github.com/QwenLM/qwen-code/pull/9855)) by @AaronZ345

#### Internal Changes

- Migrated autofix prose to a design record to reduce workflow file size and implemented a ratchet mechanism to limit future growth visibility in reviews. ([#9677](https://github.com/QwenLM/qwen-code/pull/9677)) by @wenshao
- Adds tests confirming subagent registries exclude MCP instructions, ensuring buildMcpServerInstructionsReminder remains safe without production code changes. ([#9720](https://github.com/QwenLM/qwen-code/pull/9720)) by @wenshao
- Enforced architectural boundaries by moving domain-coupled modules out of the CLI utils leaf layer and adding an ESLint rule to prevent upward imports. ([#9737](https://github.com/QwenLM/qwen-code/pull/9737)) by @yiliang114
- Refactors ACP skill management by extracting source acquisition and mutation logic into cohesive internal modules. ([#8865](https://github.com/QwenLM/qwen-code/pull/8865)) by @callmeYe
- Image generation now supports MiniMax endpoints by using the correct request schema and handling both URL and base64 responses. ([#8322](https://github.com/QwenLM/qwen-code/pull/8322)) by @octo-patch
- Refactored Goal continuation prompts to use a single core renderer for consistent output across all interfaces. ([#9581](https://github.com/QwenLM/qwen-code/pull/9581)) by @qqqys
- The review skill manifest is split into a core body and verdict-gated reference files to optimize loading based on posting status. ([#9804](https://github.com/QwenLM/qwen-code/pull/9804)) by @wenshao
- chore(ci): refresh the core issue-owner pool ([#9808](https://github.com/QwenLM/qwen-code/pull/9808)) by @yiliang114
- Refactors core utils to be a strict leaf layer with no runtime dependencies on other core modules, ensuring cleaner architectural boundaries. ([#9778](https://github.com/QwenLM/qwen-code/pull/9778)) by @yiliang114
- Centralizes approval mode contracts across core, CLI, and SDKs to ensure consistent validation and prevent silent mismatches in future updates. ([#9796](https://github.com/QwenLM/qwen-code/pull/9796)) by @yiliang114
- Establishes explicit ownership for derived Config instances via a new deriveConfig factory boundary and guards for lifecycle mutations. ([#8100](https://github.com/QwenLM/qwen-code/pull/8100)) by @yiliang114
- ACP cron tests now terminate the entire CLI process tree during cleanup to prevent directory deletion errors on POSIX and Windows. ([#9815](https://github.com/QwenLM/qwen-code/pull/9815)) by @dream-creator
- Removed unused token-counting and summarized-thinking capabilities from the core content generator interface to simplify provider implementations. ([#9676](https://github.com/QwenLM/qwen-code/pull/9676)) by @DragonnZhang
- Updated the Vertex-mode lazy generator test to use embedContent instead of the removed countTokens method to fix the TypeScript build. ([#9888](https://github.com/QwenLM/qwen-code/pull/9888)) by @AaronZ345
- Skipped the unreadable-ledger test when running as root since permission checks are bypassed, ensuring test stability in root environments. ([#9913](https://github.com/QwenLM/qwen-code/pull/9913)) by @wenshao
- Updated internal comments to correctly explain that replay safety relies on discarding failed attempt turns rather than excluding thought parts from history. ([#8861](https://github.com/QwenLM/qwen-code/pull/8861)) by @ComplexSimply
- Refactored the Core client to remove a runtime import cycle by importing the approval-mode enum directly from its definition. ([#9959](https://github.com/QwenLM/qwen-code/pull/9959)) by @DragonnZhang
- Workspace Git and status routes now share a single trusted-runtime resolver to ensure consistent security validation across all endpoints. ([#9958](https://github.com/QwenLM/qwen-code/pull/9958)) by @DragonnZhang
- chore(github): add @qqqys as core package codeowner ([#9982](https://github.com/QwenLM/qwen-code/pull/9982)) by @yiliang114
- test(cli): teach session-swap telemetry fakes the /branch title prerequisites ([#9998](https://github.com/QwenLM/qwen-code/pull/9998)) by @yiliang114
- refactor(acp-bridge): narrow workspace event capabilities ([#9957](https://github.com/QwenLM/qwen-code/pull/9957)) by @DragonnZhang
- refactor(web-shell): extract shared contexts ([#9954](https://github.com/QwenLM/qwen-code/pull/9954)) by @DragonnZhang
- refactor(web-shell): reuse canonical todo parser ([#9956](https://github.com/QwenLM/qwen-code/pull/9956)) by @DragonnZhang
- refactor(cli): remove unused EnumSelector component ([#9997](https://github.com/QwenLM/qwen-code/pull/9997)) by @qqqys
- ci: take the macOS and Windows lanes off pull requests ([#10059](https://github.com/QwenLM/qwen-code/pull/10059)) by @wenshao
- refactor(core): remove unused LruCache utility ([#9926](https://github.com/QwenLM/qwen-code/pull/9926)) by @AaronZ345
- refactor(cli): remove unused useInputHistoryStore hook ([#10041](https://github.com/QwenLM/qwen-code/pull/10041)) by @qqqys
- chore(ci): migrate CUA npm packages to trusted publishing ([#9836](https://github.com/QwenLM/qwen-code/pull/9836)) by @yiliang114
- chore(cua-driver): bump SDK to 0.20.1 ([#10127](https://github.com/QwenLM/qwen-code/pull/10127)) by @LaZzyMan

### New Contributors

- @cactuser-Lu made their first contribution in [#9457](https://github.com/QwenLM/qwen-code/pull/9457)
- @axiom-of-choice made their first contribution in [#9017](https://github.com/QwenLM/qwen-code/pull/9017)
- @zhou2024NAU made their first contribution in [#9779](https://github.com/QwenLM/qwen-code/pull/9779)
- @octo-patch made their first contribution in [#8322](https://github.com/QwenLM/qwen-code/pull/8322)
- @yefuyou made their first contribution in [#8953](https://github.com/QwenLM/qwen-code/pull/8953)
- @tao943 made their first contribution in [#9018](https://github.com/QwenLM/qwen-code/pull/9018)
- @AaronZ345 made their first contribution in [#9550](https://github.com/QwenLM/qwen-code/pull/9550)
- @yu-xin-c made their first contribution in [#9795](https://github.com/QwenLM/qwen-code/pull/9795)
- @dream-creator made their first contribution in [#9815](https://github.com/QwenLM/qwen-code/pull/9815)
- @zgxkbtl made their first contribution in [#9992](https://github.com/QwenLM/qwen-code/pull/9992)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.22.0...v0.22.2

## [0.22.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.22.0) - 2026-08-22

### Highlights

- Web Shell prevents out-of-memory crashes by bounding transcript retention and trimming oversized replays. ([#9303](https://github.com/QwenLM/qwen-code/pull/9303))
- Review loops now explain instability by citing specific files with recurring findings or non-shrinking comment volumes. ([#9461](https://github.com/QwenLM/qwen-code/pull/9461))
- Autofix now audits PR approach for simplicity instead of stopping automation immediately upon a growth-budget breach. ([#9262](https://github.com/QwenLM/qwen-code/pull/9262))
- Web Shell keeps conversation turns expanded while background shells run, collapsing them only after completion. ([#9632](https://github.com/QwenLM/qwen-code/pull/9632))
- Created GitHub PRs are now bound to originating sessions with a searchable list and sidebar badge. ([#9543](https://github.com/QwenLM/qwen-code/pull/9543))
- Non-blocking slash commands now include eleven built-ins like /theme and /tools for immediate execution during streaming. ([#9495](https://github.com/QwenLM/qwen-code/pull/9495))

### Breaking Changes

No known breaking changes.

### Web Shell Experience

Improves Web Shell stability, UI responsiveness, streaming performance, and conversation handling during active sessions.

- Web Shell now bounds daemon transcript retention and trims oversized replays to prevent renderer out-of-memory crashes. ([#9303](https://github.com/QwenLM/qwen-code/pull/9303))
- Web Shell now keeps conversation turns expanded while their background shells are running, collapsing them only after completion. ([#9632](https://github.com/QwenLM/qwen-code/pull/9632))
- Fixes web-shell UI so subagent prompts scroll correctly and parallel-agent groups collapse immediately upon completion. ([#9640](https://github.com/QwenLM/qwen-code/pull/9640))
- Adds a hover tooltip to the create-group icon in Web Shell to clarify its function for mouse users. ([#9400](https://github.com/QwenLM/qwen-code/pull/9400))
- Updates the conversation loading indicator to use the daemon's hasActivePrompt state, ensuring it remains visible during long tool calls even when streaming is idle. ([#9631](https://github.com/QwenLM/qwen-code/pull/9631))
- Prevents the Web Shell tool-approval dialog from stealing keyboard focus when it appears while the user is actively typing in an editable element. ([#9609](https://github.com/QwenLM/qwen-code/pull/9609))
- Optimizes Web Shell streaming performance by reducing main-thread work and reloading oversized transcripts after 15 seconds of inactivity. ([#9672](https://github.com/QwenLM/qwen-code/pull/9672))
- Routes ordinary Web Shell messages based on session activity rather than Goal status to improve turn handling and insertion logic. ([#9667](https://github.com/QwenLM/qwen-code/pull/9667))

### Review & Autofix Logic

Enhances review loop explanations, Autofix auditing, convergence observations, and PR detection to reduce noise and improve automation reliability.

- Review loops now explain why they are not settling by citing specific files with recurring findings or comment volumes that are not shrinking. ([#9461](https://github.com/QwenLM/qwen-code/pull/9461))
- Autofix now audits the PR approach for simplicity and minimal change instead of stopping automation immediately upon a growth-budget breach. ([#9262](https://github.com/QwenLM/qwen-code/pull/9262))
- Fixed autofix busy-PR detection to include pending workflow runs, preventing duplicate dispatches caused by GitHub status reporting delays. ([#9662](https://github.com/QwenLM/qwen-code/pull/9662))
- Adds machine-readable convergence observation codes like root-cause-triage and batch-fixes to enable automated review actions. ([#9623](https://github.com/QwenLM/qwen-code/pull/9623))
- Assigns review agents a dedicated subagent type with only six required tools to reduce token usage and improve performance. ([#9678](https://github.com/QwenLM/qwen-code/pull/9678))
- Adjusts review body trimming priority to preserve convergence observations about finding rates until all other advisory content is dropped. ([#9715](https://github.com/QwenLM/qwen-code/pull/9715))
- Extends the /review skill cleanup audit to Aone Code targets, flagging comments or edits made within the review window that were not submitted via the sanctioned path. ([#9633](https://github.com/QwenLM/qwen-code/pull/9633))

### Aone & GitHub Integration

Fixes Aone AGit-Flow caching, presubmit checks, and comment handling while binding GitHub PRs to sessions for better traceability.

- Fixed incremental review caching for Aone AGit-Flow CRs by computing diffs between local heads instead of relying on ancestry tests that fail after amendments. ([#9630](https://github.com/QwenLM/qwen-code/pull/9630))
- Enabled /review presubmit on Aone targets to detect self-MRs and head drift by routing through the a1 CLI and comparing author identity. ([#9629](https://github.com/QwenLM/qwen-code/pull/9629))
- Updated /review --comment output on Aone targets to explicitly disclose that posted comments are unmarked and only join the generic discussion gate. ([#9625](https://github.com/QwenLM/qwen-code/pull/9625))
- Binds created GitHub PRs to their originating sessions with a searchable list and sidebar badge, supporting up to 10 PRs per session with latest-first ordering. ([#9543](https://github.com/QwenLM/qwen-code/pull/9543))
- Fixes Aone review support by generating canonical PR links directly from the platform and updating test-plan routing and version floors. ([#9624](https://github.com/QwenLM/qwen-code/pull/9624))
- Clears deferred Round-5 findings on the Aone write path, ensuring empty --host arguments fail distinctly and test pins correctly guard regressions. ([#9604](https://github.com/QwenLM/qwen-code/pull/9604))
- Adds a secure fallback path for installing public GitHub extensions on older Git versions by resolving commits via GitHub's anonymous API and downloading archives directly. ([#9680](https://github.com/QwenLM/qwen-code/pull/9680))

### Slash Commands & Tools

Expands non-blocking slash commands, stabilizes menu selection during streaming, and restores interactive HITL prompts on session resume.

- Extends non-blocking slash commands to eleven built-ins like /theme and /tools, allowing immediate execution during streaming. ([#9495](https://github.com/QwenLM/qwen-code/pull/9495))
- Stabilizes slash-command menu selection while a response streams by preventing unnecessary re-runs of the suggestion search due to unrelated context updates. ([#9508](https://github.com/QwenLM/qwen-code/pull/9508))
- serve: restore ask_user_question HITL on session load/resume ([#9665](https://github.com/QwenLM/qwen-code/pull/9665))
- Integrates import widening logic into fetch-pr --since to streamline incremental scope calculation and reduce token usage. ([#9332](https://github.com/QwenLM/qwen-code/pull/9332))

### Security & Dependencies

Patches high-severity CVEs, secures sandbox images against tampering, and enforces stricter dependency and workflow security gates.

- The sandbox image is now bound to its specific pulled digest to prevent tampering via mutable tags between resolve and consumption steps. ([#9527](https://github.com/QwenLM/qwen-code/pull/9527))
- Upgraded dependencies including OpenTelemetry 0.221.x and markdown-it 15 to resolve high-severity CVEs and enforced the security gate as a hard block. ([#9584](https://github.com/QwenLM/qwen-code/pull/9584))
- Bumps vulnerable dependencies including tar, protobufjs, dompurify, and echarts to patched versions to resolve CVE audits without changing code or package ranges. ([#9703](https://github.com/QwenLM/qwen-code/pull/9703))
- core: make list_directory opt-in (disabled by default) ([#9424](https://github.com/QwenLM/qwen-code/pull/9424))

### SDKs & Permissions

Updates Python and Java SDKs to support auto permission mode, aligning tool call approval behavior across all client libraries.

- Updates Python and Java SDKs to support the auto permission mode, aligning them with the CLI and TypeScript SDK for LLM-based tool call approval. ([#9003](https://github.com/QwenLM/qwen-code/pull/9003))

### CI & Artifact Handling

Corrects CI fallback comments, fixes artifact download logic for Office files, and stabilizes verification gates with proper environment variables.

- The CI fallback comment no longer incorrectly claims a review failed when the same run successfully posted a review earlier. ([#9462](https://github.com/QwenLM/qwen-code/pull/9462))
- Fixed artifact handling to expand recorded directories into per-file downloads while skipping hidden or junk files, and ensured Office documents download directly. ([#9395](https://github.com/QwenLM/qwen-code/pull/9395))
- Restores CI=true to autofix verification-gate launches to prevent test flakiness caused by missing environment variables in clean child processes. ([#9649](https://github.com/QwenLM/qwen-code/pull/9649))
- Excludes idle watchdog timeouts from the cumulative timeout cap so they no longer block PRs while remaining visible in logs. ([#9673](https://github.com/QwenLM/qwen-code/pull/9673))

### General Fixes

Addresses miscellaneous bugs including session recovery races, review body trimming, and daemon state synchronization issues.

- Fixes session recovery across archive races by prioritizing active storage copies for REST, daemon ACP, and embedded ACP load operations. ([#9513](https://github.com/QwenLM/qwen-code/pull/9513))
- Removes root barrel self-imports in packages/core and adds an ESLint rule to prevent circular dependencies and enforce architecture boundaries. ([#9635](https://github.com/QwenLM/qwen-code/pull/9635))
- Refactors acp-integration and serve internals to enforce dependency boundaries with no intended behavior change for users. ([#9144](https://github.com/QwenLM/qwen-code/pull/9144))
- Moves the push-and-report workflow logic to a separate shell script to reduce YAML size while maintaining execution security. ([#9653](https://github.com/QwenLM/qwen-code/pull/9653))
- Adds translated Unset entries to all nine CLI locale dictionaries for consistent settings dialog display across languages. ([#9714](https://github.com/QwenLM/qwen-code/pull/9714))
- review: report the address a drive's service actually bound ([#9655](https://github.com/QwenLM/qwen-code/pull/9655))

### Other Changes

- Release CI now disables install scripts during dependency installation and requires core maintainer approval for security-checks workflow changes. ([#9577](https://github.com/QwenLM/qwen-code/pull/9577))
- Corrected workflow comments to accurately state that the self-hosted ECS pool supports container runtime execution. ([#9575](https://github.com/QwenLM/qwen-code/pull/9575))
- Documents a new design for autofix that isolates trusted publishing steps from untrusted code execution to enhance security. ([#9525](https://github.com/QwenLM/qwen-code/pull/9525))
- Documents how inline terminal image previews render, including limits, fallbacks, and session-resume behavior. ([#8656](https://github.com/QwenLM/qwen-code/pull/8656))
- Documents the experimental Session Workflow setting, covering its default state, live updates, and Web Shell presentation. ([#8554](https://github.com/QwenLM/qwen-code/pull/8554))
- Documentation updated to clarify that autofix checks are derived strictly from patch text and to outline sequencing constraints for issue-autofix. ([#9652](https://github.com/QwenLM/qwen-code/pull/9652))
- autofix: add an operator guide for /takeover from N ([#9622](https://github.com/QwenLM/qwen-code/pull/9622))
- Corrects the autofix round-seed guide to clarify that any leading whitespace, including spaces, tabs, or newlines, prevents command recognition. ([#9663](https://github.com/QwenLM/qwen-code/pull/9663))
- Documents architectural invariants classified by enforcement mechanism including ESLint rules, tests, and tsconfig settings. ([#9689](https://github.com/QwenLM/qwen-code/pull/9689))

### 中文摘要

#### 亮点

- Web Shell 通过限制转录保留并修剪过大的重放来防止内存溢出崩溃。 ([#9303](https://github.com/QwenLM/qwen-code/pull/9303))
- 审查循环现在通过指出存在重复问题的文件或评论数量未减少的情况来说明不稳定的原因。 ([#9461](https://github.com/QwenLM/qwen-code/pull/9461))
- Autofix 现在在超出增长预算时审计 PR 方法的简洁性，而不是立即停止自动化。 ([#9262](https://github.com/QwenLM/qwen-code/pull/9262))
- Web Shell 现在会在后台 shell 运行时保持对话轮次展开，仅在完成后折叠。 ([#9632](https://github.com/QwenLM/qwen-code/pull/9632))
- 创建的 GitHub PR 现在绑定到其源会话，提供可搜索列表和侧边栏徽章。 ([#9543](https://github.com/QwenLM/qwen-code/pull/9543))
- 非阻塞斜杠命令现在扩展到 /theme 和 /tools 等十一个内置命令，允许在流式传输期间立即执行。 ([#9495](https://github.com/QwenLM/qwen-code/pull/9495))

#### Web Shell 体验优化

提升 Web Shell 的稳定性、UI 响应速度、流式传输性能以及活跃会话期间的对话处理能力。

- Web Shell 现在限制了守护进程转录保留并修剪过大的重放，以防止渲染器内存溢出崩溃。 ([#9303](https://github.com/QwenLM/qwen-code/pull/9303))
- Web Shell 现在会在后台 shell 运行时保持对话轮次展开，仅在完成后折叠。 ([#9632](https://github.com/QwenLM/qwen-code/pull/9632))
- 修复 Web Shell UI，使子代理提示正常滚动且并行代理组在完成后立即折叠。 ([#9640](https://github.com/QwenLM/qwen-code/pull/9640))
- 为 Web Shell 中的 create-group 图标添加悬停提示，以便鼠标用户了解其功能。 ([#9400](https://github.com/QwenLM/qwen-code/pull/9400))
- 更新对话加载指示器以使用 daemon 的 hasActivePrompt 状态，确保在长时间工具调用期间即使流式传输空闲也能保持可见。 ([#9631](https://github.com/QwenLM/qwen-code/pull/9631))
- 防止 Web Shell 工具批准对话框在用户正在可编辑元素中输入时弹出并窃取键盘焦点。 ([#9609](https://github.com/QwenLM/qwen-code/pull/9609))
- 通过减少主线程工作并在空闲 15 秒后重载过大转录文本来优化 Web Shell 流式传输性能。 ([#9672](https://github.com/QwenLM/qwen-code/pull/9672))
- 根据会话活动而非 Goal 状态路由普通 Web Shell 消息，以改进轮次处理和插入逻辑。 ([#9667](https://github.com/QwenLM/qwen-code/pull/9667))

#### 审查与自动修复逻辑

增强审查循环解释、Autofix 审计、收敛观察及 PR 检测功能，以减少噪音并提升自动化可靠性。

- 审查循环现在会说明未稳定的原因，指出存在重复问题的文件或评论数量未减少的情况。 ([#9461](https://github.com/QwenLM/qwen-code/pull/9461))
- Autofix 现在在超出增长预算时审计 PR 方法的简洁性和最小变更，而不是立即停止自动化。 ([#9262](https://github.com/QwenLM/qwen-code/pull/9262))
- 修复了 autofix 繁忙 PR 检测逻辑以包含 pending 状态的工作流运行，防止因 GitHub 状态报告延迟导致的重复分发。 ([#9662](https://github.com/QwenLM/qwen-code/pull/9662))
- 添加了 root-cause-triage 和 batch-fixes 等机器可读的收敛观察代码以支持自动化审查操作。 ([#9623](https://github.com/QwenLM/qwen-code/pull/9623))
- 为审查代理分配仅含六个必要工具的专用子代理类型，以减少令牌使用并提升性能。 ([#9678](https://github.com/QwenLM/qwen-code/pull/9678))
- 调整审查正文裁剪优先级，确保在丢弃其他建议内容前保留关于发现率的收敛观察。 ([#9715](https://github.com/QwenLM/qwen-code/pull/9715))
- 将 /review 技能清理审计扩展至 Aone Code 目标，标记在审查窗口内未经过批准路径提交的评论或编辑。 ([#9633](https://github.com/QwenLM/qwen-code/pull/9633))

#### Aone 与 GitHub 集成

修复 Aone AGit-Flow 缓存、预提交检查及评论处理，并将 GitHub PR 绑定至会话以提升可追溯性。

- 修复了 Aone AGit-Flow CR 的增量审查缓存，通过计算本地头之间的差异而非依赖修正后失效的祖先测试。 ([#9630](https://github.com/QwenLM/qwen-code/pull/9630))
- 启用了 Aone 目标上的 /review presubmit 功能，通过 a1 CLI 路由并比对作者身份来检测 self-MR 和头部分支漂移。 ([#9629](https://github.com/QwenLM/qwen-code/pull/9629))
- 更新了 Aone 目标上 /review --comment 的输出，明确说明发布的评论未标记且仅加入通用讨论网关。 ([#9625](https://github.com/QwenLM/qwen-code/pull/9625))
- 将创建的 GitHub PR 绑定到其源会话，提供可搜索列表和侧边栏徽章，每会话支持最多 10 个 PR 并按最新优先排序。 ([#9543](https://github.com/QwenLM/qwen-code/pull/9543))
- 修复 Aone 审查支持，直接从平台生成规范 PR 链接，并更新 test-plan 路由和版本下限。 ([#9624](https://github.com/QwenLM/qwen-code/pull/9624))
- 清理 Aone 写入路径上延迟的第五轮发现，确保空 --host 参数明确失败且测试桩正确防护回归。 ([#9604](https://github.com/QwenLM/qwen-code/pull/9604))
- 为旧版 Git 添加安全回退路径，通过 GitHub 匿名 API 解析提交并直接下载归档，以安装公共 GitHub 扩展。 ([#9680](https://github.com/QwenLM/qwen-code/pull/9680))

#### 斜杠命令与工具

扩展非阻塞斜杠命令，稳定流式传输期间的菜单选择，并在会话恢复时还原交互式 HITL 提示。

- 将非阻塞斜杠命令扩展到 /theme 和 /tools 等十一个内置命令，允许在流式传输期间立即执行。 ([#9495](https://github.com/QwenLM/qwen-code/pull/9495))
- 通过防止因无关上下文更新而重新运行建议搜索，稳定响应流式传输时的斜杠命令菜单选择。 ([#9508](https://github.com/QwenLM/qwen-code/pull/9508))
- serve: restore ask_user_question HITL on session load/resume ([#9665](https://github.com/QwenLM/qwen-code/pull/9665))
- 将导入扩展逻辑集成到 fetch-pr --since 中，以简化增量范围计算并减少 token 使用量。 ([#9332](https://github.com/QwenLM/qwen-code/pull/9332))

#### 安全与依赖项

修补高危 CVE 漏洞，防止沙箱镜像被篡改，并执行更严格的依赖项与工作流安全网关。

- 沙箱镜像现在绑定到其特定的拉取摘要，以防止在解析和使用步骤之间通过可变标签进行篡改。 ([#9527](https://github.com/QwenLM/qwen-code/pull/9527))
- 升级了 OpenTelemetry 0.221.x 和 markdown-it 15 等依赖以修复高危 CVE，并将安全网关设为强制拦截。 ([#9584](https://github.com/QwenLM/qwen-code/pull/9584))
- 提升 tar、protobufjs、dompurify 和 echarts 等易受攻击依赖项至修补版本，以解决 CVE 审计问题，无需更改代码或包范围。 ([#9703](https://github.com/QwenLM/qwen-code/pull/9703))
- core: make list_directory opt-in (disabled by default) ([#9424](https://github.com/QwenLM/qwen-code/pull/9424))

#### SDK 与权限管理

更新 Python 和 Java SDK 以支持 auto 权限模式，统一所有客户端库的工具调用审批行为。

- 更新 Python 和 Java SDK 以支持 auto 权限模式，使其与 CLI 和 TypeScript SDK 在基于 LLM 的工具调用审批上保持一致。 ([#9003](https://github.com/QwenLM/qwen-code/pull/9003))

#### CI 与工件处理

修正 CI 回退评论，修复 Office 文件的工件下载逻辑，并通过正确的环境变量稳定验证网关。

- CI 回退评论不再错误地声称审查失败，如果同一运行已成功发布审查。 ([#9462](https://github.com/QwenLM/qwen-code/pull/9462))
- 修复了工件处理逻辑，将目录展开为单文件下载并跳过隐藏文件，同时确保 Office 文档直接下载。 ([#9395](https://github.com/QwenLM/qwen-code/pull/9395))
- 恢复 autofix verification-gate 启动时的 CI=true，防止因清理子进程缺少环境变量导致的测试不稳定。 ([#9649](https://github.com/QwenLM/qwen-code/pull/9649))
- 将空闲看门狗超时排除在累计超时上限之外，使其不再阻塞 PR 但仍保留在日志中。 ([#9673](https://github.com/QwenLM/qwen-code/pull/9673))

#### 常规修复

解决包括会话恢复竞争、审查正文裁剪及守护进程状态同步在内的各类杂项问题。

- 修复跨归档竞争的会话恢复，优先在 REST、daemon ACP 和 embedded ACP 加载操作中使用活动存储副本。 ([#9513](https://github.com/QwenLM/qwen-code/pull/9513))
- 移除 packages/core 中的根桶自导入并添加 ESLint 规则，防止循环依赖并强制架构边界。 ([#9635](https://github.com/QwenLM/qwen-code/pull/9635))
- 重构 acp-integration 和 serve 内部结构以强制依赖边界，对用户无预期行为变更。 ([#9144](https://github.com/QwenLM/qwen-code/pull/9144))
- 将 push-and-report 工作流逻辑移至单独的 Shell 脚本，在保持执行安全性的同时减小 YAML 文件体积。 ([#9653](https://github.com/QwenLM/qwen-code/pull/9653))
- 为所有九种 CLI 语言字典添加了 Unset 翻译条目，以确保设置对话框的多语言显示一致性。 ([#9714](https://github.com/QwenLM/qwen-code/pull/9714))
- review: report the address a drive's service actually bound ([#9655](https://github.com/QwenLM/qwen-code/pull/9655))

#### 其他变更

- 发布 CI 现在在安装依赖时禁用安装脚本，并需要核心维护者批准 security-checks 工作流的更改。 ([#9577](https://github.com/QwenLM/qwen-code/pull/9577))
- 更正了工作流注释，准确说明自托管 ECS 池支持容器运行时执行。 ([#9575](https://github.com/QwenLM/qwen-code/pull/9575))
- 文档化了 autofix 的新设计，将可信发布步骤与不可信代码执行隔离以增强安全性。 ([#9525](https://github.com/QwenLM/qwen-code/pull/9525))
- 文档化了终端内联图片预览的渲染方式，包括限制、回退机制和会话恢复行为。 ([#8656](https://github.com/QwenLM/qwen-code/pull/8656))
- 文档化了实验性 Session Workflow 设置，涵盖其默认状态、实时更新和 Web Shell 展示方式。 ([#8554](https://github.com/QwenLM/qwen-code/pull/8554))
- 文档更新了 autofix 检查仅源自 patch 文本的说明，并概述了 issue-autofix 的时序约束。 ([#9652](https://github.com/QwenLM/qwen-code/pull/9652))
- autofix: add an operator guide for /takeover from N ([#9622](https://github.com/QwenLM/qwen-code/pull/9622))
- 修正 autofix round-seed 指南，明确任何前导空白（包括空格、制表符或换行）都会导致命令无法识别。 ([#9663](https://github.com/QwenLM/qwen-code/pull/9663))
- 文档化了按执行机制分类的架构不变量，包括 ESLint 规则、测试和 tsconfig 设置。 ([#9689](https://github.com/QwenLM/qwen-code/pull/9689))

### Complete Change List (50 pull requests)

#### Features

- review: tell the author why a review loop is not settling ([#9461](https://github.com/QwenLM/qwen-code/pull/9461)) by @wenshao
- web-shell: keep a turn expanded while its background shell runs ([#9632](https://github.com/QwenLM/qwen-code/pull/9632)) by @ytahdn
- autofix: audit the approach instead of stopping on growth-budget breach ([#9262](https://github.com/QwenLM/qwen-code/pull/9262)) by @wenshao
- review: fold the one-hop import widening into fetch-pr --since ([#9332](https://github.com/QwenLM/qwen-code/pull/9332)) by @wenshao
- core: make list_directory opt-in (disabled by default) ([#9424](https://github.com/QwenLM/qwen-code/pull/9424)) by @DragonnZhang
- cli: extend non-blocking slash commands to more builtins ([#9495](https://github.com/QwenLM/qwen-code/pull/9495)) by @DragonnZhang
- review: disclose that Aone posts join the discussion gate only ([#9625](https://github.com/QwenLM/qwen-code/pull/9625)) by @wenshao
- review: detect self-MR on Aone targets in presubmit ([#9629](https://github.com/QwenLM/qwen-code/pull/9629)) by @wenshao
- web-shell: Bind GitHub PRs to sessions with sidebar badge and search ([#9543](https://github.com/QwenLM/qwen-code/pull/9543)) by @wenshao
- review: give the convergence observation a machine-readable half ([#9623](https://github.com/QwenLM/qwen-code/pull/9623)) by @wenshao
- review: report the address a drive's service actually bound ([#9655](https://github.com/QwenLM/qwen-code/pull/9655)) by @wenshao
- review: close Aone residual gaps — composeUrl, test-plan routing, a1 version floor ([#9624](https://github.com/QwenLM/qwen-code/pull/9624)) by @wenshao
- serve: restore ask_user_question HITL on session load/resume ([#9665](https://github.com/QwenLM/qwen-code/pull/9665)) by @doudouOUC

#### Bug Fixes

- ci: stop the fallback comment from denying a review it already posted ([#9462](https://github.com/QwenLM/qwen-code/pull/9462)) by @wenshao
- web-shell: bound daemon transcript retention to stop renderer OOM crashes ([#9303](https://github.com/QwenLM/qwen-code/pull/9303)) by @wenshao
- autofix: bind the sandbox image to its pulled digest ([#9527](https://github.com/QwenLM/qwen-code/pull/9527)) by @wenshao
- web-shell: settle parallel-agents collapse and unify agent detail transcript ([#9640](https://github.com/QwenLM/qwen-code/pull/9640)) by @ytahdn
- web-shell: show create-group tooltip ([#9400](https://github.com/QwenLM/qwen-code/pull/9400)) by @deggs7
- artifacts: expand recorded directories into per-file artifacts ([#9395](https://github.com/QwenLM/qwen-code/pull/9395)) by @zjgzx1988
- review: make the incremental cache work for Aone AGit-Flow CRs ([#9630](https://github.com/QwenLM/qwen-code/pull/9630)) by @wenshao
- autofix: include pending runs in the busy-PR enumeration ([#9662](https://github.com/QwenLM/qwen-code/pull/9662)) by @wenshao
- web-shell: use daemon live-state hasActivePrompt for loading indicator (#9487) ([#9631](https://github.com/QwenLM/qwen-code/pull/9631)) by @yiliang114
- cli: keep slash menu selection stable while a response streams ([#9508](https://github.com/QwenLM/qwen-code/pull/9508)) by @yiliang114
- web-shell: don't steal approval focus while the user is typing ([#9609](https://github.com/QwenLM/qwen-code/pull/9609)) by @yiliang114
- core: support public GitHub extensions with older Git ([#9680](https://github.com/QwenLM/qwen-code/pull/9680)) by @yiliang114
- ci: bump vulnerable dependencies to unblock CVE audit ([#9703](https://github.com/QwenLM/qwen-code/pull/9703)) by @yiliang114
- review: audit Aone targets in cleanup's bypass tripwire ([#9633](https://github.com/QwenLM/qwen-code/pull/9633)) by @wenshao
- autofix: stop counting idle timeouts toward the timeout cap ([#9673](https://github.com/QwenLM/qwen-code/pull/9673)) by @wenshao
- web-shell: route goal messages by session activity ([#9667](https://github.com/QwenLM/qwen-code/pull/9667)) by @ytahdn
- autofix: pass CI=true through the gate's env -i launches ([#9649](https://github.com/QwenLM/qwen-code/pull/9649)) by @wenshao
- review: stop shedding the convergence observation first ([#9715](https://github.com/QwenLM/qwen-code/pull/9715)) by @wenshao
- review: clear the deferred Round-5 findings from the Aone write path ([#9604](https://github.com/QwenLM/qwen-code/pull/9604)) by @wenshao
- cli: Recover sessions across archive races ([#9513](https://github.com/QwenLM/qwen-code/pull/9513)) by @doudouOUC
- sdk: support "auto" permission mode ([#9003](https://github.com/QwenLM/qwen-code/pull/9003)) by @shenyankm

#### Performance

- web-shell: optimize streaming transcript rendering ([#9672](https://github.com/QwenLM/qwen-code/pull/9672)) by @ytahdn
- review: give review agents their own subagent type ([#9678](https://github.com/QwenLM/qwen-code/pull/9678)) by @wenshao

#### Documentation

- ci: the ECS pool does run containers — correct two comments that say it does not ([#9575](https://github.com/QwenLM/qwen-code/pull/9575)) by @wenshao
- autofix: design runner-level isolation for PAT-bearing steps ([#9525](https://github.com/QwenLM/qwen-code/pull/9525)) by @wenshao
- document inline terminal image previews ([#8656](https://github.com/QwenLM/qwen-code/pull/8656)) by @DragonnZhang
- document the Session Workflow setting ([#8554](https://github.com/QwenLM/qwen-code/pull/8554)) by @DragonnZhang
- autofix: pin the publish-side checks to the patch text ([#9652](https://github.com/QwenLM/qwen-code/pull/9652)) by @wenshao
- autofix: add an operator guide for /takeover from N ([#9622](https://github.com/QwenLM/qwen-code/pull/9622)) by @wenshao
- autofix: correct the round-seed guide on leading whitespace ([#9663](https://github.com/QwenLM/qwen-code/pull/9663)) by @wenshao
- classify architecture invariants by enforcement mechanism (#9152) ([#9689](https://github.com/QwenLM/qwen-code/pull/9689)) by @yiliang114

#### Internal Changes

- chore(ci): Disable install scripts in release CI and guard security-checks workflow ([#9577](https://github.com/QwenLM/qwen-code/pull/9577)) by @yiliang114
- chore(deps): Clear high-severity CVE baseline and harden the security gate ([#9584](https://github.com/QwenLM/qwen-code/pull/9584)) by @yiliang114
- i18n(cli): translate Unset in the settings dialog ([#9714](https://github.com/QwenLM/qwen-code/pull/9714)) by @yiliang114
- refactor(autofix): move the push-and-report body out of the workflow file ([#9653](https://github.com/QwenLM/qwen-code/pull/9653)) by @wenshao
- refactor(cli): keep acp-integration off serve internals (#8084) ([#9144](https://github.com/QwenLM/qwen-code/pull/9144)) by @yiliang114
- refactor(core): remove root barrel self-imports and enforce the boundary ([#9635](https://github.com/QwenLM/qwen-code/pull/9635)) by @yiliang114

### New Contributors

- @deggs7 made their first contribution in [#9400](https://github.com/QwenLM/qwen-code/pull/9400)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.15...v0.22.0

<!-- qwen-code-dsw-swe-verified:start -->
#### SWE-bench Verified

- Status: **SUCCEEDED**
- Dataset: `swe-bench/swe-bench-verified@2`; 500/500 completed
- Results: 380 resolved, 113 unresolved, 5 execution errors, 2 infrastructure failures
- Score: **77.08%**
- Score denominator: valid grader results (380 + 113 = 493)
- Qwen Code: `v0.22.0` (`1c3a385d9bc8`); model `qwen3.7-plus`
- Run: `pool-b3c14a381dad4f8f`; dispatch workflow: https://github.com/QwenLM/qwen-code/actions/runs/32580293448
- Case trajectories: `swe-bench-verified-v0.22.0-trajectories.tar.gz` (498 cases)
<!-- qwen-code-dsw-swe-verified:end -->

<!-- qwen-code-dsw-terminal-bench-2.0:start -->
#### Terminal-Bench 2.0

- Status: **QUARANTINED**
- Dataset: `terminal-bench@2.0`; 89/89 completed
- Results: 43 resolved, 29 unresolved, 15 execution errors, 2 infrastructure failures
- Score: not published (non-scoreable or quarantined run)
- Score denominator: valid grader results (43 + 29 = 72)
- Qwen Code: `v0.22.0` (`1c3a385d9bc8`); model `qwen3.7-plus`
- Run: `pool-4564557c6b714d59`; dispatch workflow: https://github.com/QwenLM/qwen-code/actions/runs/32580293448
- Case trajectories: `terminal-bench-2.0-v0.22.0-trajectories.tar.gz` (79 cases)
<!-- qwen-code-dsw-terminal-bench-2.0:end -->

## [0.21.15](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.15) - 2026-08-20

### Highlights

- Web Shell now supports inserting file attachments via composer or @ selection, with improved streaming performance and immediate sidebar synchronization. ([#9405](https://github.com/QwenLM/qwen-code/pull/9405), [#9477](https://github.com/QwenLM/qwen-code/pull/9477), [#9570](https://github.com/QwenLM/qwen-code/pull/9570), [#9533](https://github.com/QwenLM/qwen-code/pull/9533))
- Qwen hybrid models now expose a simple Thinking toggle for reasoning control, and the stable qwen3.8-max model is available via /model. ([#9574](https://github.com/QwenLM/qwen-code/pull/9574), [#9383](https://github.com/QwenLM/qwen-code/pull/9383))
- The --resume flag is now supported in /review and CI retries to continue interrupted reviews when the PR head has not moved. ([#9153](https://github.com/QwenLM/qwen-code/pull/9153))
- Added support for authenticated HTTPS Git extension installs with configurable credential persistence for secure private repository cloning. ([#9458](https://github.com/QwenLM/qwen-code/pull/9458))
- Tool approval and ask-user dialogs now appear as in-flow bottom sheets aligned to chat width for a more integrated experience. ([#9351](https://github.com/QwenLM/qwen-code/pull/9351))
- Fixed issues where /rewind incorrectly dropped conversation history and duplicate tool-call IDs caused execution errors. ([#9331](https://github.com/QwenLM/qwen-code/pull/9331), [#9436](https://github.com/QwenLM/qwen-code/pull/9436))

### Breaking Changes

No known breaking changes.

### Web Shell Experience

Web Shell now features improved streaming performance, unified file uploads, Goal v3 controls, and real-time sidebar synchronization.

- Web Shell streaming output is now more responsive during long tasks by batching transcript delivery and avoiding expensive Markdown parsing on growing content. ([#9405](https://github.com/QwenLM/qwen-code/pull/9405))
- Improved Web Shell performance by using live-state activity timestamps to refresh session recency and sort active lists without triggering rate-limited full catalog rescans. ([#9476](https://github.com/QwenLM/qwen-code/pull/9476))
- Unifies file uploads in Web Shell to offer reference or upload options, storing attachments persistently with duplicate name handling. ([#9477](https://github.com/QwenLM/qwen-code/pull/9477))
- Web Shell sidebar now immediately synchronizes session changes like renaming or deleting, while improving loading indicator spacing. ([#9533](https://github.com/QwenLM/qwen-code/pull/9533))
- Web Shell now stops redundant session title catalog refreshes after resolving a display name, reducing unnecessary network requests. ([#9563](https://github.com/QwenLM/qwen-code/pull/9563))
- Web Shell now supports inserting file attachments into active turns via the composer or @ selection, with preview and queue management. ([#9570](https://github.com/QwenLM/qwen-code/pull/9570))
- WebShell adopts Goal v3 controls, allowing goals to be managed independently of chat messages with a compact composer row. ([#9393](https://github.com/QwenLM/qwen-code/pull/9393))
- web-shell: fall back to execCommand copy in non-secure contexts ([#9540](https://github.com/QwenLM/qwen-code/pull/9540))
- ui: collapse duplicate in-flight tool_group rendered from history + pending ([#9421](https://github.com/QwenLM/qwen-code/pull/9421))

### Review & Verification

Enhanced review workflows with resume support, Aone Code integration, stricter verification disciplines, and accurate volume tracking.

- The --resume flag is now supported in /review, review run, and CI retries to continue interrupted reviews when the PR head has not moved. ([#9153](https://github.com/QwenLM/qwen-code/pull/9153))
- Review ledger markers now record the posted inline comment count for the current and previous rounds to track posting volume trends. ([#9413](https://github.com/QwenLM/qwen-code/pull/9413))
- Review verifiers now enforce four run disciplines from live two-arm verification, including starting stateful targets from fresh state for each row. ([#9447](https://github.com/QwenLM/qwen-code/pull/9447))
- review: clamp the posting volume at its origin, not only where it is written ([#9460](https://github.com/QwenLM/qwen-code/pull/9460))
- review: keep the blocker in a COMMENT body every softening path reaches ([#9416](https://github.com/QwenLM/qwen-code/pull/9416))
- review: add runtime-axis, table-sweep and isolation witness forms ([#9445](https://github.com/QwenLM/qwen-code/pull/9445))
- Review verifier probes now run in private scratch worktrees to prevent race conditions with auditors reading the shared tree. ([#9221](https://github.com/QwenLM/qwen-code/pull/9221))
- The review system now validates that consumer-facing contract documentation accurately matches the implemented code behavior. ([#9448](https://github.com/QwenLM/qwen-code/pull/9448))
- The /review skill now supports posting comments and approvals to Aone Code via the a1 CLI when using the --comment flag. ([#9491](https://github.com/QwenLM/qwen-code/pull/9491))

### Autofix & CI Reliability

Resolved GitHub Actions bottlenecks, fixed workflow queuing deadlocks, and enforced test coverage for automated code fixes.

- Fixed a CI failure in the flakiness gate by diffing against a pinned base OID instead of resolving HEAD^1, preventing intermittent access errors on the persistent pool. ([#9464](https://github.com/QwenLM/qwen-code/pull/9464))
- Fixes the flake-gate CI step by computing git diffs before environment scrubbing to prevent access errors on shallow merge-ref objects. ([#9468](https://github.com/QwenLM/qwen-code/pull/9468))
- Clones the autonomous-fix workflow into a new entity to bypass a GitHub Actions backend issue causing runs to stick in queued state. ([#9482](https://github.com/QwenLM/qwen-code/pull/9482))
- Added a comment to the autofix workflow file to force GitHub Actions to re-register triggers that had silently stopped executing scheduled and event-based runs. ([#9479](https://github.com/QwenLM/qwen-code/pull/9479))
- Reduced the size of the qwen-autofix.yml workflow file to stay under GitHub's 500 KB limit, restoring silent-failing automated fix runs that had stopped executing. ([#9517](https://github.com/QwenLM/qwen-code/pull/9517))
- The shepherd no longer counts permanently queued workflow runs with zero jobs as in-flight, preventing deadlocks that blocked autofix loops for hours. ([#9518](https://github.com/QwenLM/qwen-code/pull/9518))
- Autofix now requires mutation probes to verify that new guards or branches added in a round are covered by tests before committing changes. ([#9578](https://github.com/QwenLM/qwen-code/pull/9578))
- Autofix finding replies are now idempotent, skipping duplicate posts when the thread already contains an identical comment from the bot. ([#9463](https://github.com/QwenLM/qwen-code/pull/9463))
- Release pull requests are now authored by a dedicated bot account instead of the GitHub Actions token, enabling finalization in organizations that restrict Actions-created PRs. ([#9592](https://github.com/QwenLM/qwen-code/pull/9592))

### Session & Conversation Management

Introduced conversation isolation primitives, privacy-preserving ledgers, and fixed history retention issues during compression.

- Introduces primitives for standalone conversation isolation, enabling deterministic session identity and validated lineage checks. ([#9341](https://github.com/QwenLM/qwen-code/pull/9341))
- Sessions now persist a privacy-preserving ledger of prompt outcomes to enable accurate cold-load reconciliation without storing user content. ([#9426](https://github.com/QwenLM/qwen-code/pull/9426))
- Fixed an issue where /rewind would incorrectly drop conversation history after /compress-fast by properly distinguishing rule-based compression markers from summarizing boundaries. ([#9331](https://github.com/QwenLM/qwen-code/pull/9331))
- Standalone conversation primitives now safely adopt concurrently created directories and enforce strict integrity budgets for JSONL readers. ([#9512](https://github.com/QwenLM/qwen-code/pull/9512))
- Skipped duplicate tool results during ACP loop detection are now persisted as terminal errors, preventing missing tool results in transcript replays after session resumes. ([#9593](https://github.com/QwenLM/qwen-code/pull/9593))

### Agent Capabilities & Models

Added stable qwen3.8-max model, simplified Thinking toggles, enabled DingTalk media access, and improved tool-call handling.

- Added the stable qwen3.8-max model to the Token Plan model list, allowing users to select it via /model alongside the existing preview version. ([#9383](https://github.com/QwenLM/qwen-code/pull/9383))
- Qwen hybrid models now expose a simple Thinking toggle for reasoning control, removing complex effort tiers for supported versions. ([#9574](https://github.com/QwenLM/qwen-code/pull/9574))
- Enables DingTalk to download and attach media from quoted messages, allowing agents to inspect referenced images and files. ([#9347](https://github.com/QwenLM/qwen-code/pull/9347))
- Treats duplicate provider tool-call IDs as replays only when arguments match, allowing ID collisions with different arguments to execute normally. ([#9436](https://github.com/QwenLM/qwen-code/pull/9436))
- Prevents upstream fail-fast placeholder responses like '(request timeout)' from appearing in chat by retrying them internally. ([#8938](https://github.com/QwenLM/qwen-code/pull/8938))
- cli: surface the daemon duplicate tool-call breaker as a visible loop-detected stop ([#9435](https://github.com/QwenLM/qwen-code/pull/9435))
- core: reject run_in_background: false for named teammates ([#9433](https://github.com/QwenLM/qwen-code/pull/9433))
- core: clarify list_agents excludes Agent Team teammates ([#9432](https://github.com/QwenLM/qwen-code/pull/9432))

### Extensions & Git Integration

Enabled authenticated HTTPS Git installs, batch Extension state updates, and PTY worker support for managed terminal sessions.

- Added support for authenticated HTTPS Git extension installs with configurable credential persistence, enabling secure cloning of private repositories via the daemon. ([#9458](https://github.com/QwenLM/qwen-code/pull/9458))
- Added batch APIs to update Extension activation states for up to 100 extensions globally or for specific trusted workspaces. ([#8788](https://github.com/QwenLM/qwen-code/pull/8788))
- Adds PTY worker support to enable managed Agent View sessions with local terminal hosts and authenticated stream forwarding. ([#7800](https://github.com/QwenLM/qwen-code/pull/7800))

### Observability & Diagnostics

Exposed V8 heap metrics, linked distributed tracing contexts, and routed unrecognized diagnostics to bounded sidechannels.

- ACP child processes now track and report V8 old-generation heap metrics, including peak committed memory and major-GC counts, in daemon status. ([#9380](https://github.com/QwenLM/qwen-code/pull/9380))
- Links daemon HTTP request spans to inbound W3C traceparent headers to maintain continuous distributed tracing context. ([#9391](https://github.com/QwenLM/qwen-code/pull/9391))
- Routes unrecognized diagnostics to a bounded sidechannel instead of cluttering the main transcript blocks with debug entries. ([#9202](https://github.com/QwenLM/qwen-code/pull/9202))
- The bridge now advances a strictly monotonic per-session watermark and exposes it via BridgeSessionSummary.updatedAt in the live-state API. ([#9396](https://github.com/QwenLM/qwen-code/pull/9396))

### CLI & Workflow APIs

Added context file visibility, structured Workflow runtime models, and support for posting comments via a1 CLI.

- Added a one-time INFO message to the CLI that lists attached context files above the first user prompt, making invisible system prompt attachments visible in the chat. ([#8855](https://github.com/QwenLM/qwen-code/pull/8855))
- Exposes a structured runtime model for Workflow execution to record lifecycle events, persist state, and support cancellation. ([#9034](https://github.com/QwenLM/qwen-code/pull/9034))
- Attachment uploads now send filenames as encoded URL query parameters instead of custom headers to prevent cross-origin issues. ([#9567](https://github.com/QwenLM/qwen-code/pull/9567))
- Suppresses Homebrew update notifications when local metadata confirms no newer version is available, preventing false alerts. ([#9502](https://github.com/QwenLM/qwen-code/pull/9502))

### Other Changes

- Tool approval and ask-user dialogs now appear as in-flow bottom sheets aligned to chat width, and the agent-launch dialog defaults focus to allow. ([#9351](https://github.com/QwenLM/qwen-code/pull/9351))
- Ensures image payload eviction remains consistent across chat history and forks by rewriting large images to stable text markers. ([#9423](https://github.com/QwenLM/qwen-code/pull/9423))
- web-shell: add transcript contract prevalidation ([#9388](https://github.com/QwenLM/qwen-code/pull/9388))
- Refactored CLI internals to move shared helpers for findings validation into a common utility package, ensuring consistent behavior across review commands. ([#9345](https://github.com/QwenLM/qwen-code/pull/9345))
- Refactored the review pipeline to define certification bar atoms exactly once in a new library module, eliminating duplicate predicate logic across multiple files. ([#9473](https://github.com/QwenLM/qwen-code/pull/9473))
- Refactors certification path validation to use a single helper function, ensuring consistent exact-path matching across atoms. ([#9484](https://github.com/QwenLM/qwen-code/pull/9484))
- Adds --provenance to npm publish commands to generate signed attestations verifying package origin from CI pipelines. ([#9532](https://github.com/QwenLM/qwen-code/pull/9532))
- Centralized ownership for live-task tool-name and delegated prompt-length contracts to prevent silent drift between packages. ([#9497](https://github.com/QwenLM/qwen-code/pull/9497))
- Fixed a build failure on main caused by missing deleteSessionAttachments mock in the case-variant delete test. ([#9551](https://github.com/QwenLM/qwen-code/pull/9551))
- E2E tests now retry cleanup removals on transient ENOTEMPTY errors to fix flaky failures in recurring cron job scenarios. ([#9559](https://github.com/QwenLM/qwen-code/pull/9559))
- chore(ci): Drop NPM_TOKEN in favor of npm Trusted Publishing ([#9552](https://github.com/QwenLM/qwen-code/pull/9552))
- The autofix brake now treats a BLOCKED handoff as a valid round outcome, preventing false failures when the agent stops to request human intervention. ([#9297](https://github.com/QwenLM/qwen-code/pull/9297))
- Fixed the diff-read test fixture to prevent double-encoding and ensure correct gating for failed diff read scenarios. ([#9539](https://github.com/QwenLM/qwen-code/pull/9539))
- Incremental review now builds its scope directly from the PR diff, ensuring every reviewed line matches GitHub's display without requiring post-hoc proof. ([#9267](https://github.com/QwenLM/qwen-code/pull/9267))
- CI now heals workspaces replaced by symlinks or non-directories before wiping, preventing runner wedges caused by hardened guard refusals. ([#9498](https://github.com/QwenLM/qwen-code/pull/9498))
- The serve A/B test suite can now stage transcripts on disk before requests, enabling validation of session state behaviors previously unreachable with empty homes. ([#9444](https://github.com/QwenLM/qwen-code/pull/9444))

### 中文摘要

#### 亮点

- Web Shell 现支持通过 composer 或 @ 选择插入文件附件，优化了流式输出性能并实现侧边栏即时同步。 ([#9405](https://github.com/QwenLM/qwen-code/pull/9405), [#9477](https://github.com/QwenLM/qwen-code/pull/9477), [#9570](https://github.com/QwenLM/qwen-code/pull/9570), [#9533](https://github.com/QwenLM/qwen-code/pull/9533))
- Qwen 混合模型现提供简单的 Thinking 切换以控制推理，稳定的 qwen3.8-max 模型可通过 /model 选择。 ([#9574](https://github.com/QwenLM/qwen-code/pull/9574), [#9383](https://github.com/QwenLM/qwen-code/pull/9383))
- --resume 标志现支持用于 /review 和 CI 重试，以便在 PR 头部未移动时继续中断的审查。 ([#9153](https://github.com/QwenLM/qwen-code/pull/9153))
- 增加了对带可配置凭据持久性的 authenticated HTTPS Git 扩展安装支持，实现安全克隆私有仓库。 ([#9458](https://github.com/QwenLM/qwen-code/pull/9458))
- 工具审批和询问用户对话框现在作为与聊天宽度对齐的流内底部表单显示，体验更集成。 ([#9351](https://github.com/QwenLM/qwen-code/pull/9351))
- 修复了 /rewind 错误丢弃对话历史以及重复 tool-call ID 导致执行错误的问题。 ([#9331](https://github.com/QwenLM/qwen-code/pull/9331), [#9436](https://github.com/QwenLM/qwen-code/pull/9436))

#### Web Shell 体验

Web Shell 现在具备更优的流式性能、统一文件上传、Goal v3 控制及实时侧边栏同步功能。

- Web Shell 通过批量处理转录交付并避免对增长内容进行昂贵的 Markdown 解析，提升了长任务期间流式输出的响应速度。 ([#9405](https://github.com/QwenLM/qwen-code/pull/9405))
- 通过利用实时状态活动时间戳刷新会话最近性并排序活动列表，提升了 Web Shell 性能，避免了受限的全量目录重新扫描。 ([#9476](https://github.com/QwenLM/qwen-code/pull/9476))
- 统一 Web Shell 中的文件上传，提供引用或上传选项，并持久化存储附件且处理重复文件名。 ([#9477](https://github.com/QwenLM/qwen-code/pull/9477))
- Web Shell 侧边栏现在可立即同步重命名或删除等会话变更，并优化了加载指示器的间距。 ([#9533](https://github.com/QwenLM/qwen-code/pull/9533))
- Web Shell 在解析显示名称后停止多余的会话标题目录刷新，减少不必要的网络请求。 ([#9563](https://github.com/QwenLM/qwen-code/pull/9563))
- Web Shell 现在支持通过 composer 或 @ 选择将文件附件插入进行中轮次，包含预览和队列管理。 ([#9570](https://github.com/QwenLM/qwen-code/pull/9570))
- WebShell 采用 Goal v3 控制，允许独立于聊天消息管理目标，并配备紧凑的 composer 行。 ([#9393](https://github.com/QwenLM/qwen-code/pull/9393))
- web-shell: fall back to execCommand copy in non-secure contexts ([#9540](https://github.com/QwenLM/qwen-code/pull/9540))
- ui: collapse duplicate in-flight tool_group rendered from history + pending ([#9421](https://github.com/QwenLM/qwen-code/pull/9421))

#### 审查与验证

通过恢复支持、Aone Code 集成、更严格的验证准则及准确的体量追踪，增强了审查工作流。

- --resume 标志现在支持用于 /review、review run 和 CI 重试，以便在 PR 头部未移动时继续中断的审查。 ([#9153](https://github.com/QwenLM/qwen-code/pull/9153))
- 审查 ledger 标记现在记录当前和上一轮的已发布内联评论数量，以跟踪发布量趋势。 ([#9413](https://github.com/QwenLM/qwen-code/pull/9413))
- 审查验证器现在执行来自实时双臂验证的四个运行准则，包括为每一行从全新状态启动有状态目标。 ([#9447](https://github.com/QwenLM/qwen-code/pull/9447))
- 通过在计数来源处应用共享 volume reader 限制，修复了 review 发布量报告中的不一致问题，确保所有输出表面的数据一致。 ([#9460](https://github.com/QwenLM/qwen-code/pull/9460))
- review: keep the blocker in a COMMENT body every softening path reaches ([#9416](https://github.com/QwenLM/qwen-code/pull/9416))
- 扩展了验证器的 brief，增加了用于运行时轴验证、表扫描影响分析和隔离测试的新见证形式，以处理关于未发布版本和硬编码表的声明。 ([#9445](https://github.com/QwenLM/qwen-code/pull/9445))
- Review verifier 探针现在在私有临时工作树中运行，以防止与读取共享树的审计器发生竞态条件。 ([#9221](https://github.com/QwenLM/qwen-code/pull/9221))
- review 系统现在验证面向消费者的合同文档是否准确匹配已实现的代码行为。 ([#9448](https://github.com/QwenLM/qwen-code/pull/9448))
- /review 技能现在支持通过 a1 CLI 的 --comment 标志向 Aone Code 发布评论和批准意见。 ([#9491](https://github.com/QwenLM/qwen-code/pull/9491))

#### Autofix 与 CI 可靠性

解决了 GitHub Actions 瓶颈，修复了工作流排队死锁，并对自动代码修复强制执行测试覆盖。

- 修复了 flakiness gate 中的 CI 故障，改为针对固定的 base OID 进行 diff，避免了在持久化池上解析 HEAD^1 时的间歇性访问错误。 ([#9464](https://github.com/QwenLM/qwen-code/pull/9464))
- 通过在环境清理前计算 git 差异来修复 flake-gate CI 步骤，防止浅合并引用对象的访问错误。 ([#9468](https://github.com/QwenLM/qwen-code/pull/9468))
- 将 autonomous-fix 工作流克隆到新实体，以绕过导致运行卡在排队状态的 GitHub Actions 后端问题。 ([#9482](https://github.com/QwenLM/qwen-code/pull/9482))
- 在 autofix 工作流中添加注释以强制 GitHub Actions 重新注册触发器，修复了定时和事件驱动运行静默停止的问题。 ([#9479](https://github.com/QwenLM/qwen-code/pull/9479))
- 减小了 qwen-autofix.yml 工作流文件的大小以保持在 GitHub 500 KB 限制内，恢复了此前因超限而静默失败的自动修复运行。 ([#9517](https://github.com/QwenLM/qwen-code/pull/9517))
- Shepherd 不再将零任务的永久排队运行视为进行中，避免了阻碍 autofix 循环数小时的死锁。 ([#9518](https://github.com/QwenLM/qwen-code/pull/9518))
- Autofix 现在要求通过变异探测验证新增的防护或分支在提交前已被测试覆盖。 ([#9578](https://github.com/QwenLM/qwen-code/pull/9578))
- Autofix 查找回复现已幂等，若线程中已存在机器人发布的相同评论，则跳过重复发帖。 ([#9463](https://github.com/QwenLM/qwen-code/pull/9463))
- 发布 PR 现在由专用机器人账户而非 GitHub Actions 令牌创建，使在限制 Actions 创建 PR 的组织中也能完成发布。 ([#9592](https://github.com/QwenLM/qwen-code/pull/9592))

#### 会话与对话管理

引入了对话隔离原语和保护隐私的分类账，并修复了压缩过程中的历史记录保留问题。

- 引入独立会话隔离原语，支持确定性会话身份验证和谱系检查。 ([#9341](https://github.com/QwenLM/qwen-code/pull/9341))
- 会话现在持久化一个保护隐私的提示结果分类账，以便在不存储用户内容的情况下实现准确的冷加载对账。 ([#9426](https://github.com/QwenLM/qwen-code/pull/9426))
- 修复了 /rewind 在 /compress-fast 之后错误丢弃对话历史的问题，方法是正确区分基于规则的压缩标记和总结边界。 ([#9331](https://github.com/QwenLM/qwen-code/pull/9331))
- 独立对话原语现在能安全采纳并发创建的目录，并对 JSONL 读取器执行严格的完整性预算。 ([#9512](https://github.com/QwenLM/qwen-code/pull/9512))
- ACP 循环检测期间跳过的重复工具结果现在会持久化为终端错误，避免会话恢复后转录重放时出现缺失的工具结果。 ([#9593](https://github.com/QwenLM/qwen-code/pull/9593))

#### Agent 能力与模型

添加了稳定的 qwen3.8-max 模型，简化了 Thinking 切换，启用了 DingTalk 媒体访问，并改进了工具调用处理。

- 将稳定的 qwen3.8-max 模型添加到 Token Plan 模型列表中，允许用户通过 /model 选择该模型以及现有的预览版本。 ([#9383](https://github.com/QwenLM/qwen-code/pull/9383))
- Qwen 混合模型现在暴露简单的 Thinking 切换以控制推理，为支持的版本移除了复杂的 effort 层级。 ([#9574](https://github.com/QwenLM/qwen-code/pull/9574))
- 使 DingTalk 能够下载并附加引用消息中的媒体，让 agent 可以检查引用的图片和文件。 ([#9347](https://github.com/QwenLM/qwen-code/pull/9347))
- 仅当参数匹配时将重复的 provider tool-call ID 视为重放，允许参数不同的 ID 冲突正常执行。 ([#9436](https://github.com/QwenLM/qwen-code/pull/9436))
- 防止上游快速失败占位符响应（如 '(request timeout)'）显示在聊天中，改为内部重试。 ([#8938](https://github.com/QwenLM/qwen-code/pull/8938))
- cli: surface the daemon duplicate tool-call breaker as a visible loop-detected stop ([#9435](https://github.com/QwenLM/qwen-code/pull/9435))
- core: reject run_in_background: false for named teammates ([#9433](https://github.com/QwenLM/qwen-code/pull/9433))
- core: clarify list_agents excludes Agent Team teammates ([#9432](https://github.com/QwenLM/qwen-code/pull/9432))

#### 扩展与 Git 集成

启用了认证 HTTPS Git 安装、批量扩展状态更新以及用于托管终端会话的 PTY worker 支持。

- 增加了对带有可配置凭据持久性的 authenticated HTTPS Git 扩展安装的支持，实现了通过 daemon 安全克隆私有仓库的功能。 ([#9458](https://github.com/QwenLM/qwen-code/pull/9458))
- 添加了批量 API，用于全局更新多达 100 个扩展的激活状态或针对特定受信任工作区进行更新。 ([#8788](https://github.com/QwenLM/qwen-code/pull/8788))
- 添加 PTY worker 支持以启用托管 Agent View 会话，包含本地终端主机和认证流转发。 ([#7800](https://github.com/QwenLM/qwen-code/pull/7800))

#### 可观测性与诊断

暴露了 V8 堆指标，链接了分布式追踪上下文，并将未识别的诊断路由到有界的侧通道。

- ACP 子进程现在跟踪并在 daemon 状态中报告 V8 老生代堆指标，包括峰值提交内存和主要 GC 计数。 ([#9380](https://github.com/QwenLM/qwen-code/pull/9380))
- 将 daemon HTTP 请求跨度链接到入站 W3C traceparent 头，以维持连续的分布式追踪上下文。 ([#9391](https://github.com/QwenLM/qwen-code/pull/9391))
- 将未识别的诊断路由到有界的侧通道，而不是用调试条目杂乱主转录块。 ([#9202](https://github.com/QwenLM/qwen-code/pull/9202))
- Bridge 现在推进严格的每会话单调水印，并通过 live-state API 中的 BridgeSessionSummary.updatedAt 暴露该值。 ([#9396](https://github.com/QwenLM/qwen-code/pull/9396))

#### CLI 与工作流 API

增加了上下文文件可见性、结构化工作流运行时模型，并支持通过 a1 CLI 发布评论。

- 在 CLI 中增加了一次性 INFO 消息，在首个用户提示上方列出附加的上下文文件，使原本不可见的系统提示附件在聊天中可见。 ([#8855](https://github.com/QwenLM/qwen-code/pull/8855))
- 暴露 Workflow 执行的结构化运行时模型，用于记录生命周期事件、持久化状态并支持取消操作。 ([#9034](https://github.com/QwenLM/qwen-code/pull/9034))
- 附件上传现在将文件名作为编码的 URL 查询参数发送而非自定义头，以避免跨域问题。 ([#9567](https://github.com/QwenLM/qwen-code/pull/9567))
- 当本地元数据确认无更新版本时抑制 Homebrew 更新通知，防止误报。 ([#9502](https://github.com/QwenLM/qwen-code/pull/9502))

#### 其他变更

- 工具审批和询问用户对话框现在作为与聊天宽度对齐的流内底部表单显示，agent-launch 对话框默认聚焦于允许。 ([#9351](https://github.com/QwenLM/qwen-code/pull/9351))
- 通过将大图像重写为稳定文本标记，确保图像负载驱逐在聊天历史和分支间保持一致。 ([#9423](https://github.com/QwenLM/qwen-code/pull/9423))
- web-shell: add transcript contract prevalidation ([#9388](https://github.com/QwenLM/qwen-code/pull/9388))
- 重构 CLI 内部结构，将共享的 findings 验证助手移至通用工具包，确保审查命令间行为一致。 ([#9345](https://github.com/QwenLM/qwen-code/pull/9345))
- 重构审查管道，在新库模块中唯一定义认证栏原子，消除了多个文件中的重复谓词逻辑。 ([#9473](https://github.com/QwenLM/qwen-code/pull/9473))
- 重构认证路径验证以使用单一辅助函数，确保跨原子的一致性精确路径匹配。 ([#9484](https://github.com/QwenLM/qwen-code/pull/9484))
- 向 npm publish 命令添加 --provenance 以生成签名证明，验证包源自 CI 流水线。 ([#9532](https://github.com/QwenLM/qwen-code/pull/9532))
- 集中管理 live-task tool-name 和 delegated prompt-length 契约的所有权，防止包之间出现静默偏差。 ([#9497](https://github.com/QwenLM/qwen-code/pull/9497))
- 修复了因 case-variant delete 测试中缺少 deleteSessionAttachments mock 而导致 main 分支构建失败的问题。 ([#9551](https://github.com/QwenLM/qwen-code/pull/9551))
- E2E 测试现在会在遇到瞬态 ENOTEMPTY 错误时重试清理删除，以修复循环 cron 作业场景中的不稳定失败。 ([#9559](https://github.com/QwenLM/qwen-code/pull/9559))
- chore(ci): Drop NPM_TOKEN in favor of npm Trusted Publishing ([#9552](https://github.com/QwenLM/qwen-code/pull/9552))
- autofix 刹车现在将 BLOCKED 移交视为有效的轮次结果，防止代理停止请求人工干预时出现误报失败。 ([#9297](https://github.com/QwenLM/qwen-code/pull/9297))
- 修复了 diff-read 测试夹具以防止双重编码，并确保失败 diff 读取场景的正确门控。 ([#9539](https://github.com/QwenLM/qwen-code/pull/9539))
- 增量审查现在直接从 PR 差异构建范围，确保每行审查内容与 GitHub 显示一致，无需事后验证。 ([#9267](https://github.com/QwenLM/qwen-code/pull/9267))
- CI 现在会在清理前修复被符号链接或非目录替换的工作区，防止因硬性防护拒绝导致的运行器卡死。 ([#9498](https://github.com/QwenLM/qwen-code/pull/9498))
- Serve A/B 测试套件现在可在请求前将转录文件暂存到磁盘，从而验证此前在空主目录下无法触及的会话状态行为。 ([#9444](https://github.com/QwenLM/qwen-code/pull/9444))

### Complete Change List (67 pull requests)

#### Features

- web-shell: approval and ask-user dialogs as in-flow sheets; fix background-agent false failure ([#9351](https://github.com/QwenLM/qwen-code/pull/9351)) by @ytahdn
- serve: Add live-state session activity watermark ([#9396](https://github.com/QwenLM/qwen-code/pull/9396)) by @doudouOUC
- serve: measure ACP child peak old-generation heap ([#9380](https://github.com/QwenLM/qwen-code/pull/9380)) by @doudouOUC
- review: wire --resume through /review, review run and the CI retry ([#9153](https://github.com/QwenLM/qwen-code/pull/9153)) by @wenshao
- review: record each round's posting volume in the ledger marker ([#9413](https://github.com/QwenLM/qwen-code/pull/9413)) by @wenshao
- review: teach verifiers four run disciplines from a live two-arm verification ([#9447](https://github.com/QwenLM/qwen-code/pull/9447)) by @wenshao
- daemon: add batch extension activation APIs ([#8788](https://github.com/QwenLM/qwen-code/pull/8788)) by @callmeYe
- providers: add qwen3.8-max to Token Plan model list ([#9383](https://github.com/QwenLM/qwen-code/pull/9383)) by @qqqys
- extensions: support authenticated HTTPS Git installs ([#9458](https://github.com/QwenLM/qwen-code/pull/9458)) by @callmeYe
- telemetry: link daemon HTTP request spans to inbound W3C traceparent ([#9391](https://github.com/QwenLM/qwen-code/pull/9391)) by @chiga0
- web-shell: add transcript contract prevalidation ([#9388](https://github.com/QwenLM/qwen-code/pull/9388)) by @water-in-stone
- web-shell: Consume live-state session activity timestamps ([#9476](https://github.com/QwenLM/qwen-code/pull/9476)) by @doudouOUC
- cli: show loaded context files alongside the first prompt ([#8855](https://github.com/QwenLM/qwen-code/pull/8855)) by @ZijianZhang989
- review: add runtime-axis, table-sweep and isolation witness forms ([#9445](https://github.com/QwenLM/qwen-code/pull/9445)) by @wenshao
- cli: Add agent view PTY workers ([#7800](https://github.com/QwenLM/qwen-code/pull/7800)) by @ZijianZhang989
- core: expose workflow execution state ([#9034](https://github.com/QwenLM/qwen-code/pull/9034)) by @qqqys
- cli: Add standalone conversation isolation primitives ([#9341](https://github.com/QwenLM/qwen-code/pull/9341)) by @doudouOUC
- web-shell: unify file uploads and references ([#9477](https://github.com/QwenLM/qwen-code/pull/9477)) by @ytahdn
- serve: persist prompt terminal ledger for cold-load reconciliation ([#9426](https://github.com/QwenLM/qwen-code/pull/9426)) by @chiga0
- review: rule on contract documentation, and matrix layered guards ([#9448](https://github.com/QwenLM/qwen-code/pull/9448)) by @wenshao
- web-shell: support file attachments in mid-turn messages ([#9570](https://github.com/QwenLM/qwen-code/pull/9570)) by @ytahdn
- register toggle-only reasoning for Qwen hybrid models ([#9574](https://github.com/QwenLM/qwen-code/pull/9574)) by @callmeYe
- web-shell: adopt canonical Goal v3 controls ([#9393](https://github.com/QwenLM/qwen-code/pull/9393)) by @qqqys
- review: post --comment reviews to Aone Code via the a1 CLI ([#9491](https://github.com/QwenLM/qwen-code/pull/9491)) by @wenshao

#### Bug Fixes

- triage: diff the flake-gate file list against the pinned base OID ([#9464](https://github.com/QwenLM/qwen-code/pull/9464)) by @yiliang114
- cli: surface the daemon duplicate tool-call breaker as a visible loop-detected stop ([#9435](https://github.com/QwenLM/qwen-code/pull/9435)) by @doudouOUC
- cli: prevent /rewind from dropping conversation history after /compress-fast ([#9331](https://github.com/QwenLM/qwen-code/pull/9331)) by @yiliang114
- core: reject run_in_background: false for named teammates ([#9433](https://github.com/QwenLM/qwen-code/pull/9433)) by @yiliang114
- review: clamp the posting volume at its origin, not only where it is written ([#9460](https://github.com/QwenLM/qwen-code/pull/9460)) by @wenshao
- core: clarify list_agents excludes Agent Team teammates ([#9432](https://github.com/QwenLM/qwen-code/pull/9432)) by @yiliang114
- core: reject upstream fail-fast placeholder responses ([#8938](https://github.com/QwenLM/qwen-code/pull/8938)) by @yiliang114
- core: isolate image payload eviction state ([#9423](https://github.com/QwenLM/qwen-code/pull/9423)) by @yiliang114
- core: treat duplicate provider tool-call ids as replays only when arguments match ([#9436](https://github.com/QwenLM/qwen-code/pull/9436)) by @doudouOUC
- triage: compute the flake-gate diff before the env -i re-exec ([#9468](https://github.com/QwenLM/qwen-code/pull/9468)) by @yiliang114
- sdk: route unrecognized diagnostics onto a bounded transcript sidechannel ([#9202](https://github.com/QwenLM/qwen-code/pull/9202)) by @yiliang114
- ci: clone qwen-autofix into a recovery workflow entity ([#9482](https://github.com/QwenLM/qwen-code/pull/9482)) by @wenshao
- ci: no-op touch to re-register the autofix workflow triggers ([#9479](https://github.com/QwenLM/qwen-code/pull/9479)) by @wenshao
- review: keep the blocker in a COMMENT body every softening path reaches ([#9416](https://github.com/QwenLM/qwen-code/pull/9416)) by @wenshao
- ci: keep qwen-autofix.yml under GitHub's 500 KB start-runs limit ([#9517](https://github.com/QwenLM/qwen-code/pull/9517)) by @wenshao
- dingtalk: attach media from quoted messages ([#9347](https://github.com/QwenLM/qwen-code/pull/9347)) by @qqqys
- cli: suppress Homebrew update notification when brew has nothing newer (#9493) ([#9502](https://github.com/QwenLM/qwen-code/pull/9502)) by @yiliang114
- web-shell: keep sidebar sessions synchronized ([#9533](https://github.com/QwenLM/qwen-code/pull/9533)) by @ytahdn
- cli: give the case-variant delete test the attachments mock ([#9551](https://github.com/QwenLM/qwen-code/pull/9551)) by @wenshao
- review: run verifier probes in a private scratch worktree (#9207) ([#9221](https://github.com/QwenLM/qwen-code/pull/9221)) by @wenshao
- serve: Harden standalone conversation primitives ([#9512](https://github.com/QwenLM/qwen-code/pull/9512)) by @doudouOUC
- tests: retry acp-cron cleanup rm on transient ENOTEMPTY ([#9559](https://github.com/QwenLM/qwen-code/pull/9559)) by @yiliang114
- autofix: make the brake's BLOCKED handoff a first-class round outcome ([#9297](https://github.com/QwenLM/qwen-code/pull/9297)) by @wenshao
- web-shell: Stop repeated session title catalog refreshes ([#9563](https://github.com/QwenLM/qwen-code/pull/9563)) by @doudouOUC
- daemon: avoid custom attachment upload header ([#9567](https://github.com/QwenLM/qwen-code/pull/9567)) by @ytahdn
- ci: stop counting wedged queued runs as in-flight in the shepherd ([#9518](https://github.com/QwenLM/qwen-code/pull/9518)) by @wenshao
- ci: heal a symlinked workspace instead of wedging the runner on it ([#9498](https://github.com/QwenLM/qwen-code/pull/9498)) by @wenshao
- autofix: mutation-probe new guards before a round commits ([#9578](https://github.com/QwenLM/qwen-code/pull/9578)) by @wenshao
- ci: make autofix finding replies idempotent ([#9463](https://github.com/QwenLM/qwen-code/pull/9463)) by @wenshao
- ci: author the release PR with a third bot PAT ([#9592](https://github.com/QwenLM/qwen-code/pull/9592)) by @yiliang114
- cli: persist skipped duplicate tool results ([#9593](https://github.com/QwenLM/qwen-code/pull/9593)) by @yiliang114
- web-shell: fall back to execCommand copy in non-secure contexts ([#9540](https://github.com/QwenLM/qwen-code/pull/9540)) by @yiliang114
- ui: collapse duplicate in-flight tool_group rendered from history + pending ([#9421](https://github.com/QwenLM/qwen-code/pull/9421)) by @qwen-code-dev-bot

#### Performance

- web-shell: keep streaming output responsive ([#9405](https://github.com/QwenLM/qwen-code/pull/9405)) by @ytahdn

#### Internal Changes

- refactor(cli): consolidate shared helpers ahead of the legacy audit skill ([#9345](https://github.com/QwenLM/qwen-code/pull/9345)) by @wenshao
- refactor(review): define each certification-bar atom exactly once ([#9473](https://github.com/QwenLM/qwen-code/pull/9473)) by @wenshao
- refactor(review): route the certification path atoms through one needle ([#9484](https://github.com/QwenLM/qwen-code/pull/9484)) by @wenshao
- chore(ci): Add --provenance to npm publish and id-token permission ([#9532](https://github.com/QwenLM/qwen-code/pull/9532)) by @yiliang114
- refactor: centralize cross-package contracts ([#9497](https://github.com/QwenLM/qwen-code/pull/9497)) by @yiliang114
- chore(ci): Drop NPM_TOKEN in favor of npm Trusted Publishing ([#9552](https://github.com/QwenLM/qwen-code/pull/9552)) by @yiliang114
- test(review): single-encode the diff-read fixture and pin the failed-read gate ([#9539](https://github.com/QwenLM/qwen-code/pull/9539)) by @wenshao
- refactor(review): build the incremental scope from the PR's diff, not a check ([#9267](https://github.com/QwenLM/qwen-code/pull/9267)) by @wenshao
- test(ci): stage on-disk session state in the serve A/B ([#9444](https://github.com/QwenLM/qwen-code/pull/9444)) by @wenshao

### New Contributors

- @qwen-code-review-bot made their first contribution in [#9594](https://github.com/QwenLM/qwen-code/pull/9594)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.14...v0.21.15

## [0.21.14](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.14) - 2026-08-19

### Highlights

- Added qwen sessions ps command and live-state API to list and monitor running interactive sessions with JSON output. ([#8969](https://github.com/QwenLM/qwen-code/pull/8969), [#9261](https://github.com/QwenLM/qwen-code/pull/9261), [#9366](https://github.com/QwenLM/qwen-code/pull/9366))
- Introduced /advisor slash command for independent read-only opinions and enhanced review skills for GitLab and CI script analysis. ([#7567](https://github.com/QwenLM/qwen-code/pull/7567), [#9226](https://github.com/QwenLM/qwen-code/pull/9226), [#9263](https://github.com/QwenLM/qwen-code/pull/9263))
- Improved Web Shell resilience by allowing prompt submission during disconnection and preventing session crashes on render errors. ([#9323](https://github.com/QwenLM/qwen-code/pull/9323), [#9292](https://github.com/QwenLM/qwen-code/pull/9292))
- Minimized spam visibility gaps by checking new comments against blocklists immediately upon creation. ([#9266](https://github.com/QwenLM/qwen-code/pull/9266))
- Added end-to-end support for session-scoped media references ensuring image previews persist across refreshes. ([#9310](https://github.com/QwenLM/qwen-code/pull/9310))
- Enabled workflow agents to pin to specific working directories using the workingDir parameter to extend their lifecycle. ([#8972](https://github.com/QwenLM/qwen-code/pull/8972))

### Breaking Changes

No known breaking changes.

### Session Management & Web Shell

Enhanced live session tracking, media persistence, and file handling in Web Shell with improved state synchronization and UI controls.

- Adds a live-session registry and the qwen sessions ps command to list running interactive sessions with optional JSON output. ([#8969](https://github.com/QwenLM/qwen-code/pull/8969))
- Improves Web Shell sidebar session management with consistent hover details, compact status indicators, and persistent workspace expansion. ([#9311](https://github.com/QwenLM/qwen-code/pull/9311))
- Added end-to-end support for session-scoped media references, ensuring image previews persist across refreshes and reconcile consistently. ([#9310](https://github.com/QwenLM/qwen-code/pull/9310))
- Adds a trusted-only GET /workspaces/:workspace/sessions/live-state endpoint returning volatile session snapshots and a catalog version token to reduce polling. ([#9261](https://github.com/QwenLM/qwen-code/pull/9261))
- WebShell now consumes workspace-scoped session live-state to reduce polling overhead and only refresh the session catalog when necessary. ([#9366](https://github.com/QwenLM/qwen-code/pull/9366))
- Web Shell now fully disables file drag-and-drop when fileUploadEnabled is false and adds support for uploading directories via fileUploadDirectory. ([#9382](https://github.com/QwenLM/qwen-code/pull/9382))
- The exported HTML viewer now includes a global Expand all/Collapse all toolbar to simultaneously toggle thinking blocks, tool outputs, and file references. ([#9367](https://github.com/QwenLM/qwen-code/pull/9367))
- revert(web-shell): restore pre-#8098 composer animations at 50% opacity ([#9349](https://github.com/QwenLM/qwen-code/pull/9349))

### Review Pipeline & Automation

Improved review accuracy with better anchor handling, multi-model support, and automated workflows for SWE-bench and Terminal-Bench.

- Chains Terminal-Bench release evaluation by submitting SWE-bench runs first and dispatching TB runs only after SWE results are published. ([#9120](https://github.com/QwenLM/qwen-code/pull/9120))
- Repairs seven review pipeline defects found in live runs, including fixing incremental anchor withholding and enabling multi-call build-and-test dimensions. ([#9175](https://github.com/QwenLM/qwen-code/pull/9175))
- Enhanced the review skill to analyze shell and CI scripts against the specific lanes and environments that execute them. ([#9263](https://github.com/QwenLM/qwen-code/pull/9263))
- Updated review skill documentation and tests to reflect the settled 3-round cap state and improve coverage for chunk gating logic. ([#9258](https://github.com/QwenLM/qwen-code/pull/9258))
- Incremental review anchors now record the certifying model, preventing incorrect skip behavior when re-running with a different model. ([#9184](https://github.com/QwenLM/qwen-code/pull/9184))
- Added Aone Code read path support to /review, enabling meta, issue-context, and fetch-pr commands for GitLab-based repositories. ([#9226](https://github.com/QwenLM/qwen-code/pull/9226))
- The compose-review command now enforces GitHub's 65,536-character review limit by trimming Chinese translations and deferral notes before truncating essential blockers. ([#9247](https://github.com/QwenLM/qwen-code/pull/9247))
- Review comments posted via --comment now use plain reviewer prose instead of templated scaffolding, while severity markers continue to follow review.attribution rules. ([#9027](https://github.com/QwenLM/qwen-code/pull/9027))
- Sandboxed verification now includes a deterministic flakiness gate that re-runs modified unit tests multiple times to detect and report non-deterministic failures. ([#9130](https://github.com/QwenLM/qwen-code/pull/9130))
- Added --resume flag to fetch-pr to resume interrupted reviews by validating on-disk state and reusing the worktree. ([#9092](https://github.com/QwenLM/qwen-code/pull/9092))
- Enabled pagination for review thread fetching to ensure all threads are resolved instead of only the oldest 100. ([#9390](https://github.com/QwenLM/qwen-code/pull/9390))
- Simplified the review checkout self-heal logic by removing complex guard layers and retaining the core wipe-and-retry mechanism. ([#9327](https://github.com/QwenLM/qwen-code/pull/9327))

### Agent Capabilities & Orchestration

Expanded agent functionality with directory pinning, team task routing, and robust error handling for foreground processes.

- daemon: attach skill-toggle mutation metadata to settings_changed ([#9051](https://github.com/QwenLM/qwen-code/pull/9051))
- Enabled workflow agents to pin to a specific working directory using the workingDir parameter, allowing them to outlive default bounds. ([#8972](https://github.com/QwenLM/qwen-code/pull/8972))
- Fixed an issue where foreground agents were incorrectly marked as failed due to missing routing fields in SSE events. ([#9330](https://github.com/QwenLM/qwen-code/pull/9330))
- Updated agent-team prompts and TeamCreate descriptions to accurately reflect automatic final answer delivery when teammates go idle. ([#9284](https://github.com/QwenLM/qwen-code/pull/9284))
- core: dispatch manually assigned team tasks to their owner ([#9289](https://github.com/QwenLM/qwen-code/pull/9289))
- autofix: seed the takeover round counter with /takeover from N ([#9321](https://github.com/QwenLM/qwen-code/pull/9321))
- The autofix convergence brake now correctly instructs the agent to write handoff details to failure.md instead of restricted wrapper files. ([#9371](https://github.com/QwenLM/qwen-code/pull/9371))
- The autofix fleet scan now fails closed on API enumeration errors to prevent dispatching jobs to busy PRs and marks dispatched PRs clearly. ([#9329](https://github.com/QwenLM/qwen-code/pull/9329))
- Certification bars in the reverse-audit path now report specific failure names like 'receipt lead contradicts the phrase' to improve diagnostic clarity for retirement causes. ([#9272](https://github.com/QwenLM/qwen-code/pull/9272))

### System Reliability & Performance

Strengthened system stability with retry logic for I/O errors, memory cache bounds, and graceful degradation for render failures.

- Makes transient resource-exhaustion and read I/O errors retryable while keeping malformed record errors terminal to prevent false corruption flags. ([#9362](https://github.com/QwenLM/qwen-code/pull/9362))
- Bounds text utility caches to 500 entries with oldest-entry eviction to prevent unbounded memory growth in long sessions. ([#9185](https://github.com/QwenLM/qwen-code/pull/9185))
- Clamps compression output budget to the remaining context window size to ensure valid requests when prompt estimates exhaust available tokens. ([#9109](https://github.com/QwenLM/qwen-code/pull/9109))
- Wraps the agent-tab view in a non-fatal ErrorBoundary so render errors degrade gracefully instead of exiting the entire session. ([#9292](https://github.com/QwenLM/qwen-code/pull/9292))
- Images with unsupported MIME types or decoding errors are now omitted with a text notice instead of causing the entire session to abort. ([#9295](https://github.com/QwenLM/qwen-code/pull/9295))
- Memory recall now waits up to 100ms for results before injecting deterministic candidates, improving reliability and non-ASCII coverage. ([#8716](https://github.com/QwenLM/qwen-code/pull/8716))
- The web-shell now uses backend-authoritative queue states to prevent duplicate messages and ensure draft payloads are only restored after proven delivery failures. ([#9407](https://github.com/QwenLM/qwen-code/pull/9407))
- Cleared a backlog of nineteen deferred suggestions and fixed behavior issues including persistRecoveredLedger flag handling. ([#9342](https://github.com/QwenLM/qwen-code/pull/9342))

### Daemon & Local Control

Consolidated Local Control architecture and added configurable modes and pollable routes for daemon status and answers.

- Consolidates Local Control into a single daemon-owned implementation with a secondary listener, unified security model, and revocable pairing credentials. ([#9106](https://github.com/QwenLM/qwen-code/pull/9106))
- daemon: make serve new-file mode configurable (QWEN_SERVE_NEW_FILE_MODE) ([#9364](https://github.com/QwenLM/qwen-code/pull/9364))
- Added pollable HTTP routes to check daemon turn status and retrieve final model answers without requiring an SSE subscription. ([#9080](https://github.com/QwenLM/qwen-code/pull/9080))

### Security & Spam Prevention

Reduced spam visibility gaps with instant blocklist checks and added workspace wipe guards to prevent unsafe directory removal.

- Minimizes new spam comments immediately upon creation by checking against the blocklist, reducing visibility gaps from over an hour to near zero. ([#9266](https://github.com/QwenLM/qwen-code/pull/9266))
- Added workspace wipe guards to triage and Serve A/B workflows to prevent unsafe directory removal in non-canonical runner environments. ([#9277](https://github.com/QwenLM/qwen-code/pull/9277))

### User Commands & Interfaces

Introduced the /advisor command for second opinions and improved CLI behavior for severity floors and resume flags.

- Added the /advisor slash command to request an independent, read-only second opinion on the current conversation without mutating history. ([#7567](https://github.com/QwenLM/qwen-code/pull/7567))
- When the severity floor resolves to Critical-only, the CLI automatically moves inline Suggestion comments to the review body deferral list instead of posting them to GitHub. ([#9279](https://github.com/QwenLM/qwen-code/pull/9279))
- Autofix failure comments now include bilingual content with Chinese analysis in a collapsed details block. ([#9386](https://github.com/QwenLM/qwen-code/pull/9386))

### Diagnostics & Observability

Added privacy-safe diagnostic events and fixed context reporting to exclude disabled skills for accurate consumption metrics.

- Introduced privacy-safe diagnostic events to correlate oversized or mutated tool-result representations without exposing sensitive content. ([#9039](https://github.com/QwenLM/qwen-code/pull/9039))
- Fixed context usage details to exclude disabled skills, ensuring accurate reporting of context consumption. ([#9346](https://github.com/QwenLM/qwen-code/pull/9346))
- Unit tests in packages/cli now fail immediately with an actionable error message and the exact npm run build command if required dist/ outputs or generated files are missing. ([#9171](https://github.com/QwenLM/qwen-code/pull/9171))
- artifacts: verify and canonicalize record_artifact workspace paths ([#9142](https://github.com/QwenLM/qwen-code/pull/9142))

### Other Changes

- ci: drop pull_request_review events on closed PRs at the route gate ([#9299](https://github.com/QwenLM/qwen-code/pull/9299))
- Decouples the composer from SSE catch-up to keep input enabled during reconnection and allows prompt submission even when disconnected. ([#9323](https://github.com/QwenLM/qwen-code/pull/9323))
- The Weixin channel now refreshes the typing indicator every 4 seconds during long turns to prevent it from expiring prematurely. ([#9358](https://github.com/QwenLM/qwen-code/pull/9358))
- Fixed a bug where the enableCacheSharing setting default was ignored, ensuring cache-aware suggestions work without explicit user configuration. ([#9233](https://github.com/QwenLM/qwen-code/pull/9233))
- Removed thirteen unused internal helpers from the settings utility module to clean up legacy code. ([#9379](https://github.com/QwenLM/qwen-code/pull/9379))

### 中文摘要

#### 亮点

- 新增 qwen sessions ps 命令和 live-state API，支持以 JSON 格式列出和监控运行中的交互式会话。 ([#8969](https://github.com/QwenLM/qwen-code/pull/8969), [#9261](https://github.com/QwenLM/qwen-code/pull/9261), [#9366](https://github.com/QwenLM/qwen-code/pull/9366))
- 新增 /advisor 斜杠命令获取独立只读意见，并增强 review 技能以分析 GitLab 仓库和 CI 脚本。 ([#7567](https://github.com/QwenLM/qwen-code/pull/7567), [#9226](https://github.com/QwenLM/qwen-code/pull/9226), [#9263](https://github.com/QwenLM/qwen-code/pull/9263))
- 提升 Web Shell 韧性，支持断开连接时提交提示，并防止因渲染错误导致会话崩溃。 ([#9323](https://github.com/QwenLM/qwen-code/pull/9323), [#9292](https://github.com/QwenLM/qwen-code/pull/9292))
- 通过在创建时即时检查黑名单，将新垃圾评论的可见间隔缩短至接近零。 ([#9266](https://github.com/QwenLM/qwen-code/pull/9266))
- 新增会话级媒体引用端到端支持，确保图片预览在刷新后持久保留。 ([#9310](https://github.com/QwenLM/qwen-code/pull/9310))
- 允许工作流代理通过 workingDir 参数锁定特定目录，从而延长其生存周期。 ([#8972](https://github.com/QwenLM/qwen-code/pull/8972))

#### 会话管理与 Web Shell

增强了 Web Shell 中的实时会话跟踪、媒体持久化和文件处理，改进了状态同步和 UI 控制。

- 新增实时会话注册表和 qwen sessions ps 命令，用于列出正在运行的交互式会话并支持 JSON 输出。 ([#8969](https://github.com/QwenLM/qwen-code/pull/8969))
- 改进了 Web Shell 侧边栏会话管理，提供一致的海悬停详情、紧凑状态指示器和持久的工作区展开功能。 ([#9311](https://github.com/QwenLM/qwen-code/pull/9311))
- 新增会话级媒体引用端到端支持，确保图片预览在刷新后保留并一致协调。 ([#9310](https://github.com/QwenLM/qwen-code/pull/9310))
- 新增受信任的 GET /workspaces/:workspace/sessions/live-state 端点，返回实时会话快照和目录版本令牌以减少轮询。 ([#9261](https://github.com/QwenLM/qwen-code/pull/9261))
- WebShell 现使用工作区会话实时状态以减少轮询开销，仅在必要时刷新会话目录。 ([#9366](https://github.com/QwenLM/qwen-code/pull/9366))
- Web Shell 现在在 fileUploadEnabled 为 false 时完全禁用文件拖放，并通过 fileUploadDirectory 支持目录上传。 ([#9382](https://github.com/QwenLM/qwen-code/pull/9382))
- 导出的 HTML 查看器现在包含一个全局的 Expand all/Collapse all 工具栏，可同时切换思考块、工具输出和文件引用。 ([#9367](https://github.com/QwenLM/qwen-code/pull/9367))
- revert(web-shell): restore pre-#8098 composer animations at 50% opacity ([#9349](https://github.com/QwenLM/qwen-code/pull/9349))

#### 审查管道与自动化

通过更好的锚点处理、多模型支持以及 SWE-bench 和 Terminal-Bench 的自动化工作流，提高了审查准确性。

- 通过先提交 SWE-bench 运行并在发布结果后分派 TB 运行，实现了 Terminal-Bench 发布评估的链式处理。 ([#9120](https://github.com/QwenLM/qwen-code/pull/9120))
- 修复了实时运行中发现的七个审查管道缺陷，包括解决增量锚点扣留问题并启用多调用构建测试维度。 ([#9175](https://github.com/QwenLM/qwen-code/pull/9175))
- 增强了 review 技能，使其能针对执行 shell 和 CI 脚本的具体 lane 和环境进行分析。 ([#9263](https://github.com/QwenLM/qwen-code/pull/9263))
- 更新了 review 技能文档和测试以反映确定的 3 轮上限状态，并改进 chunk  gating 逻辑的覆盖率。 ([#9258](https://github.com/QwenLM/qwen-code/pull/9258))
- 增量审查锚点现在记录认证模型，防止在不同模型下重运行时出现错误的跳过行为。 ([#9184](https://github.com/QwenLM/qwen-code/pull/9184))
- 为 /review 添加 Aone Code 读取路径支持，使基于 GitLab 的仓库可使用 meta、issue-context 和 fetch-pr 命令。 ([#9226](https://github.com/QwenLM/qwen-code/pull/9226))
- compose-review 现在强制执行 GitHub 65,536 字符限制，优先裁剪中文翻译和延期注释，最后才截断关键的 blockers。 ([#9247](https://github.com/QwenLM/qwen-code/pull/9247))
- 通过 --comment 发布的审查注释现在使用纯审查员散文而非模板脚手架，而严重性标记继续遵循 review.attribution 规则。 ([#9027](https://github.com/QwenLM/qwen-code/pull/9027))
- 沙盒验证现在包含一个确定性 flakiness 门控，可多次重新运行修改后的单元测试以检测并报告非确定性失败。 ([#9130](https://github.com/QwenLM/qwen-code/pull/9130))
- 为 fetch-pr 添加 --resume 标志，通过验证磁盘状态和重用工作树来恢复中断的审查。 ([#9092](https://github.com/QwenLM/qwen-code/pull/9092))
- 启用了审查线程获取的分页功能，确保解析所有线程而不仅是最旧的 100 个。 ([#9390](https://github.com/QwenLM/qwen-code/pull/9390))
- 通过移除复杂的防护层并保留核心的 wipe-and-retry 机制简化了审查检出自愈逻辑。 ([#9327](https://github.com/QwenLM/qwen-code/pull/9327))

#### 代理能力与编排

通过目录锁定、团队任务路由和前台进程的健壮错误处理，扩展了代理功能。

- daemon: attach skill-toggle mutation metadata to settings_changed ([#9051](https://github.com/QwenLM/qwen-code/pull/9051))
- 允许工作流代理通过 workingDir 参数锁定特定目录，使其生存期超出默认限制。 ([#8972](https://github.com/QwenLM/qwen-code/pull/8972))
- 修复了因 SSE 事件中缺少路由字段导致前台代理被错误标记为失败的问题。 ([#9330](https://github.com/QwenLM/qwen-code/pull/9330))
- 更新了 agent-team 提示和 TeamCreate 描述，以准确反映队友空闲时自动交付最终答案的行为。 ([#9284](https://github.com/QwenLM/qwen-code/pull/9284))
- core: dispatch manually assigned team tasks to their owner ([#9289](https://github.com/QwenLM/qwen-code/pull/9289))
- autofix: seed the takeover round counter with /takeover from N ([#9321](https://github.com/QwenLM/qwen-code/pull/9321))
- autofix 收敛制动现在正确指示代理将交接详情写入 failure.md 而非受限的包装文件。 ([#9371](https://github.com/QwenLM/qwen-code/pull/9371))
- autofix 集群扫描现在在 API 枚举错误时失败关闭，防止向忙碌的 PR 分发任务，并清晰标记已分发的 PR。 ([#9329](https://github.com/QwenLM/qwen-code/pull/9329))
- 逆向审计路径中的认证条现在报告具体的失败名称（如'receipt lead contradicts the phrase'），以提高退休原因的诊断清晰度。 ([#9272](https://github.com/QwenLM/qwen-code/pull/9272))

#### 系统可靠性与性能

通过 I/O 错误的重试逻辑、内存缓存限制和渲染失败的优雅降级，加强了系统稳定性。

- 使临时资源耗尽和读取 I/O 错误可重试，同时保持格式错误为终止状态，以防止误报损坏。 ([#9362](https://github.com/QwenLM/qwen-code/pull/9362))
- 将文本工具缓存限制为 500 个条目并淘汰最旧 entry，以防止长会话中内存无限增长。 ([#9185](https://github.com/QwenLM/qwen-code/pull/9185))
- 将压缩输出预算限制在剩余上下文窗口大小内，确保提示估算耗尽可用 token 时请求仍有效。 ([#9109](https://github.com/QwenLM/qwen-code/pull/9109))
- 将 agent-tab 视图包裹在非致命 ErrorBoundary 中，使渲染错误优雅降级而非退出整个会话。 ([#9292](https://github.com/QwenLM/qwen-code/pull/9292))
- 不支持的 MIME 类型或解码错误的图像现在会被省略并提示文本，避免导致整个会话中断。 ([#9295](https://github.com/QwenLM/qwen-code/pull/9295))
- 内存召回现在最多等待 100ms 再注入确定性候选项，提升了可靠性和非 ASCII 内容的覆盖范围。 ([#8716](https://github.com/QwenLM/qwen-code/pull/8716))
- web-shell 现在使用后端权威的队列状态以防止消息重复，并确保仅在确认交付失败后恢复草稿负载。 ([#9407](https://github.com/QwenLM/qwen-code/pull/9407))
- 清除了十九个延迟建议的积压并修复了包括 persistRecoveredLedger 标志处理在内的行为问题。 ([#9342](https://github.com/QwenLM/qwen-code/pull/9342))

#### 守护进程与本地控制

整合了本地控制架构，并为守护进程状态和答案添加了可配置模式和可轮询路由。

- 将 Local Control 整合为单一的 daemon 实现，包含辅助监听器、统一安全模型和可撤销的配对凭证。 ([#9106](https://github.com/QwenLM/qwen-code/pull/9106))
- daemon: make serve new-file mode configurable (QWEN_SERVE_NEW_FILE_MODE) ([#9364](https://github.com/QwenLM/qwen-code/pull/9364))
- 添加了可轮询的 HTTP 路由以检查 daemon 轮次状态并获取最终模型答案，无需 SSE 订阅。 ([#9080](https://github.com/QwenLM/qwen-code/pull/9080))

#### 安全与垃圾信息防护

通过即时黑名单检查减少了垃圾信息可见性差距，并添加了工作区清理保护以防止不安全的目录删除。

- 通过创建时即时检查黑名单来最小化新垃圾评论，将可见间隔从一小时以上缩短至接近零。 ([#9266](https://github.com/QwenLM/qwen-code/pull/9266))
- 为 triage 和 Serve A/B 流程添加工作区清理保护，防止在非规范运行环境中发生不安全的目录删除。 ([#9277](https://github.com/QwenLM/qwen-code/pull/9277))

#### 用户命令与界面

引入了用于获取第二意见的 /advisor 命令，并改进了 CLI 在严重性下限和恢复标志方面的行为。

- 新增 /advisor 斜杠命令，可在不修改历史记录的情况下获取对当前对话的独立只读评审意见。 ([#7567](https://github.com/QwenLM/qwen-code/pull/7567))
- 当严重性下限解析为 Critical-only 时，CLI 会自动将内联 Suggestion 注释移至审查正文的延期列表，而不是发布到 GitHub。 ([#9279](https://github.com/QwenLM/qwen-code/pull/9279))
- Autofix 失败评论现在包含双语内容，在折叠的详情块中提供中文分析。 ([#9386](https://github.com/QwenLM/qwen-code/pull/9386))

#### 诊断与可观测性

添加了隐私安全的诊断事件，并修复了上下文报告以排除已禁用的 skills，从而获得准确的消耗指标。

- 引入了隐私安全的诊断事件，用于关联过大或变异的工具结果表示，同时不暴露敏感内容。 ([#9039](https://github.com/QwenLM/qwen-code/pull/9039))
- 修复了上下文使用详情，排除已禁用的 skills，确保上下文消耗报告准确。 ([#9346](https://github.com/QwenLM/qwen-code/pull/9346))
- 如果缺少必需的 dist/输出或生成文件，packages/cli 中的单元测试现在会立即失败，并提供可操作的错误消息及确切的 npm run build 命令。 ([#9171](https://github.com/QwenLM/qwen-code/pull/9171))
- artifacts: verify and canonicalize record_artifact workspace paths ([#9142](https://github.com/QwenLM/qwen-code/pull/9142))

#### 其他变更

- ci: drop pull_request_review events on closed PRs at the route gate ([#9299](https://github.com/QwenLM/qwen-code/pull/9299))
- 将 composer 与 SSE 追赶解耦，确保重连期间输入可用，并允许在断开连接时继续提交提示。 ([#9323](https://github.com/QwenLM/qwen-code/pull/9323))
- Weixin 通道现在每 4 秒刷新一次 typing 指示器，防止其在长轮次中过早消失。 ([#9358](https://github.com/QwenLM/qwen-code/pull/9358))
- 修复了 enableCacheSharing 设置默认值被忽略的问题，确保无需用户显式配置即可使用缓存感知建议。 ([#9233](https://github.com/QwenLM/qwen-code/pull/9233))
- 移除了设置工具模块中十三个未使用的内部辅助函数以清理遗留代码。 ([#9379](https://github.com/QwenLM/qwen-code/pull/9379))

### Complete Change List (54 pull requests)

#### Features

- core: add a live-session registry and qwen sessions ps ([#8969](https://github.com/QwenLM/qwen-code/pull/8969)) by @qqqys
- daemon: attach skill-toggle mutation metadata to settings_changed ([#9051](https://github.com/QwenLM/qwen-code/pull/9051)) by @samuelhsin
- chain Terminal-Bench release evaluation ([#9120](https://github.com/QwenLM/qwen-code/pull/9120)) by @DennisYu07
- web-shell: improve sidebar session management ([#9311](https://github.com/QwenLM/qwen-code/pull/9311)) by @ytahdn
- web-shell: decouple composer from catch-up and rebuild SSE on disconnected submit ([#9323](https://github.com/QwenLM/qwen-code/pull/9323)) by @ytahdn
- support session media references end-to-end ([#9310](https://github.com/QwenLM/qwen-code/pull/9310)) by @ytahdn
- core: let a workflow agent pin a directory and outlive the default bounds ([#8972](https://github.com/QwenLM/qwen-code/pull/8972)) by @qqqys
- review: review shell and CI scripts against the lanes that run them ([#9263](https://github.com/QwenLM/qwen-code/pull/9263)) by @wenshao
- cli: add /advisor command for second-opinion conversation review ([#7567](https://github.com/QwenLM/qwen-code/pull/7567)) by @yiliang114
- core: Add privacy-safe tool-result boundary diagnostics ([#9039](https://github.com/QwenLM/qwen-code/pull/9039)) by @doudouOUC
- serve: Add workspace session live-state endpoint and catalog version ([#9261](https://github.com/QwenLM/qwen-code/pull/9261)) by @doudouOUC
- consolidate Local Control into one daemon-owned implementation ([#9106](https://github.com/QwenLM/qwen-code/pull/9106)) by @yiliang114
- autofix: seed the takeover round counter with /takeover from N ([#9321](https://github.com/QwenLM/qwen-code/pull/9321)) by @wenshao
- daemon: make serve new-file mode configurable (QWEN_SERVE_NEW_FILE_MODE) ([#9364](https://github.com/QwenLM/qwen-code/pull/9364)) by @yiliang114
- web-shell: support upload directory and hard-disable drag-in when fileUploadEnabled=false ([#9382](https://github.com/QwenLM/qwen-code/pull/9382)) by @ytahdn
- serve: add pollable daemon turn status ([#9080](https://github.com/QwenLM/qwen-code/pull/9080)) by @BenGuanRan
- web-shell: Consume workspace session live-state ([#9366](https://github.com/QwenLM/qwen-code/pull/9366)) by @doudouOUC
- review: Aone Code read path (second review-platform provider) ([#9226](https://github.com/QwenLM/qwen-code/pull/9226)) by @wenshao
- webui: add global expand/collapse control to exported HTML viewer ([#9367](https://github.com/QwenLM/qwen-code/pull/9367)) by @yiliang114
- review: enforce the resolved severity floor at the posting boundary ([#9279](https://github.com/QwenLM/qwen-code/pull/9279)) by @wenshao
- cli: plain-prose /review comments; severity markers follow review.attribution ([#9027](https://github.com/QwenLM/qwen-code/pull/9027)) by @wenshao
- triage: add a deterministic flakiness gate to sandboxed verification ([#9130](https://github.com/QwenLM/qwen-code/pull/9130)) by @wenshao
- review: resume an interrupted PR review from its on-disk state ([#9092](https://github.com/QwenLM/qwen-code/pull/9092)) by @wenshao
- ci: post autofix failure-path handoff comments bilingually ([#9386](https://github.com/QwenLM/qwen-code/pull/9386)) by @wenshao

#### Bug Fixes

- ci: minimize new spam comments on creation ([#9266](https://github.com/QwenLM/qwen-code/pull/9266)) by @yiliang114
- ci: drop pull_request_review events on closed PRs at the route gate ([#9299](https://github.com/QwenLM/qwen-code/pull/9299)) by @wenshao
- review: repair seven pipeline defects found by live runs ([#9175](https://github.com/QwenLM/qwen-code/pull/9175)) by @wenshao
- web-shell: keep foreground agent status on SSE ([#9330](https://github.com/QwenLM/qwen-code/pull/9330)) by @ytahdn
- cli: exclude disabled skills from context usage details ([#9346](https://github.com/QwenLM/qwen-code/pull/9346)) by @callmeYe
- core: align agent-team prompts and TeamCreate description with actual delivery ([#9284](https://github.com/QwenLM/qwen-code/pull/9284)) by @yiliang114
- cli: Keep transient runtime record I/O retryable ([#9362](https://github.com/QwenLM/qwen-code/pull/9362)) by @doudouOUC
- cli: contain agent-tab render errors instead of exiting the session ([#9292](https://github.com/QwenLM/qwen-code/pull/9292)) by @yiliang114
- cli: bound string width and code point caches (#2128) ([#9185](https://github.com/QwenLM/qwen-code/pull/9185)) by @yiliang114
- core: Clamp compression output budget to remaining context window ([#9109](https://github.com/QwenLM/qwen-code/pull/9109)) by @ZijianZhang989
- weixin: keep typing indicator alive during long turns ([#9358](https://github.com/QwenLM/qwen-code/pull/9358)) by @yiliang114
- ci: route the autofix convergence-brake handoff through failure.md ([#9371](https://github.com/QwenLM/qwen-code/pull/9371)) by @wenshao
- ci: make autofix busy detection fail closed and mark dispatched PRs ([#9329](https://github.com/QwenLM/qwen-code/pull/9329)) by @wenshao
- cli: honour the declared enableCacheSharing default in both suggestion gates ([#9233](https://github.com/QwenLM/qwen-code/pull/9233)) by @yiliang114
- core: dispatch manually assigned team tasks to their owner ([#9289](https://github.com/QwenLM/qwen-code/pull/9289)) by @yiliang114
- ci: back-port the checkout-heal wipe guard to the triage and serve-ab wipes ([#9277](https://github.com/QwenLM/qwen-code/pull/9277)) by @yiliang114
- review: gate the recovered incremental anchor on the model that certified it ([#9184](https://github.com/QwenLM/qwen-code/pull/9184)) by @wenshao
- artifacts: verify and canonicalize record_artifact workspace paths ([#9142](https://github.com/QwenLM/qwen-code/pull/9142)) by @zjgzx1988
- core: omit image media the model endpoint cannot safely consume (#9291) ([#9295](https://github.com/QwenLM/qwen-code/pull/9295)) by @yiliang114
- memory: improve recall reliability and candidate coverage ([#8716](https://github.com/QwenLM/qwen-code/pull/8716)) by @yiliang114
- review: budget the composed body against GitHub's review limit ([#9247](https://github.com/QwenLM/qwen-code/pull/9247)) by @wenshao
- web-shell: use backend-authoritative queue state ([#9407](https://github.com/QwenLM/qwen-code/pull/9407)) by @ytahdn
- review: name each certification bar and defer degrade notes past admission (#9259) ([#9272](https://github.com/QwenLM/qwen-code/pull/9272)) by @wenshao
- devx: fail with actionable message when unit-test build prerequisites are missing (#9149) ([#9171](https://github.com/QwenLM/qwen-code/pull/9171)) by @yiliang114
- review: clear the deferred-suggestion backlog from #9175's review rounds ([#9342](https://github.com/QwenLM/qwen-code/pull/9342)) by @wenshao
- autofix: paginate review threads instead of reaching the oldest 100 ([#9390](https://github.com/QwenLM/qwen-code/pull/9390)) by @qqqys

#### Internal Changes

- revert(web-shell): restore pre-#8098 composer animations at 50% opacity ([#9349](https://github.com/QwenLM/qwen-code/pull/9349)) by @ytahdn
- test(review): sync round-cap prose and pin the deferred coverage gaps (#9256) ([#9258](https://github.com/QwenLM/qwen-code/pull/9258)) by @yiliang114
- refactor(cli): remove superseded settings dialog helpers ([#9379](https://github.com/QwenLM/qwen-code/pull/9379)) by @qqqys
- refactor(ci): simplify the review checkout self-heal back to wipe-and-retry ([#9327](https://github.com/QwenLM/qwen-code/pull/9327)) by @wenshao

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.13...v0.21.14

## [0.21.13](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.13) - 2026-08-17

### Highlights

- Web Shell composer now supports dragging, dropping, and pasting text files as named attachments alongside images. ([#9180](https://github.com/QwenLM/qwen-code/pull/9180))
- Users can now fork conversations from any specific Assistant response using durable checkpoints to ensure branch accuracy. ([#8817](https://github.com/QwenLM/qwen-code/pull/8817))
- Split-view panes now inherit the host's @ mention configuration, ensuring custom categories and exclusions apply consistently. ([#9052](https://github.com/QwenLM/qwen-code/pull/9052))
- The /review skill now uses dedicated platform subcommands like meta and fetch-diff instead of executing raw gh commands. ([#9096](https://github.com/QwenLM/qwen-code/pull/9096))
- Stopped takeover PRs now receive an autofix/needs-human label and appear in a new Takeover pool table on the dashboard. ([#8960](https://github.com/QwenLM/qwen-code/pull/8960))
- Review sessions now record session IDs and diff hashes to enable crediting agent work across interrupted runs. ([#9091](https://github.com/QwenLM/qwen-code/pull/9091))

### Breaking Changes

No known breaking changes.

### Review Workflow & /review Skill

Enhanced the /review skill with dedicated subcommands, dynamic finding limits, and improved concurrency handling to prevent loops and ensure accurate reporting.

- Split-view panes now inherit the host's @ mention configuration, ensuring custom categories appear and builtinAtProviders exclusions apply consistently. ([#9052](https://github.com/QwenLM/qwen-code/pull/9052))
- The /review skill now uses dedicated platform subcommands like meta and fetch-diff instead of executing raw gh commands via prompt prose. ([#9096](https://github.com/QwenLM/qwen-code/pull/9096))
- The /review command now limits posted suggestions to Critical findings after round 5 to prevent review loops, while deferring other findings to the final report. ([#9118](https://github.com/QwenLM/qwen-code/pull/9118))
- Review workflow concurrency now isolates no-op human review requests to prevent them from blocking active PR review jobs. ([#9210](https://github.com/QwenLM/qwen-code/pull/9210))
- Duplicate suggestions in /review are now listed in a dedicated paragraph with links to existing comments instead of being counted as anchor failures. ([#9215](https://github.com/QwenLM/qwen-code/pull/9215))
- The /review presubmit gate now correctly handles carried-id re-posts to prevent dropping valid findings that match existing comment IDs. ([#9212](https://github.com/QwenLM/qwen-code/pull/9212))
- Fixed the /review pipeline to accept bracketed source tags and added a --to-anchors option to normalize inputs for final gates. ([#9222](https://github.com/QwenLM/qwen-code/pull/9222))
- The PR review workflow now posts a fallback comment with retry guidance if the main review job dies abnormally. ([#9255](https://github.com/QwenLM/qwen-code/pull/9255))
- Review sessions now record session IDs and diff hashes to enable crediting agent work across interrupted runs. ([#9091](https://github.com/QwenLM/qwen-code/pull/9091))
- Review runners now automatically wipe and retry failed checkouts to self-heal from persistent workspace corruption. ([#9220](https://github.com/QwenLM/qwen-code/pull/9220))
- PR review worktree leases now act as locks to prevent concurrent sessions from destroying active review states during setup or cleanup. ([#9211](https://github.com/QwenLM/qwen-code/pull/9211))

### Autofix & Takeover Management

Improved Autofix visibility with new dashboard pools and labels, while refining footprint gates and growth tracking for better takeover handling.

- autofix: deny-by-default footprint gate and positional window censuses ([#9156](https://github.com/QwenLM/qwen-code/pull/9156))
- Stopped takeover PRs now receive an autofix/needs-human label and appear in a new Takeover pool table on the dashboard for better visibility. ([#8960](https://github.com/QwenLM/qwen-code/pull/8960))
- The autofix-growth-now marker now uses the prepare-time measurement instant to ensure growth divergence reports accurately reflect the correct base version. ([#9192](https://github.com/QwenLM/qwen-code/pull/9192))
- Prevented the triage agent from processing tracking issues created by the autofix bot by adding a user login guard to the workflow trigger. ([#9271](https://github.com/QwenLM/qwen-code/pull/9271))

### Reverse-Audit & Findings Tracking

Optimized reverse-audit rounds based on diff size and ensured verified findings outside PR footprints are tracked in dedicated issues.

- The reverse-audit round cap now scales dynamically based on diff topology, allowing more rounds for small diffs and fewer for huge ones. ([#9183](https://github.com/QwenLM/qwen-code/pull/9183))
- The reverse-audit round cap for huge diffs is now reduced to three only when the run has a clock; otherwise, it remains at five. ([#9203](https://github.com/QwenLM/qwen-code/pull/9203))
- Verified findings outside the PR footprint are now deferred to a follow-up queue and tracked in a dedicated issue instead of being lost. ([#9189](https://github.com/QwenLM/qwen-code/pull/9189))
- Reverse-audit now reports retirement failures with specific diagnostics and accepts additional punctuation separators in dry-receipt parsing. ([#9213](https://github.com/QwenLM/qwen-code/pull/9213))
- Presubmit overlap lists are now written to a separate file to prevent overwriting the canonical findings artifact. ([#9268](https://github.com/QwenLM/qwen-code/pull/9268))

### Web Shell & User Interface

Added support for dragging and pasting text files in Web Shell and improved release note presentation with bilingual digests.

- The Web Shell composer now supports dragging, dropping, and pasting text files as named attachments alongside images. ([#9180](https://github.com/QwenLM/qwen-code/pull/9180))
- Release notes are now presented as a user-friendly digest grouped by capability themes with bilingual English and Chinese summaries and attached screenshots. ([#9216](https://github.com/QwenLM/qwen-code/pull/9216))
- Skill bodies are now redacted from Web Shell event surfaces to reduce payload size while remaining available for native ACP clients. ([#9235](https://github.com/QwenLM/qwen-code/pull/9235))

### Conversation & Session Control

Enabled forking conversations from specific responses and improved session resilience to preserve active work during shutdowns.

- Users can now fork conversations from any specific Assistant response using durable checkpoints to ensure branch accuracy. ([#8817](https://github.com/QwenLM/qwen-code/pull/8817))
- Established a hidden runtime boundary for Conversations to isolate ownership and lifecycle while preserving existing owner-routed compatibility paths. ([#9181](https://github.com/QwenLM/qwen-code/pull/9181))
- Sessions now preserve active work when close is refused by draining queued tasks within an 8-second budget before tearing down the session. ([#9134](https://github.com/QwenLM/qwen-code/pull/9134))

### CLI Tools & Extensions

Introduced External Context Provider profiles and added flags to qwen review commands for incremental validation and scoping.

- Introduced the External Context Provider Extension Profile v1 to enable provider-owned retrieval integrations via Qwen Extension and MCP boundaries. ([#9068](https://github.com/QwenLM/qwen-code/pull/9068))
- Added --since flag to qwen review fetch-pr for validating incremental review anchors and scoping diffs based on local cache or ledger markers. ([#9100](https://github.com/QwenLM/qwen-code/pull/9100))
- The runAllChunks command now outputs a diagnostic message on stderr when --all-chunks fans out a plan identified as Step 3A. ([#9249](https://github.com/QwenLM/qwen-code/pull/9249))
- Fixed a bug where the findings command could silently overwrite input files when using --to-anchors and added validation to prevent flag wiring mismatches. ([#9270](https://github.com/QwenLM/qwen-code/pull/9270))

### Infrastructure & Reliability

Strengthened CI pipelines, resource limits, and automation workflows to prevent build failures and ensure consistent agent settings.

- ci: skip non-bot review_requested siblings before jobs spend compute ([#9204](https://github.com/QwenLM/qwen-code/pull/9204))
- The hourly spam-minimization sweep now includes inline pull request review comments to block unwanted content effectively. ([#9229](https://github.com/QwenLM/qwen-code/pull/9229))
- Increased the browser daemon SDK bundle size budget to 191 KiB to accommodate new attachment metadata and fix build failures. ([#9238](https://github.com/QwenLM/qwen-code/pull/9238))
- ACP HTTP pre-attach buffers are now strictly bounded by byte count and frame limits to prevent resource exhaustion. ([#9007](https://github.com/QwenLM/qwen-code/pull/9007))
- Release jobs now force-push release branches to prevent non-fast-forward errors during retries after previous failed publication attempts. ([#9082](https://github.com/QwenLM/qwen-code/pull/9082))
- Fixed automation workflows to correctly pass agent settings like turn caps and tool allowlists that were previously silently dropped. ([#9252](https://github.com/QwenLM/qwen-code/pull/9252))

### Other Fixes & Improvements

Addressed various edge cases in tracing, mocking, and goal summarization to ensure system stability.

- goal: summarise the last Goal when a turn holds no permit ([#9164](https://github.com/QwenLM/qwen-code/pull/9164))
- Fixed main-agent tracing edge cases regarding budget-triggered aborts, non-streaming calls, and deferred TUI tool batch ownership. ([#9121](https://github.com/QwenLM/qwen-code/pull/9121))
- Fixed mock ACP child fixtures in integration tests to correctly handle the tool-guard handshake required by qwen serve. ([#9161](https://github.com/QwenLM/qwen-code/pull/9161))

### Other Changes

- Added an internal limitKind field to GoalRecord to improve how stopped Goals are typed, with no change to user-facing resume behavior. ([#9165](https://github.com/QwenLM/qwen-code/pull/9165))
- Added test-only pins to verify ordering invariants and write-target paths without changing production behavior. ([#9225](https://github.com/QwenLM/qwen-code/pull/9225))
- Tests now verify that background artifact refresh failures silently preserve the last successful state without showing errors or clearing the panel. ([#9227](https://github.com/QwenLM/qwen-code/pull/9227))
- Fixed skill-parity tests on macOS by resolving the fixture root with realpath to ensure path consistency when tmpdir is a symlink. ([#9269](https://github.com/QwenLM/qwen-code/pull/9269))

### 中文摘要

#### 亮点

- Web Shell 编辑器现在支持拖放和粘贴文本文件作为命名附件，与图片并列显示。 ([#9180](https://github.com/QwenLM/qwen-code/pull/9180))
- 用户现在可以使用持久化检查点从任意 Assistant 回复分叉对话，以确保分支准确性。 ([#8817](https://github.com/QwenLM/qwen-code/pull/8817))
- 分屏视图现在继承主机的 @ 提及配置，确保自定义类别显示且 builtinAtProviders 排除项一致生效。 ([#9052](https://github.com/QwenLM/qwen-code/pull/9052))
- /review 技能现在使用 meta 和 fetch-diff 等专用平台子命令，不再通过提示文本执行原始 gh 命令。 ([#9096](https://github.com/QwenLM/qwen-code/pull/9096))
- 停止的接管 PR 现在获得 autofix/needs-human 标签，并在仪表板的 Takeover pool 表中显示。 ([#8960](https://github.com/QwenLM/qwen-code/pull/8960))
- 审查会话现在记录会话 ID 和差异哈希，以便在中断的运行中确认代理工作。 ([#9091](https://github.com/QwenLM/qwen-code/pull/9091))

#### 审查工作流与 /review 技能

增强了 /review 技能，引入专用子命令、动态发现限制及改进的并发处理，以防止循环并确保报告准确。

- 分屏视图现在继承主机的 @ 提及配置，确保自定义类别显示且 builtinAtProviders 排除项一致生效。 ([#9052](https://github.com/QwenLM/qwen-code/pull/9052))
- /review 技能现在使用 meta 和 fetch-diff 等专用平台子命令，不再通过提示文本执行原始 gh 命令。 ([#9096](https://github.com/QwenLM/qwen-code/pull/9096))
- /review 命令在第 5 轮后仅发布 Critical 建议以避免循环，其他发现将延迟至最终报告。 ([#9118](https://github.com/QwenLM/qwen-code/pull/9118))
- 审查工作流并发现在隔离无效的人类审查请求，防止其阻塞活跃的 PR 审查作业。 ([#9210](https://github.com/QwenLM/qwen-code/pull/9210))
- /review 中的重复建议现在列在带有现有评论链接的专用段落中，不再计为锚点失败。 ([#9215](https://github.com/QwenLM/qwen-code/pull/9215))
- /review 预提交网关现在正确处理携带 ID 的重新发布，防止丢弃匹配现有评论 ID 的有效发现。 ([#9212](https://github.com/QwenLM/qwen-code/pull/9212))
- 修复了 /review 管道以接受带括号来源标签，并添加了 --to-anchors 选项以规范化最终网关的输入。 ([#9222](https://github.com/QwenLM/qwen-code/pull/9222))
- 如果主审查作业异常终止，PR 审查工作流现在会发布包含重试指南的备用评论。 ([#9255](https://github.com/QwenLM/qwen-code/pull/9255))
- 审查会话现在记录会话 ID 和差异哈希，以便在中断的运行中确认代理工作。 ([#9091](https://github.com/QwenLM/qwen-code/pull/9091))
- 审查运行器现在会自动清除并重试失败的检出，以从持久性工作区损坏中自我修复。 ([#9220](https://github.com/QwenLM/qwen-code/pull/9220))
- PR 审查工作树租约现在充当锁，防止并发会话破坏正在进行的审查状态。 ([#9211](https://github.com/QwenLM/qwen-code/pull/9211))

#### Autofix 与接管管理

通过新仪表板池和标签提升 Autofix 可见性，同时优化足迹门控和增长追踪以更好地处理接管任务。

- autofix: deny-by-default footprint gate and positional window censuses ([#9156](https://github.com/QwenLM/qwen-code/pull/9156))
- 停止的接管 PR 现在获得 autofix/needs-human 标签，并在仪表板的 Takeover pool 表中显示。 ([#8960](https://github.com/QwenLM/qwen-code/pull/8960))
- autofix-growth-now 标记现在使用准备时的测量时刻，确保增长差异报告准确反映正确的基准版本。 ([#9192](https://github.com/QwenLM/qwen-code/pull/9192))
- 通过在工作流触发器中添加用户登录守卫，防止审查代理处理 autofix bot 创建的跟踪问题。 ([#9271](https://github.com/QwenLM/qwen-code/pull/9271))

#### 逆向审计与发现追踪

根据差异大小优化逆向审计轮次，并确保 PR 范围外的已验证发现在专用 issue 中追踪。

- reverse-audit 轮次上限现在根据 diff 拓扑动态调整，小 diff 允许更多轮次，大 diff 则减少。 ([#9183](https://github.com/QwenLM/qwen-code/pull/9183))
- 只有当运行有时钟时，巨大差异的反向审计轮次上限才会降至三，否则保持为五。 ([#9203](https://github.com/QwenLM/qwen-code/pull/9203))
- PR 范围外已验证的发现现在推迟到后续队列，并在专用 issue 中跟踪，避免丢失。 ([#9189](https://github.com/QwenLM/qwen-code/pull/9189))
- 逆向审计现在报告具体的退休失败诊断信息，并在干接收解析中接受更多标点分隔符。 ([#9213](https://github.com/QwenLM/qwen-code/pull/9213))
- 预提交重叠列表现在写入单独的文件，以防止覆盖规范 findings 工件。 ([#9268](https://github.com/QwenLM/qwen-code/pull/9268))

#### Web Shell 与用户界面

在 Web Shell 中支持拖放和粘贴文本文件，并通过双语摘要改进发布说明展示。

- Web Shell 编辑器现在支持拖放和粘贴文本文件作为命名附件，与图片并列显示。 ([#9180](https://github.com/QwenLM/qwen-code/pull/9180))
- 发布说明现在按功能主题分组，提供双语摘要和截图，更易于用户阅读。 ([#9216](https://github.com/QwenLM/qwen-code/pull/9216))
- 已从 Web Shell 事件表面中剔除技能正文以减少负载大小，同时保留对原生 ACP 客户端的可用性。 ([#9235](https://github.com/QwenLM/qwen-code/pull/9235))

#### 对话与会话控制

支持从特定回复分叉对话，并增强会话弹性以在关闭时保留活跃工作。

- 用户现在可以使用持久化检查点从任意 Assistant 回复分叉对话，以确保分支准确性。 ([#8817](https://github.com/QwenLM/qwen-code/pull/8817))
- 为 Conversations 建立隐藏运行时边界以隔离所有权和生命周期，同时保留现有的所有者路由兼容路径。 ([#9181](https://github.com/QwenLM/qwen-code/pull/9181))
- 当关闭被拒绝时，会话现在会在 8 秒内排空排队任务再销毁会话，从而保留正在进行的活跃工作。 ([#9134](https://github.com/QwenLM/qwen-code/pull/9134))

#### CLI 工具与扩展

引入外部上下文提供者配置，并为 qwen review 命令添加标志以支持增量验证和范围限定。

- 引入 External Context Provider Extension Profile v1，支持通过 Qwen Extension 和 MCP 边界提供独立的检索集成。 ([#9068](https://github.com/QwenLM/qwen-code/pull/9068))
- 为 qwen review fetch-pr 添加 --since 标志，用于验证增量审查锚点并基于本地缓存或账本标记限定差异范围。 ([#9100](https://github.com/QwenLM/qwen-code/pull/9100))
- 当 --all-chunks 分发被识别为 Step 3A 的计划时，runAllChunks 命令现在会在 stderr 输出诊断信息。 ([#9249](https://github.com/QwenLM/qwen-code/pull/9249))
- 修复了 findings 命令在使用 --to-anchors 时可能静默覆盖输入文件的问题，并增加了标志验证。 ([#9270](https://github.com/QwenLM/qwen-code/pull/9270))

#### 基础设施与可靠性

强化 CI 流水线、资源限制及自动化工作流，以防止构建失败并确保代理设置一致。

- ci: skip non-bot review_requested siblings before jobs spend compute ([#9204](https://github.com/QwenLM/qwen-code/pull/9204))
- 每小时垃圾邮件最小化扫描现在包含内联 PR 审查评论，以有效阻止不需要的内容。 ([#9229](https://github.com/QwenLM/qwen-code/pull/9229))
- 将 browser daemon SDK 包大小预算提升至 191 KiB 以容纳新的附件元数据并修复构建失败。 ([#9238](https://github.com/QwenLM/qwen-code/pull/9238))
- ACP HTTP 预附加缓冲区现在严格按字节数和帧数限制，以防止资源耗尽。 ([#9007](https://github.com/QwenLM/qwen-code/pull/9007))
- 发布任务现在强制推送 release 分支，防止因之前失败尝试导致的非快进错误在重试时阻塞发布。 ([#9082](https://github.com/QwenLM/qwen-code/pull/9082))
- 修复了自动化工作流，正确传递之前被静默丢弃的代理设置（如轮次上限和工具允许列表）。 ([#9252](https://github.com/QwenLM/qwen-code/pull/9252))

#### 其他修复与改进

解决了追踪、模拟和目标摘要中的各种边缘情况，以确保系统稳定性。

- goal: summarise the last Goal when a turn holds no permit ([#9164](https://github.com/QwenLM/qwen-code/pull/9164))
- 修复了 main-agent 追踪中关于预算触发中止、非流式调用和延迟 TUI 工具批处理所有权的边缘情况。 ([#9121](https://github.com/QwenLM/qwen-code/pull/9121))
- 修复了集成测试中的 mock ACP child 以正确处理 qwen serve 所需的 tool-guard 握手。 ([#9161](https://github.com/QwenLM/qwen-code/pull/9161))

#### 其他变更

- 在 GoalRecord 中添加了内部 limitKind 字段以改进已停止 Goal 的类型定义，不影响用户可见的恢复行为。 ([#9165](https://github.com/QwenLM/qwen-code/pull/9165))
- 添加了仅用于测试的固定项以验证顺序不变量和写入目标路径，不改变生产行为。 ([#9225](https://github.com/QwenLM/qwen-code/pull/9225))
- 测试验证后台构件刷新失败时静默保留上次成功状态，不显示错误也不清空面板。 ([#9227](https://github.com/QwenLM/qwen-code/pull/9227))
- 通过在 macOS 上对 fixture 根目录使用 realpath 修复技能一致性测试，确保 tmpdir 为符号链接时的路径一致性。 ([#9269](https://github.com/QwenLM/qwen-code/pull/9269))

### Complete Change List (43 pull requests)

#### Features

- autofix: deny-by-default footprint gate and positional window censuses ([#9156](https://github.com/QwenLM/qwen-code/pull/9156)) by @wenshao
- review: absorb prose gh commands into platform-backed subcommands ([#9096](https://github.com/QwenLM/qwen-code/pull/9096)) by @wenshao
- support fork from any conversation ([#8817](https://github.com/QwenLM/qwen-code/pull/8817)) by @water-in-stone
- web-shell: support text file attachments in the composer ([#9180](https://github.com/QwenLM/qwen-code/pull/9180)) by @doudouOUC
- review: adopt a round-aware convergence posture for posted findings ([#9118](https://github.com/QwenLM/qwen-code/pull/9118)) by @wenshao
- autofix: escalate stopped takeover PRs and age out unanswered pauses ([#8960](https://github.com/QwenLM/qwen-code/pull/8960)) by @wenshao
- review: scale the reverse-audit round cap to the diff topology ([#9183](https://github.com/QwenLM/qwen-code/pull/9183)) by @wenshao
- review: apply the huge round reduction only when the run has a clock ([#9203](https://github.com/QwenLM/qwen-code/pull/9203)) by @wenshao
- autofix: defer verified out-of-footprint findings to a surviving follow-up queue ([#9189](https://github.com/QwenLM/qwen-code/pull/9189)) by @wenshao
- review: run-session ledger and cross-session agent evidence ([#9091](https://github.com/QwenLM/qwen-code/pull/9091)) by @wenshao
- external-context: Add provider extension profile ([#9068](https://github.com/QwenLM/qwen-code/pull/9068)) by @doudouOUC
- review: validate and scope the incremental anchor inside fetch-pr ([#9100](https://github.com/QwenLM/qwen-code/pull/9100)) by @wenshao
- daemon: Isolate the Conversations runtime boundary ([#9181](https://github.com/QwenLM/qwen-code/pull/9181)) by @doudouOUC
- release: user-facing bilingual digest for release notes ([#9216](https://github.com/QwenLM/qwen-code/pull/9216)) by @wenshao

#### Bug Fixes

- web-shell: share at mention providers with split-view panes ([#9052](https://github.com/QwenLM/qwen-code/pull/9052)) by @samuelhsin
- ci: skip non-bot review_requested siblings before jobs spend compute ([#9204](https://github.com/QwenLM/qwen-code/pull/9204)) by @yiliang114
- ci: minimize spam inline review comments ([#9229](https://github.com/QwenLM/qwen-code/pull/9229)) by @yiliang114
- ci: keep no-op review requests out of the PR review concurrency group ([#9210](https://github.com/QwenLM/qwen-code/pull/9210)) by @wenshao
- integration-tests: ack daemon tool-guard handshake in the mock ACP child (#9159) ([#9161](https://github.com/QwenLM/qwen-code/pull/9161)) by @qwen-code-dev-bot
- sdk: raise daemon browser bundle budget to 191KB ([#9238](https://github.com/QwenLM/qwen-code/pull/9238)) by @wenshao
- review: note when --all-chunks fans out a plan whose numbers say 3A ([#9249](https://github.com/QwenLM/qwen-code/pull/9249)) by @yiliang114
- telemetry: Address main agent tracing edge cases ([#9121](https://github.com/QwenLM/qwen-code/pull/9121)) by @doudouOUC
- review: give duplicate-dropped Suggestions their own compose state and body sentence ([#9215](https://github.com/QwenLM/qwen-code/pull/9215)) by @wenshao
- autofix: re-anchor growth divergence on measurement time and external head moves ([#9192](https://github.com/QwenLM/qwen-code/pull/9192)) by @wenshao
- ci: stop dropping agent settings in resolve and follow-up workflows ([#9252](https://github.com/QwenLM/qwen-code/pull/9252)) by @wenshao
- goal: summarise the last Goal when a turn holds no permit ([#9164](https://github.com/QwenLM/qwen-code/pull/9164)) by @qqqys
- serve: redact skill bodies from the Web Shell event surface ([#9235](https://github.com/QwenLM/qwen-code/pull/9235)) by @wenshao
- review: exempt carried-id re-posts from the presubmit overlap drop ([#9212](https://github.com/QwenLM/qwen-code/pull/9212)) by @yiliang114
- review: normalize last-gate inputs and anchor mid-line fragments ([#9222](https://github.com/QwenLM/qwen-code/pull/9222)) by @wenshao
- review: fix silent reverse-audit retirement failures and keep non-converged evidence ([#9213](https://github.com/QwenLM/qwen-code/pull/9213)) by @wenshao
- ci: keep a fallback comment when the PR review runner dies ([#9255](https://github.com/QwenLM/qwen-code/pull/9255)) by @wenshao
- serve: Bound ACP HTTP pre-attach buffers by bytes ([#9007](https://github.com/QwenLM/qwen-code/pull/9007)) by @doudouOUC
- ci: self-heal failed checkouts on the reused review runners ([#9220](https://github.com/QwenLM/qwen-code/pull/9220)) by @wenshao
- review: keep the presubmit overlap list out of the canonical findings artifact ([#9268](https://github.com/QwenLM/qwen-code/pull/9268)) by @wenshao
- ci: force-push release branch so retries replace failed attempts (#9076) ([#9082](https://github.com/QwenLM/qwen-code/pull/9082)) by @qwen-code-dev-bot
- ci: stop triaging the autofix bot's own deferred-finding tracking issues (#9264) ([#9271](https://github.com/QwenLM/qwen-code/pull/9271)) by @yiliang114
- daemon: Preserve sessions when active-work close is refused ([#9134](https://github.com/QwenLM/qwen-code/pull/9134)) by @doudouOUC
- review: close out the four leftover findings from the #9222 review ([#9270](https://github.com/QwenLM/qwen-code/pull/9270)) by @wenshao
- review: lock the PR review worktree lease against concurrent sessions ([#9211](https://github.com/QwenLM/qwen-code/pull/9211)) by @wenshao

#### Internal Changes

- refactor(goal): type the limit that stopped a Goal ([#9165](https://github.com/QwenLM/qwen-code/pull/9165)) by @qqqys
- test(review): close confirmed pin gaps from #9194 (batch 1) ([#9225](https://github.com/QwenLM/qwen-code/pull/9225)) by @yiliang114
- test(web-shell): pin silent failure of background artifact refreshes (#7427) ([#9227](https://github.com/QwenLM/qwen-code/pull/9227)) by @yiliang114
- test(review): realpath the skill-parity fixture root ([#9269](https://github.com/QwenLM/qwen-code/pull/9269)) by @wenshao

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.12...v0.21.13

## [0.21.12](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.12) - 2026-08-14

### Highlights

- Added support for uploading workspace files to the Web Shell composer via drag-and-drop or the @ file panel with progress tracking. ([#8874](https://github.com/QwenLM/qwen-code/pull/8874))
- Implemented a diff growth brake in autofix reviews to limit source and test line increases per window using configurable budgets. ([#8981](https://github.com/QwenLM/qwen-code/pull/8981))
- Confirmed Critical findings now require an executed witness with observed output, automatically demoting unverified claims to low confidence. ([#9065](https://github.com/QwenLM/qwen-code/pull/9065))
- The daemon now adaptively grows live-journal caps up to 256 MiB per session to prevent data loss during long turns. ([#8905](https://github.com/QwenLM/qwen-code/pull/8905))
- Fixed visual jitter in the desktop app's sidebar and ensured external URLs open reliably through the system browser. ([#9073](https://github.com/QwenLM/qwen-code/pull/9073), [#9069](https://github.com/QwenLM/qwen-code/pull/9069), [#9111](https://github.com/QwenLM/qwen-code/pull/9111))
- Compact mode now displays model reasoning as a foldable summary, and background shell activity is tracked to prevent premature cleanup. ([#9148](https://github.com/QwenLM/qwen-code/pull/9148), [#9042](https://github.com/QwenLM/qwen-code/pull/9042))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- Added support for uploading workspace files directly to the Web Shell composer via drag-and-drop or the @ file panel with progress tracking. ([#8874](https://github.com/QwenLM/qwen-code/pull/8874)) by @ytahdn
- Implemented a diff growth brake in autofix reviews to limit source and test line increases per window using configurable budgets. ([#8981](https://github.com/QwenLM/qwen-code/pull/8981)) by @wenshao
- The daemon now adaptively grows live-journal caps up to 256 MiB per session before truncating replay entries, using a shared memory pool to prevent data loss during long turns. ([#8905](https://github.com/QwenLM/qwen-code/pull/8905)) by @wenshao
- Confirmed Critical findings now require an executed witness with observed output, automatically demoting unverified claims to low confidence and hiding them from PR posts. ([#9065](https://github.com/QwenLM/qwen-code/pull/9065)) by @wenshao
- Review ledger markers now include the anchor commit SHA to ensure accurate incremental diff scoping across environments and prevent certification of unreviewed ranges. ([#9067](https://github.com/QwenLM/qwen-code/pull/9067)) by @wenshao
- Added user settings to control review attribution footers, default effort levels, and default comments, preventing repository files from overriding these policies. ([#8994](https://github.com/QwenLM/qwen-code/pull/8994)) by @wenshao
- Requests routed through Alibaba Cloud API Gateway domains now correctly include metadata fields for session tracing and log correlation. ([#9103](https://github.com/QwenLM/qwen-code/pull/9103)) by @yiliang114
- Added optional OpenTelemetry trace and span IDs to daemon logs to improve correlation and debugging capabilities for sampled requests. ([#9084](https://github.com/QwenLM/qwen-code/pull/9084)) by @doudouOUC
- Enabled per-agent JSONL transcripts for all workflow agent dispatches to record prompts, tool calls, and results consistently. ([#8971](https://github.com/QwenLM/qwen-code/pull/8971)) by @qqqys
- The /review command now identifies and reports entire classes of unbounded defects prospectively instead of listing individual instances one by one. ([#9095](https://github.com/QwenLM/qwen-code/pull/9095)) by @wenshao
- Main agent invocations now generate OpenTelemetry-compliant traces with stable identities and correct status semantics for success, cancellation, and errors. ([#9107](https://github.com/QwenLM/qwen-code/pull/9107)) by @doudouOUC
- Background shells are now tracked in activeWork, enabling explicit negotiation of shell categories and preventing premature automatic cleanup during shell activity. ([#9042](https://github.com/QwenLM/qwen-code/pull/9042)) by @doudouOUC
- Web Shell Channel management now supports full policy configuration, workspace binding, and a redesigned interface consistent with other management surfaces. ([#8848](https://github.com/QwenLM/qwen-code/pull/8848)) by @qqqys
- Added automatic escalation to maintainers when autofix diffs exceed growth budgets across multiple rounds instead of patching indefinitely. ([#9104](https://github.com/QwenLM/qwen-code/pull/9104)) by @wenshao
- Updated the review loop to validate feedback based on content accuracy rather than relying solely on the author's identity. ([#8996](https://github.com/QwenLM/qwen-code/pull/8996)) by @wenshao
- Added a guard to block cross-worktree Git mutations from model-issued commands that target directories outside the current session. ([#8687](https://github.com/QwenLM/qwen-code/pull/8687)) by @wenshao
- Compact mode (Ctrl+O) now displays model reasoning as a foldable "Thinking…" summary instead of hiding it entirely. ([#9148](https://github.com/QwenLM/qwen-code/pull/9148)) by @ytahdn

#### Bug Fixes

- Fixed an issue in the standalone Web Shell where the first prompt could fail to submit due to session target synchronization errors. ([#9038](https://github.com/QwenLM/qwen-code/pull/9038)) by @ytahdn
- Updated the release workflow to allow automated bots to fully approve release pull requests without requiring manual human intervention. ([#9056](https://github.com/QwenLM/qwen-code/pull/9056)) by @yiliang114
- Ensured OpenTelemetry session ownership is correctly preserved across model requests and asynchronous streams in daemon modes. ([#9077](https://github.com/QwenLM/qwen-code/pull/9077)) by @doudouOUC
- Fixed visual jitter in the desktop app's sidebar project list by reserving space for the scrollbar gutter. ([#9073](https://github.com/QwenLM/qwen-code/pull/9073)) by @yiliang114
- Fixed a security gap where inline-level quotations could bypass layer gates, ensuring that only properly walked block-level quotes can trigger approval caps. ([#9020](https://github.com/QwenLM/qwen-code/pull/9020)) by @wenshao
- Autofix verification gates are now hermetic to runner git configurations, preventing host-level settings from poisoning subsequent test runs. ([#8961](https://github.com/QwenLM/qwen-code/pull/8961)) by @wenshao
- Fixed an issue where restricted secondary workspace rows in the web-shell displayed duplicate archive buttons, ensuring only one accessible action remains visible. ([#9066](https://github.com/QwenLM/qwen-code/pull/9066)) by @yiliang114
- Enabled opening external URLs from Markdown links and artifacts in the desktop app by routing them through the system browser with improved error handling. ([#9069](https://github.com/QwenLM/qwen-code/pull/9069)) by @yiliang114
- Prevented the Windows runtime terminal window from appearing during startup and aligned the reduced-motion bootstrap view for consistent visual centering. ([#9064](https://github.com/QwenLM/qwen-code/pull/9064)) by @yiliang114
- Extended the one-time migration bridge from Electron to Tauri to support Windows and Linux, ensuring seamless updates while preserving user data. ([#9079](https://github.com/QwenLM/qwen-code/pull/9079)) by @yiliang114
- Reduced CI test flakes caused by disk space and system load by optimizing fixture cleanup and using disk-backed temporary directories on Linux. ([#8982](https://github.com/QwenLM/qwen-code/pull/8982)) by @yiliang114
- Improved error messages for review comments when pull request binding is missing and added tests to enforce operator-scope invariants. ([#9102](https://github.com/QwenLM/qwen-code/pull/9102)) by @wenshao
- The Windows standalone installer now uses built-in .NET hashing instead of PowerShell commands to prevent failures when verifying checksums. ([#9112](https://github.com/QwenLM/qwen-code/pull/9112)) by @MichaelYochpaz
- Automatic fixes now wait for in-flight code reviews to complete before updating branches, ensuring human feedback is incorporated without losing context. ([#8899](https://github.com/QwenLM/qwen-code/pull/8899)) by @yiliang114
- The daemon now offers a compact conversation summary for web clients that excludes detailed subagent events to improve load times and reduce data usage. ([#9057](https://github.com/QwenLM/qwen-code/pull/9057)) by @ytahdn
- The desktop app now reliably opens all external links, including OAuth and documentation URLs, through the system browser instead of silently dropping them. ([#9111](https://github.com/QwenLM/qwen-code/pull/9111)) by @yiliang114
- Tool execution failures in the web shell no longer display prominent text labels in collapsed summaries, showing only a subtle icon count instead. ([#9053](https://github.com/QwenLM/qwen-code/pull/9053)) by @ytahdn
- The review pipeline now isolates concurrent runs to prevent verdict overwrites and includes regression tests for four previously observed live-run failures. ([#9086](https://github.com/QwenLM/qwen-code/pull/9086)) by @wenshao
- Tool-loop protection stops now surface as structured turn errors with localized guidance, ensuring errors persist across page reloads without offering invalid retry actions. ([#8853](https://github.com/QwenLM/qwen-code/pull/8853)) by @ytahdn
- Assistant footer actions like Copy and Branch now remain hidden until background agents complete and the main agent provides a final summarized response. ([#8787](https://github.com/QwenLM/qwen-code/pull/8787)) by @carffuca
- The review run command now rejects targets consisting only of path separators and fixes the composed-name oracle anchoring to prevent slow failure paths. ([#9128](https://github.com/QwenLM/qwen-code/pull/9128)) by @wenshao
- Reverted transactional session switching to restore the loading-skeleton model, ensuring transcripts clear and skeletons display during session loads. ([#9129](https://github.com/QwenLM/qwen-code/pull/9129)) by @ytahdn
- Fixed spam minimization workflows by using the repository-scoped GITHUB_TOKEN to prevent permission errors when minimizing comments. ([#9140](https://github.com/QwenLM/qwen-code/pull/9140)) by @yiliang114
- Fixed Shell to correctly honor the tools.truncateToolOutputThreshold setting instead of hardcoding a 30,000-character limit. ([#9014](https://github.com/QwenLM/qwen-code/pull/9014)) by @cxruan
- Enabled workspace batch Skill toggles to accept uninstalled Skill names, allowing users to declare disabled states before installation. ([#9139](https://github.com/QwenLM/qwen-code/pull/9139)) by @callmeYe
- fix(core): detect line-continuation and @P shell substitutions (#8582) ([#8590](https://github.com/QwenLM/qwen-code/pull/8590)) by @yiliang114
- Fixed E2E test failures by updating the mock ACP child to correctly acknowledge the daemon tool guard handshake. ([#9162](https://github.com/QwenLM/qwen-code/pull/9162)) by @qwen-code-dev-bot

#### Performance

- Daemon session restore is now selective, reading only necessary records to reconstruct state and significantly improving performance for large sessions. ([#9055](https://github.com/QwenLM/qwen-code/pull/9055)) by @doudouOUC

#### Internal Changes

- Upgraded the sharp image library to version 0.35.0 to resolve a known security vulnerability flagged by npm audit. ([#8952](https://github.com/QwenLM/qwen-code/pull/8952)) by @yiliang114
- Fixed a flaky test in the web UI by improving the timing logic for draining batched transcript dispatches. ([#9058](https://github.com/QwenLM/qwen-code/pull/9058)) by @wenshao
- Release workflows now require designated approvers, use least-privilege permissions, and include automated security scans for dependencies and secrets. ([#9008](https://github.com/QwenLM/qwen-code/pull/9008)) by @yiliang114
- The Conversations runtime foundation has been generalized to support both the standalone daemon and Live Voice sessions within a unified manager. ([#8890](https://github.com/QwenLM/qwen-code/pull/8890)) by @doudouOUC
- VSCode companion sync publishing can now be paused by setting the RELEASE_VSCODE_SYNC_PUBLISH repository variable to false without affecting manual releases. ([#9132](https://github.com/QwenLM/qwen-code/pull/9132)) by @yiliang114
- Refactored internal CLI dependencies to remove circular imports between utils, serve, and UI layers for better module isolation. ([#9147](https://github.com/QwenLM/qwen-code/pull/9147)) by @yiliang114

### New Contributors

- @MichaelYochpaz made their first contribution in [#9112](https://github.com/QwenLM/qwen-code/pull/9112)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.11...v0.21.12

## [0.21.11](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.11) - 2026-08-13

### Highlights

- Added support for Agent Plugins v1 to extend agent capabilities. ([#8834](https://github.com/QwenLM/qwen-code/pull/8834))
- Enabled native multi-agent workflows with read-only teammates via the /coordinate command. ([#8804](https://github.com/QwenLM/qwen-code/pull/8804))
- Improved text selection with word-wise drag on double-click and line-wise extension on triple-click. ([#8739](https://github.com/QwenLM/qwen-code/pull/8739))
- Fixed DashScope Qwen 3.8 request failures by preventing conflicting reasoning settings. ([#8525](https://github.com/QwenLM/qwen-code/pull/8525))
- Enhanced Web Shell interactivity with persistent chevrons, better hover states, and inline agent metrics. ([#8780](https://github.com/QwenLM/qwen-code/pull/8780))
- Added OpenTelemetry session lifecycle events to improve observability of session creation and shutdown. ([#8616](https://github.com/QwenLM/qwen-code/pull/8616))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- feat(serve): bound daemon ACP NDJSON buffers ([#8911](https://github.com/QwenLM/qwen-code/pull/8911)) by @doudouOUC
- feat(extensions): support Agent Plugins v1 ([#8834](https://github.com/QwenLM/qwen-code/pull/8834)) by @callmeYe
- feat(ui): word-wise drag after double-click, line-wise extension after triple-click ([#8739](https://github.com/QwenLM/qwen-code/pull/8739)) by @qwen-code-dev-bot
- Adds standard OpenTelemetry session.start and session.end lifecycle events to improve observability of session creation and shutdown. ([#8616](https://github.com/QwenLM/qwen-code/pull/8616)) by @zjunothing
- Web Shell subagent rows are now more interactive with persistent chevrons, better hover states, and inline display of agent types and metrics. ([#8780](https://github.com/QwenLM/qwen-code/pull/8780)) by @carffuca
- Session list reads now properly propagate request cancellation to prevent disconnected clients from leaving expensive background scans running. ([#8954](https://github.com/QwenLM/qwen-code/pull/8954)) by @doudouOUC
- feat(desktop): add Aliyun OSS release mirror ([#8976](https://github.com/QwenLM/qwen-code/pull/8976)) by @yiliang114
- feat(web-shell): improve compact tool activity ([#8973](https://github.com/QwenLM/qwen-code/pull/8973)) by @ytahdn
- ACP sessions now use the unified Goal v3 runtime to support create, edit, pause, resume, and clear actions with improved turn scheduling. ([#8732](https://github.com/QwenLM/qwen-code/pull/8732)) by @qqqys
- The Web Shell sidebar now includes a Channels view to track integration sessions from DingTalk, Feishu, and WeCom alongside standard tasks. ([#8457](https://github.com/QwenLM/qwen-code/pull/8457)) by @BZ-D
- The /coordinate command now supports native multi-agent workflows with read-only teammates and automated result forwarding to the leader agent. ([#8804](https://github.com/QwenLM/qwen-code/pull/8804)) by @yiliang114
- The review skill's reverse audit now detects defects in modeled system layers like sandboxes by comparing runtime state semantics against the model. ([#8956](https://github.com/QwenLM/qwen-code/pull/8956)) by @wenshao
- Terminal window titles now display status symbols like ◐ and ✳ to indicate task state in multiplexers where color cues are unavailable. ([#8970](https://github.com/QwenLM/qwen-code/pull/8970)) by @qwen-code-dev-bot
- The /doctor memory command now reports tool result retention stats, including character counts and warnings for results exceeding 30k characters. ([#8875](https://github.com/QwenLM/qwen-code/pull/8875)) by @ZijianZhang989
- Background task notifications in the web shell are now localizable and display structured metadata within consistent chat-style bubbles. ([#8989](https://github.com/QwenLM/qwen-code/pull/8989)) by @ytahdn
- Web Shell now supports Qwen 3.8 reasoning controls, allowing users to toggle Thinking mode and select effort levels directly from the model chip. ([#8974](https://github.com/QwenLM/qwen-code/pull/8974)) by @callmeYe

#### Bug Fixes

- fix(web-shell): Enforce prompt-safe session navigation ([#8931](https://github.com/QwenLM/qwen-code/pull/8931)) by @doudouOUC
- fix(desktop): consolidate 0.1.1 regressions ([#8896](https://github.com/QwenLM/qwen-code/pull/8896)) by @yiliang114
- fix(serve): Keep restore request shapes distinct ([#8933](https://github.com/QwenLM/qwen-code/pull/8933)) by @doudouOUC
- fix(web-shell): improve ask user question keyboard interactions ([#8876](https://github.com/QwenLM/qwen-code/pull/8876)) by @carffuca
- Prevents DashScope Qwen 3.8 requests from failing by ensuring conflicting reasoning_effort and thinking_budget settings are not sent together. ([#8525](https://github.com/QwenLM/qwen-code/pull/8525)) by @DragonnZhang
- Fixes workspace path containment checks in tests to correctly handle canonicalized paths on macOS systems. ([#8759](https://github.com/QwenLM/qwen-code/pull/8759)) by @rbalachandar
- Ensures the repair agent is warned to rebuild dist/ on all retryable A/B exit paths to prevent trusting stale baseline artifacts. ([#8958](https://github.com/QwenLM/qwen-code/pull/8958)) by @wenshao
- Fixes parsing of dotted-minor Claude model aliases and adds token limit support for Opus 5 models. ([#8585](https://github.com/QwenLM/qwen-code/pull/8585)) by @netbrah
- Correctly identifies OpenAI SDK APIUserAbortError as a user cancellation to prevent false API error reporting when requests are aborted. ([#8399](https://github.com/QwenLM/qwen-code/pull/8399)) by @harjothkhara
- Virtual subagent session IDs now support reserved characters like colons and slashes to fix detail view resolution for certain provider task IDs. ([#8717](https://github.com/QwenLM/qwen-code/pull/8717)) by @carffuca
- Closed resource ownership gaps in the daemon ACP transport by validating envelopes earlier and preventing reuse of failed channel generations. ([#8947](https://github.com/QwenLM/qwen-code/pull/8947)) by @doudouOUC
- Same-session refresh operations are now transactional to ensure visible session state remains unchanged if a candidate restore fails or times out. ([#8939](https://github.com/QwenLM/qwen-code/pull/8939)) by @doudouOUC
- Extended defense against content-only thinking-tag leaks to all OpenAI-compatible providers to prevent unclosed tags from breaking streams. ([#8818](https://github.com/QwenLM/qwen-code/pull/8818)) by @yiliang114
- Updated review body wording to clearly disclose coverage gaps and prevent contradictions when agents cannot certify the entire diff. ([#8857](https://github.com/QwenLM/qwen-code/pull/8857)) by @yiliang114
- fix(web-shell): keep workspace picker suggestions closed ([#8844](https://github.com/QwenLM/qwen-code/pull/8844)) by @ytahdn
- fix(desktop): add safe area to macOS app icon ([#8987](https://github.com/QwenLM/qwen-code/pull/8987)) by @yiliang114
- fix(webui): Close same-session refresh race gaps ([#8990](https://github.com/QwenLM/qwen-code/pull/8990)) by @doudouOUC
- fix(web-shell): Harden prompt admission ownership ([#8955](https://github.com/QwenLM/qwen-code/pull/8955)) by @doudouOUC
- fix(desktop): follow-up review fixes from #8896 ([#8951](https://github.com/QwenLM/qwen-code/pull/8951)) by @yiliang114
- Text selection in Virtualized History mode now includes the footer and statusline while keeping other controls excluded from the selection region. ([#8329](https://github.com/QwenLM/qwen-code/pull/8329)) by @DragonnZhang
- The desktop app now displays a minimal icon during startup and hides the internal workspace until loading or recovery actions are complete. ([#8988](https://github.com/QwenLM/qwen-code/pull/8988)) by @yiliang114
- Headless tool result content is now bounded to 65,536 bytes, displaying deterministic previews for oversized outputs without altering semantic data. ([#9012](https://github.com/QwenLM/qwen-code/pull/9012)) by @doudouOUC
- The desktop release pipeline now enforces stricter version checks, verifies Node.js archives, and ensures safe runtime assembly during updates. ([#9009](https://github.com/QwenLM/qwen-code/pull/9009)) by @yiliang114
- Transient slash commands like authentication and settings no longer clutter history, while model picker actions now explicitly report their outcomes. ([#8365](https://github.com/QwenLM/qwen-code/pull/8365)) by @DragonnZhang
- Removed web-shell e2e test paths from the review context manifest to ensure reviewers only see relevant source code files. ([#9028](https://github.com/QwenLM/qwen-code/pull/9028)) by @wenshao
- Improved CI reliability by caching linter downloads on ECS runners with strict checksum verification to speed up builds. ([#9001](https://github.com/QwenLM/qwen-code/pull/9001)) by @yiliang114

#### Performance

- Reverse-audit convergence pairs now launch rounds 1 and 2 concurrently for 3B chunked reviews to reduce wait times on long CI runs. ([#8903](https://github.com/QwenLM/qwen-code/pull/8903)) by @wenshao

#### Documentation

- docs(agents): drop mandatory /review step from the general workflow ([#9000](https://github.com/QwenLM/qwen-code/pull/9000)) by @wenshao
- Documentation now defines the implementation contract for selective daemon session restore, replacing full transcript materialization with targeted projections. ([#8743](https://github.com/QwenLM/qwen-code/pull/8743)) by @doudouOUC

#### Internal Changes

- chore(serve): Log session continuation admissions ([#8932](https://github.com/QwenLM/qwen-code/pull/8932)) by @doudouOUC
- Project memory isolation now defaults to workspace scope for qwen serve runtimes, while standalone CLI behavior remains unchanged. ([#8856](https://github.com/QwenLM/qwen-code/pull/8856)) by @qqqys
- Fixed a deterministic test failure in the ACP bridge transport failure scenario caused by a logical merge conflict in history page sizing. ([#8984](https://github.com/QwenLM/qwen-code/pull/8984)) by @wenshao
- A new regression test ensures model selection remains stable during multi-provider template updates to prevent unintended provider overwrites. ([#8879](https://github.com/QwenLM/qwen-code/pull/8879)) by @ComplexSimply

### New Contributors

- @rbalachandar made their first contribution in [#8759](https://github.com/QwenLM/qwen-code/pull/8759)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.10...v0.21.11

## [0.21.10](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.10) - 2026-08-11

### Highlights

- Added ACP support for configuring reasoning effort levels from Default to Max via session configuration. ([#8526](https://github.com/QwenLM/qwen-code/pull/8526))
- Clicking uploaded or pasted images in the Web Shell now opens a preview in the artifact panel with download support. ([#8930](https://github.com/QwenLM/qwen-code/pull/8930))
- Fixed AutoFix timeouts by enabling streamed progress output to detect active work during long-running headless tasks. ([#8895](https://github.com/QwenLM/qwen-code/pull/8895))
- Fixed Desktop Local Control to support enterprise LAN addresses by allowing non-private IPv4 routes on verified interfaces. ([#8866](https://github.com/QwenLM/qwen-code/pull/8866))
- Improved Web Shell responsiveness by fixing animation stutter, scrolling stability, and line-change statistics for large files. ([#8915](https://github.com/QwenLM/qwen-code/pull/8915), [#8914](https://github.com/QwenLM/qwen-code/pull/8914), [#8924](https://github.com/QwenLM/qwen-code/pull/8924))
- Fixed Windows bug where the desktop app failed to spawn the Node runtime due to unhandled verbatim path prefixes. ([#8936](https://github.com/QwenLM/qwen-code/pull/8936))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- OpenAI API log cleanup now applies to non-interactive sessions, headless invocations, and daemon modes to reduce disk usage. ([#8893](https://github.com/QwenLM/qwen-code/pull/8893)) by @doudouOUC
- Web Shell session lists now share cached data across components to improve loading performance and reduce network requests. ([#8891](https://github.com/QwenLM/qwen-code/pull/8891)) by @doudouOUC
- Added ACP support for configuring reasoning effort levels, allowing clients to set options from Default to Max via session configuration. ([#8526](https://github.com/QwenLM/qwen-code/pull/8526)) by @zjunothing
- Clicking uploaded or pasted images in the Web Shell now opens a preview in the right-hand artifact panel with download support. ([#8930](https://github.com/QwenLM/qwen-code/pull/8930)) by @ytahdn

#### Bug Fixes

- Fixed AutoFix timeouts by enabling streamed progress output so the system can detect active work during long-running headless tasks. ([#8895](https://github.com/QwenLM/qwen-code/pull/8895)) by @qqqys
- Changed @ completion to use bare Left and Right arrow keys for switching category tabs instead of Ctrl+arrow or Ctrl+Tab. ([#8576](https://github.com/QwenLM/qwen-code/pull/8576)) by @LaZzyMan
- Corrected the round-cap marker lifecycle to prevent contradictory stop disclosures and ensure markers clear properly upon convergence. ([#8850](https://github.com/QwenLM/qwen-code/pull/8850)) by @wenshao
- Improved Web Shell subagent panel responsiveness by fixing animation stutter, elapsed time resets, and output scrolling behavior. ([#8915](https://github.com/QwenLM/qwen-code/pull/8915)) by @ytahdn
- Fixed a bug where session load timeouts prevented retrying the same session by clearing the stale target identity upon expiration. ([#8883](https://github.com/QwenLM/qwen-code/pull/8883)) by @yiliang114
- Restored Live Host release mirroring to Aliyun OSS by correcting workflow permissions and credential passing. ([#8917](https://github.com/QwenLM/qwen-code/pull/8917)) by @LaZzyMan
- Context usage indicators no longer appear twice in the UI when the status line already displays context information. ([#8749](https://github.com/QwenLM/qwen-code/pull/8749)) by @yiliang114
- Hyperlinks in chat output now correctly stop at full-width CJK punctuation to prevent broken URLs in Chinese text. ([#8755](https://github.com/QwenLM/qwen-code/pull/8755)) by @yiliang114
- Web Shell now reliably reconciles mid-turn messages with daemon state to prevent duplicate submissions after refreshes. ([#8798](https://github.com/QwenLM/qwen-code/pull/8798)) by @ytahdn
- Fixed banner duplication and screen flickering issues when resizing the terminal window or waking the application. ([#8831](https://github.com/QwenLM/qwen-code/pull/8831)) by @chiga0
- Scrolling through long Web Shell transcripts is now stable and preserves visible messages during history pagination. ([#8914](https://github.com/QwenLM/qwen-code/pull/8914)) by @ytahdn
- Made WebUI cross-session switching transactional to prevent data loss or state corruption when resuming sessions fails or times out. ([#8882](https://github.com/QwenLM/qwen-code/pull/8882)) by @doudouOUC
- Fixed Desktop Local Control to support enterprise LAN addresses by allowing non-private IPv4 routes on verified physical interfaces. ([#8866](https://github.com/QwenLM/qwen-code/pull/8866)) by @yiliang114
- Fixed Web Shell to correctly display line-change statistics for large edited files by replacing the previous comparison limit with a linear-time algorithm. ([#8924](https://github.com/QwenLM/qwen-code/pull/8924)) by @ytahdn
- Fixed an issue where deferred MCP tools were missing in resumed sessions by re-revealing them when tool declarations are refreshed. ([#8475](https://github.com/QwenLM/qwen-code/pull/8475)) by @zjunothing
- Fixed CLI VP mode to fully expand static history items when pressing Ctrl+S, ensuring long tables and output are no longer truncated. ([#8704](https://github.com/QwenLM/qwen-code/pull/8704)) by @zjunothing
- Automatic session titles now exclude hook context to prevent long generic blocks from displacing the user's actual request. ([#8781](https://github.com/QwenLM/qwen-code/pull/8781)) by @zjunothing
- Fixed a Windows bug where the desktop app failed to spawn the Node runtime due to unhandled verbatim path prefixes. ([#8936](https://github.com/QwenLM/qwen-code/pull/8936)) by @yiliang114
- Added a structured error code for closing sessions to ensure reliable retry handling in the Web UI and Java clients. ([#8884](https://github.com/QwenLM/qwen-code/pull/8884)) by @yiliang114
- Fixed provider version synchronization to correctly distinguish between installed model hashes and template refresh states. ([#8889](https://github.com/QwenLM/qwen-code/pull/8889)) by @yiliang114

#### Performance

- Improved CLI performance by caching persisted session catalogs for organized and filtered daemon lists, with automatic invalidation on metadata changes. ([#8892](https://github.com/QwenLM/qwen-code/pull/8892)) by @doudouOUC

#### Documentation

- Updated documentation to correct session resume and screen-reader verification steps for inline image testing. ([#8746](https://github.com/QwenLM/qwen-code/pull/8746)) by @zjunothing

#### Internal Changes

- Added regression tests to ensure the /remember command context refresh marker persists correctly during retry and notification turns. ([#8809](https://github.com/QwenLM/qwen-code/pull/8809)) by @ZijianZhang989
- Refactored internal toolchain code for qwen review build-test without changing any CLI arguments, outputs, or npm behaviors. ([#8776](https://github.com/QwenLM/qwen-code/pull/8776)) by @wenshao
- No user-facing changes; this update improves test stability for plan mode exits during LLM timeouts. ([#8881](https://github.com/QwenLM/qwen-code/pull/8881)) by @yiliang114
- Fixed an infinite render loop in the Web Shell test harness that previously caused CI jobs to fail due to heap exhaustion. ([#8934](https://github.com/QwenLM/qwen-code/pull/8934)) by @ytahdn

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.9...v0.21.10

## [0.21.9](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.9) - 2026-08-10

### Highlights

- Added native support for installing Qoder plugins from directories, archives, Git repos, URLs, and npm packages with automatic system-prompt loading. ([#8661](https://github.com/QwenLM/qwen-code/pull/8661))
- Enabled Local Control pairing via QR code in CLI and Desktop apps for secure LAN access and added automatic default workspace creation on first launch. ([#8727](https://github.com/QwenLM/qwen-code/pull/8727), [#8814](https://github.com/QwenLM/qwen-code/pull/8814))
- Added drag-and-drop support for images in Web Shell and a fullscreen toggle for the right panel to improve artifact and subagent visibility. ([#8696](https://github.com/QwenLM/qwen-code/pull/8696), [#8614](https://github.com/QwenLM/qwen-code/pull/8614))
- Fixed Linux Wayland text copying to prefer native wl-copy and enabled microphone access for the macOS Desktop app with required entitlements. ([#8481](https://github.com/QwenLM/qwen-code/pull/8481), [#8715](https://github.com/QwenLM/qwen-code/pull/8715))
- Prevented telemetry startup failures by ignoring unsupported OpenTelemetry exporter environment variables and fixed session attribution marker logic. ([#8703](https://github.com/QwenLM/qwen-code/pull/8703), [#8712](https://github.com/QwenLM/qwen-code/pull/8712))
- Improved code review performance for large diffs and guaranteed composition survival during budget stops by reserving a 20-minute floor. ([#8773](https://github.com/QwenLM/qwen-code/pull/8773), [#8791](https://github.com/QwenLM/qwen-code/pull/8791))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- Adds native support for installing Qoder plugins from directories, archives, Git repos, URLs, and npm packages, automatically loading system-prompt.md as extension context. ([#8661](https://github.com/QwenLM/qwen-code/pull/8661)) by @callmeYe
- Automatically assigns issues to area owners based on labels using a round-robin strategy that prefers owners with the fewest open assigned issues. ([#8668](https://github.com/QwenLM/qwen-code/pull/8668)) by @yiliang114
- Adds a daemon API endpoint and SDK helpers to enable or disable up to 100 Skills in a single batch request with per-target error reporting. ([#8664](https://github.com/QwenLM/qwen-code/pull/8664)) by @callmeYe
- The qwen review submit command now outputs the direct URL to posted reviews in both stderr and JSON stdout. ([#8770](https://github.com/QwenLM/qwen-code/pull/8770)) by @wenshao
- Added Local Control pairing to the CLI and Desktop app, allowing secure LAN access via QR code and a new Control menu option. ([#8727](https://github.com/QwenLM/qwen-code/pull/8727)) by @yiliang114
- Added a fullscreen toggle to the Web Shell right panel for easier viewing of artifacts and subagent details. ([#8614](https://github.com/QwenLM/qwen-code/pull/8614)) by @wenshao
- Added a guard to pause tool execution after repeated failures within a single interactive ACP session. ([#8469](https://github.com/QwenLM/qwen-code/pull/8469)) by @doudouOUC
- Enhanced the Workflow tool description with orchestration policies and default pipelining guidance for better model behavior. ([#8694](https://github.com/QwenLM/qwen-code/pull/8694)) by @qqqys
- Desktop now automatically creates a default workspace at ~/Documents/Qwen and starts the runtime on first launch without blocking the main thread. ([#8814](https://github.com/QwenLM/qwen-code/pull/8814)) by @yiliang114
- Web Shell now displays context window usage as a mini progress pill in the status bar with tooltips and accessible labels. ([#8794](https://github.com/QwenLM/qwen-code/pull/8794)) by @wenshao
- Web Shell now supports dragging and dropping PNG, JPEG, GIF, WebP, and BMP images into the composer with full attachment management and concurrency limits. ([#8696](https://github.com/QwenLM/qwen-code/pull/8696)) by @water-in-stone
- Stable Qwen Live Host packages are now mirrored to Aliyun OSS with automatic fallback to GitHub and support for up to one-hour archive downloads. ([#8674](https://github.com/QwenLM/qwen-code/pull/8674)) by @LaZzyMan
- Added automatic background cleanup for expired OpenAI API logs based on the new model.openAILogRetentionDays setting, which defaults to seven days. ([#8862](https://github.com/QwenLM/qwen-code/pull/8862)) by @doudouOUC

#### Bug Fixes

- Requires explicit confirmation for read-only Git commands when repository configuration executes external programs via diff.external or core.fsmonitor. ([#8645](https://github.com/QwenLM/qwen-code/pull/8645)) by @yiliang114
- Prevents telemetry initialization failures by ignoring unsupported OTEL_TRACES_EXPORTER, OTEL_LOGS_EXPORTER, and OTEL_METRICS_EXPORTER environment variables during startup. ([#8703](https://github.com/QwenLM/qwen-code/pull/8703)) by @zjunothing
- Improves the WebSearch startup notice to include a copy-pasteable settings.json example and environment variable alternative when no search model is configured. ([#8665](https://github.com/QwenLM/qwen-code/pull/8665)) by @qwen-code-dev-bot
- Prefers the native wl-copy command for text copying on Linux Wayland sessions, falling back to xclip, xsel, or OSC 52 if unavailable. ([#8481](https://github.com/QwenLM/qwen-code/pull/8481)) by @zjunothing
- Fixes session attribution to require exact value 1 for QWEN_CODE_SERVE and QWEN_CODE_DESKTOP markers, preventing false positives from values like 0 or false. ([#8712](https://github.com/QwenLM/qwen-code/pull/8712)) by @yiliang114
- Fixed a rendering issue where the queued-acknowledgement comment on pull requests displayed raw text instead of formatted Markdown with working links. ([#8726](https://github.com/QwenLM/qwen-code/pull/8726)) by @wenshao
- Standardized caller-supplied session IDs across all daemon interfaces to ensure consistent session creation and validation. ([#8415](https://github.com/QwenLM/qwen-code/pull/8415)) by @doudouOUC
- Reduced noise in the demo event log by aggregating usage_update frames into a single context meter display. ([#8762](https://github.com/QwenLM/qwen-code/pull/8762)) by @wenshao
- Fixed a compatibility issue in external context reading by switching to an explicit reader loop for response bodies. ([#8764](https://github.com/QwenLM/qwen-code/pull/8764)) by @wenshao
- Enabled microphone access for the macOS Desktop app by adding the required usage description and audio-input entitlement. ([#8715](https://github.com/QwenLM/qwen-code/pull/8715)) by @yiliang114
- Fixed a race condition in the Qoder plugin install integration test by properly awaiting the test rig setup. ([#8793](https://github.com/QwenLM/qwen-code/pull/8793)) by @yiliang114
- Fixed flaky CI tests by updating memory extraction timeouts and extending manifest fixture teardown limits. ([#8797](https://github.com/QwenLM/qwen-code/pull/8797)) by @wenshao
- Hidden raw ACP usage update notifications from Web Shell transcripts while retaining token accounting functionality. ([#8790](https://github.com/QwenLM/qwen-code/pull/8790)) by @carffuca
- Compacted the Local Control dialog to ensure the QR code, pairing link, and disconnect button remain visible without scrolling. ([#8800](https://github.com/QwenLM/qwen-code/pull/8800)) by @yiliang114
- Fixed workflow label mutations by switching to REST endpoints to avoid errors with older GitHub CLI versions. ([#8761](https://github.com/QwenLM/qwen-code/pull/8761)) by @wenshao
- Implemented a dedicated 60-second timeout for ACP session restoration to prevent hangs and improve error handling. ([#8691](https://github.com/QwenLM/qwen-code/pull/8691)) by @doudouOUC
- Web Shell no longer displays debug projections for unrecognized daemon events as conversation content in transcripts. ([#8812](https://github.com/QwenLM/qwen-code/pull/8812)) by @wenshao
- Background shell tests now use unique temporary paths to prevent file permission errors caused by shared sidecar files. ([#8813](https://github.com/QwenLM/qwen-code/pull/8813)) by @wenshao
- Local Control now opens the active Desktop session on mobile instead of a blank Web Shell and improves network address verification security. ([#8806](https://github.com/QwenLM/qwen-code/pull/8806)) by @yiliang114
- Desktop now displays specific error messages when automatic updates fail instead of silently returning or attempting unsafe retries. ([#8807](https://github.com/QwenLM/qwen-code/pull/8807)) by @yiliang114
- The floating Todo panel now respects the Session Workflow setting, appearing as non-interactive progress when disabled and opening the plan execution view when enabled. ([#8828](https://github.com/QwenLM/qwen-code/pull/8828)) by @yiliang114
- Workspace trust is now evaluated separately for each project .env file to prevent untrusted parent directories from leaking secrets into trusted child workspaces. ([#8706](https://github.com/QwenLM/qwen-code/pull/8706)) by @zjunothing
- On macOS, closing the main window now hides it instead of destroying it, allowing instant restoration from the Dock while preserving focus behavior. ([#8802](https://github.com/QwenLM/qwen-code/pull/8802)) by @yiliang114
- Session work is now fenced by specific attachment identity to prevent stale asynchronous operations from corrupting newer attachments sharing the same session ID. ([#8833](https://github.com/QwenLM/qwen-code/pull/8833)) by @doudouOUC
- Shell registry tests now use isolated temporary directories to prevent conflicts, and notifications are sanitized using a shared helper for consistent display. ([#8795](https://github.com/QwenLM/qwen-code/pull/8795)) by @wenshao
- Bounded replay snapshots now compact consecutive assistant text and thought chunks into entries of at most 256 source events while preserving metadata boundaries. ([#8801](https://github.com/QwenLM/qwen-code/pull/8801)) by @wenshao
- Added an idle watchdog to kill silent sandbox hangs after 20 minutes and implemented stale container reaping to prevent leaked runners from consuming resources. ([#8816](https://github.com/QwenLM/qwen-code/pull/8816)) by @wenshao
- Extended the environment variable denylist to prevent untrusted workspace .env values from leaking into session subprocesses and hardened the scrub lifecycle. ([#8763](https://github.com/QwenLM/qwen-code/pull/8763)) by @wenshao
- Session-switch errors now list specific blocking background tasks with their IDs and statuses, directing users to the correct commands to stop them. ([#8742](https://github.com/QwenLM/qwen-code/pull/8742)) by @yiliang114
- Daemon-owned runtimes can now complete authorized external text writes via built-in tools without disabling ACP delegation or widening workspace boundaries. ([#8852](https://github.com/QwenLM/qwen-code/pull/8852)) by @doudouOUC
- Fixed a bug where setting QWEN_CODE_SERVE to 0 or false incorrectly removed NODE_OPTIONS and NODE_PATH during direct ACP launches. ([#8811](https://github.com/QwenLM/qwen-code/pull/8811)) by @yiliang114
- Fixed an issue where refreshing a provider template incorrectly reset the user's selected model if that model belonged to a different provider. ([#8868](https://github.com/QwenLM/qwen-code/pull/8868)) by @yiliang114
- Ported remaining hardening improvements to the verify gate to prevent unnecessary full re-runs caused by identity-less failures. ([#8878](https://github.com/QwenLM/qwen-code/pull/8878)) by @wenshao
- Fixed sandbox container name collisions in shared daemon environments by switching to random 8-character hex suffixes for container names. ([#8880](https://github.com/QwenLM/qwen-code/pull/8880)) by @wenshao
- Fixed the provider update prompt to respect the 'Remind me later' choice by persisting a 24-hour cooldown instead of re-prompting on every startup. ([#8829](https://github.com/QwenLM/qwen-code/pull/8829)) by @qwen-code-dev-bot
- Review comments posted via /review are now formatted with proper paragraphs and lists to improve readability when unresolved Criticals or coverage disclosures are present. ([#8825](https://github.com/QwenLM/qwen-code/pull/8825)) by @wenshao

#### Performance

- The review process now guarantees compose and submission survive budget stops by reserving a 20-minute floor for composition before verification. ([#8791](https://github.com/QwenLM/qwen-code/pull/8791)) by @wenshao
- Automatic review timeouts for micro diffs under 25 lines are now halved to reduce latency while maintaining high effort and inline comments. ([#8774](https://github.com/QwenLM/qwen-code/pull/8774)) by @wenshao
- Code review performance is improved for diffs over 3000 lines by reducing audit rounds and disabling the specialist agent to prevent timeouts. ([#8773](https://github.com/QwenLM/qwen-code/pull/8773)) by @wenshao
- Made the triage job timeout configurable via the QWEN_TRIAGE_TIMEOUT_MINUTES repository variable to prevent premature cancellations of long-running checks. ([#8810](https://github.com/QwenLM/qwen-code/pull/8810)) by @wenshao

#### Documentation

- Korean (한국어) has been added to the documentation language bar in the README to provide direct access to localized guides. ([#8836](https://github.com/QwenLM/qwen-code/pull/8836)) by @dss1222

#### Internal Changes

- Synchronized the external-context workspace version in the dependency lockfile to prevent unnecessary local install churn and working tree dirtiness. ([#8858](https://github.com/QwenLM/qwen-code/pull/8858)) by @wenshao
- Removed the legacy /demo debug page from the daemon as its functionality is fully covered by the main Web Shell interface. ([#8805](https://github.com/QwenLM/qwen-code/pull/8805)) by @wenshao
- Improved Web Shell session switching to retry when a target session is still closing instead of immediately reporting a permanent error. ([#8864](https://github.com/QwenLM/qwen-code/pull/8864)) by @yiliang114

### New Contributors

- @dss1222 made their first contribution in [#8836](https://github.com/QwenLM/qwen-code/pull/8836)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.8...v0.21.9

## [0.21.8](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.8) - 2026-08-08

### Highlights

- Restored real-time autofix support for pull requests opened from forks by bridging review events to credentialed workflows. ([#8676](https://github.com/QwenLM/qwen-code/pull/8676))
- Enabled compression cache sharing for OpenAI, Gemini, and Vertex AI to reuse conversation prefixes and reduce redundant input processing. ([#8418](https://github.com/QwenLM/qwen-code/pull/8418), [#8425](https://github.com/QwenLM/qwen-code/pull/8425))
- Added repository context manifests to guide the /review command with bounded domains, related paths, and recommended tests. ([#8654](https://github.com/QwenLM/qwen-code/pull/8654))
- Fixed a security issue where explicitly distrusted workspaces were incorrectly inheriting trust from parent directories. ([#8628](https://github.com/QwenLM/qwen-code/pull/8628))
- Improved /review performance by moving remote matching to a deterministic CLI subcommand, achieving up to 93.3% prompt cache hit rates. ([#8658](https://github.com/QwenLM/qwen-code/pull/8658))
- Allowed ACP agent tool calls to run concurrently at the configured limit, removing artificial serialization that slowed down fan-out operations. ([#8631](https://github.com/QwenLM/qwen-code/pull/8631))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- Review runs now warn users if the executing bundle is older than the current code and document the findings --test-delta flag for severity adjustments. ([#8390](https://github.com/QwenLM/qwen-code/pull/8390)) by @wenshao
- The daemon now observes and reports memory pressure levels and ratios using real denominators for both the root process and child heaps. ([#8423](https://github.com/QwenLM/qwen-code/pull/8423)) by @doudouOUC
- Compression cache sharing is now enabled for all OpenAI-compatible providers, including stable session keys for the official OpenAI API. ([#8418](https://github.com/QwenLM/qwen-code/pull/8418)) by @DragonnZhang
- Compression cache sharing is now enabled for Gemini and Vertex AI to reuse conversation prefixes and reduce redundant input processing. ([#8425](https://github.com/QwenLM/qwen-code/pull/8425)) by @DragonnZhang
- Group chats can now be approved once via a stable chat ID using the new group pairing policy, allowing access for all members. ([#8440](https://github.com/QwenLM/qwen-code/pull/8440)) by @qqqys
- Added a repository context manifest to guide the /review command with bounded domains, related paths, and recommended tests for specific repository areas. ([#8654](https://github.com/QwenLM/qwen-code/pull/8654)) by @wenshao
- Enhanced DingTalk integration to include stable identifiers of mentioned members in the inbound context when the bot is mentioned alongside other users. ([#8639](https://github.com/QwenLM/qwen-code/pull/8639)) by @BenGuanRan
- Restores real-time autofix support for pull requests opened from forks by bridging review events to the credentialed workflow lane. ([#8676](https://github.com/QwenLM/qwen-code/pull/8676)) by @wenshao
- Enriches Feishu contact observations with sender display names and group names to replace opaque IDs with recognizable labels. ([#8569](https://github.com/QwenLM/qwen-code/pull/8569)) by @BenGuanRan
- Improves Web Shell feedback for parallel subagents by keeping status visible, auto-expanding details during work, and collapsing groups upon completion. ([#8559](https://github.com/QwenLM/qwen-code/pull/8559)) by @carffuca
- Adds optional Mem0 memory write support to the Direct External Context integration for approved content when explicitly enabled in configuration. ([#8507](https://github.com/QwenLM/qwen-code/pull/8507)) by @doudouOUC
- Improves telemetry attribution to distinguish daemon-spawned sessions from direct CLI launches in usage statistics. ([#8670](https://github.com/QwenLM/qwen-code/pull/8670)) by @yiliang114
- Added support for installing Web Shell Extensions directly from local .zip or .tar.gz archive files via the Extension manager. ([#8621](https://github.com/QwenLM/qwen-code/pull/8621)) by @callmeYe
- Feishu users can now answer structured single-select and multi-select questions directly via native Card V2 forms instead of text replies. ([#8578](https://github.com/QwenLM/qwen-code/pull/8578)) by @BenGuanRan
- Dynamic Workflows now support cooperative pause and resume via the 'p' shortcut in Background Tasks or the '/workflows p' command in the TUI. ([#8320](https://github.com/QwenLM/qwen-code/pull/8320)) by @qqqys
- Added activeWork, activeWorkReporting, and activeWorkStaleMs fields to the GET /health?deep=1 endpoint to expose current work state. ([#8588](https://github.com/QwenLM/qwen-code/pull/8588)) by @doudouOUC
- Implemented durable evidence checkpointing for long-running Goals to prevent data loss and manage evidence limits during execution. ([#8465](https://github.com/QwenLM/qwen-code/pull/8465)) by @qqqys

#### Bug Fixes

- Forced AutoFix review admission now fails closed with explicit validation and stable reason codes when takeover permissions cannot be verified. ([#8410](https://github.com/QwenLM/qwen-code/pull/8410)) by @qqqys
- Automatic recap results are now discarded if a new user message starts while the recap is still processing to prevent output from appearing in the wrong turn. ([#8573](https://github.com/QwenLM/qwen-code/pull/8573)) by @carffuca
- File caching and session leases now fail closed when inode values are zero to prevent unrelated files from being incorrectly treated as identical. ([#8290](https://github.com/QwenLM/qwen-code/pull/8290)) by @xianjianlf2
- Backward transcript pagination now caps page expansion to prevent single large turns from inflating pages beyond the requested size and byte budget. ([#8553](https://github.com/QwenLM/qwen-code/pull/8553)) by @wenshao
- Signal-terminated foreground shell commands are now correctly reported as errors instead of being treated as successful executions. ([#8501](https://github.com/QwenLM/qwen-code/pull/8501)) by @daleselaji-dev
- The npm cache producer now runs as a non-root user to prevent file permission issues on persistent self-hosted CI runners. ([#8669](https://github.com/QwenLM/qwen-code/pull/8669)) by @yiliang114
- Same-host daemon bridges now use the regular CLI filesystem service for text reads while keeping text writes delegated through the workspace boundary. ([#8620](https://github.com/QwenLM/qwen-code/pull/8620)) by @doudouOUC
- Automated fix jobs backed by personal access tokens are now skipped for fork pull requests that lack repository secrets. ([#8671](https://github.com/QwenLM/qwen-code/pull/8671)) by @wenshao
- The triage status comment now finalizes correctly even when the workflow is cancelled or times out, preventing stale running indicators. ([#8436](https://github.com/QwenLM/qwen-code/pull/8436)) by @wenshao
- Fixed an issue where slash command names were truncated in narrow terminals, ensuring full command names like 'review' and 'doctor' remain visible in completion menus. ([#8657](https://github.com/QwenLM/qwen-code/pull/8657)) by @carffuca
- Removed a blocking disk flush command from directory E2E tests to prevent Vitest worker timeouts on busy self-hosted Linux runners. ([#8685](https://github.com/QwenLM/qwen-code/pull/8685)) by @wenshao
- Added a timeout to silent MCP SSE startup attempts in 'qwen mcp list' to prevent the command from hanging indefinitely on unresponsive endpoints. ([#8555](https://github.com/QwenLM/qwen-code/pull/8555)) by @daleselaji-dev
- Enabled management of DingTalk interactive card configurations in the daemon channel catalog and ensured Web Shell preserves these object-valued settings. ([#8517](https://github.com/QwenLM/qwen-code/pull/8517)) by @BenGuanRan
- Increased SDK request timeouts and stream limits for CI review runs to prevent failures during long upstream processing or large context generation. ([#8673](https://github.com/QwenLM/qwen-code/pull/8673)) by @wenshao
- Fixes an issue on Windows where workspace paths with verbatim prefixes caused failures during runtime startup and workspace resolution. ([#8619](https://github.com/QwenLM/qwen-code/pull/8619)) by @yiliang114
- Ensures links in assistant replies open in the system browser when the built-in browser pane fails to load or navigate. ([#8594](https://github.com/QwenLM/qwen-code/pull/8594)) by @yiliang114
- Allows ACP agent tool calls to run concurrently at the configured limit, removing artificial serialization that slowed down fan-out operations. ([#8631](https://github.com/QwenLM/qwen-code/pull/8631)) by @wenshao
- Fixes mobile layout issues to keep the composer anchored at the bottom of the chat pane on screens up to 760px wide. ([#8601](https://github.com/QwenLM/qwen-code/pull/8601)) by @dreamWB
- Fixes an issue where resuming a session after a connection cut would display incomplete responses by correctly recording the delivered text prefix. ([#8624](https://github.com/QwenLM/qwen-code/pull/8624)) by @harjothkhara
- Ensures live system instructions refresh immediately after memory writes so new context is applied without requiring a session restart. ([#8640](https://github.com/QwenLM/qwen-code/pull/8640)) by @ZijianZhang989
- Hardens QQ group sender attribution to consistently display neutral labels for username-less senders and prevent identity exposure when mentions are disabled. ([#8477](https://github.com/QwenLM/qwen-code/pull/8477)) by @zjunothing
- Fixes stream-json sessions to remain alive after an interrupt signal, allowing users to continue interactions without restarting the CLI. ([#8509](https://github.com/QwenLM/qwen-code/pull/8509)) by @zjunothing
- Corrects integration test configuration to enforce worker limits and prevent unbounded parallelism during test execution. ([#8689](https://github.com/QwenLM/qwen-code/pull/8689)) by @wenshao
- Emits standard ACP usage update notifications after each model round to accurately report prompt context occupancy and window size. ([#8528](https://github.com/QwenLM/qwen-code/pull/8528)) by @zjunothing
- Fixed an issue where changing trust or tool settings now correctly refreshes MCP session metadata without requiring a full reconnection. ([#8522](https://github.com/QwenLM/qwen-code/pull/8522)) by @zjunothing
- Fixed a layout issue where collapsing thought blocks in the terminal buffer now correctly releases reserved vertical space immediately. ([#8570](https://github.com/QwenLM/qwen-code/pull/8570)) by @chiga0
- Fixed timeout error handling to preserve underlying cause and HTTP status codes, ensuring retry policies function correctly for network failures. ([#8531](https://github.com/QwenLM/qwen-code/pull/8531)) by @zjunothing
- Separated internal hook context from user-visible transcript text to ensure clean display and accurate telemetry across all interfaces. ([#7948](https://github.com/QwenLM/qwen-code/pull/7948)) by @destire-mio
- Integration test cleanup now runs asynchronously and stops waiting immediately if telemetry fails to become ready, preventing hangs during test execution. ([#8688](https://github.com/QwenLM/qwen-code/pull/8688)) by @wenshao
- Review agent transcripts are now wrapped to prevent accidental execution of workflow commands found in logged file contents. ([#8683](https://github.com/QwenLM/qwen-code/pull/8683)) by @wenshao
- The resume session command is now echoed to the main terminal buffer on exit so it remains visible in scrollback when chat recording is enabled. ([#8455](https://github.com/QwenLM/qwen-code/pull/8455)) by @chiga0
- A persistent 'N queued' badge now appears in the Footer status row to indicate pending messages even when the main queue display is clipped during streaming. ([#8667](https://github.com/QwenLM/qwen-code/pull/8667)) by @qwen-code-dev-bot
- Pressing ESC once now immediately cancels ongoing agent work instead of requiring multiple presses to clear queued messages first. ([#8353](https://github.com/QwenLM/qwen-code/pull/8353)) by @C0d3N1nja97342
- The Alibaba Token Plan preset now uses the correct Singapore-region model ID 'deepseek-v4-flash-0731' to prevent HTTP 403 errors. ([#8705](https://github.com/QwenLM/qwen-code/pull/8705)) by @zjunothing
- Fixed a startup failure in the review workflow caused by exceeding GitHub's maximum expression length limit. ([#8720](https://github.com/QwenLM/qwen-code/pull/8720)) by @wenshao
- Fixed a security issue where explicitly distrusted workspaces were incorrectly inheriting trust from parent directories. ([#8628](https://github.com/QwenLM/qwen-code/pull/8628)) by @daleselaji-dev
- Fixed an issue where multi-line /review commands followed by a newline failed to trigger the review process. ([#8723](https://github.com/QwenLM/qwen-code/pull/8723)) by @wenshao
- Changed the autofix loop to enter Critical-only mode after five change rounds to prevent excessive automated modifications. ([#8751](https://github.com/QwenLM/qwen-code/pull/8751)) by @wenshao
- Prevents daemon sessions from inheriting loader-affecting environment variables like NODE_OPTIONS and LD_* that could interfere with subprocess execution. ([#8663](https://github.com/QwenLM/qwen-code/pull/8663)) by @wenshao
- Enables successful type checking for integration tests by fixing configuration errors and resolving previously undetected type issues. ([#8693](https://github.com/QwenLM/qwen-code/pull/8693)) by @doudouOUC

#### Performance

- Stopped restoring the large remote npm cache on self-hosted runners to improve performance, as the restore time exceeded the installation time saved. ([#8681](https://github.com/QwenLM/qwen-code/pull/8681)) by @wenshao
- Optimizes CI by running automatic reviews for documentation-only pull requests at medium effort while maintaining high effort for all other changes. ([#8648](https://github.com/QwenLM/qwen-code/pull/8648)) by @wenshao
- Improved /review performance by moving remote matching to a deterministic CLI subcommand and achieving up to 93.3% prompt cache hit rates. ([#8658](https://github.com/QwenLM/qwen-code/pull/8658)) by @wenshao
- Made autofix fleet caps tunable via repository variables and raised default limits to improve CI throughput without workflow edits. ([#8731](https://github.com/QwenLM/qwen-code/pull/8731)) by @wenshao
- Introduced a soft tool-call budget into review plans to optimize resource usage during finder and auditor operations. ([#8708](https://github.com/QwenLM/qwen-code/pull/8708)) by @wenshao

#### Documentation

- Documentation now covers the per-caller and workspace-wide concurrency settings for the qwen serve command, including defaults and accepted ranges. ([#8404](https://github.com/QwenLM/qwen-code/pull/8404)) by @DragonnZhang
- Added Aliyun Model Studio CLI (bailian-cli) to the Ecosystem section to support image generation, knowledge retrieval, and agent orchestration. ([#8710](https://github.com/QwenLM/qwen-code/pull/8710)) by @Maddock-MDF
- Clarified SDK documentation to confirm that reusable queries remain open for further prompts after an interruption, unless the session is explicitly closed. ([#8711](https://github.com/QwenLM/qwen-code/pull/8711)) by @DragonnZhang

#### Internal Changes

- Markdown parsing during message streaming is now throttled to 80ms intervals to prevent performance degradation while maintaining immediate updates when streaming stops. ([#7904](https://github.com/QwenLM/qwen-code/pull/7904)) by @PratikWayase

### New Contributors

- @daleselaji-dev made their first contribution in [#8501](https://github.com/QwenLM/qwen-code/pull/8501)
- @Maddock-MDF made their first contribution in [#8710](https://github.com/QwenLM/qwen-code/pull/8710)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.7...v0.21.8

## [0.21.7](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.7) - 2026-08-06

### Highlights

- Removed the 50-turn limit for Goals, allowing tasks to resume and continue beyond previous boundaries. ([#8421](https://github.com/QwenLM/qwen-code/pull/8421))
- Enabled rendering inline terminal images from model outputs in the interactive CLI for Kitty, Ghostty, and chafa. ([#8305](https://github.com/QwenLM/qwen-code/pull/8305))
- Introduced a declarative manifest and command to customize review plans with repository-specific context. ([#8401](https://github.com/QwenLM/qwen-code/pull/8401))
- Fixed Live Host release signing by normalizing certificate names to match Electron Builder expectations. ([#8579](https://github.com/QwenLM/qwen-code/pull/8579))
- Prevents silent hangs in GitHub-triggered review runs by capping the total lifetime of streaming responses. ([#8602](https://github.com/QwenLM/qwen-code/pull/8602))
- Allows managed deployments to route voice transcription through specific HTTP or private-network ASR gateways. ([#8350](https://github.com/QwenLM/qwen-code/pull/8350))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- Adds the security.allowedInsecureVoiceBaseUrls setting to allow managed deployments to route voice transcription through specific HTTP or private-network ASR gateways. ([#8350](https://github.com/QwenLM/qwen-code/pull/8350)) by @rockybot2026
- Enables rendering inline terminal images from model and tool outputs in the interactive CLI with support for Kitty, Ghostty, and chafa. ([#8305](https://github.com/QwenLM/qwen-code/pull/8305)) by @tlysanhuo
- Introduces a declarative .qwen/review-context.json manifest and the review repo-context command to customize review plans with repository-specific context. ([#8401](https://github.com/QwenLM/qwen-code/pull/8401)) by @wenshao
- Added observability for REST SSE connections with stable UUIDs and telemetry for stream lifecycle events including slow-client warnings and evictions. ([#8572](https://github.com/QwenLM/qwen-code/pull/8572)) by @doudouOUC

#### Bug Fixes

- Fixed the review CLI bundle to include the core package build output, ensuring verification checks run correctly in review phases. ([#8612](https://github.com/QwenLM/qwen-code/pull/8612)) by @wenshao
- Fixed Live Host release signing by normalizing the Developer ID certificate name to match Electron Builder expectations. ([#8579](https://github.com/QwenLM/qwen-code/pull/8579)) by @LaZzyMan
- Enhanced sandbox runtime selection to probe availability before use, providing clearer errors when no working runtime is found. ([#7734](https://github.com/QwenLM/qwen-code/pull/7734)) by @harjothkhara
- Fixed a race condition in autofix workflows by ensuring scan-and-pick runs execute within a single concurrency group. ([#8435](https://github.com/QwenLM/qwen-code/pull/8435)) by @wenshao
- Fixed file read permissions to resolve symbolic links before checking workspace boundaries, ensuring accurate access decisions. ([#8636](https://github.com/QwenLM/qwen-code/pull/8636)) by @doudouOUC
- Removed the fixed 50-continuation limit for Goals, allowing them to resume and continue beyond previous turn count boundaries. ([#8421](https://github.com/QwenLM/qwen-code/pull/8421)) by @qqqys
- Prevents silent hangs in GitHub-triggered /review runs by capping the total lifetime of streaming responses with the new QWEN_STREAM_MAX_LIFETIME_MS setting. ([#8602](https://github.com/QwenLM/qwen-code/pull/8602)) by @wenshao
- Updates the Web Shell sidebar branch chip immediately after a checkout to reflect the new branch name without waiting for the next poll. ([#8600](https://github.com/QwenLM/qwen-code/pull/8600)) by @wenshao
- Allows refreshing Web Shell session pages in the browser address bar without authentication errors while keeping API subpaths secured. ([#8445](https://github.com/QwenLM/qwen-code/pull/8445)) by @BZ-D
- Scopes artifact previews, downloads, and review reports to their owning workspace to prevent access issues after workspace changes. ([#8510](https://github.com/QwenLM/qwen-code/pull/8510)) by @zjunothing
- fix(cli): accept scope flags in /language ui <language> subcommands ([#8633](https://github.com/QwenLM/qwen-code/pull/8633)) by @yiliang114
- DingTalk tasks now use a single continuous status card for updates and final answers, preventing clutter and ensuring correct user mentions. ([#8565](https://github.com/QwenLM/qwen-code/pull/8565)) by @qqqys

#### Performance

- Reduces /review pipeline latency by removing unnecessary serial delays in the audit loop and verification steps. ([#8642](https://github.com/QwenLM/qwen-code/pull/8642)) by @wenshao

#### Documentation

- Added a design document for the legacy code audit skill which applies review machinery to existing merged code. ([#8397](https://github.com/QwenLM/qwen-code/pull/8397)) by @wenshao

#### Internal Changes

- Improved test reliability by using a dedicated empty directory for external-path glob tests to prevent timeouts on busy systems. ([#8604](https://github.com/QwenLM/qwen-code/pull/8604)) by @wenshao

### New Contributors

- @rockybot2026 made their first contribution in [#8350](https://github.com/QwenLM/qwen-code/pull/8350)
- @tlysanhuo made their first contribution in [#8305](https://github.com/QwenLM/qwen-code/pull/8305)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.6...v0.21.7

## [0.21.6](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.6) - 2026-08-05

### Highlights

- Added experimental native Live Voice support to WebShell on macOS for real-time audio interactions via a global shortcut. ([#7859](https://github.com/QwenLM/qwen-code/pull/7859))
- Web Shell now keeps conversation turns expanded during active background subagent tasks and allows immediate execution of read-only info commands. ([#8413](https://github.com/QwenLM/qwen-code/pull/8413), [#8496](https://github.com/QwenLM/qwen-code/pull/8496))
- Restored desktop app release capabilities by fixing macOS notarization and updating the Tauri signing key for valid release signatures. ([#8511](https://github.com/QwenLM/qwen-code/pull/8511), [#8518](https://github.com/QwenLM/qwen-code/pull/8518))
- Resolved DashScope API request failures for Qwen models by correcting conflicting reasoning parameters and honoring explicit opt-outs. ([#8488](https://github.com/QwenLM/qwen-code/pull/8488), [#8536](https://github.com/QwenLM/qwen-code/pull/8536))
- Improved autofix and review performance by optimizing bundle reuse, parallel context loading, and reverse audit pipelines for large pull requests. ([#8487](https://github.com/QwenLM/qwen-code/pull/8487), [#8548](https://github.com/QwenLM/qwen-code/pull/8548), [#8498](https://github.com/QwenLM/qwen-code/pull/8498))
- Fixed GitHub integration issues including paginated API handling for large PRs, credential reuse for Channels, and accurate version reporting. ([#8438](https://github.com/QwenLM/qwen-code/pull/8438), [#8461](https://github.com/QwenLM/qwen-code/pull/8461), [#8431](https://github.com/QwenLM/qwen-code/pull/8431))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- The Chrome extension alpha now includes daemon and browser-automation onboarding states, runtime MCP diagnostics, and an automated acceptance flow for real-Chrome testing. ([#6739](https://github.com/QwenLM/qwen-code/pull/6739)) by @yiliang114
- The record_artifact tool now explicitly guides users to register URLs for pull requests, issues, and comments as link artifacts for later access. ([#8453](https://github.com/QwenLM/qwen-code/pull/8453)) by @wenshao
- Bound web-shell plan approvals to specific Todo revisions to prevent stale snapshots from validating outdated plans. ([#8393](https://github.com/QwenLM/qwen-code/pull/8393)) by @yiliang114
- Added an optional external tool guard provider for managed serve deployments to enforce pre-execution allow/deny policies. ([#8125](https://github.com/QwenLM/qwen-code/pull/8125)) by @chiga0
- Added the qwen review cost-ledger command to aggregate model usage statistics from existing review records on disk. ([#8471](https://github.com/QwenLM/qwen-code/pull/8471)) by @wenshao
- Adds experimental native Live Voice support to WebShell on macOS, enabling real-time audio interactions via a dedicated global shortcut. ([#7859](https://github.com/QwenLM/qwen-code/pull/7859)) by @LaZzyMan
- GitHub Channels can now reuse the daemon host's existing gh auth login credentials when no personal access token is explicitly configured. ([#8461](https://github.com/QwenLM/qwen-code/pull/8461)) by @wenshao
- Read-only info commands like /stats, /about, and /context now execute immediately mid-turn in Web Shell instead of waiting for streaming to finish. ([#8496](https://github.com/QwenLM/qwen-code/pull/8496)) by @wenshao
- Review tests now cover the full reverse-dependency closure of code changes to catch behavioral regressions in dependent workspaces. ([#8490](https://github.com/QwenLM/qwen-code/pull/8490)) by @wenshao

#### Bug Fixes

- Web Shell now keeps conversation turns expanded while any background subagent remains active, preventing premature collapse during parallel tasks. ([#8413](https://github.com/QwenLM/qwen-code/pull/8413)) by @carffuca
- The desktop app updater now uses a newly rotated Tauri signing key to restore the ability to publish signed releases. ([#8511](https://github.com/QwenLM/qwen-code/pull/8511)) by @yiliang114
- Added a CSS rule to restore visible text selection highlights for message content in Firefox that were previously missing. ([#8417](https://github.com/QwenLM/qwen-code/pull/8417)) by @C0d3N1nja97342
- Fixed DashScope API requests for Qwen 3.8 models to prevent conflicting reasoning parameters that caused request rejections. ([#8488](https://github.com/QwenLM/qwen-code/pull/8488)) by @wenshao
- Prevented review jobs from timing out without reporting results by stopping the reverse-audit loop before the hard kill limit. ([#8468](https://github.com/QwenLM/qwen-code/pull/8468)) by @wenshao
- Fixed autofix workflows to correctly handle paginated GitHub API responses for PRs with over 100 comments or events. ([#8438](https://github.com/QwenLM/qwen-code/pull/8438)) by @wenshao
- Resolved DashScope thinking parameter conflicts by correctly honoring explicit opt-outs and preserving legacy budget settings. ([#8536](https://github.com/QwenLM/qwen-code/pull/8536)) by @wenshao
- Stabilized review test-efficacy tests to prevent failures caused by ambient vitest binaries in temporary directories. ([#8537](https://github.com/QwenLM/qwen-code/pull/8537)) by @wenshao
- Fixed macOS notarization failures by codesigning bundled ripgrep and Node.js binaries before the Tauri build. ([#8518](https://github.com/QwenLM/qwen-code/pull/8518)) by @yiliang114
- Enabled prompt cache reuse for chat compression with media-bearing histories to improve efficiency while maintaining safety fallbacks. ([#8419](https://github.com/QwenLM/qwen-code/pull/8419)) by @DragonnZhang
- Ensured qwen review submit consistently reports the startup CLI version in both inline comments and summary review bodies. ([#8431](https://github.com/QwenLM/qwen-code/pull/8431)) by @yiliang114
- Fixed line ending detection to analyze the entire file instead of a single slice, preventing silent CRLF-to-LF conversion errors. ([#8383](https://github.com/QwenLM/qwen-code/pull/8383)) by @doudouOUC
- Secured evidence image uploads by validating file content via magic bytes instead of relying solely on file extensions. ([#8459](https://github.com/QwenLM/qwen-code/pull/8459)) by @wenshao
- Prevents CI failures on reused runners by automatically cleaning up stale Git worktrees and branches left behind after cancelled or timed-out reviews. ([#8474](https://github.com/QwenLM/qwen-code/pull/8474)) by @yiliang114
- Fixes WebUI session recovery to correctly reconstruct complete conversation turns after live journal truncation events. ([#8414](https://github.com/QwenLM/qwen-code/pull/8414)) by @doudouOUC
- Prevents daemon crashes caused by missing lock files by logging warnings instead of throwing errors when lock compromises occur. ([#8442](https://github.com/QwenLM/qwen-code/pull/8442)) by @wenshao
- Fixes the Qwen Live Host release workflow to correctly reuse existing Apple signing secrets and generate ephemeral keychain passwords. ([#8574](https://github.com/QwenLM/qwen-code/pull/8574)) by @LaZzyMan
- Textual tool-result payloads in the CLI are now bounded to 65,536 bytes to prevent excessive output sizes in ACP transport. ([#8450](https://github.com/QwenLM/qwen-code/pull/8450)) by @doudouOUC

#### Performance

- Reduced review setup time by issuing independent context and rule loading calls in a single response instead of serially. ([#8487](https://github.com/QwenLM/qwen-code/pull/8487)) by @wenshao
- Optimized prompt cache retention by clearing old tool results to a low watermark instead of stopping just below the threshold. ([#8464](https://github.com/QwenLM/qwen-code/pull/8464)) by @doudouOUC
- Speeds up autofix reviews by building the CLI bundle once per scan and reusing it across all parallel review legs. ([#8548](https://github.com/QwenLM/qwen-code/pull/8548)) by @wenshao
- Improves reverse audit performance by retiring dry chunks and optimizing the pipeline verification loop for large pull requests. ([#8498](https://github.com/QwenLM/qwen-code/pull/8498)) by @wenshao

#### Documentation

- Documentation now covers the Goal v3 lifecycle for headless CLI runs, including state persistence, autonomous continuation limits, and streaming event handling. ([#8503](https://github.com/QwenLM/qwen-code/pull/8503)) by @DragonnZhang

#### Internal Changes

- Trusted fork PRs and no-checkout jobs now route to the ECS runner pool when the maintainer kill-switch allows, ensuring consistent Linux CI execution. ([#8502](https://github.com/QwenLM/qwen-code/pull/8502)) by @wenshao
- Moved detailed incident narratives from SKILL.md to DESIGN.md to reduce runtime context size while preserving rule justifications via references. ([#8499](https://github.com/QwenLM/qwen-code/pull/8499)) by @wenshao
- Updated CI tests to align timeout expectations with externalized repository variables for review workflows. ([#8485](https://github.com/QwenLM/qwen-code/pull/8485)) by @wenshao
- Updates the vendored CUA Driver to upstream version 0.17.0, adding support for typed browser automation and native menu operations. ([#8564](https://github.com/QwenLM/qwen-code/pull/8564)) by @LaZzyMan
- Windows merge queue tests now run on the validated ecs-win self-hosted runner by default to reduce reliance on hosted pools. ([#8386](https://github.com/QwenLM/qwen-code/pull/8386)) by @yiliang114
- The GitHub-triggered review workflow now optionally installs tmux and freeze tools to enable higher-fidelity evidence image capture. ([#8454](https://github.com/QwenLM/qwen-code/pull/8454)) by @wenshao

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.5...v0.21.6

## [0.21.5](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.5) - 2026-08-04

### Highlights

- Adds an opt-in one-time update bridge for macOS users to migrate from the Electron desktop app to the new Tauri shell. ([#8392](https://github.com/QwenLM/qwen-code/pull/8392))
- Introduces detailed execution-specific outcome tracking for tool calls to distinguish between invocation success, failure, and cancellation. ([#8180](https://github.com/QwenLM/qwen-code/pull/8180))
- Prevents unsafe replay of MCP tool calls after connection loss unless the tool is explicitly marked idempotent and the workspace is trusted. ([#8387](https://github.com/QwenLM/qwen-code/pull/8387))
- Stops infinite Goal mode retries after evidence catalog exhaustion by transitioning the Goal to a usage_limited state requiring user intervention. ([#8430](https://github.com/QwenLM/qwen-code/pull/8430))
- Introduces a structured, finding-centric view in Web Shell for review results, displaying severity, confidence, and suggested fixes. ([#8402](https://github.com/QwenLM/qwen-code/pull/8402))
- Prevents unexpected page scrolling when closing cell-value dialogs in enhanced Markdown tables while preserving keyboard focus. ([#8407](https://github.com/QwenLM/qwen-code/pull/8407))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- Adds an opt-in one-time update bridge for macOS users to migrate from the Electron desktop app to the new Tauri shell. ([#8392](https://github.com/QwenLM/qwen-code/pull/8392)) by @yiliang114
- Introduces detailed execution-specific outcome tracking for tool calls to distinguish between invocation success, failure, and cancellation. ([#8180](https://github.com/QwenLM/qwen-code/pull/8180)) by @doudouOUC
- Introduces a structured, finding-centric view in Web Shell for review results, displaying severity, confidence, and suggested fixes alongside durable reports. ([#8402](https://github.com/QwenLM/qwen-code/pull/8402)) by @wenshao
- Enables support for Qwen 3.8 reasoning effort levels by mapping existing effort flags to the provider-specific reasoning_effort parameter. ([#8472](https://github.com/QwenLM/qwen-code/pull/8472)) by @DragonnZhang

#### Bug Fixes

- Prevents unexpected page scrolling when closing cell-value dialogs in enhanced Markdown tables while preserving keyboard focus. ([#8407](https://github.com/QwenLM/qwen-code/pull/8407)) by @carffuca
- Clarifies write_file guidance to explicitly require reading a target file before writing when its existence or contents are unknown. ([#8428](https://github.com/QwenLM/qwen-code/pull/8428)) by @doudouOUC
- Fixes the Windows desktop release smoke test by reading logs from the correct LocalAppData path used by the Tauri runtime. ([#8381](https://github.com/QwenLM/qwen-code/pull/8381)) by @yiliang114
- Prevents unsafe replay of MCP tool calls after connection loss unless the tool is explicitly marked idempotent and the workspace is trusted. ([#8387](https://github.com/QwenLM/qwen-code/pull/8387)) by @doudouOUC
- Stops infinite Goal mode retries after evidence catalog exhaustion by transitioning the Goal to a usage_limited state requiring user intervention. ([#8430](https://github.com/QwenLM/qwen-code/pull/8430)) by @qqqys
- Prevents the review system from unnecessarily re-running agents for launches that were already successfully delivered, saving time and tokens. ([#8466](https://github.com/QwenLM/qwen-code/pull/8466)) by @wenshao
- Fixes a failing unit test for MCP reconnection to ensure it correctly validates safe replay policies with trusted server configurations. ([#8478](https://github.com/QwenLM/qwen-code/pull/8478)) by @wenshao
- Updates review workflow tests to correctly assert against externalized timeout variables, resolving failures in the Quality Checks job. ([#8486](https://github.com/QwenLM/qwen-code/pull/8486)) by @wenshao

#### Internal Changes

- Removes the broken legacy scheduled PR triage workflow that previously failed to sync labels due to incorrect issue reference parsing. ([#8434](https://github.com/QwenLM/qwen-code/pull/8434)) by @wenshao
- Reduces queue times for SDK Java tests by canceling stale runs on new commits and routing trusted Linux jobs to faster ECS runners. ([#8441](https://github.com/QwenLM/qwen-code/pull/8441)) by @yiliang114

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.4...v0.21.5

## [0.21.4](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.4) - 2026-08-03

### Highlights

- Web Shell is now a release-ready desktop app with native lifecycle management, single-instance behavior, and automatic updates. ([#8132](https://github.com/QwenLM/qwen-code/pull/8132))
- Web Shell history pagination now handles oversized turns gracefully and includes a retry button to reload failed pages without restarting sessions. ([#8335](https://github.com/QwenLM/qwen-code/pull/8335))
- Forked subagents are now isolated from sibling forks, ensuring each agent accesses only its own assigned instructions and directives. ([#8344](https://github.com/QwenLM/qwen-code/pull/8344))
- Chat compression now reuses the main conversation prompt cache on supported providers, reducing latency without executing tools. ([#8339](https://github.com/QwenLM/qwen-code/pull/8339))
- Fixed a Windows issue where pasting sensitive extension settings like API keys was ignored by enabling multi-character paste events. ([#8342](https://github.com/QwenLM/qwen-code/pull/8342))
- The /review skill now correctly follows the user's configured output language for Tip lines, saved reports, and review labels. ([#8370](https://github.com/QwenLM/qwen-code/pull/8370))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- The /summary command now accepts an optional path argument to save project summaries to custom locations, automatically creating parent directories if needed. ([#8116](https://github.com/QwenLM/qwen-code/pull/8116)) by @qwen-code-dev-bot
- Updated the review verifier to treat unverified findings as low-confidence confirmations rather than rejections, instructing it to check cited sources first. ([#8346](https://github.com/QwenLM/qwen-code/pull/8346)) by @wenshao
- Added the qwen review drive command to poll for service readiness and verify completion facts instead of relying on fixed sleep delays. ([#8349](https://github.com/QwenLM/qwen-code/pull/8349)) by @wenshao
- The daemon now resolves and reports its memory budget in /daemon/status to indicate proximity to exhaustion. ([#8245](https://github.com/QwenLM/qwen-code/pull/8245)) by @doudouOUC
- Added the qwen review mock-provider command to record OpenAI-compatible requests as JSONL for testing against a faithful outside world simulation. ([#8355](https://github.com/QwenLM/qwen-code/pull/8355)) by @wenshao
- The Web Shell is now packaged as a release-ready desktop app with native lifecycle management, single-instance behavior, and automatic updates. ([#8132](https://github.com/QwenLM/qwen-code/pull/8132)) by @yiliang114
- feat(serve): make sub-session concurrency caps configurable ([#8341](https://github.com/QwenLM/qwen-code/pull/8341)) by @wenshao
- Add a repo-hygiene skill and weekly workflow to automatically scan for and propose fixes for documentation and code quality issues. ([#7908](https://github.com/QwenLM/qwen-code/pull/7908)) by @ZijianZhang989
- Adjust the automated PR review timeout based on change size, allowing up to 240 minutes for large pull requests exceeding 300 lines. ([#8377](https://github.com/QwenLM/qwen-code/pull/8377)) by @wenshao
- Enable full Web Shell management for GitHub and GitLab channels, allowing users to configure tokens and policies without editing settings files. ([#8310](https://github.com/QwenLM/qwen-code/pull/8310)) by @OrbitZore
- Adds the qwen review publish-assets command to host evidence images in a user-designated repository for embedding in PR review comments. ([#8351](https://github.com/QwenLM/qwen-code/pull/8351)) by @wenshao
- Adds a built-in Java/JVM performance checklist to the review tool that flags correctness traps and JVM-cost defects in Java files. ([#8379](https://github.com/QwenLM/qwen-code/pull/8379)) by @wenshao
- feat(ci): expand code owner pool for packages/core ([#8347](https://github.com/QwenLM/qwen-code/pull/8347)) by @wenshao
- Introduced the experimental.sessionWorkflow setting to optionally enable Session Workflow features like Plan & Review mode and the Workflow DAG. ([#8391](https://github.com/QwenLM/qwen-code/pull/8391)) by @yiliang114
- Updated non-interactive CLI /goal commands to use the Goal v3 runtime, ensuring consistent state persistence and improved streaming behavior. ([#8324](https://github.com/QwenLM/qwen-code/pull/8324)) by @qqqys
- Added the memory.agentMaxTurns setting to configure turn limits for all managed memory agents, with 0 disabling the limit entirely. ([#8171](https://github.com/QwenLM/qwen-code/pull/8171)) by @tomatotomata

#### Bug Fixes

- Web Shell history pagination now proceeds even when a single turn exceeds the page budget, and a retry button allows reloading failed history pages without restarting the session. ([#8335](https://github.com/QwenLM/qwen-code/pull/8335)) by @wenshao
- The CI triage job now ensures the qwen CLI is installed before running actions to prevent redundant installations and fix fleet-wide failures on self-hosted runners. ([#8337](https://github.com/QwenLM/qwen-code/pull/8337)) by @yiliang114
- Mutation testing now correctly marks mutants as inconclusive instead of survived when their collocated tests failed in the unmutated baseline, preventing false positive findings. ([#8345](https://github.com/QwenLM/qwen-code/pull/8345)) by @wenshao
- Forked subagents can no longer see the directives of sibling forks launched in the same turn, ensuring each subagent only accesses its own assigned instructions. ([#8344](https://github.com/QwenLM/qwen-code/pull/8344)) by @harjothkhara
- Todo behavior outside Session Workflow views is restored to ensure agent association is opt-in and historical dependency references do not incorrectly mark plans as blocked. ([#8334](https://github.com/QwenLM/qwen-code/pull/8334)) by @yiliang114
- Fixed a flaky Java daemon test by accepting ERROR terminal states during session teardown races in addition to COMPLETE cancelled states. ([#8354](https://github.com/QwenLM/qwen-code/pull/8354)) by @wenshao
- Enabled chat compression to reuse the main conversation prompt cache when using supported providers, reducing latency without executing tools. ([#8339](https://github.com/QwenLM/qwen-code/pull/8339)) by @DragonnZhang
- Fixed an issue on Windows where pasting sensitive extension settings like API keys was ignored by allowing multi-character paste events. ([#8342](https://github.com/QwenLM/qwen-code/pull/8342)) by @DragonnZhang
- GitHub channel inbound tasks are now restart-safe, ensuring interrupted work is recovered and pending comments are retried without rerunning agents. ([#8306](https://github.com/QwenLM/qwen-code/pull/8306)) by @yiliang114
- Prevented malformed JSON tool responses with leaked protocol tags from reaching the UI by routing them through the existing retry path. ([#8301](https://github.com/QwenLM/qwen-code/pull/8301)) by @yiliang114
- Fix CI failures on older branches by correctly calculating PR file changes instead of comparing against the base branch history. ([#8372](https://github.com/QwenLM/qwen-code/pull/8372)) by @wenshao
- Ensure ECS runner fleets update automatically by triggering the reconciliation workflow whenever the updater logic changes on main. ([#8373](https://github.com/QwenLM/qwen-code/pull/8373)) by @yiliang114
- Ensure Tip lines, saved reports, and review labels in the /review skill correctly follow the user's configured output language. ([#8370](https://github.com/QwenLM/qwen-code/pull/8370)) by @wenshao
- Fixes qwen review run to correctly handle the QWEN_CODE_CLI environment variable when spawning child processes to ensure proper build stamping. ([#8378](https://github.com/QwenLM/qwen-code/pull/8378)) by @wenshao
- Enables recovery of long response streams interrupted by socket closures by distinguishing delivered output from internal reasoning steps. ([#7896](https://github.com/QwenLM/qwen-code/pull/7896)) by @LHMQ878
- Ensures Auto Recall hooks properly dispose of proxy dispatchers after retrieval completes to prevent resource leaks. ([#8352](https://github.com/QwenLM/qwen-code/pull/8352)) by @doudouOUC
- Updates review reports to clearly distinguish between tests that failed and tests that produced no results when excluding mutants due to pre-existing issues. ([#8374](https://github.com/QwenLM/qwen-code/pull/8374)) by @wenshao
- Downgrades findings to Suggestion severity when tests blamed on a pull request are confirmed to already fail on the merge base. ([#8380](https://github.com/QwenLM/qwen-code/pull/8380)) by @wenshao
- Fixed /review to deprioritize Maven generated test sources, preventing them from crowding out production Java paths in rule headings. ([#8405](https://github.com/QwenLM/qwen-code/pull/8405)) by @wenshao

#### Documentation

- docs: complete TUI keyboard shortcut reference ([#8327](https://github.com/QwenLM/qwen-code/pull/8327)) by @DragonnZhang
- Updated the architecture overview to reflect Qwen Code as a multi-surface monorepo, detailing CLI, ACP, and daemon execution models. ([#8325](https://github.com/QwenLM/qwen-code/pull/8325)) by @DragonnZhang
- Documentation now explains how to select models for chat compression and image generation, including defaults and provider requirements. ([#8348](https://github.com/QwenLM/qwen-code/pull/8348)) by @DragonnZhang
- Update agent documentation to include the drive and mock-provider commands and clarify how verification tests should be structured. ([#8369](https://github.com/QwenLM/qwen-code/pull/8369)) by @wenshao

#### Internal Changes

- ci: gate merges on deterministic no-AK E2E ([#8313](https://github.com/QwenLM/qwen-code/pull/8313)) by @yiliang114
- Made the SDK permission control end-to-end tests deterministic by scripting model responses while retaining real tool and CLI interactions. ([#8302](https://github.com/QwenLM/qwen-code/pull/8302)) by @yiliang114
- Automated ECS runner updates to the latest stable Qwen CLI version immediately after publish and prevented accidental downgrades to prerelease builds. ([#8343](https://github.com/QwenLM/qwen-code/pull/8343)) by @wenshao
- Fixed a flaky test in the extension manager that previously caused intermittent CI failures due to clock racing. ([#8362](https://github.com/QwenLM/qwen-code/pull/8362)) by @wenshao
- Fixed a drive test case on macOS by asserting a shell-invariant behavior instead of relying on specific bash version exit codes. ([#8366](https://github.com/QwenLM/qwen-code/pull/8366)) by @wenshao
- Improves the stability of acp-cron integration tests by selecting notifications based on source metadata instead of wall-clock timestamps. ([#8336](https://github.com/QwenLM/qwen-code/pull/8336)) by @qwen-code-dev-bot

### New Contributors

- @LHMQ878 made their first contribution in [#7896](https://github.com/QwenLM/qwen-code/pull/7896)
- @tomatotomata made their first contribution in [#8171](https://github.com/QwenLM/qwen-code/pull/8171)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.3...v0.21.4

## [0.21.3](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.3) - 2026-08-01

### Highlights

- Enhanced /review command with test plan validation, measured failure attribution, and new verification lenses to improve code change analysis. ([#8215](https://github.com/QwenLM/qwen-code/pull/8215), [#8218](https://github.com/QwenLM/qwen-code/pull/8218), [#8225](https://github.com/QwenLM/qwen-code/pull/8225), [#8261](https://github.com/QwenLM/qwen-code/pull/8261), [#8315](https://github.com/QwenLM/qwen-code/pull/8315))
- Added support for project-level named fork profiles to define tool allowlists and prompt hints via markdown configuration files. ([#8148](https://github.com/QwenLM/qwen-code/pull/8148))
- Enabled workflow agents to surface approval requests for shell commands and edits directly to the parent interface with background run support. ([#8240](https://github.com/QwenLM/qwen-code/pull/8240), [#8303](https://github.com/QwenLM/qwen-code/pull/8303))
- Fixed Anthropic API integration issues by sanitizing tool IDs, preventing duplicate result blocks, and ensuring correct message ordering. ([#8164](https://github.com/QwenLM/qwen-code/pull/8164), [#8165](https://github.com/QwenLM/qwen-code/pull/8165), [#8163](https://github.com/QwenLM/qwen-code/pull/8163), [#8040](https://github.com/QwenLM/qwen-code/pull/8040))
- Improved Web Shell usability with artifact downloads, fixed text pasting visibility, and resolved session recap context switching errors. ([#8234](https://github.com/QwenLM/qwen-code/pull/8234), [#8230](https://github.com/QwenLM/qwen-code/pull/8230), [#8262](https://github.com/QwenLM/qwen-code/pull/8262))
- Added native terminal image rendering via a new display_image tool and restored right-click menus with URL hyperlink handling. ([#8217](https://github.com/QwenLM/qwen-code/pull/8217), [#8198](https://github.com/QwenLM/qwen-code/pull/8198))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- Lifecycle hooks now include optional source_type and source_id fields to help platforms distinguish sessions created through different entry points. ([#8155](https://github.com/QwenLM/qwen-code/pull/8155)) by @xurik
- The review workflow now verifies cache identity consistency to prevent mismatches between cache writing and reading agents in GitHub Actions. ([#8205](https://github.com/QwenLM/qwen-code/pull/8205)) by @wenshao
- Daemon channel adapter state is now isolated by workspace to safely support persistent browser authentication across multiple workspaces. ([#8178](https://github.com/QwenLM/qwen-code/pull/8178)) by @qqqys
- Added the verify-capture.mjs script to generate evidence images for PR verification with a single command instead of a complex pipeline. ([#8114](https://github.com/QwenLM/qwen-code/pull/8114)) by @wenshao
- Added generationConfig.cacheRetention settings to support Anthropic's extended 1-hour prompt-cache tier alongside the default 5-minute retention. ([#8048](https://github.com/QwenLM/qwen-code/pull/8048)) by @netbrah
- The CI startup bundle check now fails if the CLI entry point is incorrectly hoisted into a shared chunk, preventing silent execution failures. ([#8203](https://github.com/QwenLM/qwen-code/pull/8203)) by @wenshao
- Adds a transient 👀 emoji to GitLab notes while the agent is working and removes it upon completion. ([#8119](https://github.com/QwenLM/qwen-code/pull/8119)) by @OrbitZore
- Normalizes tool-call telemetry data to ensure consistent status reporting and error classification across all consumers. ([#8176](https://github.com/QwenLM/qwen-code/pull/8176)) by @doudouOUC
- Added a SessionDelete hook event triggered after successfully deleting a historical session via /delete or ACP. ([#8059](https://github.com/QwenLM/qwen-code/pull/8059)) by @xurik
- Enabled POST /session to accept and validate a caller-supplied sessionId instead of silently ignoring it. ([#7836](https://github.com/QwenLM/qwen-code/pull/7836)) by @qwen-code-dev-bot
- Allow safe slash commands like /status, /settings, and /help to run immediately while model responses are streaming. ([#8130](https://github.com/QwenLM/qwen-code/pull/8130)) by @DragonnZhang
- Adds an optional host tool invocation guard that can deny execution before a tool runs, preventing calls when configured to do so. ([#8032](https://github.com/QwenLM/qwen-code/pull/8032)) by @chiga0
- Adds OpenTelemetry GenAI streaming attributes to LLM spans, recording time-to-first-chunk for streaming requests while removing the private stream attribute. ([#8150](https://github.com/QwenLM/qwen-code/pull/8150)) by @doudouOUC
- Running the /triage command on a pull request now triggers the sandboxed verify lane in parallel to start building and running tests immediately. ([#8249](https://github.com/QwenLM/qwen-code/pull/8249)) by @wenshao
- The daemon default maximum session limit per workspace has increased from 20 to 32 to better support heavy multi-session workflows. ([#8235](https://github.com/QwenLM/qwen-code/pull/8235)) by @wenshao
- The Web Shell transcript and review views now include a Download action for artifacts, allowing users to save HTML, Markdown, and workspace files locally. ([#8234](https://github.com/QwenLM/qwen-code/pull/8234)) by @ytahdn
- Forked Dream workers now respect an opt-in gate that prevents writing to or editing files in top-level pinned directories during scheduled cleanup and workspace operations. ([#7714](https://github.com/QwenLM/qwen-code/pull/7714)) by @destire-mio
- Added support for project-level named fork profiles that define tool allowlists and prompt hints via markdown files in the .qwen/fork-profiles directory. ([#8148](https://github.com/QwenLM/qwen-code/pull/8148)) by @destire-mio
- Adds the skills.disabledLevels setting to hide bundled, project, user, or extension skills without affecting host-provided skills. ([#8057](https://github.com/QwenLM/qwen-code/pull/8057)) by @zhangxy-zju
- Extends the /autofix skill to review and repair local working trees with explicit user confirmation while retaining existing GitHub Actions support. ([#8121](https://github.com/QwenLM/qwen-code/pull/8121)) by @yiliang114
- Enabled workflow agents to surface approval requests for shell commands and edits directly to the parent interface. ([#8240](https://github.com/QwenLM/qwen-code/pull/8240)) by @qqqys
- Enhanced the verify skill to measure suggested fixes and calibrate replay tests against live code mutations. ([#8242](https://github.com/QwenLM/qwen-code/pull/8242)) by @wenshao
- Auto-generated Skills are now tracked for usage, marked stale after 30 days of inactivity, and archived after 90 days via a new project-scoped curator. ([#7846](https://github.com/QwenLM/qwen-code/pull/7846)) by @DragonnZhang
- The /review command now validates Test Plan assertions in PR descriptions against the actual code changes and workspace state. ([#8215](https://github.com/QwenLM/qwen-code/pull/8215)) by @wenshao
- Updated verification rules to explicitly check acceptance criteria and distinguish between empty results and unmeasured states. ([#8295](https://github.com/QwenLM/qwen-code/pull/8295)) by @wenshao
- Added the foundational runtime supervisor for Agent View, enabling local session management and terminal stream bridging. ([#7799](https://github.com/QwenLM/qwen-code/pull/7799)) by @ZijianZhang989
- Review output footers now include the Qwen Code CLI version to help trace findings to specific releases. ([#8294](https://github.com/QwenLM/qwen-code/pull/8294)) by @wenshao
- Plain-text messages sent during an active turn now enter the running turn by default with visible queue management. ([#8229](https://github.com/QwenLM/qwen-code/pull/8229)) by @ytahdn
- Added a Session Workflow view that visualizes plan execution, agent calls, and transcripts as a dependency graph. ([#7580](https://github.com/QwenLM/qwen-code/pull/7580)) by @yiliang114
- Added the --compaction flag to the /model command to configure a dedicated model for chat compression. ([#7818](https://github.com/QwenLM/qwen-code/pull/7818)) by @Aleks-0
- Connected the interactive TUI to the Goal v3 runtime with new lifecycle commands, status cards, and improved input queuing. ([#8005](https://github.com/QwenLM/qwen-code/pull/8005)) by @qqqys
- Workflows now support an opt-in background run mode that returns a run ID and reports results via a dedicated channel. ([#8303](https://github.com/QwenLM/qwen-code/pull/8303)) by @qqqys
- Added measured test-failure attribution to /review to accurately distinguish new failures from pre-existing ones. ([#8218](https://github.com/QwenLM/qwen-code/pull/8218)) by @wenshao
- Added a display_image tool to the TUI that renders PNGs using native terminal features or chafa fallbacks with an 8 MiB limit. ([#8217](https://github.com/QwenLM/qwen-code/pull/8217)) by @DragonnZhang
- Enhanced the /review command with adjudication rendering, workflow step extraction, and three new verification lenses. ([#8225](https://github.com/QwenLM/qwen-code/pull/8225)) by @wenshao
- The /review command now borrows recall mechanics, a fix loop, and size-derived budgeting from Claude Code to improve finding surfacing and diff cost estimation. ([#8315](https://github.com/QwenLM/qwen-code/pull/8315)) by @wenshao
- Review round ledgers are now embedded in the posted review body to persist across environments and enable the default effort level to recover previous round data. ([#8255](https://github.com/QwenLM/qwen-code/pull/8255)) by @wenshao
- The review process now detects empty or collapsed diffs to stop early and recommends closing superseded branches while applying seven new verification lenses. ([#8261](https://github.com/QwenLM/qwen-code/pull/8261)) by @wenshao

#### Bug Fixes

- Fixed an issue preventing the Web Shell from creating scratch workspaces on loopback daemons when bearer authentication is not configured. ([#8204](https://github.com/QwenLM/qwen-code/pull/8204)) by @wenshao
- Updated setPermissionMode E2E tests to use the shared TEST_TIMEOUT constant, resolving intermittent timeouts on CI runners. ([#8135](https://github.com/QwenLM/qwen-code/pull/8135)) by @qwen-code-dev-bot
- GitHub channel final replies are now queued and retried on restart if GitHub definitely rejected the initial write due to rate limits. ([#8087](https://github.com/QwenLM/qwen-code/pull/8087)) by @yiliang114
- fix(core): Tolerate transcript timestamp drift ([#7886](https://github.com/QwenLM/qwen-code/pull/7886)) by @doudouOUC
- Added Ctrl+Tab and Ctrl+Shift+Tab as alternative shortcuts for switching @ completion tabs to avoid conflicts with terminal word-movement bindings. ([#8074](https://github.com/QwenLM/qwen-code/pull/8074)) by @qwen-code-dev-bot
- Added an uncaught exception handler to prevent silent crashes in VP mode by ensuring errors are logged and displayed on the terminal for debugging. ([#8088](https://github.com/QwenLM/qwen-code/pull/8088)) by @chiga0
- Fixed compactString to strictly respect character limits even when the truncation marker itself exceeds the specified budget. ([#7872](https://github.com/QwenLM/qwen-code/pull/7872)) by @chinesepowered
- Localized built-in agent type names in the Web Shell UI for Chinese users to prevent mixed-language display issues. ([#8209](https://github.com/QwenLM/qwen-code/pull/8209)) by @wenshao
- Fixed the release workflow to anchor notes correctly and cap the release body length to prevent GitHub API validation errors. ([#8199](https://github.com/QwenLM/qwen-code/pull/8199)) by @wenshao
- Fixes 400 errors for assistant-turn prefill and restores visible thinking output on Claude 4.6+ and 5.x models. ([#8040](https://github.com/QwenLM/qwen-code/pull/8040)) by @netbrah
- Ensures tool results appear before other content in user messages to prevent Anthropic API rejections. ([#8165](https://github.com/QwenLM/qwen-code/pull/8165)) by @netbrah
- Sanitizes tool IDs to meet Anthropic character requirements and prevents empty ID errors. ([#8164](https://github.com/QwenLM/qwen-code/pull/8164)) by @netbrah
- Fixes model selector dropdown truncation by adapting width to long model names and adding hover tooltips. ([#8220](https://github.com/QwenLM/qwen-code/pull/8220)) by @wenshao
- Stabilizes a flaky integration test for async SDK MCP tool handlers by asserting on deterministic tool results. ([#8223](https://github.com/QwenLM/qwen-code/pull/8223)) by @qwen-code-dev-bot
- Fixed a test isolation issue to ensure temporary directories for worktree symlink tests are unique per run and fully cleaned up. ([#8228](https://github.com/QwenLM/qwen-code/pull/8228)) by @wenshao
- Fixed memory usage display to correctly show units like MB or GB when rounded values reach the next boundary. ([#7871](https://github.com/QwenLM/qwen-code/pull/7871)) by @chinesepowered
- Prevented subagents from asking users interactive questions to avoid indefinite waiting during background tasks. ([#8219](https://github.com/QwenLM/qwen-code/pull/8219)) by @DragonnZhang
- Fixed command splitting to correctly treat the bare & operator as a command boundary for permission checks. ([#7864](https://github.com/QwenLM/qwen-code/pull/7864)) by @chinesepowered
- Added Option+V as a macOS shortcut for pasting clipboard images alongside the existing Ctrl+V binding. ([#8120](https://github.com/QwenLM/qwen-code/pull/8120)) by @qwen-code-dev-bot
- Fixes a bug where mouse wheel events could scroll the background viewport briefly while a dialog was opening. ([#8089](https://github.com/QwenLM/qwen-code/pull/8089)) by @kagura-agent
- Fixes a CI failure where conflicting color environment variables caused extra warning output that broke PNG capture tests. ([#8236](https://github.com/QwenLM/qwen-code/pull/8236)) by @ytahdn
- Adds workspace-qualified memory operations and a new CLI option to isolate managed project memory by selected workspace. ([#8056](https://github.com/QwenLM/qwen-code/pull/8056)) by @qqqys
- Fixes the Web Shell to ensure pasted plain text remains fully visible and editable in the composer regardless of length. ([#8230](https://github.com/QwenLM/qwen-code/pull/8230)) by @ytahdn
- Qwen Autofix now resolves review threads only when tied to a verified commit, preventing resolution if the PR head changes or results are ambiguous. ([#8231](https://github.com/QwenLM/qwen-code/pull/8231)) by @wenshao
- Autofix now allows up to ten rounds of suggestion-level changes before restricting further edits to critical findings, failed checks, or base conflicts. ([#8247](https://github.com/QwenLM/qwen-code/pull/8247)) by @wenshao
- The system now recovers XML-style tool calls embedded in plain text model responses, preventing agent loops from breaking during long sessions. ([#8037](https://github.com/QwenLM/qwen-code/pull/8037)) by @qwen-code-dev-bot
- Upgraded external-context dependencies to MCP SDK 1.30.0 and patched Hono versions to resolve security advisories while maintaining Node 18 compatibility for mobile packages. ([#8206](https://github.com/QwenLM/qwen-code/pull/8206)) by @doudouOUC
- Fixed an issue where duplicate tool result blocks sharing the same ID caused Anthropic API requests to fail with a 400 error by ensuring only the first result is retained. ([#8163](https://github.com/QwenLM/qwen-code/pull/8163)) by @netbrah
- Background task polling in web-shell now silently handles transient network failures to prevent repetitive error notices while still reporting persistent hard failures. ([#7923](https://github.com/QwenLM/qwen-code/pull/7923)) by @han-dreamer
- Channel ACP bridges now automatically recover after long host sleep periods or event-loop stalls without requiring a full messaging adapter reconnection. ([#8211](https://github.com/QwenLM/qwen-code/pull/8211)) by @yiliang114
- Fixed an issue where raw SGR mouse escape sequences appeared in the input box at startup by correctly filtering them during early input capture. ([#8268](https://github.com/QwenLM/qwen-code/pull/8268)) by @qwen-code-dev-bot
- Stabilizes the thinking block height to prevent layout shifts and replaces the full-screen transcript overlay with an inline Ctrl+O toggle. ([#8077](https://github.com/QwenLM/qwen-code/pull/8077)) by @chiga0
- Completes image @ reference routing across TUI, ACP, and non-interactive CLI entry points with consistent security validation. ([#7206](https://github.com/QwenLM/qwen-code/pull/7206)) by @yiliang114
- Fixes flaky ACP cron integration tests by using QWEN_CODE_TEST_CRON_FAST to trigger jobs after a 5-second delay instead of waiting for real time. ([#8243](https://github.com/QwenLM/qwen-code/pull/8243)) by @qwen-code-dev-bot
- Prevents stale thinking blocks from appearing by removing them when their associated tool calls are orphaned or contain empty text. ([#8166](https://github.com/QwenLM/qwen-code/pull/8166)) by @netbrah
- Compacts the advanced table toolbar in narrow message areas by hiding labels and statistics while keeping essential actions visible. ([#8264](https://github.com/QwenLM/qwen-code/pull/8264)) by @ytahdn
- Fixes the mobile composer display after resuming by removing broken WebGL overlays and limiting animated placeholders to new sessions. ([#8263](https://github.com/QwenLM/qwen-code/pull/8263)) by @ytahdn
- Fixed test suite failures on Windows by handling path separators, line endings, and temporary directories correctly. ([#8050](https://github.com/QwenLM/qwen-code/pull/8050)) by @yiliang114
- Rendered verification reports as formatted Markdown instead of escaped raw text to improve readability in comments. ([#8147](https://github.com/QwenLM/qwen-code/pull/8147)) by @wenshao
- Prevented automatic session recaps from appearing in the wrong Web Shell session when switching contexts rapidly. ([#8262](https://github.com/QwenLM/qwen-code/pull/8262)) by @wenshao
- Corrected re-run summary messages to accurately describe existing bot reviews that deferred without voting. ([#8273](https://github.com/QwenLM/qwen-code/pull/8273)) by @wenshao
- Fixed self-hosted runner failures caused by file permission errors left behind by previous containerized jobs. ([#8115](https://github.com/QwenLM/qwen-code/pull/8115)) by @qwen-code-dev-bot
- Fixed an issue in the Web Shell where duplicate permission buttons with identical labels appeared in the approval dialog. ([#8250](https://github.com/QwenLM/qwen-code/pull/8250)) by @qwen-code-dev-bot
- Fixed the notices generator to correctly include license text for packages installed at multiple distinct versions within the dependency tree. ([#8272](https://github.com/QwenLM/qwen-code/pull/8272)) by @yiliang114
- QQ Bot group messages now display the full sender openid in prompts when mention support is enabled to improve model context. ([#8233](https://github.com/QwenLM/qwen-code/pull/8233)) by @Eric-GoodBoy-Tech
- Fixed AutoFix timeouts by explicitly setting the primary agent budget to align with the enclosing step's time limits. ([#8257](https://github.com/QwenLM/qwen-code/pull/8257)) by @wenshao
- Restored right-click menus and URL clicks by adding the ui.mouseTracking setting and implementing application-level hyperlink handling. ([#8198](https://github.com/QwenLM/qwen-code/pull/8198)) by @qwen-code-dev-bot
- Replaced hard truncation for long tool outputs with a collapsible view that preserves full content and improves scrolling. ([#8251](https://github.com/QwenLM/qwen-code/pull/8251)) by @destire-mio

#### Performance

- File search crawling is now faster by caching directory ignore lookups to avoid redundant checks for sibling files. ([#8253](https://github.com/QwenLM/qwen-code/pull/8253)) by @dexhunter

#### Documentation

- Adds a runnable Python example demonstrating how to implement an external judgment service for PreToolUse HTTP hooks. ([#8202](https://github.com/QwenLM/qwen-code/pull/8202)) by @babyblueviper1
- Reorganized Web Shell design documents into a dedicated directory to improve navigation and naming consistency. ([#8304](https://github.com/QwenLM/qwen-code/pull/8304)) by @water-in-stone
- Documentation now covers the /learn command, Skill discovery sources, and clarifies that personal and project Skill edits hot-reload without restarting unless in bare mode. ([#8298](https://github.com/QwenLM/qwen-code/pull/8298)) by @DragonnZhang

#### Internal Changes

- Simplified plugin manager button labels in the Web Shell to Add, Upload, and Create for a more concise interface in English and Chinese. ([#8174](https://github.com/QwenLM/qwen-code/pull/8174)) by @ytahdn
- Refactors internal workflow execution ownership to improve session management and cancellation handling. ([#8140](https://github.com/QwenLM/qwen-code/pull/8140)) by @qqqys
- Migrates the acp-cron integration test to use a fake OpenAI server for deterministic responses and isolates agent home directories. ([#8082](https://github.com/QwenLM/qwen-code/pull/8082)) by @qwen-code-dev-bot
- Subagent execution E2E tests now inherit the suite's default timeout instead of a restrictive 60-second limit, preventing failures during multi-turn model workflows. ([#8246](https://github.com/QwenLM/qwen-code/pull/8246)) by @qwen-code-dev-bot
- Two flaky SDK E2E cases relying on specific live model tool choices have been skipped to stabilize the main branch test suite. ([#8259](https://github.com/QwenLM/qwen-code/pull/8259)) by @qwen-code-dev-bot
- No user-facing changes in this release. ([#7967](https://github.com/QwenLM/qwen-code/pull/7967)) by @doudouOUC
- No user-facing changes; this release refactors internal CLI dependencies to improve code organization. ([#8141](https://github.com/QwenLM/qwen-code/pull/8141)) by @yiliang114
- Fixed a flaky E2E test for abort signals in tool permission callbacks to ensure deterministic execution. ([#8300](https://github.com/QwenLM/qwen-code/pull/8300)) by @qwen-code-dev-bot
- Fixed a test harness argument order to correctly pass the locale parameter, resolving failing Chinese localization checks. ([#8314](https://github.com/QwenLM/qwen-code/pull/8314)) by @yiliang114
- Fixed a silent startup failure for the ACP process when the extension is loaded from a symlinked directory. ([#8309](https://github.com/QwenLM/qwen-code/pull/8309)) by @Wchoi189
- SDK orchestration end-to-end tests are now deterministic by using scripted local responses, reducing test cases from 22 to 8 while maintaining core coverage. ([#8312](https://github.com/QwenLM/qwen-code/pull/8312)) by @yiliang114

### New Contributors

- @babyblueviper1 made their first contribution in [#8202](https://github.com/QwenLM/qwen-code/pull/8202)
- @Wchoi189 made their first contribution in [#8309](https://github.com/QwenLM/qwen-code/pull/8309)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.2...v0.21.3

## [0.21.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.2) - 2026-07-31

### Highlights

- Autofix now defers lower-severity suggestions after five rounds and posts visible notices when refusing to proceed due to round limits. ([#7913](https://github.com/QwenLM/qwen-code/pull/7913), [#8067](https://github.com/QwenLM/qwen-code/pull/8067))
- Added an opt-in Auto Recall profile that automatically searches external context with built-in security limits. ([#7877](https://github.com/QwenLM/qwen-code/pull/7877))
- Enhanced the /verify command with increased time budgets, evidence screenshots, and new maintainer verification techniques. ([#8010](https://github.com/QwenLM/qwen-code/pull/8010), [#8014](https://github.com/QwenLM/qwen-code/pull/8014), [#8016](https://github.com/QwenLM/qwen-code/pull/8016))
- Web Shell now supports contextual task panels, theme-aware visuals, and correctly handles artifact previews and session states. ([#7929](https://github.com/QwenLM/qwen-code/pull/7929), [#8098](https://github.com/QwenLM/qwen-code/pull/8098), [#8078](https://github.com/QwenLM/qwen-code/pull/8078), [#8106](https://github.com/QwenLM/qwen-code/pull/8106))
- GitHub channels now emit exactly one final comment per event and display eyes reactions to indicate active agent processing. ([#8033](https://github.com/QwenLM/qwen-code/pull/8033), [#8061](https://github.com/QwenLM/qwen-code/pull/8061))
- Added APIs and UI controls to view, approve, and revoke channel pairing approvals within specific workspaces. ([#8045](https://github.com/QwenLM/qwen-code/pull/8045), [#8081](https://github.com/QwenLM/qwen-code/pull/8081))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- Autofix now defers lower-severity suggestions after five change rounds, allowing only critical findings and failed checks to drive further code modifications. ([#7913](https://github.com/QwenLM/qwen-code/pull/7913)) by @qqqys
- Goal v3 is now connected to the turn engine with deterministic permit handling, ensuring runtime continuations do not consume session or recursive turn budgets. ([#7895](https://github.com/QwenLM/qwen-code/pull/7895)) by @qqqys
- Static image reads now return a canonical, auto-oriented JPEG overview with source dimensions to support reliable zooming within shared resource budgets. ([#7911](https://github.com/QwenLM/qwen-code/pull/7911)) by @qqqys
- The triage system now mechanically triggers the 2b-bis sandboxed-lane recommendation when a Stage 2 draft explicitly contains a not-verified sentence. ([#7965](https://github.com/QwenLM/qwen-code/pull/7965)) by @wenshao
- Adds an opt-in Auto Recall profile that automatically searches external context when you submit a prompt, with built-in security limits. ([#7877](https://github.com/QwenLM/qwen-code/pull/7877)) by @doudouOUC
- Updates WebShell to use a shared renderer for streaming charts, ensuring canonical markdown-chart blocks work without extra host configuration. ([#7916](https://github.com/QwenLM/qwen-code/pull/7916)) by @zhangxy-zju
- Improves ripgrep reliability by retrying failed searches and correctly distinguishing between no matches found and incomplete search results. ([#7888](https://github.com/QwenLM/qwen-code/pull/7888)) by @water-in-stone
- feat(channels): add DingTalk interactive cards ([#6930](https://github.com/QwenLM/qwen-code/pull/6930)) by @BenGuanRan
- feat(web-shell): refine advanced table controls ([#7999](https://github.com/QwenLM/qwen-code/pull/7999)) by @ytahdn
- Updated triage comments to lead with a clear pass or fail verdict and display English by default with Chinese translations folded. ([#7974](https://github.com/QwenLM/qwen-code/pull/7974)) by @wenshao
- feat(triage): run external /verify on ECS behind a workspace wipe ([#7985](https://github.com/QwenLM/qwen-code/pull/7985)) by @wenshao
- Added the security.allowPrivateNetworkHooks setting to allow HTTP hooks to access private network addresses in trusted platform-managed environments. ([#7968](https://github.com/QwenLM/qwen-code/pull/7968)) by @xurik
- Added a customizable action slot to split pane headers that automatically overflows into a menu when space is limited. ([#7808](https://github.com/QwenLM/qwen-code/pull/7808)) by @samuelhsin
- Added a GitLab polling channel adapter that converts GitLab todos into inbound messages for automated processing. ([#7862](https://github.com/QwenLM/qwen-code/pull/7862)) by @OrbitZore
- Added APIs and SDK helpers to list approved pairing senders and revoke access within a specific workspace. ([#8045](https://github.com/QwenLM/qwen-code/pull/8045)) by @qqqys
- Introduced an optional reasonFilter setting for GitHub channels to skip unwanted notification reasons and prevent unintended agent actions. ([#8031](https://github.com/QwenLM/qwen-code/pull/8031)) by @xianjianlf2
- Review approvals with zero findings on non-trivial diffs now explicitly disclose low signal status in the verdict line. ([#7987](https://github.com/QwenLM/qwen-code/pull/7987)) by @wenshao
- Added a threshold setting to automatically preload deferred tools into the context window when their total size fits within limits. ([#7922](https://github.com/QwenLM/qwen-code/pull/7922)) by @DragonnZhang
- feat(review): add `review run` — headless review with a machine-readable verdict ([#7983](https://github.com/QwenLM/qwen-code/pull/7983)) by @wenshao
- Enhanced the verify-pr skill with seven new techniques from maintainer verification rounds to improve change validation. ([#8010](https://github.com/QwenLM/qwen-code/pull/8010)) by @wenshao
- Increased the /verify agent budget from 25 to 120 minutes to allow comprehensive verification matching local maintainer rounds. ([#8014](https://github.com/QwenLM/qwen-code/pull/8014)) by @wenshao
- Added automatic milestone summaries every tenth takeover round to provide visibility into long-running fix attempts. ([#8046](https://github.com/QwenLM/qwen-code/pull/8046)) by @wenshao
- Adds a temporary eyes reaction to GitHub issues and comments while an agent turn is running to indicate active processing. ([#8061](https://github.com/QwenLM/qwen-code/pull/8061)) by @yiliang114
- Reduces scan delays by skipping inspection of idle autofix candidates to prioritize fresh engagements. ([#8049](https://github.com/QwenLM/qwen-code/pull/8049)) by @wenshao
- The /verify command now successfully captures and includes evidence screenshots in its reports. ([#8016](https://github.com/QwenLM/qwen-code/pull/8016)) by @wenshao
- Ensures maintainer feedback containing specific phrases is not deferred in Critical-only mode by implementing a per-source feedback budget. ([#8071](https://github.com/QwenLM/qwen-code/pull/8071)) by @wenshao
- Tags UserPromptSubmit hook context in model requests and records display provenance to ensure session replays accurately reflect what the model saw. ([#7956](https://github.com/QwenLM/qwen-code/pull/7956)) by @zjgzx1988
- Adds byte-cursor paging to large text file reads across HTTP, ACP, and SDK surfaces to efficiently retrieve subsequent content without rescanning. ([#8002](https://github.com/QwenLM/qwen-code/pull/8002)) by @doudouOUC
- The qwen review test-efficacy command now detects unprotected safety statements using statement-level mutation probes that delete single lines to verify test coverage. ([#8020](https://github.com/QwenLM/qwen-code/pull/8020)) by @wenshao
- feat(web-shell): add contextual task panels ([#7929](https://github.com/QwenLM/qwen-code/pull/7929)) by @ytahdn
- Subagents using the fork type now support an optional fork_tools allowlist to restrict execution to specific canonical tool names or MCP server patterns. ([#8066](https://github.com/QwenLM/qwen-code/pull/8066)) by @destire-mio
- The Channel editor now allows operators to view, approve, and revoke pairing approvals with explicit confirmation dialogs distinct from the configured allowlist. ([#8081](https://github.com/QwenLM/qwen-code/pull/8081)) by @qqqys
- Enhanced Web Shell visuals with theme-aware composer highlights, interactive dot animations for empty sessions, and a new typewriter effect for placeholders. ([#8098](https://github.com/QwenLM/qwen-code/pull/8098)) by @ytahdn

#### Bug Fixes

- Interactive end-to-end tests now scale read-then-write waits with the environment timeout instead of using a fixed 15-second limit to prevent flakiness. ([#7943](https://github.com/QwenLM/qwen-code/pull/7943)) by @qwen-code-dev-bot
- CI now cleans stale .qwen/ directories before checkout to prevent permission denied errors caused by restrictive file modes left by previous jobs. ([#7977](https://github.com/QwenLM/qwen-code/pull/7977)) by @qwen-code-dev-bot
- CI verify jobs now correctly restore write permissions on the .qwen tree before returning workspace ownership to prevent checkout failures on self-hosted runners. ([#7992](https://github.com/QwenLM/qwen-code/pull/7992)) by @yiliang114
- Fixes an issue where ECS runners on specific hosts failed to update the Qwen binary to the requested version. ([#8000](https://github.com/QwenLM/qwen-code/pull/8000)) by @yiliang114
- Fixes directory listing to clearly distinguish between folders that are empty and those that were skipped due to item budget limits. ([#7868](https://github.com/QwenLM/qwen-code/pull/7868)) by @chinesepowered
- Fixes a bug where code blocks in Feishu messages could exceed size limits by incorrectly calculating space needed for closing fences. ([#7850](https://github.com/QwenLM/qwen-code/pull/7850)) by @chinesepowered
- Ensures standalone WebShell URLs preserve authentication tokens and deployment base paths when navigating between sessions. ([#7926](https://github.com/QwenLM/qwen-code/pull/7926)) by @ytahdn
- fix(web-shell): polish Channel pairing requests ([#7997](https://github.com/QwenLM/qwen-code/pull/7997)) by @qqqys
- fix(cli): correct hardware cursor off-by-one in fullscreen mode ([#7998](https://github.com/QwenLM/qwen-code/pull/7998)) by @chiga0
- fix(cli): prevent SGR mouse events from being swallowed as paste on Windows ([#7988](https://github.com/QwenLM/qwen-code/pull/7988)) by @chiga0
- fix(serve): allow bounded reads of large text files ([#7947](https://github.com/QwenLM/qwen-code/pull/7947)) by @doudouOUC
- fix(web-shell): prefer artifact type metadata in cards ([#7973](https://github.com/QwenLM/qwen-code/pull/7973)) by @ytahdn
- fix(web-shell): reduce composer input latency ([#8015](https://github.com/QwenLM/qwen-code/pull/8015)) by @ytahdn
- Fixed session history pagination to prevent failures when loading earlier records by using stable record boundaries instead of opaque cursors. ([#8001](https://github.com/QwenLM/qwen-code/pull/8001)) by @ytahdn
- Fixed release note generation to correctly handle cases where the previous release tag diverges from the current release target. ([#7970](https://github.com/QwenLM/qwen-code/pull/7970)) by @qwen-code-dev-bot
- Increased the browser daemon SDK bundle size budget to 177KB to accommodate recent feature additions and restore successful builds. ([#8024](https://github.com/QwenLM/qwen-code/pull/8024)) by @wenshao
- Fixed keyboard handling in Kitty protocol terminals to correctly map the Command or Super key modifier to the meta flag for shortcuts. ([#7996](https://github.com/QwenLM/qwen-code/pull/7996)) by @chiga0
- Improved diagnostic messages to distinguish between a missing channel worker and a worker that is intentionally draining during workspace reloads. ([#7932](https://github.com/QwenLM/qwen-code/pull/7932)) by @destire-mio
- Added preflight disk space checks to the build-test command to prevent installation and build failures caused by insufficient storage. ([#7986](https://github.com/QwenLM/qwen-code/pull/7986)) by @wenshao
- Fixed Ctrl+Shift+C to correctly copy text in the terminal instead of triggering quit or clear actions. ([#8011](https://github.com/QwenLM/qwen-code/pull/8011)) by @chiga0
- Artifact file writes are now automatically recorded upon success, eliminating the need for a separate manual registration step. ([#7914](https://github.com/QwenLM/qwen-code/pull/7914)) by @chiga0
- Fixed an issue where pressing Enter during MCP prompt completion incorrectly treated optional parameters as mandatory. ([#7995](https://github.com/QwenLM/qwen-code/pull/7995)) by @qwen-code-dev-bot
- Disabled native cron jobs in daemon-managed Channel sessions to ensure scheduled tasks are correctly tracked and delivered. ([#8034](https://github.com/QwenLM/qwen-code/pull/8034)) by @qqqys
- GitHub channels now fail startup with guidance if configured with a self-only operator allowlist that cannot receive usable notifications. ([#8055](https://github.com/QwenLM/qwen-code/pull/8055)) by @zjunothing
- Removed a schema combinator from the send_message tool to fix compatibility with Anthropic models that previously rejected the request. ([#7989](https://github.com/QwenLM/qwen-code/pull/7989)) by @netbrah
- Fixed a terminal resize issue that caused excessive scrolling and history re-rendering during panel toggle animations. ([#8009](https://github.com/QwenLM/qwen-code/pull/8009)) by @chiga0
- Forked background agents now correctly refresh tool capabilities and system instructions when resumed while preserving conversation history. ([#7927](https://github.com/QwenLM/qwen-code/pull/7927)) by @DragonnZhang
- GitHub channel publications now emit exactly one final comment per event, preventing duplicate or intermediate outputs while recording detailed audit metadata for every attempt. ([#8033](https://github.com/QwenLM/qwen-code/pull/8033)) by @yiliang114
- The review-pr job now restores workspace ownership before checkout to prevent permission denied errors on reused self-hosted runners. ([#8062](https://github.com/QwenLM/qwen-code/pull/8062)) by @yiliang114
- Preview version generation now detects existing stable releases and bumps the patch number to prevent npm publishing conflicts for channel packages. ([#7978](https://github.com/QwenLM/qwen-code/pull/7978)) by @yiliang114
- Daemon-managed session writers now use an integrity-protected handoff protocol with sealed locks to ensure safe ownership transfer during managed shutdowns. ([#7976](https://github.com/QwenLM/qwen-code/pull/7976)) by @doudouOUC
- Transport stream retries are now allowed during the thinking-only phase by distinguishing non-thought content chunks from intermediate processing steps. ([#7938](https://github.com/QwenLM/qwen-code/pull/7938)) by @ComplexSimply
- The reasonFilter setting now validates input arrays, rejects unknown reasons, and treats empty arrays as unset to ensure reliable notification routing. ([#8035](https://github.com/QwenLM/qwen-code/pull/8035)) by @yiliang114
- Fixed an issue where CJK-heavy text could cause output token limits to be exceeded, preventing API errors during generation. ([#7963](https://github.com/QwenLM/qwen-code/pull/7963)) by @zambalee
- Ensured active Todo lists persist correctly across tool turns to maintain context without interfering with user input priority. ([#7919](https://github.com/QwenLM/qwen-code/pull/7919)) by @yiliang114
- Fixed environment variable propagation to ensure skill subprocesses use the correct CLI build and model configuration. ([#7993](https://github.com/QwenLM/qwen-code/pull/7993)) by @wenshao
- Fixed the autofix loop to properly count timeouts toward failure limits and corrected status messages during handoffs. ([#8044](https://github.com/QwenLM/qwen-code/pull/8044)) by @wenshao
- Fixes takeover acknowledgments by posting confirmations directly from the command to prevent event loss and long delays. ([#8043](https://github.com/QwenLM/qwen-code/pull/8043)) by @wenshao
- Stabilizes web shell table controls by fixing column sizing, frozen-column shadows, and scroll position during row expansion. ([#8041](https://github.com/QwenLM/qwen-code/pull/8041)) by @ytahdn
- Makes the interactive read-then-write integration test deterministic by using a fake server instead of a live LLM. ([#8064](https://github.com/QwenLM/qwen-code/pull/8064)) by @qwen-code-dev-bot
- Adds a visible Queued on server status in the web shell for messages waiting in the daemon queue before execution. ([#8065](https://github.com/QwenLM/qwen-code/pull/8065)) by @wenshao
- Fixes web shell artifact previews by enabling scripts in sandboxed iframes and correctly handling binary image files. ([#8078](https://github.com/QwenLM/qwen-code/pull/8078)) by @ytahdn
- Optimized the Comment Attachment Guard to skip unnecessary runner allocation, reducing queue congestion for hosted jobs. ([#8095](https://github.com/QwenLM/qwen-code/pull/8095)) by @wenshao
- Web Shell now correctly translates legacy /skills invocations with arguments into direct skill commands. ([#8103](https://github.com/QwenLM/qwen-code/pull/8103)) by @ytahdn
- Updated the verify-pr agent to account for evidence capture costs within its execution budget to ensure images are generated. ([#8104](https://github.com/QwenLM/qwen-code/pull/8104)) by @wenshao
- Web Shell now displays a clear failure status and Retry action for prompts that fail before daemon admission. ([#8106](https://github.com/QwenLM/qwen-code/pull/8106)) by @ytahdn
- Added retry capability and in-progress states to Web Shell question submissions to prevent silent failures. ([#8096](https://github.com/QwenLM/qwen-code/pull/8096)) by @ytahdn
- Fixed Web Shell to correctly distinguish and label one-time tool approvals that also switch the session to Default mode. ([#8099](https://github.com/QwenLM/qwen-code/pull/8099)) by @ytahdn
- Autofix now posts visible notices to PRs when refusing to proceed due to round-cap limits instead of logging only. ([#8067](https://github.com/QwenLM/qwen-code/pull/8067)) by @wenshao
- Prevents loss of verified autofix results by merging concurrent pushes and retrying when the PR head moves during a long agent run. ([#8042](https://github.com/QwenLM/qwen-code/pull/8042)) by @wenshao
- Properly aborts active dynamic workflow runs during session shutdown to prevent orphaned dispatches and unnecessary token usage. ([#8107](https://github.com/QwenLM/qwen-code/pull/8107)) by @qqqys
- Stabilizes the setModel E2E test by detecting turn completion via result messages instead of counting assistant messages. ([#8075](https://github.com/QwenLM/qwen-code/pull/8075)) by @qwen-code-dev-bot
- Increases the per-turn model response timeout in multi-model E2E tests from 30s to 60s to reduce flakiness on CI. ([#8111](https://github.com/QwenLM/qwen-code/pull/8111)) by @qwen-code-dev-bot
- Prevents repeated workspace skill rescans by making status reads side-effect free and implementing generation-guarded caching with ETag support. ([#8080](https://github.com/QwenLM/qwen-code/pull/8080)) by @doudouOUC
- Daemon session maintenance now uses a writer-lease protocol to isolate transcript updates and prevent conflicts during session deletion, archiving, and cleanup operations. ([#7975](https://github.com/QwenLM/qwen-code/pull/7975)) by @doudouOUC
- Fixed a build failure by routing side-task rollback operations through the workspace session service to resolve an unbound identifier introduced by recent maintenance changes. ([#8144](https://github.com/QwenLM/qwen-code/pull/8144)) by @wenshao
- Web Shell worktree sessions now consistently execute commands in the session's effective working directory and defer MCP discovery until trusted relocation completes. ([#8068](https://github.com/QwenLM/qwen-code/pull/8068)) by @wenshao
- Permission-control E2E tests now use shared response timeouts to prevent false failures caused by slow model responses during dynamic permission mode changes. ([#8149](https://github.com/QwenLM/qwen-code/pull/8149)) by @wenshao
- Fixed a flaky end-to-end test for auto-edit permissions to ensure deterministic results without relying on live model behavior. ([#8154](https://github.com/QwenLM/qwen-code/pull/8154)) by @wenshao
- Fixed session details menus overflowing on narrow layouts and added a keyboard-accessible action to copy the full session ID. ([#8127](https://github.com/QwenLM/qwen-code/pull/8127)) by @dreamWB

#### Internal Changes

- The asyncGenerator canUseTool test now validates tool-call arguments instead of strict file content equality to stabilize assertions against model wording variations. ([#7939](https://github.com/QwenLM/qwen-code/pull/7939)) by @qwen-code-dev-bot
- Adds an isolated CI pipeline to automatically run SWE-bench benchmarks on stable Qwen Code releases. ([#7656](https://github.com/QwenLM/qwen-code/pull/7656)) by @DennisYu07
- Migrated flaky end-to-end tests to a deterministic fake server to eliminate failures caused by model output variance and latency. ([#7934](https://github.com/QwenLM/qwen-code/pull/7934)) by @yiliang114
- Expanded regression tests now verify session history pagination behavior, including active record tracking and edge cases for page-size parsing. ([#7907](https://github.com/QwenLM/qwen-code/pull/7907)) by @PratikWayase
- Opt-in daemon benchmarks now measure immediate prompt dispatch stages, including HTTP acceptance, message echo, and queue-wait durations. ([#7994](https://github.com/QwenLM/qwen-code/pull/7994)) by @doudouOUC
- Stabilizes a flaky E2E test case for subagent delegation by refining prompt instructions without changing production code. ([#8073](https://github.com/QwenLM/qwen-code/pull/8073)) by @qwen-code-dev-bot

### New Contributors

- @xianjianlf2 made their first contribution in [#8031](https://github.com/QwenLM/qwen-code/pull/8031)
- @zambalee made their first contribution in [#7963](https://github.com/QwenLM/qwen-code/pull/7963)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.1...v0.21.2

## [0.21.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.1) - 2026-07-28

### Highlights

_See the complete change list below._

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- feat(core): Align GenAI content telemetry fields ([#7667](https://github.com/QwenLM/qwen-code/pull/7667)) by @doudouOUC
- feat(core): add Goal v3 runtime orchestration ([#7664](https://github.com/QwenLM/qwen-code/pull/7664)) by @qqqys
- feat(triage): stop in-agent CI polling, finalize evidence and approval after CI completes ([#7693](https://github.com/QwenLM/qwen-code/pull/7693)) by @wenshao
- feat(serve): expose workspace Channel management API ([#7637](https://github.com/QwenLM/qwen-code/pull/7637)) by @qqqys
- feat(web-shell): add read-only GitHub pull requests panel ([#7683](https://github.com/QwenLM/qwen-code/pull/7683)) by @wenshao
- Adds a retrieval-only context_search tool for external corpora, configured by administrators without automatic recall or write capabilities. ([#7586](https://github.com/QwenLM/qwen-code/pull/7586)) by @doudouOUC
- Introduces the qwen review comment-status subcommand to quickly triage existing inline comments and reduce API calls during review runs. ([#7690](https://github.com/QwenLM/qwen-code/pull/7690)) by @wenshao
- Enforces a strict write contract for review submissions and adds a tripwire to detect and flag any bypass attempts via terminal commands. ([#7691](https://github.com/QwenLM/qwen-code/pull/7691)) by @wenshao
- Enables hot-reloading of workspace trust changes in the running daemon, applying new policies immediately without requiring a process restart. ([#7268](https://github.com/QwenLM/qwen-code/pull/7268)) by @doudouOUC
- Adds retryInitialDelayMs and retryMaxDelayMs settings to configure stream-side rate-limit retry delays for better provider compatibility. ([#7674](https://github.com/QwenLM/qwen-code/pull/7674)) by @jay666mnj
- Updates the /stats command and Session tab to display generation timing metrics including TTFT, duration, output tokens, and TPS. ([#7677](https://github.com/QwenLM/qwen-code/pull/7677)) by @destire-mio
- Adds a GitHub channel adapter that polls notifications and responds to mentions by posting comments using a signal-based wakeup architecture. ([#7632](https://github.com/QwenLM/qwen-code/pull/7632)) by @OrbitZore
- Adds optional retryInitialDelayMs and retryMaxDelayMs settings to configure SSE stream rate-limit retry delays for specific provider quota windows. ([#7666](https://github.com/QwenLM/qwen-code/pull/7666)) by @hogeheer499-commits
- Introduces an overridable default-disabled state for skills, allowing soft defaults that yield to explicit enablement while hard disables remain absolute. ([#7357](https://github.com/QwenLM/qwen-code/pull/7357)) by @samuelhsin
- feat(webui): add workspace Channel management hook ([#7728](https://github.com/QwenLM/qwen-code/pull/7728)) by @qqqys
- feat(review): redefine medium effort as a balanced verified pass ([#7733](https://github.com/QwenLM/qwen-code/pull/7733)) by @wenshao
- feat(review): mutation-test the tests in the test-coverage pass (Agent 5) ([#7735](https://github.com/QwenLM/qwen-code/pull/7735)) by @wenshao
- feat(review): borrow maintainer review lenses into the agent briefs ([#7736](https://github.com/QwenLM/qwen-code/pull/7736)) by @wenshao
- feat(web-shell): persist terminal history pagination errors ([#7709](https://github.com/QwenLM/qwen-code/pull/7709)) by @PratikWayase
- feat(triage): add sandboxed /verify deep-verification lane ([#7710](https://github.com/QwenLM/qwen-code/pull/7710)) by @wenshao
- feat(review): give the verifier a probe capability — run a runnable claim, don't just read it ([#7756](https://github.com/QwenLM/qwen-code/pull/7756)) by @wenshao
- feat(core): add model grade selection for subagent spawn (#7685) ([#7702](https://github.com/QwenLM/qwen-code/pull/7702)) by @yiliang114
- feat(dingtalk): support outbound image delivery ([#7698](https://github.com/QwenLM/qwen-code/pull/7698)) by @qqqys
- feat(web-shell): allow widening sidebar up to half the window width ([#7778](https://github.com/QwenLM/qwen-code/pull/7778)) by @wenshao
- feat(core): add Goal v3 worker tools ([#7729](https://github.com/QwenLM/qwen-code/pull/7729)) by @qqqys
- feat(review): script-lint as a deterministic gate — compose-review reads the report, no agent ([#7751](https://github.com/QwenLM/qwen-code/pull/7751)) by @wenshao
- feat(web-shell): add monitor task details ([#7817](https://github.com/QwenLM/qwen-code/pull/7817)) by @ytahdn
- feat(web-shell): Scope voice to composer workspace ([#7754](https://github.com/QwenLM/qwen-code/pull/7754)) by @doudouOUC
- feat(hooks): Add submitted prompt provenance ([#7762](https://github.com/QwenLM/qwen-code/pull/7762)) by @doudouOUC
- feat(autofix): retry deterministic rejection once ([#7796](https://github.com/QwenLM/qwen-code/pull/7796)) by @qqqys
- feat(web-shell): add Channel management page ([#7793](https://github.com/QwenLM/qwen-code/pull/7793)) by @qqqys
- feat(acp): add session-scoped runtime MCP ([#7847](https://github.com/QwenLM/qwen-code/pull/7847)) by @qqqys
- feat(core): persist and replay Goal v3 state ([#7815](https://github.com/QwenLM/qwen-code/pull/7815)) by @qqqys
- feat(core): add full-resolution image zoom tool ([#7809](https://github.com/QwenLM/qwen-code/pull/7809)) by @qqqys
- feat(web-shell): add composer footer renderer ([#7856](https://github.com/QwenLM/qwen-code/pull/7856)) by @dreamWB
- feat: Gate session writer lease behind opt-in ([#7894](https://github.com/QwenLM/qwen-code/pull/7894)) by @doudouOUC
- feat(ci): Deduplicate E2E failure issues by commenting on existing issue ([#7792](https://github.com/QwenLM/qwen-code/pull/7792)) by @yiliang114
- feat(triage): add revert-pattern high-risk path detection ([#7414](https://github.com/QwenLM/qwen-code/pull/7414)) by @yiliang114
- feat(web-shell): add native workspace folder picker ([#7849](https://github.com/QwenLM/qwen-code/pull/7849)) by @qqqys
- feat(web-shell): add Channel configuration flows ([#7893](https://github.com/QwenLM/qwen-code/pull/7893)) by @qqqys
- feat(core): Add ARMS session user ID ([#7921](https://github.com/QwenLM/qwen-code/pull/7921)) by @doudouOUC
- feat(channels): expose loop tools in daemon sessions ([#7891](https://github.com/QwenLM/qwen-code/pull/7891)) by @qqqys
- feat(web-shell): honor voice hold mode ([#7839](https://github.com/QwenLM/qwen-code/pull/7839)) by @callmeYe
- feat(web-shell): manage Channel pairing requests ([#7909](https://github.com/QwenLM/qwen-code/pull/7909)) by @qqqys
- feat(channels): dispatch GitHub notifications by reason ([#7826](https://github.com/QwenLM/qwen-code/pull/7826)) by @yiliang114
- feat(web-shell): add git branch picker, commit dialog, and create PR flow ([#7731](https://github.com/QwenLM/qwen-code/pull/7731)) by @wenshao
- feat(triage): surface the sandboxed lanes on the CI path ([#7917](https://github.com/QwenLM/qwen-code/pull/7917)) by @wenshao
- feat(web-shell): suggest BTW for side questions ([#7935](https://github.com/QwenLM/qwen-code/pull/7935)) by @carffuca
- feat(triage): make the verify report readable in Chinese ([#7918](https://github.com/QwenLM/qwen-code/pull/7918)) by @wenshao

#### Bug Fixes

- fix(cli): measure insight days and hours in local time everywhere ([#7670](https://github.com/QwenLM/qwen-code/pull/7670)) by @ComplexSimply
- fix(ci): don't fail triage cleanup when there is nothing to clean ([#7688](https://github.com/QwenLM/qwen-code/pull/7688)) by @wenshao
- fix(ci): update qwen in the runner's active npm prefix ([#7689](https://github.com/QwenLM/qwen-code/pull/7689)) by @yiliang114
- fix(acp): sweep review worktree leases at the end of each prompt turn ([#7694](https://github.com/QwenLM/qwen-code/pull/7694)) by @wenshao
- fix(core): write a status sidecar so models stop misreading quiet background shells ([#7669](https://github.com/QwenLM/qwen-code/pull/7669)) by @ComplexSimply
- fix(core): exit_plan_mode returns guidance error from execute() instead of permission deny ([#7673](https://github.com/QwenLM/qwen-code/pull/7673)) by @qwen-code-dev-bot
- fix(core): tell the model when the user manually exits plan mode ([#7682](https://github.com/QwenLM/qwen-code/pull/7682)) by @zjunothing
- fix(core): give plugins from the same repository distinct extension ids ([#7676](https://github.com/QwenLM/qwen-code/pull/7676)) by @zjunothing
- fix(core): allow reading saved plan files without a confirmation prompt ([#7678](https://github.com/QwenLM/qwen-code/pull/7678)) by @zjunothing
- fix(cli): clear stale retry error when agent auto-recovers mid-turn ([#7681](https://github.com/QwenLM/qwen-code/pull/7681)) by @qwen-code-dev-bot
- fix(mcp): harden OAuth callback handling ([#7510](https://github.com/QwenLM/qwen-code/pull/7510)) by @gauravyad86
- fix(web-shell): add :focus-visible outline to GitHub PR list rows ([#7704](https://github.com/QwenLM/qwen-code/pull/7704)) by @wenshao
- fix(triage): resolve stage comment ids by marker at patch time, harden model injection ([#7703](https://github.com/QwenLM/qwen-code/pull/7703)) by @wenshao
- fix(triage): resolve finalize PRs from the open-PR list, not the commit association ([#7706](https://github.com/QwenLM/qwen-code/pull/7706)) by @wenshao
- Fixes inline math recognition to correctly handle single-character expressions, escaped dollars, and code spans across prose and tables. ([#7701](https://github.com/QwenLM/qwen-code/pull/7701)) by @CubeLander
- Fixes desktop file size display to correctly render terabyte and larger values instead of showing undefined for huge files. ([#7623](https://github.com/QwenLM/qwen-code/pull/7623)) by @chinesepowered
- Ensures const-derived enums are correctly stringified during OpenAPI 3.0 conversion to meet strict schema requirements. ([#7547](https://github.com/QwenLM/qwen-code/pull/7547)) by @chinesepowered
- Fixes schema conversion to properly handle nested objects even when property names match JSON Schema constraint keywords like maximum. ([#7546](https://github.com/QwenLM/qwen-code/pull/7546)) by @chinesepowered
- Silences xterm.js parser diagnostic logs in headless shell terminals to prevent error messages from leaking when commands emit invalid ANSI escape sequences. ([#7663](https://github.com/QwenLM/qwen-code/pull/7663)) by @mvanhorn
- Hardens the review skill by declaring the optional host argument in CommentStatusArgs and improving error handling for authentication or network failures. ([#7708](https://github.com/QwenLM/qwen-code/pull/7708)) by @wenshao
- Ensures StopFailure hooks fire correctly when loop detection triggers an early return during the streaming loop instead of only on API errors. ([#7592](https://github.com/QwenLM/qwen-code/pull/7592)) by @qwen-code-dev-bot
- Enables the Changes and History dialogs for worktree sessions in the Web Shell by threading the correct git working directory through the entire stack. ([#7695](https://github.com/QwenLM/qwen-code/pull/7695)) by @wenshao
- Strictly parses the heatmapDays query parameter to reject malformed values like negative numbers or decimals, falling back to the default instead of clamping invalid input. ([#7218](https://github.com/QwenLM/qwen-code/pull/7218)) by @VectorPeak
- Raises default live journal caps to 10,000 events and 8 MiB while exposing --max-journal-events and --max-journal-bytes flags for configuration. ([#7715](https://github.com/QwenLM/qwen-code/pull/7715)) by @wenshao
- Allows pinning and grouping secondary workspace sessions in the Web Shell sidebar without requiring the workspace to be locked first. ([#7716](https://github.com/QwenLM/qwen-code/pull/7716)) by @wenshao
- Corrects the review submit-gate audit to avoid falsely claiming a bypass when detecting valid same-account writes from other sources like triage bots. ([#7718](https://github.com/QwenLM/qwen-code/pull/7718)) by @wenshao
- Fixes QQ Bot session restoration by returning the input session ID from AcpBridge and ensuring session patching runs even when validation fails. ([#7722](https://github.com/QwenLM/qwen-code/pull/7722)) by @Eric-GoodBoy-Tech
- fix(core): prevent updates to extension-provided agents ([#7245](https://github.com/QwenLM/qwen-code/pull/7245)) by @destire-mio
- fix(core): fall back to system rg when bundled ripgrep cannot run ([#7203](https://github.com/QwenLM/qwen-code/pull/7203)) by @harjothkhara
- fix(core): avoid required tools in DashScope thinking ([#7661](https://github.com/QwenLM/qwen-code/pull/7661)) by @hogeheer499-commits
- fix(channels): use username as senderId in GitHub adapter to fix allowlist gate ([#7727](https://github.com/QwenLM/qwen-code/pull/7727)) by @OrbitZore
- fix(web-shell): parse 256-color and truecolor SGR sequences in parseAnsi ([#7620](https://github.com/QwenLM/qwen-code/pull/7620)) by @chinesepowered
- fix(triage): only the bot's own approval counts as already approved ([#7737](https://github.com/QwenLM/qwen-code/pull/7737)) by @wenshao
- fix(core): stop humanReadableCron naming intervals that never happen ([#7529](https://github.com/QwenLM/qwen-code/pull/7529)) by @chinesepowered
- fix(cli): keep IME cursor aligned after footer updates ([#7711](https://github.com/QwenLM/qwen-code/pull/7711)) by @water-in-stone
- fix(core): redact the plan argument from history after an approved exit_plan_mode ([#7197](https://github.com/QwenLM/qwen-code/pull/7197)) by @zjunothing
- fix(review): correct the borrowed lenses and vacuous-test severity (follow-up to #7735/#7736) ([#7746](https://github.com/QwenLM/qwen-code/pull/7746)) by @wenshao
- fix(core): reliably deliver manual plan-exit notices ([#7744](https://github.com/QwenLM/qwen-code/pull/7744)) by @doudouOUC
- fix(review): recover bilingual register from the live PR when the plan omits the Han flag ([#7739](https://github.com/QwenLM/qwen-code/pull/7739)) by @wenshao
- fix(cli): complete repeated skill slash commands ([#7720](https://github.com/QwenLM/qwen-code/pull/7720)) by @Sparkle6979
- fix(cli): handle escaped dollars around inline math ([#7741](https://github.com/QwenLM/qwen-code/pull/7741)) by @CubeLander
- fix(cli): show tool descriptions in multi-tool compact summaries ([#7589](https://github.com/QwenLM/qwen-code/pull/7589)) by @ovochouovo
- fix(ci): rename triage status marker to avoid duplicate-guard collision ([#7723](https://github.com/QwenLM/qwen-code/pull/7723)) by @yiliang114
- fix(core): route id-less continuation chunks to a colliding tool-call opener's slot ([#6981](https://github.com/QwenLM/qwen-code/pull/6981)) by @he-yufeng
- fix(autofix): answer every review thread, resolve the ones actually fixed ([#7758](https://github.com/QwenLM/qwen-code/pull/7758)) by @wenshao
- fix(core): treat properties as a name map in toOpenAPI30 ([#7760](https://github.com/QwenLM/qwen-code/pull/7760)) by @chinesepowered
- fix(core): keep leading whitespace in gitignore patterns ([#7763](https://github.com/QwenLM/qwen-code/pull/7763)) by @chinesepowered
- fix(core): stop trailing slash from anchoring nested gitignore patterns ([#7764](https://github.com/QwenLM/qwen-code/pull/7764)) by @chinesepowered
- fix(core): keep the model name when a model id carries a variant tag ([#7766](https://github.com/QwenLM/qwen-code/pull/7766)) by @chinesepowered
- fix(weixin): create the account credential file already private ([#7726](https://github.com/QwenLM/qwen-code/pull/7726)) by @chinesepowered
- fix(core): stop rewriting backslash escapes in gitignore patterns ([#7765](https://github.com/QwenLM/qwen-code/pull/7765)) by @chinesepowered
- fix(core): scope the timeout veto to the fragment it appears in ([#7776](https://github.com/QwenLM/qwen-code/pull/7776)) by @chinesepowered
- fix(core): decline sed patterns whose bracket expression starts with ] ([#7775](https://github.com/QwenLM/qwen-code/pull/7775)) by @chinesepowered
- fix(web-shell): stabilize mobile voice input ([#7806](https://github.com/QwenLM/qwen-code/pull/7806)) by @ytahdn
- fix(test): give every E2E case a clean directory again ([#7811](https://github.com/QwenLM/qwen-code/pull/7811)) by @wenshao
- fix(web-shell): allow shell commands in new tasks without a session ([#7724](https://github.com/QwenLM/qwen-code/pull/7724)) by @wenshao
- fix(triage): carry the /verify lane's hardening across to /tmux ([#7753](https://github.com/QwenLM/qwen-code/pull/7753)) by @wenshao
- fix(web-shell): render task notifications as system messages ([#7822](https://github.com/QwenLM/qwen-code/pull/7822)) by @ytahdn
- fix(ci): add default bash shell to container jobs in qwen-triage ([#7838](https://github.com/QwenLM/qwen-code/pull/7838)) by @qwen-code-dev-bot
- fix(web-shell): preserve pasted text in composer ([#7824](https://github.com/QwenLM/qwen-code/pull/7824)) by @ytahdn
- fix(ci): add git safe.directory for container jobs ([#7843](https://github.com/QwenLM/qwen-code/pull/7843)) by @qwen-code-dev-bot
- fix(ci): add --init to container jobs to reap zombie processes ([#7848](https://github.com/QwenLM/qwen-code/pull/7848)) by @qwen-code-dev-bot
- fix(core): wait for output stream flush before settling background shells ([#7833](https://github.com/QwenLM/qwen-code/pull/7833)) by @ComplexSimply
- fix(scripts): retry model calls and surface degraded release notes ([#7535](https://github.com/QwenLM/qwen-code/pull/7535)) by @he-yufeng
- fix(ci): prevent worktree cleanup from failing the verify job ([#7857](https://github.com/QwenLM/qwen-code/pull/7857)) by @qwen-code-dev-bot
- fix(release): publish all channel packages, not just channel-base ([#7845](https://github.com/QwenLM/qwen-code/pull/7845)) by @yiliang114
- fix(scripts): harden retry classification and preserve deadline error context ([#7854](https://github.com/QwenLM/qwen-code/pull/7854)) by @yiliang114
- fix(core): fast-fail permanent quota-exhaustion 429s instead of silent retry ([#7842](https://github.com/QwenLM/qwen-code/pull/7842)) by @yiliang114
- fix(web-shell): isolate history and session drafts ([#7810](https://github.com/QwenLM/qwen-code/pull/7810)) by @ytahdn
- fix(triage): retry a transient npm ci before blaming the PR for it ([#7884](https://github.com/QwenLM/qwen-code/pull/7884)) by @wenshao
- fix(webui): fall back to history_truncated marker recordId for transcript pagination anchor ([#7829](https://github.com/QwenLM/qwen-code/pull/7829)) by @wenshao
- fix(review): give the review retry the remaining time budget ([#7852](https://github.com/QwenLM/qwen-code/pull/7852)) by @wenshao
- fix(integration): configure Docker sandbox networking for submitted-prompt provenance test (#7879) ([#7881](https://github.com/QwenLM/qwen-code/pull/7881)) by @qwen-code-dev-bot
- fix(cli): report a genuine $0.00 cost instead of N/A ([#7784](https://github.com/QwenLM/qwen-code/pull/7784)) by @chinesepowered
- fix(core): reject socks5h and socks4a proxy URLs ([#7786](https://github.com/QwenLM/qwen-code/pull/7786)) by @chinesepowered
- fix(core): correct the character classes in checkContentLoop ([#7788](https://github.com/QwenLM/qwen-code/pull/7788)) by @chinesepowered
- fix(web-shell): make /copy with a bare index work ([#7789](https://github.com/QwenLM/qwen-code/pull/7789)) by @chinesepowered
- fix(core): decline combined sed flags where -i is not last ([#7790](https://github.com/QwenLM/qwen-code/pull/7790)) by @chinesepowered
- fix(core): pass the Grep pattern behind -e so a leading dash is not an option ([#7863](https://github.com/QwenLM/qwen-code/pull/7863)) by @chinesepowered
- fix(core): cap a bare Error's message like every other getErrorMessage path ([#7865](https://github.com/QwenLM/qwen-code/pull/7865)) by @chinesepowered
- fix(cli): make wrapToVisualLines count zero-width characters like its sibling ([#7873](https://github.com/QwenLM/qwen-code/pull/7873)) by @chinesepowered
- fix(core): charge the separator and ellipsis to the preview budget ([#7874](https://github.com/QwenLM/qwen-code/pull/7874)) by @chinesepowered
- fix(cli): do not count a partial trailing line when re-opening a split fence ([#7875](https://github.com/QwenLM/qwen-code/pull/7875)) by @chinesepowered
- fix(cli): make /copy <message> <index> select the code block ([#7883](https://github.com/QwenLM/qwen-code/pull/7883)) by @chinesepowered
- fix(test): Restore first-output benchmark measurement validity and correct its artifact schema ([#7820](https://github.com/QwenLM/qwen-code/pull/7820)) by @doudouOUC
- fix(daemon): harden Todo Stop Guard continuations ([#7821](https://github.com/QwenLM/qwen-code/pull/7821)) by @doudouOUC
- fix(core): read the stash reflog from the common git dir ([#7774](https://github.com/QwenLM/qwen-code/pull/7774)) by @chinesepowered
- fix(core): keep Draft 4 boolean exclusive bounds in toOpenAPI30 ([#7782](https://github.com/QwenLM/qwen-code/pull/7782)) by @chinesepowered
- fix(core): apply maxDepth to flat-format memory imports ([#7851](https://github.com/QwenLM/qwen-code/pull/7851)) by @chinesepowered
- fix(core): render a thought part's reasoning instead of the boolean flag ([#7866](https://github.com/QwenLM/qwen-code/pull/7866)) by @chinesepowered
- fix(core): bridge tool-result images for text-only models ([#7484](https://github.com/QwenLM/qwen-code/pull/7484)) by @LaZzyMan
- fix(cli): patch ink to clear staticNode on indirect subtree removal ([#7816](https://github.com/QwenLM/qwen-code/pull/7816)) by @chiga0
- fix(core): auto-retry transient network errors during API calls ([#7898](https://github.com/QwenLM/qwen-code/pull/7898)) by @chiga0
- fix(cli): hide stale sticky todos from previous turns ([#7900](https://github.com/QwenLM/qwen-code/pull/7900)) by @chiga0
- fix(serve): Release managed session writer locks on shutdown ([#7812](https://github.com/QwenLM/qwen-code/pull/7812)) by @doudouOUC
- fix(cli): add polling fallback for git branch name display ([#7830](https://github.com/QwenLM/qwen-code/pull/7830)) by @qwen-code-dev-bot
- fix(cli): remove redundant 'Read file' prefix from @mention tool card ([#7902](https://github.com/QwenLM/qwen-code/pull/7902)) by @qwen-code-dev-bot
- fix(safe-mode): preserve caller-supplied top-tier MCP servers ([#7827](https://github.com/QwenLM/qwen-code/pull/7827)) by @VitaliBabkin
- fix(ci): keep the post-merge E2E signal on main alive ([#7795](https://github.com/QwenLM/qwen-code/pull/7795)) by @wenshao
- fix(core): short-circuit the flush wait when the output stream cannot flush ([#7905](https://github.com/QwenLM/qwen-code/pull/7905)) by @ComplexSimply
- fix(core): track quotes inside a command substitution in splitCommands ([#7870](https://github.com/QwenLM/qwen-code/pull/7870)) by @chinesepowered
- fix(core): count the per-server and per-tool always-allow outcomes as approvals ([#7869](https://github.com/QwenLM/qwen-code/pull/7869)) by @chinesepowered
- fix(web-shell): report intended workspace to host when starting a new chat ([#7910](https://github.com/QwenLM/qwen-code/pull/7910)) by @wenshao
- fix(cli): default to virtualized terminal history ([#5738](https://github.com/QwenLM/qwen-code/pull/5738)) by @ZevGit
- fix(ci): restore workspace ownership in cleanup to prevent EACCES ([#7931](https://github.com/QwenLM/qwen-code/pull/7931)) by @qwen-code-dev-bot
- fix(review): recover the resolved effort when --effort is not re-threaded ([#7855](https://github.com/QwenLM/qwen-code/pull/7855)) by @wenshao
- fix(scripts): slim release-note model prompts and log request timing ([#7941](https://github.com/QwenLM/qwen-code/pull/7941)) by @yiliang114
- fix(release): pin channel-base dep to exact version during release bump ([#7953](https://github.com/QwenLM/qwen-code/pull/7953)) by @yiliang114
- fix(triage): make the build-process guard diagnosable and zombie-aware ([#7858](https://github.com/QwenLM/qwen-code/pull/7858)) by @wenshao
- fix(ci): give each job its own proxy wrapper directory ([#7951](https://github.com/QwenLM/qwen-code/pull/7951)) by @wenshao

#### Performance

- perf(cli): cache GitHub PR list in the daemon route with a 60s TTL ([#7705](https://github.com/QwenLM/qwen-code/pull/7705)) by @wenshao
- perf(core): keep the volatile auto-memory section last in the system prompt ([#7651](https://github.com/QwenLM/qwen-code/pull/7651)) by @DragonnZhang
- perf(web-shell): paint the composer git chip before git status completes ([#7680](https://github.com/QwenLM/qwen-code/pull/7680)) by @wenshao
- perf(core): Lazy-load first-use dependencies ([#7686](https://github.com/QwenLM/qwen-code/pull/7686)) by @doudouOUC
- perf(cli): replace comment-json settings parser ([#7747](https://github.com/QwenLM/qwen-code/pull/7747)) by @doudouOUC
- perf(acp): Preload providers after session creation ([#7767](https://github.com/QwenLM/qwen-code/pull/7767)) by @doudouOUC
- perf(core): add early Anthropic cache breakpoint on the stable system prefix ([#7912](https://github.com/QwenLM/qwen-code/pull/7912)) by @DragonnZhang
- perf(ci): cut the E2E suite from ~40min to ~24min ([#7798](https://github.com/QwenLM/qwen-code/pull/7798)) by @wenshao

#### Documentation

- docs(channels): Document loops and proactive delivery ([#7628](https://github.com/QwenLM/qwen-code/pull/7628)) by @wenshao

#### Internal Changes

- refactor(autofix): extract review verification runner ([#7644](https://github.com/QwenLM/qwen-code/pull/7644)) by @qqqys
- test(web-shell): capture the git-mode new-branch sub-state in the visuals suite ([#7672](https://github.com/QwenLM/qwen-code/pull/7672)) by @wenshao
- Refactors system prompt assembly into a layered builder to explicitly manage stable, context, and volatile instruction layers. ([#7707](https://github.com/QwenLM/qwen-code/pull/7707)) by @DragonnZhang
- Adds regression tests to verify that restored-session transcript pagination correctly URL-encodes boundaries and preserves state during retry attempts. ([#7657](https://github.com/QwenLM/qwen-code/pull/7657)) by @jay666mnj
- test(cli): cover bottom-stuck virtualized list behavior ([#7652](https://github.com/QwenLM/qwen-code/pull/7652)) by @jay666mnj
- ci: keep the critical-audit gate honest when npm cannot answer ([#7743](https://github.com/QwenLM/qwen-code/pull/7743)) by @wenshao
- test(integration): deflake tool-control permission cases ([#7725](https://github.com/QwenLM/qwen-code/pull/7725)) by @yiliang114
- revert: drop the stale-base un-park recovery (#7602) ([#7640](https://github.com/QwenLM/qwen-code/pull/7640)) by @wenshao
- test(serve): Add first-output latency benchmark ([#7761](https://github.com/QwenLM/qwen-code/pull/7761)) by @doudouOUC
- test(channels): run the feishu, weixin and qqbot suites in CI ([#7853](https://github.com/QwenLM/qwen-code/pull/7853)) by @chinesepowered

### New Contributors

- @jay666mnj made their first contribution in [#7674](https://github.com/QwenLM/qwen-code/pull/7674)
- @harjothkhara made their first contribution in [#7203](https://github.com/QwenLM/qwen-code/pull/7203)
- @PratikWayase made their first contribution in [#7709](https://github.com/QwenLM/qwen-code/pull/7709)
- @Sparkle6979 made their first contribution in [#7720](https://github.com/QwenLM/qwen-code/pull/7720)
- @VitaliBabkin made their first contribution in [#7827](https://github.com/QwenLM/qwen-code/pull/7827)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.21.0...v0.21.1

## [0.21.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.0) - 2026-07-24

### Highlights

_See the complete change list below._

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- feat(web-shell): add workspace selector button with add/switch dropdown in composer toolbar ([#7390](https://github.com/QwenLM/qwen-code/pull/7390)) by @water-in-stone
- feat(web-shell): show subagent sessions in detail panel ([#7380](https://github.com/QwenLM/qwen-code/pull/7380)) by @ytahdn
- feat(web-shell): add rendered file previews ([#7467](https://github.com/QwenLM/qwen-code/pull/7467)) by @ytahdn
- feat(core): add memory recall delivery telemetry ([#7393](https://github.com/QwenLM/qwen-code/pull/7393)) by @ZijianZhang989
- feat(core): keep completed background agents resident ([#7426](https://github.com/QwenLM/qwen-code/pull/7426)) by @DragonnZhang
- feat(serve): support forced MCP reconnects ([#7488](https://github.com/QwenLM/qwen-code/pull/7488)) by @BZ-D
- feat(prompts): allow overriding core identity via QWEN_SYSTEM_IDENTITY_MD ([#7478](https://github.com/QwenLM/qwen-code/pull/7478)) by @zjgzx1988
- feat(autofix): stop a PR that fails to push for N rounds in a row ([#7482](https://github.com/QwenLM/qwen-code/pull/7482)) by @wenshao
- feat(core): restore background agent roster ([#7459](https://github.com/QwenLM/qwen-code/pull/7459)) by @DragonnZhang
- feat(cli): support custom skill directories via settings ([#7395](https://github.com/QwenLM/qwen-code/pull/7395)) by @qwen-code-dev-bot
- feat(cli): preserve semantic text when copying VP selections ([#7286](https://github.com/QwenLM/qwen-code/pull/7286)) by @chiga0
- feat(web-shell): add selective Shadow DOM isolation ([#7551](https://github.com/QwenLM/qwen-code/pull/7551)) by @ytahdn
- feat(web-shell): add renderChatHeader slot for custom session header ([#7553](https://github.com/QwenLM/qwen-code/pull/7553)) by @yuanyuanAli
- feat(serve): add workspace-level generation ([#7552](https://github.com/QwenLM/qwen-code/pull/7552)) by @ytahdn
- feat(serve): persist workspace channel configuration ([#7514](https://github.com/QwenLM/qwen-code/pull/7514)) by @qqqys
- feat(core): propagate trusted daemon invocation context ([#7279](https://github.com/QwenLM/qwen-code/pull/7279)) by @callmeYe
- feat(cli): post the review body bilingually when the PR description is Chinese ([#7564](https://github.com/QwenLM/qwen-code/pull/7564)) by @wenshao
- feat(autofix): auto-rerun a check that died on infrastructure, once ([#7562](https://github.com/QwenLM/qwen-code/pull/7562)) by @wenshao
- feat(core): Align GenAI telemetry with ARMS ([#7536](https://github.com/QwenLM/qwen-code/pull/7536)) by @doudouOUC
- feat(web-shell): add workspace agent management ([#7572](https://github.com/QwenLM/qwen-code/pull/7572)) by @ytahdn
- feat(autofix): update a stale base when the gate rejects a behind-main fix ([#7595](https://github.com/QwenLM/qwen-code/pull/7595)) by @wenshao
- feat(sdk-java): Add daemon transport ([#7463](https://github.com/QwenLM/qwen-code/pull/7463)) by @doudouOUC
- feat(autofix): auto-update a PR red only from a stale, since-fixed base ([#7554](https://github.com/QwenLM/qwen-code/pull/7554)) by @wenshao
- feat(autofix): auto-recover a PR parked on a stale base ([#7602](https://github.com/QwenLM/qwen-code/pull/7602)) by @wenshao
- feat(core): add Goal v3 state protocol ([#7517](https://github.com/QwenLM/qwen-code/pull/7517)) by @qqqys
- feat(daemon): add explicit channel delivery ([#7388](https://github.com/QwenLM/qwen-code/pull/7388)) by @BenGuanRan
- feat(serve): scope channel lifecycle to workspace runtimes ([#7577](https://github.com/QwenLM/qwen-code/pull/7577)) by @qqqys
- feat(cli): add usage statistics environment override ([#7579](https://github.com/QwenLM/qwen-code/pull/7579)) by @tanzhenxin
- feat(core): emit OAuth login URL as a single OSC 8 hyperlink ([#7255](https://github.com/QwenLM/qwen-code/pull/7255)) by @chinesepowered
- feat(web-shell): add git mode selector for new session creation ([#7471](https://github.com/QwenLM/qwen-code/pull/7471)) by @wenshao
- feat(cli): support native video input in /learn ([#7497](https://github.com/QwenLM/qwen-code/pull/7497)) by @LaZzyMan
- feat(core): Align GenAI request telemetry with ARMS ([#7635](https://github.com/QwenLM/qwen-code/pull/7635)) by @doudouOUC
- feat(cli): reference prior sessions via @ and add completion tabs ([#7302](https://github.com/QwenLM/qwen-code/pull/7302)) by @LaZzyMan
- feat(review): follow the session output language for runtime task names ([#7653](https://github.com/QwenLM/qwen-code/pull/7653)) by @wenshao
- feat(channels): run loops in daemon workers ([#7641](https://github.com/QwenLM/qwen-code/pull/7641)) by @qqqys
- feat(core): add configurable image generation models ([#7607](https://github.com/QwenLM/qwen-code/pull/7607)) by @qqqys
- feat(core): add bounded Goal evidence verification ([#7639](https://github.com/QwenLM/qwen-code/pull/7639)) by @qqqys

#### Bug Fixes

- fix(autofix): keep a still-red check visible until its head is judged ([#7438](https://github.com/QwenLM/qwen-code/pull/7438)) by @wenshao
- fix: normalize empty working_dir to unset when isolation:worktree is set on AgentTool ([#7403](https://github.com/QwenLM/qwen-code/pull/7403)) by @mvanhorn
- fix(core): Advertise completed task revival ([#7454](https://github.com/QwenLM/qwen-code/pull/7454)) by @DragonnZhang
- fix(cli): narrow update-check error classification ([#7431](https://github.com/QwenLM/qwen-code/pull/7431)) by @yiliang114
- fix(web-shell): isolate component styles from host CSS ([#7466](https://github.com/QwenLM/qwen-code/pull/7466)) by @ytahdn
- fix(web-shell): polish embedded shell interactions ([#7477](https://github.com/QwenLM/qwen-code/pull/7477)) by @ytahdn
- fix(release): exclude mobile-mcp from core version bump ([#7474](https://github.com/QwenLM/qwen-code/pull/7474)) by @yiliang114
- fix(ci): inject actual model name into triage signature ([#7475](https://github.com/QwenLM/qwen-code/pull/7475)) by @yiliang114
- fix(core): align stepped day fields with Vixie cron semantics ([#7464](https://github.com/QwenLM/qwen-code/pull/7464)) by @destire-mio
- fix(acp-bridge): close prompt-terminal follow-ups from the PR #7400 self-review ([#7453](https://github.com/QwenLM/qwen-code/pull/7453)) by @doudouOUC
- fix(core): strip Qwen-internal daemon secrets from agent-spawned child env ([#7256](https://github.com/QwenLM/qwen-code/pull/7256)) by @chinesepowered
- fix(cli): insert newline on Shift+Enter and stop streaming thinking-block flicker ([#7397](https://github.com/QwenLM/qwen-code/pull/7397)) by @chiga0
- fix(web-shell): open singleton subagent details ([#7495](https://github.com/QwenLM/qwen-code/pull/7495)) by @ytahdn
- fix(web-shell): avoid redundant Git status requests ([#7496](https://github.com/QwenLM/qwen-code/pull/7496)) by @ytahdn
- fix(agent): ignore empty working_dir placeholders ([#7343](https://github.com/QwenLM/qwen-code/pull/7343)) by @Truraly
- fix(cli): yield to single-slot background agents ([#7258](https://github.com/QwenLM/qwen-code/pull/7258)) by @hogeheer499-commits
- fix(core): add image modality support for qwen3.8-max and kimi-k3 models ([#7491](https://github.com/QwenLM/qwen-code/pull/7491)) by @yiliang114
- fix(dingtalk): preserve non-bot mention context ([#7473](https://github.com/QwenLM/qwen-code/pull/7473)) by @qwen-code-dev-bot
- fix(core): harden the usage salvage around session deletion ([#7425](https://github.com/QwenLM/qwen-code/pull/7425)) by @zjunothing
- fix(core): make fork subagents discoverable ([#7460](https://github.com/QwenLM/qwen-code/pull/7460)) by @DragonnZhang
- fix(ci): autofix route checks existing labels on non-trigger label events ([#7481](https://github.com/QwenLM/qwen-code/pull/7481)) by @yiliang114
- fix(vscode): use file picker image paths for vision input ([#7493](https://github.com/QwenLM/qwen-code/pull/7493)) by @yiliang114
- fix(cli): open the actual serve fallback port ([#7501](https://github.com/QwenLM/qwen-code/pull/7501)) by @yiliang114
- fix(ci): don't let one failing scenario sink the whole visual preview ([#7511](https://github.com/QwenLM/qwen-code/pull/7511)) by @wenshao
- fix(cli): say review coverage gaps in the author's units, not chunk ids ([#7550](https://github.com/QwenLM/qwen-code/pull/7550)) by @wenshao
- fix(autofix): retry a skipped-Prepare instead of stranding the PR terminal ([#7490](https://github.com/QwenLM/qwen-code/pull/7490)) by @wenshao
- fix(cli): keep role codenames and brief paths out of the posted review body ([#7560](https://github.com/QwenLM/qwen-code/pull/7560)) by @wenshao
- fix(autofix): retry an agent timeout instead of advancing past its feedback ([#7563](https://github.com/QwenLM/qwen-code/pull/7563)) by @wenshao
- fix(web-shell): expose managedId in artifact open requests ([#7570](https://github.com/QwenLM/qwen-code/pull/7570)) by @ytahdn
- fix(sdk-python): require canonical form in validate_session_id ([#7532](https://github.com/QwenLM/qwen-code/pull/7532)) by @chinesepowered
- fix(web-shell): sync background agent status ([#7561](https://github.com/QwenLM/qwen-code/pull/7561)) by @ytahdn
- fix(feishu): await stream cancels in media download teardown ([#7465](https://github.com/QwenLM/qwen-code/pull/7465)) by @chinesepowered
- fix(autofix): make the review-address report comment fully bilingual ([#7569](https://github.com/QwenLM/qwen-code/pull/7569)) by @wenshao
- fix(serve): detect stale SSE cursors across daemon restarts via epoch token; preserve turn attribution and surface compaction failures in replay ([#7458](https://github.com/QwenLM/qwen-code/pull/7458)) by @doudouOUC
- fix(serve): avoid TOCTOU race dropping live sessions from list response ([#7556](https://github.com/QwenLM/qwen-code/pull/7556)) by @yiliang114 with @Copilot
- fix(cli): prevent monitor notifications after task_stop ([#7573](https://github.com/QwenLM/qwen-code/pull/7573)) by @yiliang114
- Fix(cli): use npm view for update check instead of update-notifier (#7515) ([#7528](https://github.com/QwenLM/qwen-code/pull/7528)) by @dtometzki
- fix(core): avoid empty transcript history pages ([#7582](https://github.com/QwenLM/qwen-code/pull/7582)) by @ytahdn
- fix(cli): surface unhandled rejections and render errors instead of swallowing them ([#7406](https://github.com/QwenLM/qwen-code/pull/7406)) by @chiga0
- fix(web-shell): isolate slash command plugin pages ([#7581](https://github.com/QwenLM/qwen-code/pull/7581)) by @ytahdn
- fix(sdk-python): validate max_tool_calls and max_subagent_depth as integers ([#7548](https://github.com/QwenLM/qwen-code/pull/7548)) by @chinesepowered
- fix(cli): correct queued message display style and ordering ([#7381](https://github.com/QwenLM/qwen-code/pull/7381)) by @chiga0
- fix(core): persist usage for tool-only subagent rounds ([#7557](https://github.com/QwenLM/qwen-code/pull/7557)) by @DragonnZhang
- fix(core): retry requests when providers require thinking ([#7534](https://github.com/QwenLM/qwen-code/pull/7534)) by @yiliang114
- fix(core): record auto-memory index reads in FileReadCache ([#7468](https://github.com/QwenLM/qwen-code/pull/7468)) by @han-dreamer
- fix(web-shell): initialize workspace selector from ID ([#7518](https://github.com/QwenLM/qwen-code/pull/7518)) by @patrick-andstar
- fix(core): reject nested background requests ([#7593](https://github.com/QwenLM/qwen-code/pull/7593)) by @patrick-andstar
- fix(web-shell): prevent React measure detail OOM ([#7596](https://github.com/QwenLM/qwen-code/pull/7596)) by @ytahdn
- fix(core): jsonl write([]) should leave an empty file, not a stray newline ([#7533](https://github.com/QwenLM/qwen-code/pull/7533)) by @chinesepowered
- fix(core): strip daemon secrets from hook and tool-discovery child env ([#7527](https://github.com/QwenLM/qwen-code/pull/7527)) by @chinesepowered
- fix(core): preserve disabled reasoning effort ([#7541](https://github.com/QwenLM/qwen-code/pull/7541)) by @WladmirJunior
- fix(web-shell): render a plain textarea composer on touch devices ([#7587](https://github.com/QwenLM/qwen-code/pull/7587)) by @ComplexSimply
- fix(core): treat backslash as literal inside single quotes in splitCommands ([#7526](https://github.com/QwenLM/qwen-code/pull/7526)) by @chinesepowered
- fix(cli): stop treating version-manager npm shims as npm-cli.js ([#7545](https://github.com/QwenLM/qwen-code/pull/7545)) by @nerdalytics
- fix(core,cli): isolate teammate leader turns from agent context ([#7576](https://github.com/QwenLM/qwen-code/pull/7576)) by @yiliang114
- fix(sdk-java): let a terminal continuation start the next prompt ([#7615](https://github.com/QwenLM/qwen-code/pull/7615)) by @wenshao
- fix(channels): route Telegram replies to forum topics ([#7612](https://github.com/QwenLM/qwen-code/pull/7612)) by @hogeheer499-commits
- fix(acp): hide discontinued OAuth model for other auth types ([#7522](https://github.com/QwenLM/qwen-code/pull/7522)) by @hogeheer499-commits
- fix(channels): stop dropping multi-task messages when a channel memory is saved ([#7608](https://github.com/QwenLM/qwen-code/pull/7608)) by @zjunothing
- fix(channels): ignore idle ACP cancellation errors ([#7598](https://github.com/QwenLM/qwen-code/pull/7598)) by @patrick-andstar
- fix(cli): optimize large paste performance and add progress indicator ([#6506](https://github.com/QwenLM/qwen-code/pull/6506)) by @LaZzyMan
- fix(mcp): use a dedicated undici fetch for Streamable HTTP transports ([#7195](https://github.com/QwenLM/qwen-code/pull/7195)) by @zjunothing
- fix(daemon): address epoch cursor review follow-ups ([#7619](https://github.com/QwenLM/qwen-code/pull/7619)) by @doudouOUC
- fix(sdk-java): Harden daemon transport reliability ([#7603](https://github.com/QwenLM/qwen-code/pull/7603)) by @doudouOUC
- fix(acp-bridge): resource hardening for the session event pipeline (DAEMON-009/010/011) ([#7622](https://github.com/QwenLM/qwen-code/pull/7622)) by @doudouOUC
- fix(cli): clean orphaned managed npm update artifacts ([#7539](https://github.com/QwenLM/qwen-code/pull/7539)) by @patrick-andstar
- fix(web-shell): honor locked workspace session actions ([#7629](https://github.com/QwenLM/qwen-code/pull/7629)) by @dreamWB
- fix(core): Preserve usage after empty OpenAI stream frames ([#7650](https://github.com/QwenLM/qwen-code/pull/7650)) by @doudouOUC
- fix(triage): make unattended PR review static — read CI via API, never run PR code ([#7646](https://github.com/QwenLM/qwen-code/pull/7646)) by @wenshao
- fix(triage): actually restrict the CI review agent's tools ([#7647](https://github.com/QwenLM/qwen-code/pull/7647)) by @wenshao
- fix(cli): align all TUI icon columns to a uniform 2-col width ([#7633](https://github.com/QwenLM/qwen-code/pull/7633)) by @chiga0
- fix(web-shell): show full session names on hover ([#7662](https://github.com/QwenLM/qwen-code/pull/7662)) by @wenshao
- fix(web-shell): keep git mode popover open when picking branch/worktree ([#7668](https://github.com/QwenLM/qwen-code/pull/7668)) by @wenshao

#### Performance

- perf(startup): Load undici lazily behind package-local dynamic imports ([#7455](https://github.com/QwenLM/qwen-code/pull/7455)) by @doudouOUC
- perf(web-shell): optimize long session rendering ([#7408](https://github.com/QwenLM/qwen-code/pull/7408)) by @ytahdn
- perf(startup): lazy-load Google GenAI SDK on first use ([#7512](https://github.com/QwenLM/qwen-code/pull/7512)) by @doudouOUC
- perf(cli): Defer ACP telemetry initialization ([#7558](https://github.com/QwenLM/qwen-code/pull/7558)) by @doudouOUC
- perf(cli): Propagate compile cache to ACP children ([#7594](https://github.com/QwenLM/qwen-code/pull/7594)) by @doudouOUC

#### Documentation

- docs(core): align JSDoc @param names with actual function signatures ([#7492](https://github.com/QwenLM/qwen-code/pull/7492)) by @ovochouovo
- docs(autofix): require evidenced pre-commit verification, not a bare "verified" ([#7486](https://github.com/QwenLM/qwen-code/pull/7486)) by @wenshao
- docs: refresh subagent lifecycle guidance ([#7624](https://github.com/QwenLM/qwen-code/pull/7624)) by @wenshao
- docs(autofix): apply Simplicity First when addressing review feedback ([#7643](https://github.com/QwenLM/qwen-code/pull/7643)) by @wenshao
- docs(autofix): let the agent escalate a maintainer's decision, not decide it ([#7636](https://github.com/QwenLM/qwen-code/pull/7636)) by @wenshao
- docs(triage): scale PR verification to the change, add real-run depth ([#7648](https://github.com/QwenLM/qwen-code/pull/7648)) by @wenshao

#### Internal Changes

- test(telemetry): Cover daemon metrics init ordering and document metricReader asymmetry ([#7456](https://github.com/QwenLM/qwen-code/pull/7456)) by @doudouOUC
- test(core): Cover Shell truncation without an artifact ([#7470](https://github.com/QwenLM/qwen-code/pull/7470)) by @doudouOUC
- test(core): stub the registry methods agent.ts actually calls ([#7538](https://github.com/QwenLM/qwen-code/pull/7538)) by @chinesepowered
- test(autofix): single-source the infra-signature list from the workflow ([#7565](https://github.com/QwenLM/qwen-code/pull/7565)) by @wenshao
- test: deflake write_file content assertion in tool-control E2E test ([#7613](https://github.com/QwenLM/qwen-code/pull/7613)) by @yiliang114 with @Copilot
- test(sdk-java): widen the SSE idle-watchdog margins in the slow-line test ([#7617](https://github.com/QwenLM/qwen-code/pull/7617)) by @wenshao
- test(core): pin the archived-copy usage salvage in the conflict deletion test ([#7604](https://github.com/QwenLM/qwen-code/pull/7604)) by @zjunothing
- test(triage): regression-guard the triage workflow, and make the git cleanup an allowlist ([#7660](https://github.com/QwenLM/qwen-code/pull/7660)) by @wenshao

### New Contributors

- @ovochouovo made their first contribution in [#7492](https://github.com/QwenLM/qwen-code/pull/7492)
- @Truraly made their first contribution in [#7343](https://github.com/QwenLM/qwen-code/pull/7343)
- @zjgzx1988 made their first contribution in [#7478](https://github.com/QwenLM/qwen-code/pull/7478)
- @hogeheer499-commits made their first contribution in [#7258](https://github.com/QwenLM/qwen-code/pull/7258)
- @dtometzki made their first contribution in [#7528](https://github.com/QwenLM/qwen-code/pull/7528)
- @patrick-andstar made their first contribution in [#7518](https://github.com/QwenLM/qwen-code/pull/7518)
- @WladmirJunior made their first contribution in [#7541](https://github.com/QwenLM/qwen-code/pull/7541)
- @nerdalytics made their first contribution in [#7545](https://github.com/QwenLM/qwen-code/pull/7545)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.20.1...v0.21.0

## [0.20.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.20.1) - 2026-07-21

### Highlights

_See the complete change list below._

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- feat(autofix): label-driven takeover and release; fix forced-dispatch green no-op ([#7165](https://github.com/QwenLM/qwen-code/pull/7165)) by @wenshao
- feat(autofix): direct takeover of maintainer-fork PRs ([#7213](https://github.com/QwenLM/qwen-code/pull/7213)) by @wenshao
- feat(daemon): Advertise ACP preheat readiness ([#7200](https://github.com/QwenLM/qwen-code/pull/7200)) by @doudouOUC
- feat(autofix): surface the running model in every autofix report ([#7226](https://github.com/QwenLM/qwen-code/pull/7226)) by @wenshao
- feat(review): retry transient API failures once; surface quota clearly ([#7233](https://github.com/QwenLM/qwen-code/pull/7233)) by @wenshao
- feat(core): inspect persisted conversation branches ([#7185](https://github.com/QwenLM/qwen-code/pull/7185)) by @doudouOUC
- feat(core): Route Plan-mode shell commands by safety ([#7172](https://github.com/QwenLM/qwen-code/pull/7172)) by @doudouOUC
- feat(ci): auto-open a deflake fix issue for confirmed flaky tests ([#7231](https://github.com/QwenLM/qwen-code/pull/7231)) by @wenshao
- feat(autofix): auto-manage the bot's own fork PRs without a label ([#7243](https://github.com/QwenLM/qwen-code/pull/7243)) by @wenshao
- feat(web-shell): worktree-isolated sessions for parallel tasks ([#7221](https://github.com/QwenLM/qwen-code/pull/7221)) by @wenshao
- feat(i18n): update catalan translaiton ([#7253](https://github.com/QwenLM/qwen-code/pull/7253)) by @jordimas
- feat: add CODEOWNERS for core harness modules ([#7304](https://github.com/QwenLM/qwen-code/pull/7304)) by @pomelo-nwu
- feat(web-shell): support custom slash command actions ([#7267](https://github.com/QwenLM/qwen-code/pull/7267)) by @ytahdn
- feat(web-shell): add git commit history browser ([#7204](https://github.com/QwenLM/qwen-code/pull/7204)) by @wenshao
- feat: support workspace display names ([#7179](https://github.com/QwenLM/qwen-code/pull/7179)) by @samuelhsin
- feat(channels): add content-safe memory recall telemetry ([#7338](https://github.com/QwenLM/qwen-code/pull/7338)) by @qqqys
- feat(daemon): restore worktree isolation on session load/resume ([#7262](https://github.com/QwenLM/qwen-code/pull/7262)) by @wenshao
- feat(autofix): re-arm a stranded PR with @qwen-code /retry instead of deleting a marker ([#7354](https://github.com/QwenLM/qwen-code/pull/7354)) by @wenshao
- feat(serve): make ACP initialize handshake timeout configurable ([#7246](https://github.com/QwenLM/qwen-code/pull/7246)) by @qwen-code-dev-bot
- feat(autofix): pick up managed fork PRs in real time instead of waiting for the throttled schedule ([#7350](https://github.com/QwenLM/qwen-code/pull/7350)) by @wenshao
- feat(autofix): resolve the review threads whose findings it implemented ([#7364](https://github.com/QwenLM/qwen-code/pull/7364)) by @wenshao
- feat(autofix): render the managed fleet into the scan's run summary ([#7355](https://github.com/QwenLM/qwen-code/pull/7355)) by @wenshao
- feat(core): add fork_turns to fork subagents ([#7346](https://github.com/QwenLM/qwen-code/pull/7346)) by @DragonnZhang
- feat(auth): add Singapore Token Plan region ([#7280](https://github.com/QwenLM/qwen-code/pull/7280)) by @han-dreamer
- feat(web-shell): surface worktree isolation in the new-session empty state ([#7365](https://github.com/QwenLM/qwen-code/pull/7365)) by @wenshao
- feat(core): add opt-in built-in web_search backed by the DashScope Responses API ([#7215](https://github.com/QwenLM/qwen-code/pull/7215)) by @tanzhenxin
- feat(web-shell): Add sidebar customization API for branding, navigation, session actions, and footer ([#7379](https://github.com/QwenLM/qwen-code/pull/7379)) by @yuanyuanAli
- feat(autofix): raise the strict round cap from 5 to 10 ([#7412](https://github.com/QwenLM/qwen-code/pull/7412)) by @wenshao
- feat(autofix): feed the gate's rejection back so the retry can fix what it broke ([#7368](https://github.com/QwenLM/qwen-code/pull/7368)) by @wenshao

#### Bug Fixes

- fix(autofix): stage SKILL.md beside run-agent.mjs so review-address boots (P0, regression from #7165) ([#7225](https://github.com/QwenLM/qwen-code/pull/7225)) by @wenshao
- fix(ci): consolidate issue triage ownership ([#7180](https://github.com/QwenLM/qwen-code/pull/7180)) by @yiliang114
- fix(cli): allow goal controls during active loops ([#7202](https://github.com/QwenLM/qwen-code/pull/7202)) by @yiliang114
- fix(cli): show mode indicator alongside steering hint during streaming ([#7219](https://github.com/QwenLM/qwen-code/pull/7219)) by @qwen-code-dev-bot
- fix(scripts): allow multiple dev:daemon instances by probing Vite port ([#7212](https://github.com/QwenLM/qwen-code/pull/7212)) by @wenshao
- fix(review): say an unread chunk once, under its cause ([#7234](https://github.com/QwenLM/qwen-code/pull/7234)) by @wenshao
- fix(autofix): a no-output crash must not advance the review watermark ([#7229](https://github.com/QwenLM/qwen-code/pull/7229)) by @wenshao
- fix(review): prohibit isolation param in roster output and SKILL.md ([#7235](https://github.com/QwenLM/qwen-code/pull/7235)) by @wenshao
- fix(cli): align npm update checks with global registry ([#7224](https://github.com/QwenLM/qwen-code/pull/7224)) by @yiliang114
- fix(test): deflake tool-control E2E content assertions ([#7261](https://github.com/QwenLM/qwen-code/pull/7261)) by @qwen-code-dev-bot
- fix(sdk): abort SSE request on iterator exit to release daemon subscriber ([#7257](https://github.com/QwenLM/qwen-code/pull/7257)) by @chinesepowered
- fix(core): Enforce Plan mode entry boundary ([#7248](https://github.com/QwenLM/qwen-code/pull/7248)) by @doudouOUC
- fix(channels): exclude discrete ACP messages from replies ([#7223](https://github.com/QwenLM/qwen-code/pull/7223)) by @qwen-code-dev-bot
- fix(ci): create remote-tracking ref for fork PRs in autofix verify gate ([#7281](https://github.com/QwenLM/qwen-code/pull/7281)) by @wenshao
- fix(sdk): clean up SSE requests on errors and dispose ([#7269](https://github.com/QwenLM/qwen-code/pull/7269)) by @doudouOUC
- fix(cli): repaint the TUI after OS sleep/wake or SIGCONT ([#7265](https://github.com/QwenLM/qwen-code/pull/7265)) by @wenshao
- fix(mobile-mcp): restore bounds in UI hierarchy dumps ([#7321](https://github.com/QwenLM/qwen-code/pull/7321)) by @LaZzyMan
- fix(test): stabilize 3 flaky tests (serve startup, usage-stats TTL, TasksStatusMessage keypress) ([#7319](https://github.com/QwenLM/qwen-code/pull/7319)) by @qwen-code-dev-bot
- fix(cli): Preserve cancellation during permission prompts ([#7295](https://github.com/QwenLM/qwen-code/pull/7295)) by @doudouOUC
- fix(core): estimate reasoning_tokens when completion_tokens_details is missing ([#7239](https://github.com/QwenLM/qwen-code/pull/7239)) by @yiliang114
- fix(ci): tighten API error detection to avoid false positive on review prose ([#7328](https://github.com/QwenLM/qwen-code/pull/7328)) by @wenshao
- fix(web-shell): localize extension tag labels ([#7337](https://github.com/QwenLM/qwen-code/pull/7337)) by @callmeYe
- fix(test): stabilize list_directory E2E — accept text output when model skips tool call ([#7342](https://github.com/QwenLM/qwen-code/pull/7342)) by @qwen-code-dev-bot
- fix(autofix): resolve owning package for nested paths; report verify-failed handoffs as not pushed ([#7330](https://github.com/QwenLM/qwen-code/pull/7330)) by @wenshao
- fix(review): retry gh CLI on transient GitHub errors (5xx) and keyring failures ([#7291](https://github.com/QwenLM/qwen-code/pull/7291)) by @wenshao
- fix(channels): deliver background agent replies ([#7336](https://github.com/QwenLM/qwen-code/pull/7336)) by @qwen-code-dev-bot
- fix(web-shell): proxy extension APIs without intercepting modules ([#7294](https://github.com/QwenLM/qwen-code/pull/7294)) by @ytahdn
- fix(dingtalk): retry transient emotion failures ([#7329](https://github.com/QwenLM/qwen-code/pull/7329)) by @qwen-code-dev-bot
- fix(web-shell): respect voice enabled setting ([#7345](https://github.com/QwenLM/qwen-code/pull/7345)) by @callmeYe
- fix(cli): map positional args to optional MCP prompt parameters ([#7317](https://github.com/QwenLM/qwen-code/pull/7317)) by @qwen-code-dev-bot
- fix(cli): include typed directory in /cd tab completion ([#7320](https://github.com/QwenLM/qwen-code/pull/7320)) by @qwen-code-dev-bot
- fix(review): make agent launches and cleanup resilient ([#7259](https://github.com/QwenLM/qwen-code/pull/7259)) by @wenshao
- fix(ci): stop a slow patrol classifier from killing every flaky rerun ([#7358](https://github.com/QwenLM/qwen-code/pull/7358)) by @wenshao
- fix(ci): tell a visuals coverage gap apart from "no visual change" ([#7375](https://github.com/QwenLM/qwen-code/pull/7375)) by @wenshao
- fix: ask when Auto Mode classifier is unavailable ([#7331](https://github.com/QwenLM/qwen-code/pull/7331)) by @LaZzyMan
- fix(autofix): retry a verification-gate crash instead of burying the agent's fix ([#7351](https://github.com/QwenLM/qwen-code/pull/7351)) by @wenshao
- fix(core): validate goal judge terminal evidence ([#7208](https://github.com/QwenLM/qwen-code/pull/7208)) by @qwen-code-dev-bot
- fix(core): hide interaction tools in plain headless mode ([#7285](https://github.com/QwenLM/qwen-code/pull/7285)) by @DragonnZhang
- fix(cli): show worktree branch in status line instead of workspace branch ([#7367](https://github.com/QwenLM/qwen-code/pull/7367)) by @wenshao
- fix(acp-bridge): make detachClient idempotent via per-clientId attach-ref ledger ([#7386](https://github.com/QwenLM/qwen-code/pull/7386)) by @doudouOUC
- fix(autofix): refuse a non-main takeover out loud instead of only in the job log ([#7382](https://github.com/QwenLM/qwen-code/pull/7382)) by @wenshao
- fix(cli): update npm installs safely in background ([#7322](https://github.com/QwenLM/qwen-code/pull/7322)) by @yiliang114
- fix(core): support qwen3.8 side queries on DashScope ([#7303](https://github.com/QwenLM/qwen-code/pull/7303)) by @yiliang114
- fix(autofix): retry a model API error instead of stranding the PR ([#7247](https://github.com/QwenLM/qwen-code/pull/7247)) by @wenshao
- fix(ci): stop /resolve reports from being guillotined mid-sentence ([#7389](https://github.com/QwenLM/qwen-code/pull/7389)) by @wenshao
- fix(web-shell): restore scheduled task reference interactions ([#7313](https://github.com/QwenLM/qwen-code/pull/7313)) by @BZ-D
- fix(core): bound web-fetch post-processing and preserve fetched content on failure ([#7305](https://github.com/QwenLM/qwen-code/pull/7305)) by @tanzhenxin
- fix(core): Fence concurrent ACP session writers ([#7237](https://github.com/QwenLM/qwen-code/pull/7237)) by @doudouOUC
- fix(ci): serialise the two workflows that push to a PR head branch ([#7392](https://github.com/QwenLM/qwen-code/pull/7392)) by @wenshao
- fix(web-shell): persist the daemon bearer token per-tab so it survives refresh ([#7374](https://github.com/QwenLM/qwen-code/pull/7374)) by @zjunothing
- fix(core,cli): drain background notifications outside the subagent's ALS frame ([#7194](https://github.com/QwenLM/qwen-code/pull/7194)) by @zjunothing
- fix(acp-bridge): map Windows-shaped workspace paths to their sandbox mount ([#7228](https://github.com/QwenLM/qwen-code/pull/7228)) by @zjunothing
- fix(core): salvage session usage into the history before deleting transcripts ([#7391](https://github.com/QwenLM/qwen-code/pull/7391)) by @zjunothing
- fix(core): clarify background agent continuation ([#7300](https://github.com/QwenLM/qwen-code/pull/7300)) by @DragonnZhang
- fix(transcript): mark dangling tool history incomplete ([#7340](https://github.com/QwenLM/qwen-code/pull/7340)) by @cxruan
- fix(mcp): add opt-in model payload filtering ([#7413](https://github.com/QwenLM/qwen-code/pull/7413)) by @LaZzyMan
- fix(ci): tell a triage action crash apart from a silent agent ([#7418](https://github.com/QwenLM/qwen-code/pull/7418)) by @wenshao
- fix(acp-bridge): guarantee exactly-once prompt terminal events in daemon serve mode ([#7400](https://github.com/QwenLM/qwen-code/pull/7400)) by @doudouOUC
- fix(dingtalk): anchor @mention strip regex to start of text ([#7401](https://github.com/QwenLM/qwen-code/pull/7401)) by @qwen-code-dev-bot
- fix: support context-inheriting subagents in headless mode ([#7378](https://github.com/QwenLM/qwen-code/pull/7378)) by @DragonnZhang
- fix(cli): soften update-check failure UX — warning instead of error, raise timeout to 5s ([#7409](https://github.com/QwenLM/qwen-code/pull/7409)) by @ComplexSimply
- fix(test): widen daemon boot timeout from 10s to 25s for docker sandbox ([#7419](https://github.com/QwenLM/qwen-code/pull/7419)) by @qwen-code-dev-bot
- fix: worktree sessions unopenable in Web Shell while actively running ([#7424](https://github.com/QwenLM/qwen-code/pull/7424)) by @wenshao
- fix(web-shell): restore context tags in queued and recalled prompts ([#7312](https://github.com/QwenLM/qwen-code/pull/7312)) by @dreamWB
- fix(core): resolve artifact workspacePath against workspace root in worktree sessions ([#7429](https://github.com/QwenLM/qwen-code/pull/7429)) by @wenshao
- fix(cli): classify nested update-check network errors ([#7428](https://github.com/QwenLM/qwen-code/pull/7428)) by @yiliang114
- Fixed intermittent Docker CI test failures caused by session lock files resolving outside the isolated test directory. ([#7439](https://github.com/QwenLM/qwen-code/pull/7439)) by @wenshao
- Regenerated the ink@7.0.3 patch to ensure it applies cleanly during fresh installations and prevents build errors. ([#7407](https://github.com/QwenLM/qwen-code/pull/7407)) by @chiga0
- Relaxed OpenAI wire schema constraints for optional fields to prevent models from being forced to provide mutually exclusive arguments. ([#7344](https://github.com/QwenLM/qwen-code/pull/7344)) by @zjunothing
- Added a 50MB size cap and 30-second timeout to DingTalk media downloads to match Feishu adapter behavior. ([#7361](https://github.com/QwenLM/qwen-code/pull/7361)) by @chinesepowered
- Allowed simple-git to accept restricted protocol and global config settings required for public Git extension installations. ([#7293](https://github.com/QwenLM/qwen-code/pull/7293)) by @ytahdn
- Enforced deterministic aggregate budgeting for batches of tool responses to prevent exceeding character limits across all runtimes. ([#7323](https://github.com/QwenLM/qwen-code/pull/7323)) by @doudouOUC
- Fixed Docker CI session conflicts by clearing inherited sandbox session IDs to ensure each sub-session generates a unique identifier. ([#7443](https://github.com/QwenLM/qwen-code/pull/7443)) by @wenshao

#### Performance

- perf(autofix): raise fleet simultaneity from 3 to 5 ([#7396](https://github.com/QwenLM/qwen-code/pull/7396)) by @wenshao
- perf(telemetry): lazy-load the SDK and split OTLP exporter chains by protocol ([#7276](https://github.com/QwenLM/qwen-code/pull/7276)) by @doudouOUC
- perf(autofix): stop the feedback gate waiting on the LLM review check ([#7416](https://github.com/QwenLM/qwen-code/pull/7416)) by @wenshao

#### Documentation

- docs(cli): remove stale include directories limit ([#7326](https://github.com/QwenLM/qwen-code/pull/7326)) by @ZijianZhang989

#### Internal Changes

- test: raise timeout ceiling for I/O-bound tests flaky under CI contention ([#7230](https://github.com/QwenLM/qwen-code/pull/7230)) by @wenshao
- test(autofix): exercise the SKILL stage↔resolve contract end-to-end ([#7227](https://github.com/QwenLM/qwen-code/pull/7227)) by @wenshao
- test(channels): add memory recall evaluation baseline ([#7220](https://github.com/QwenLM/qwen-code/pull/7220)) by @qwen-code-dev-bot
- test(autofix): sync workflow assertions with split model vars ([#7297](https://github.com/QwenLM/qwen-code/pull/7297)) by @yiliang114
- test(feishu): enforce markdown chunk limit assertion ([#7324](https://github.com/QwenLM/qwen-code/pull/7324)) by @ZijianZhang989
- ci: move release-note classifier from per-PR workflow to release-time batch ([#7339](https://github.com/QwenLM/qwen-code/pull/7339)) by @yiliang114
- chore: add CODEOWNERS for cua-driver and mobile-mcp ([#7369](https://github.com/QwenLM/qwen-code/pull/7369)) by @qwen-code-dev-bot
- chore: simplify CODEOWNERS to package-level rules ([#7376](https://github.com/QwenLM/qwen-code/pull/7376)) by @pomelo-nwu
- chore(docs,test): batch three small docs and test fixes ([#7373](https://github.com/QwenLM/qwen-code/pull/7373)) by @ZijianZhang989
- Added tests to verify that artifact file paths resolve correctly in both ordinary and worktree sessions. ([#7434](https://github.com/QwenLM/qwen-code/pull/7434)) by @wenshao

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.20.0...v0.20.1

## [0.20.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.20.0) - 2026-07-19

### Highlights

_See the complete change list below._

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- feat(cli): Add bounded daemon log rotation ([#6969](https://github.com/QwenLM/qwen-code/pull/6969)) by @doudouOUC
- feat(review): bake the round label into a findings role's identity line and key ([#7171](https://github.com/QwenLM/qwen-code/pull/7171)) by @wenshao
- feat(webshell): replay ChatRecord history in readonly WebShell ([#6999](https://github.com/QwenLM/qwen-code/pull/6999)) by @cxruan
- feat(ui): let the user read the full plan from the exit_plan_mode confirmation ([#7060](https://github.com/QwenLM/qwen-code/pull/7060)) by @zjunothing
- feat(providers): add qwen3.8-max-preview to Token Plan model list ([#7199](https://github.com/QwenLM/qwen-code/pull/7199)) by @qwen-code-dev-bot

#### Bug Fixes

- fix(sdk-java): preserve exception cause in AcpClient init failures ([#7189](https://github.com/QwenLM/qwen-code/pull/7189)) by @chinesepowered
- fix(web-shell): proxy /goals route in Vite dev server ([#7187](https://github.com/QwenLM/qwen-code/pull/7187)) by @wenshao
- fix(sdk-java): correct TIMEOUT_30_MINUTES to actually be 30 minutes ([#7188](https://github.com/QwenLM/qwen-code/pull/7188)) by @chinesepowered
- fix(cli): emit deferred stream-json startup warnings ([#7174](https://github.com/QwenLM/qwen-code/pull/7174)) by @barry166
- fix(review): judge a CI check by its name's latest run, not by any leftover ([#7183](https://github.com/QwenLM/qwen-code/pull/7183)) by @wenshao
- fix(review): count Step 6's inline findings from the drafted comments, never from typed numbers ([#7173](https://github.com/QwenLM/qwen-code/pull/7173)) by @wenshao
- fix(web-shell): dedupe restored images and harden the sidebar shortcut handler ([#7169](https://github.com/QwenLM/qwen-code/pull/7169)) by @zjunothing
- fix(mcp): normalize tool names for strict providers ([#6976](https://github.com/QwenLM/qwen-code/pull/6976)) by @ran411285752
- fix(core): apply native tool calling schema for gemma 4 ([#7177](https://github.com/QwenLM/qwen-code/pull/7177)) by @ghisguth
- fix(cli): share one process.stdout resize listener in useTerminalSize ([#7186](https://github.com/QwenLM/qwen-code/pull/7186)) by @mvanhorn
- fix: surface underlying .cause of OpenAI-compatible connection errors in debug log and API error message ([#7010](https://github.com/QwenLM/qwen-code/pull/7010)) by @mvanhorn
- fix(web-shell): prevent toolbar label clipping ([#7196](https://github.com/QwenLM/qwen-code/pull/7196)) by @carffuca
- fix(review): one disclosure per subject — dedupe Not-reviewed, collapse an all-built-none-launched roster ([#7190](https://github.com/QwenLM/qwen-code/pull/7190)) by @wenshao
- fix(review): an unverified Critical must not become a public blocker — soften the Request changes it rides ([#7191](https://github.com/QwenLM/qwen-code/pull/7191)) by @wenshao

#### Performance

- perf(channels): cache channel memory recall ([#7175](https://github.com/QwenLM/qwen-code/pull/7175)) by @qwen-code-dev-bot
- perf(cli): Defer TUI runtime from ACP startup ([#7182](https://github.com/QwenLM/qwen-code/pull/7182)) by @doudouOUC

#### Internal Changes

- chore(vscode-ide-companion): sync third-party notices and guard against future drift ([#7161](https://github.com/QwenLM/qwen-code/pull/7161)) by @wenshao
- ci(autofix): harden the address path against stale targets and untrusted route events ([#7163](https://github.com/QwenLM/qwen-code/pull/7163)) by @wenshao

### New Contributors

- @ghisguth made their first contribution in [#7177](https://github.com/QwenLM/qwen-code/pull/7177)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.19.12...v0.20.0

## [0.19.12](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.12) - 2026-07-18

### Highlights

_See the complete change list below._

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- feat(daemon): Trace cold first-session startup ([#6907](https://github.com/QwenLM/qwen-code/pull/6907)) by @doudouOUC
- feat(web-shell): add archived session export ([#6910](https://github.com/QwenLM/qwen-code/pull/6910)) by @doudouOUC
- feat(serve): add workspace session-info aggregate endpoint ([#7077](https://github.com/QwenLM/qwen-code/pull/7077)) by @samuelhsin
- feat(web-shell): add skill management pages ([#7018](https://github.com/QwenLM/qwen-code/pull/7018)) by @ytahdn
- feat(cli): mouse text selection and copy in VP mode ([#6937](https://github.com/QwenLM/qwen-code/pull/6937)) by @chiga0
- feat(channels): stamp daemon sourceId with channel instance name on created sessions ([#7078](https://github.com/QwenLM/qwen-code/pull/7078)) by @xurik
- feat(channels): confirm natural memory mutations ([#7066](https://github.com/QwenLM/qwen-code/pull/7066)) by @qqqys
- feat(channels): save explicit multi-fact memory safely ([#7092](https://github.com/QwenLM/qwen-code/pull/7092)) by @qqqys
- feat(serve): Complete legacy session workspace telemetry ([#7003](https://github.com/QwenLM/qwen-code/pull/7003)) by @doudouOUC
- feat(core): Enable artifact defaults and write reminders ([#7068](https://github.com/QwenLM/qwen-code/pull/7068)) by @chiga0
- feat(web-shell): suggest sending new-topic drafts in a new session ([#7098](https://github.com/QwenLM/qwen-code/pull/7098)) by @carffuca
- feat(tools): add formatDisplayPath() and wire grep/glob/ripGrep descriptions ([#7050](https://github.com/QwenLM/qwen-code/pull/7050)) by @zjunothing
- feat(daemon): propagate prompt IDs to turn events ([#7082](https://github.com/QwenLM/qwen-code/pull/7082)) by @makwingchi
- feat(web-shell): paginate restored session history ([#7064](https://github.com/QwenLM/qwen-code/pull/7064)) by @ytahdn
- feat(web-shell): toggle the session sidebar with Cmd+B / Ctrl+B ([#7135](https://github.com/QwenLM/qwen-code/pull/7135)) by @zjunothing
- feat(web-shell): add directory autocomplete to the Add Workspace dialog ([#7125](https://github.com/QwenLM/qwen-code/pull/7125)) by @zjunothing
- feat(cli): support same-turn message steering ([#7090](https://github.com/QwenLM/qwen-code/pull/7090)) by @LaZzyMan
- feat: support full-turn multimodal routing for image prompts ([#7045](https://github.com/QwenLM/qwen-code/pull/7045)) by @yiliang114
- feat(agents): support per-model sub-agent concurrency limits ([#6984](https://github.com/QwenLM/qwen-code/pull/6984)) by @qwen-code-dev-bot
- feat(cli): add daemon Todo stop guard ([#6945](https://github.com/QwenLM/qwen-code/pull/6945)) by @doudouOUC
- feat(cli): show active path in compact tool summaries ([#7043](https://github.com/QwenLM/qwen-code/pull/7043)) by @zjunothing
- feat(vscode): route logs to the Qwen Code Companion output channel ([#7121](https://github.com/QwenLM/qwen-code/pull/7121)) by @yiliang114
- feat(core): overhaul web_fetch — content fidelity, binary handling, security, and resilience ([#7146](https://github.com/QwenLM/qwen-code/pull/7146)) by @tanzhenxin
- feat(channels): expose workspace-scoped observed contacts ([#7109](https://github.com/QwenLM/qwen-code/pull/7109)) by @BenGuanRan
- feat(web-shell): persist the split view across refresh, per tab ([#7136](https://github.com/QwenLM/qwen-code/pull/7136)) by @wenshao
- feat(web-shell): add a workspace Goals page, and stop losing /goal on daemon resume ([#6561](https://github.com/QwenLM/qwen-code/pull/6561)) by @wenshao
- feat(core): improve subagent delegation defaults and guardrails ([#7048](https://github.com/QwenLM/qwen-code/pull/7048)) by @DragonnZhang
- feat(review): build every Step 5 auditor of a round in one call, identity first ([#7150](https://github.com/QwenLM/qwen-code/pull/7150)) by @wenshao
- feat(channels): observe group names from inbound messages ([#7155](https://github.com/QwenLM/qwen-code/pull/7155)) by @BenGuanRan
- feat(web-shell): git status chip, visual working-tree diff, and sidebar git status ([#7054](https://github.com/QwenLM/qwen-code/pull/7054)) by @wenshao
- feat(channels): recall relevant memory per message ([#7157](https://github.com/QwenLM/qwen-code/pull/7157)) by @qwen-code-dev-bot

#### Bug Fixes

- fix(serve): Harden multi-workspace ownership guards ([#7005](https://github.com/QwenLM/qwen-code/pull/7005)) by @doudouOUC
- fix: bound usage-only streams and abort on quit ([#7038](https://github.com/QwenLM/qwen-code/pull/7038)) by @yiliang114
- fix(acp): disambiguate model routes ([#7028](https://github.com/QwenLM/qwen-code/pull/7028)) by @yiliang114
- fix(web-shell): batch transcript dispatch to avoid tab-return freeze ([#7012](https://github.com/QwenLM/qwen-code/pull/7012)) by @wenshao
- fix(core): Require explicit approval to exit Plan mode ([#6967](https://github.com/QwenLM/qwen-code/pull/6967)) by @doudouOUC
- fix(web-shell): use formatSettingCategory for fallback UI category ([#7055](https://github.com/QwenLM/qwen-code/pull/7055)) by @wenshao
- fix(integration): add missing session_info to E2E capabilities baseline ([#7091](https://github.com/QwenLM/qwen-code/pull/7091)) by @qwen-code-dev-bot
- fix(tui): pin MaxSizedBox rows and gate the pending backstop for show-more diff (#6809) ([#6957](https://github.com/QwenLM/qwen-code/pull/6957)) by @azurecgx
- fix(integration): harden flaky interactive read-then-write test ([#7105](https://github.com/QwenLM/qwen-code/pull/7105)) by @wenshao
- fix(core): retry empty tool-result continuations ([#7039](https://github.com/QwenLM/qwen-code/pull/7039)) by @yiliang114
- fix(core): align planning and response guidance ([#7085](https://github.com/QwenLM/qwen-code/pull/7085)) by @DragonnZhang
- fix(web-shell): render built-in tag icons ([#7024](https://github.com/QwenLM/qwen-code/pull/7024)) by @callmeYe
- fix(core): force tool_choice in generateJson to prevent auto-mode classifier deadlock ([#6929](https://github.com/QwenLM/qwen-code/pull/6929)) by @qwen-code-dev-bot
- fix(ci): notify silent triage re-runs ([#7079](https://github.com/QwenLM/qwen-code/pull/7079)) by @yiliang114
- fix(cli): pop the kitty keyboard protocol after leaving the alternate screen ([#7115](https://github.com/QwenLM/qwen-code/pull/7115)) by @zjunothing
- fix(web-shell): optionally restart SSE after prompt admission ([#7080](https://github.com/QwenLM/qwen-code/pull/7080)) by @ytahdn
- fix(core): accept subagents created after startup instead of rejecting on stale cache ([#7112](https://github.com/QwenLM/qwen-code/pull/7112)) by @zjunothing
- fix(cli): keep streaming code blocks intact when split across commits ([#7020](https://github.com/QwenLM/qwen-code/pull/7020)) by @MikeWang0316tw
- fix(i18n): correct "extenison" typo in extension enable/disable scope help ([#7057](https://github.com/QwenLM/qwen-code/pull/7057)) by @chinesepowered
- fix(core): make the per-turn tool-call cap adaptive ([#7052](https://github.com/QwenLM/qwen-code/pull/7052)) by @wenshao
- fix(vscode): preserve Electron Node mode for ACP launch ([#7106](https://github.com/QwenLM/qwen-code/pull/7106)) by @yiliang114
- fix(core): preserve complete skill descriptions ([#7032](https://github.com/QwenLM/qwen-code/pull/7032)) by @callmeYe
- fix(core): persist resolved subagent model in metadata ([#7104](https://github.com/QwenLM/qwen-code/pull/7104)) by @ARE404
- fix(web-shell): stop stacking duplicate copies when restoring prompt text ([#7134](https://github.com/QwenLM/qwen-code/pull/7134)) by @zjunothing
- fix(core): retry malformed repeated thinking tags ([#7100](https://github.com/QwenLM/qwen-code/pull/7100)) by @yiliang114
- fix(cli): correct misspelled handleUpdateRecieved -> handleUpdateReceived ([#7132](https://github.com/QwenLM/qwen-code/pull/7132)) by @chinesepowered
- fix(cli): hide sticky task panel when agent is idle ([#7062](https://github.com/QwenLM/qwen-code/pull/7062)) by @qwen-code-dev-bot
- fix(cli): keep the model override when a background notification drains ([#7119](https://github.com/QwenLM/qwen-code/pull/7119)) by @zjunothing
- fix(core): align prompt tool examples with schemas ([#7088](https://github.com/QwenLM/qwen-code/pull/7088)) by @DragonnZhang
- fix(cli): require a second Ctrl+C within 1s before a real SIGINT exits the TUI ([#7129](https://github.com/QwenLM/qwen-code/pull/7129)) by @zjunothing
- fix: keep quit and stream logging reliable ([#7124](https://github.com/QwenLM/qwen-code/pull/7124)) by @yiliang114
- fix(ui): keep SkillReviewDialog right border inside the dialog container ([#7047](https://github.com/QwenLM/qwen-code/pull/7047)) by @zjunothing
- fix(core): preserve existing work in system prompt ([#7087](https://github.com/QwenLM/qwen-code/pull/7087)) by @DragonnZhang
- fix(mcp): terminate descendants after discovery timeout ([#6926](https://github.com/QwenLM/qwen-code/pull/6926)) by @morluto
- fix(review): report what the transcripts prove; build the roster in one call ([#7033](https://github.com/QwenLM/qwen-code/pull/7033)) by @wenshao
- fix(cli): establish extension store generation baseline on first read ([#7072](https://github.com/QwenLM/qwen-code/pull/7072)) by @qwen-code-dev-bot
- fix(core): remove ask_user_question from the Explore agent's toolset ([#7133](https://github.com/QwenLM/qwen-code/pull/7133)) by @zjunothing
- fix(web-shell): scope advanced table overlays ([#7097](https://github.com/QwenLM/qwen-code/pull/7097)) by @ytahdn
- fix(core): correct "supercedes" typo in plan-mode system prompt ([#7058](https://github.com/QwenLM/qwen-code/pull/7058)) by @chinesepowered
- fix(ask-user-question): accept long headers and size chips to the container width ([#7063](https://github.com/QwenLM/qwen-code/pull/7063)) by @tanzhenxin
- fix(core): canonicalize restrictive permission paths ([#6923](https://github.com/QwenLM/qwen-code/pull/6923)) by @morluto
- fix(core): align system prompt with interaction mode ([#7089](https://github.com/QwenLM/qwen-code/pull/7089)) by @DragonnZhang
- fix(memory): resolve root symlinks in isAllowedMemoryPath before creation ([#6842](https://github.com/QwenLM/qwen-code/pull/6842)) by @wenshao
- fix(core): add kimi-k3 token limits (1M context, 128K output) ([#7144](https://github.com/QwenLM/qwen-code/pull/7144)) by @tanzhenxin
- fix(integration): use lenient assertion and harden poll in interactive file-system test ([#7113](https://github.com/QwenLM/qwen-code/pull/7113)) by @qwen-code-dev-bot
- fix(core): resolve a parameter expansion in command position to its command root ([#7143](https://github.com/QwenLM/qwen-code/pull/7143)) by @wenshao
- fix(cli): make auto output language follow user input ([#6953](https://github.com/QwenLM/qwen-code/pull/6953)) by @han-dreamer
- fix(core): respect enableManagedAutoMemory in memory availability ([#6941](https://github.com/QwenLM/qwen-code/pull/6941)) by @han-dreamer
- fix(cli): tighten VP-mode controls footprint and fix shell tool indicator overlap ([#6931](https://github.com/QwenLM/qwen-code/pull/6931)) by @chiga0
- fix(acp): resolve textual @ image paths ([#7123](https://github.com/QwenLM/qwen-code/pull/7123)) by @yiliang114
- fix: correct typos in comments, a tool description, and docs ([#7131](https://github.com/QwenLM/qwen-code/pull/7131)) by @chinesepowered
- fix: harden desktop MCP permission-request lifecycle so pending prompts never hang or leak ([#7013](https://github.com/QwenLM/qwen-code/pull/7013)) by @mvanhorn
- fix(cli): correct misspelled migratedInMemorScopes -> migratedInMemoryScopes ([#7140](https://github.com/QwenLM/qwen-code/pull/7140)) by @chinesepowered
- fix(web-shell): recover new-session decisions wrapped in prose or fences ([#7122](https://github.com/QwenLM/qwen-code/pull/7122)) by @wenshao
- fix(web-shell): make approval and question overlays keyboard accessible ([#7074](https://github.com/QwenLM/qwen-code/pull/7074)) by @wenshao
- fix(cli): restore cancelled prompt after streamed output ([#7149](https://github.com/QwenLM/qwen-code/pull/7149)) by @barry166
- fix(channels): scope pairing and allowlist state by workspace ([#7065](https://github.com/QwenLM/qwen-code/pull/7065)) by @zjunothing

#### Performance

- feat(daemon): Profile ACP channel initialization ([#7145](https://github.com/QwenLM/qwen-code/pull/7145)) by @doudouOUC

#### Documentation

- docs(serve): Close multi-workspace hardening gaps ([#7019](https://github.com/QwenLM/qwen-code/pull/7019)) by @doudouOUC
- docs(cua-driver): fix broken relative-coordinate design link ([#7130](https://github.com/QwenLM/qwen-code/pull/7130)) by @chinesepowered
- docs(autofix): make bot PR comments bilingual with collapsed Chinese ([#7137](https://github.com/QwenLM/qwen-code/pull/7137)) by @wenshao

#### Internal Changes

- refactor(web-shell): drop redundant primary-workspace label ([#7035](https://github.com/QwenLM/qwen-code/pull/7035)) by @wenshao
- test(web-shell): make visual-preview captures deterministic + add workspace-sidebar scenario ([#7041](https://github.com/QwenLM/qwen-code/pull/7041)) by @wenshao
- ci(autofix): recover from generated-artifact CI gates and stop silent stalls ([#6998](https://github.com/QwenLM/qwen-code/pull/6998)) by @wenshao
- ci(autofix): run the schema gate from a trusted staged copy, not the branch tree ([#7076](https://github.com/QwenLM/qwen-code/pull/7076)) by @wenshao
- test(web-shell): align workspace sidebar visual smoke ([#7107](https://github.com/QwenLM/qwen-code/pull/7107)) by @yiliang114
- test(cli): isolate sandbox-relaunch tests from ambient QWEN_SANDBOX_IMAGE ([#7093](https://github.com/QwenLM/qwen-code/pull/7093)) by @wenshao
- ci(autofix): treat Suggestion-level review findings as actionable per AGENTS.md ([#7094](https://github.com/QwenLM/qwen-code/pull/7094)) by @wenshao
- test(serve): cover session-info regressions ([#7083](https://github.com/QwenLM/qwen-code/pull/7083)) by @samuelhsin
- test(cli): actually exercise the paste-workaround path in useKeypress ([#7141](https://github.com/QwenLM/qwen-code/pull/7141)) by @chinesepowered
- ci(autofix): fan out review targets and stop route-scan starvation ([#7127](https://github.com/QwenLM/qwen-code/pull/7127)) by @wenshao
- ci(shepherd): add Fleet Shepherd — automated unblocking of the bot-PR fleet ([#7142](https://github.com/QwenLM/qwen-code/pull/7142)) by @wenshao
- refactor(core): Classify shell safety as read-only, write, or unknown ([#7053](https://github.com/QwenLM/qwen-code/pull/7053)) by @doudouOUC

### New Contributors

- @azurecgx made their first contribution in [#6957](https://github.com/QwenLM/qwen-code/pull/6957)
- @makwingchi made their first contribution in [#7082](https://github.com/QwenLM/qwen-code/pull/7082)
- @ARE404 made their first contribution in [#7104](https://github.com/QwenLM/qwen-code/pull/7104)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.19.11...v0.19.12

## [0.19.11](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.11) - 2026-07-16

### Highlights

_See the complete change list below._

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- feat(web-shell): add workspace path lock ([#6853](https://github.com/QwenLM/qwen-code/pull/6853)) by @ytahdn
- feat(web-shell): add extension management page ([#6815](https://github.com/QwenLM/qwen-code/pull/6815)) by @ytahdn
- feat(core): emit liveness heartbeats for silent foreground shell commands ([#6876](https://github.com/QwenLM/qwen-code/pull/6876)) by @doudouOUC
- feat(cli): VP mode UX improvements ([#6885](https://github.com/QwenLM/qwen-code/pull/6885)) by @chiga0
- feat(acp): expose tool-call preparation lifecycle ([#6819](https://github.com/QwenLM/qwen-code/pull/6819)) by @ran411285752
- feat(channels): add structured channel memory management ([#6860](https://github.com/QwenLM/qwen-code/pull/6860)) by @qqqys
- feat(ci): add automated PR failure patrol ([#6766](https://github.com/QwenLM/qwen-code/pull/6766)) by @yiliang114
- feat(scripts): add local PR verification gate ([#6873](https://github.com/QwenLM/qwen-code/pull/6873)) by @callmeYe
- feat(web-shell): expose session controls to hosts ([#6906](https://github.com/QwenLM/qwen-code/pull/6906)) by @dreamWB
- feat(channels): support DingTalk webhook delivery to direct messages ([#6891](https://github.com/QwenLM/qwen-code/pull/6891)) by @BenGuanRan
- feat(core): add PDF vision bridge fallback ([#6846](https://github.com/QwenLM/qwen-code/pull/6846)) by @doudouOUC
- feat(cli): add general.notificationMode to silence per-approval notifications (#6898) ([#6922](https://github.com/QwenLM/qwen-code/pull/6922)) by @C0d3N1nja97342
- feat(web-shell): use popovers for composer controls ([#6877](https://github.com/QwenLM/qwen-code/pull/6877)) by @ytahdn
- feat(cli): change default approval mode from default to auto ([#6899](https://github.com/QwenLM/qwen-code/pull/6899)) by @pomelo-nwu
- feat(cli): add /learn command for user-initiated skill creation ([#6440](https://github.com/QwenLM/qwen-code/pull/6440)) by @LaZzyMan
- feat(web-shell): auto-post visual previews (screenshots + flow GIFs) on PRs ([#6880](https://github.com/QwenLM/qwen-code/pull/6880)) by @wenshao
- feat(daemon): add immutable session source metadata ([#6932](https://github.com/QwenLM/qwen-code/pull/6932)) by @ytahdn
- feat(web-shell): add zoom, pan and drag controls to Mermaid diagrams ([#6881](https://github.com/QwenLM/qwen-code/pull/6881)) by @yuanyuanAli
- feat(review): build the Step 4 verifier and Step 5 reverse-audit prompts in code ([#6942](https://github.com/QwenLM/qwen-code/pull/6942)) by @wenshao
- feat(web-shell): maximize a single split pane ([#6951](https://github.com/QwenLM/qwen-code/pull/6951)) by @wenshao
- feat(cli): Add archived session export ([#6911](https://github.com/QwenLM/qwen-code/pull/6911)) by @doudouOUC
- feat(web-shell): show sessions awaiting user action ([#6956](https://github.com/QwenLM/qwen-code/pull/6956)) by @ytahdn
- feat(review): prove Step 4 (verify) and Step 5 (reverse audit) actually ran ([#6965](https://github.com/QwenLM/qwen-code/pull/6965)) by @wenshao
- feat(channels): support natural memory references ([#6952](https://github.com/QwenLM/qwen-code/pull/6952)) by @qqqys
- feat(daemon): add stateless generation SSE ([#6947](https://github.com/QwenLM/qwen-code/pull/6947)) by @ytahdn
- feat(daemon): Aggregate deep health across workspaces ([#6961](https://github.com/QwenLM/qwen-code/pull/6961)) by @doudouOUC
- feat(serve): add workspace MCP management ([#6954](https://github.com/QwenLM/qwen-code/pull/6954)) by @ytahdn
- feat(web-shell): color-code each split pane by workspace ([#6971](https://github.com/QwenLM/qwen-code/pull/6971)) by @wenshao
- feat(review): fold the findings list into the verify/reverse-audit prompt ([#6994](https://github.com/QwenLM/qwen-code/pull/6994)) by @wenshao
- feat(channels): tag daemon sessions with channel source ([#6991](https://github.com/QwenLM/qwen-code/pull/6991)) by @xurik

#### Bug Fixes

- fix(web-shell): improve file search and composer focus ([#6845](https://github.com/QwenLM/qwen-code/pull/6845)) by @ytahdn
- fix(web-shell): prevent composer tag update loop ([#6859](https://github.com/QwenLM/qwen-code/pull/6859)) by @ytahdn
- fix(web-shell): make composer height adaptive ([#6872](https://github.com/QwenLM/qwen-code/pull/6872)) by @dreamWB
- fix(web-shell): remove duplicate useWebShellPortalRoot import in ChatEditor ([#6890](https://github.com/QwenLM/qwen-code/pull/6890)) by @C0d3N1nja97342
- fix(ci): skip empty SDK release PR ([#6861](https://github.com/QwenLM/qwen-code/pull/6861)) by @yiliang114
- fix(ci): avoid apt on self-hosted Playwright smoke ([#6865](https://github.com/QwenLM/qwen-code/pull/6865)) by @yiliang114
- fix(webui): honor follow-up accept callback suppression ([#6862](https://github.com/QwenLM/qwen-code/pull/6862)) by @yiliang114
- fix(cli): wrap long compact tool summaries ([#6847](https://github.com/QwenLM/qwen-code/pull/6847)) by @han-dreamer
- fix(web-shell): persist collapsed session group sections across reload ([#6878](https://github.com/QwenLM/qwen-code/pull/6878)) by @samuelhsin
- fix(cli): avoid updating active CLI processes ([#6874](https://github.com/QwenLM/qwen-code/pull/6874)) by @yiliang114
- fix(dingtalk): refresh token for inbound media ([#6903](https://github.com/QwenLM/qwen-code/pull/6903)) by @qqqys
- fix(vscode): run ACP process in Electron Node mode ([#6866](https://github.com/QwenLM/qwen-code/pull/6866)) by @yiliang114
- fix(cli): keep exit_plan_mode plan visible inside the pending viewport clamp (#6867) ([#6882](https://github.com/QwenLM/qwen-code/pull/6882)) by @C0d3N1nja97342
- fix(test): isolate WeCom temporary files across concurrent CI jobs ([#6908](https://github.com/QwenLM/qwen-code/pull/6908)) by @yiliang114
- fix(core): preserve display output for malformed tool results ([#6925](https://github.com/QwenLM/qwen-code/pull/6925)) by @morluto
- fix(vscode-companion): accurate image-size messages and formatFileSize units ([#6904](https://github.com/QwenLM/qwen-code/pull/6904)) by @chinesepowered
- fix(vscode-companion): don't let a non-boundary @ suppress / completion ([#6902](https://github.com/QwenLM/qwen-code/pull/6902)) by @chinesepowered
- fix(cli): don't mutate cached trusted-folders config on preview trust check ([#6900](https://github.com/QwenLM/qwen-code/pull/6900)) by @AriaZhao-coder
- fix(mcp): require trust for read-only auto-approval ([#6924](https://github.com/QwenLM/qwen-code/pull/6924)) by @morluto
- fix(cli): apply FETCH_TIMEOUT_MS to /update version check and log fetchInfo results (#6857) ([#6887](https://github.com/QwenLM/qwen-code/pull/6887)) by @C0d3N1nja97342
- fix(core): include skill results in microcompaction ([#6788](https://github.com/QwenLM/qwen-code/pull/6788)) by @han-dreamer
- fix(core): handle unsigned Claude thinking from proxies ([#6893](https://github.com/QwenLM/qwen-code/pull/6893)) by @yiliang114
- fix(config): reject fractional session and tool-call limits ([#6920](https://github.com/QwenLM/qwen-code/pull/6920)) by @morluto
- fix(web-shell): Harden non-primary session archive actions ([#6912](https://github.com/QwenLM/qwen-code/pull/6912)) by @doudouOUC
- fix(core): sanitize standalone closing thinking tags ([#6854](https://github.com/QwenLM/qwen-code/pull/6854)) by @yiliang114
- fix(webui): route useLocalStorage functional updates through prev state ([#6905](https://github.com/QwenLM/qwen-code/pull/6905)) by @chinesepowered
- fix(core): Classify shell timeouts as tool errors ([#6864](https://github.com/QwenLM/qwen-code/pull/6864)) by @doudouOUC
- fix(web-shell): restore portal root hook import ([#6934](https://github.com/QwenLM/qwen-code/pull/6934)) by @yiliang114
- fix(review): prove the diff was read, build every agent's prompt, and compute the verdict ([#6892](https://github.com/QwenLM/qwen-code/pull/6892)) by @wenshao
- fix(core): roll back failed max-token continuation attempts ([#6921](https://github.com/QwenLM/qwen-code/pull/6921)) by @morluto
- fix(cli): isolate submit tests from inherited QWEN_CODE_SESSION_ID ([#6944](https://github.com/QwenLM/qwen-code/pull/6944)) by @qwen-code-dev-bot
- fix(web-shell): show workspace chip tooltip on narrow composer ([#6958](https://github.com/QwenLM/qwen-code/pull/6958)) by @wenshao
- fix(test): widen second-turn phase timeouts in stdin-close E2E test (#6966) ([#6973](https://github.com/QwenLM/qwen-code/pull/6973)) by @qwen-code-dev-bot
- fix(wecom): prevent requireMention from disabling group chat ([#6948](https://github.com/QwenLM/qwen-code/pull/6948)) by @BenGuanRan
- fix(cua-driver): harden MCP tool reliability ([#6968](https://github.com/QwenLM/qwen-code/pull/6968)) by @LaZzyMan
- fix(cron): add deterministic test seam for cron-interactive E2E ([#6987](https://github.com/QwenLM/qwen-code/pull/6987)) by @yiliang114
- fix(test): widen model-response timeouts in SDK E2E tests for CI stability (#6979) ([#6985](https://github.com/QwenLM/qwen-code/pull/6985)) by @qwen-code-dev-bot
- fix(cli): Preserve channel startup failure details ([#6950](https://github.com/QwenLM/qwen-code/pull/6950)) by @doudouOUC
- fix(web-shell): filter sessions by source ([#6995](https://github.com/QwenLM/qwen-code/pull/6995)) by @ytahdn
- fix(web-shell): land on the split's first pane when a shrink folds the split ([#7000](https://github.com/QwenLM/qwen-code/pull/7000)) by @wenshao
- fix(headless): run concurrency-safe tool calls in parallel ([#6993](https://github.com/QwenLM/qwen-code/pull/6993)) by @wenshao
- fix(shell): handle command-specific exit codes ([#7011](https://github.com/QwenLM/qwen-code/pull/7011)) by @ytahdn
- fix(core): preserve MCP OAuth challenges from HTTP handshakes ([#7022](https://github.com/QwenLM/qwen-code/pull/7022)) by @ytahdn

#### Performance

- perf(review): scope Agent 7's build/test to the workspaces the diff changed ([#6955](https://github.com/QwenLM/qwen-code/pull/6955)) by @wenshao

#### Documentation

- docs(review): cap PR scope after repeated review rounds ([#6848](https://github.com/QwenLM/qwen-code/pull/6848)) by @wenshao
- docs: make local PR verification optional ([#7025](https://github.com/QwenLM/qwen-code/pull/7025)) by @callmeYe

#### Internal Changes

- ci(release): finalize stable releases asynchronously ([#6868](https://github.com/QwenLM/qwen-code/pull/6868)) by @yiliang114
- ci(web-shell): stop visual previews firing on SDK-only PRs ([#6959](https://github.com/QwenLM/qwen-code/pull/6959)) by @wenshao
- ci: quarantine cron-interactive from push E2E to nightly-only ([#6986](https://github.com/QwenLM/qwen-code/pull/6986)) by @yiliang114
- chore: update default model to qwen3.7-max ([#6978](https://github.com/QwenLM/qwen-code/pull/6978)) by @qwen-code-dev-bot
- test(web-shell): add mermaid, split-view + sidebar visual scenarios ([#6964](https://github.com/QwenLM/qwen-code/pull/6964)) by @wenshao
- ci(serve): daemon A/B before/after preview on response-surface PRs ([#6975](https://github.com/QwenLM/qwen-code/pull/6975)) by @wenshao
- ci(web-shell): before/after visual previews, showing only changed views ([#6963](https://github.com/QwenLM/qwen-code/pull/6963)) by @wenshao
- revert: remove local PR verification gate ([#7031](https://github.com/QwenLM/qwen-code/pull/7031)) by @callmeYe
- Added a new visual test scenario for the Extensions manager page to detect layout regressions in dark and light themes. ([#6997](https://github.com/QwenLM/qwen-code/pull/6997)) by @wenshao

### New Contributors

- @ran411285752 made their first contribution in [#6819](https://github.com/QwenLM/qwen-code/pull/6819)
- @morluto made their first contribution in [#6925](https://github.com/QwenLM/qwen-code/pull/6925)
- @AriaZhao-coder made their first contribution in [#6900](https://github.com/QwenLM/qwen-code/pull/6900)
- @xurik made their first contribution in [#6991](https://github.com/QwenLM/qwen-code/pull/6991)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.19.10...v0.19.11

## [0.19.10](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.10) - 2026-07-14

### Highlights

- Multi-workspace support now spans ACP transport, daemon workers, split-view sessions, and workspace-aware actions. ([#6621](https://github.com/QwenLM/qwen-code/pull/6621), [#6635](https://github.com/QwenLM/qwen-code/pull/6635), [#6746](https://github.com/QwenLM/qwen-code/pull/6746), [#6724](https://github.com/QwenLM/qwen-code/pull/6724))
- Web Shell gains an artifact panel, a modernized sidebar and settings experience, and editable user-level model configuration. ([#6591](https://github.com/QwenLM/qwen-code/pull/6591), [#6804](https://github.com/QwenLM/qwen-code/pull/6804), [#6817](https://github.com/QwenLM/qwen-code/pull/6817), [#6768](https://github.com/QwenLM/qwen-code/pull/6768))
- Session and model recovery is more resilient to malformed streams, leaked protocol turns, OAuth expiry, and daemon restarts. ([#6794](https://github.com/QwenLM/qwen-code/pull/6794), [#6683](https://github.com/QwenLM/qwen-code/pull/6683), [#6732](https://github.com/QwenLM/qwen-code/pull/6732), [#6680](https://github.com/QwenLM/qwen-code/pull/6680))
- Subagents are easier to follow with richer live command context, transcript paths, a chronological timeline, and inherited Explore models. ([#6580](https://github.com/QwenLM/qwen-code/pull/6580), [#6772](https://github.com/QwenLM/qwen-code/pull/6772), [#6807](https://github.com/QwenLM/qwen-code/pull/6807))
- CLI workflows gain project-scoped prompt stashes, visible Git branches, configurable shell timeouts, and safer memory-pressure handling. ([#6709](https://github.com/QwenLM/qwen-code/pull/6709), [#6725](https://github.com/QwenLM/qwen-code/pull/6725), [#6628](https://github.com/QwenLM/qwen-code/pull/6628), [#6682](https://github.com/QwenLM/qwen-code/pull/6682))
- SDK and daemon integrations can now control effort, models, usage, context, transport options, and runtime channels. ([#6492](https://github.com/QwenLM/qwen-code/pull/6492), [#6491](https://github.com/QwenLM/qwen-code/pull/6491), [#6741](https://github.com/QwenLM/qwen-code/pull/6741))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- SDK-hosted agents now forward user answers from ask_user_question tool approvals back to the model, enabling interactive question flows in TypeScript and Python SDK integrations. ([#6655](https://github.com/QwenLM/qwen-code/pull/6655)) by @TianYuan1024
- DingTalk channels can now optionally mention group message senders in bot replies using visible @ tokens, with Markdown rendering preserved for replies without mentions. ([#6679](https://github.com/QwenLM/qwen-code/pull/6679)) by @qqqys
- Web shell now includes a right-side review panel for inspecting edited files, artifacts, and scheduled tasks with diffs, file navigation, and session-scoped tabs. ([#6591](https://github.com/QwenLM/qwen-code/pull/6591)) by @ytahdn
- Daemon now supports workspace-qualified ACP endpoints, allowing SDK and web shell clients to open sessions scoped to specific workspaces in multi-workspace deployments. ([#6621](https://github.com/QwenLM/qwen-code/pull/6621)) by @doudouOUC
- Adds a composer header render slot and an opt-in mobile welcome footer placement so embedders can show custom content above the composer on small screens. ([#6584](https://github.com/QwenLM/qwen-code/pull/6584)) by @yuanyuanAli
- Adds SDK methods to control reasoning effort, list available models, and query account and context usage statistics at runtime. ([#6492](https://github.com/QwenLM/qwen-code/pull/6492)) by @juhuan
- Expanding thinking blocks with Alt+T during streaming now displays the full reasoning content in real-time instead of a truncated preview. ([#6678](https://github.com/QwenLM/qwen-code/pull/6678)) by @huww98
- Scheduled task prompts now support inline extension, skill, and MCP reference tags via floating pickers that serialize cleanly into the saved prompt text. ([#6589](https://github.com/QwenLM/qwen-code/pull/6589)) by @BZ-D
- Pressing Ctrl+S with a non-empty prompt now stashes it for the current project and restores it on the next launch, clearing the stash upon submission. ([#6709](https://github.com/QwenLM/qwen-code/pull/6709)) by @destire-mio
- Session recovery now uses a unified plan across all entrypoints, consistently handling interrupted prompts, dangling tool calls, and degraded history. ([#6731](https://github.com/QwenLM/qwen-code/pull/6731)) by @water-in-stone
- Subagent views now show untruncated live commands, deeper progress history, execution transcript paths, and recent tool context on inline approvals. ([#6580](https://github.com/QwenLM/qwen-code/pull/6580)) by @TianYuan1024
- The qwen serve daemon can now host channel workers for multiple trusted workspaces, binding each worker to its respective workspace directory. ([#6635](https://github.com/QwenLM/qwen-code/pull/6635)) by @doudouOUC
- A new MessageDisplay hook fires incrementally during assistant streaming, allowing observers to track reply text before the turn completes. ([#6489](https://github.com/QwenLM/qwen-code/pull/6489)) by @yanchenko
- Double-clicking a cell in a rendered Markdown table now opens a dialog with the full cell value for easy reading and copying. ([#6530](https://github.com/QwenLM/qwen-code/pull/6530)) by @jifeng
- The daemon now exposes read-only session catalogs for untrusted workspaces, letting clients browse sessions without write access. ([#6717](https://github.com/QwenLM/qwen-code/pull/6717)) by @doudouOUC
- Workspace registrations added at runtime are now persisted so they survive daemon restarts without manual reconfiguration. ([#6716](https://github.com/QwenLM/qwen-code/pull/6716)) by @doudouOUC
- User messages in the web shell now render extension, skill, and MCP reference tags inline, matching the composer preview. ([#6537](https://github.com/QwenLM/qwen-code/pull/6537)) by @ever-o
- Channel workers now reconnect automatically when the daemon restarts, restoring DingTalk and Feishu sessions without manual intervention. ([#6680](https://github.com/QwenLM/qwen-code/pull/6680)) by @qqqys
- The composer toolbar now displays the current Git branch as a chip so you always know which branch you're working on. ([#6725](https://github.com/QwenLM/qwen-code/pull/6725)) by @han-dreamer
- Foreground shell commands now respect a configurable default timeout, preventing long-running commands from blocking indefinitely. ([#6628](https://github.com/QwenLM/qwen-code/pull/6628)) by @Nas01010101
- Both the TypeScript and Python SDKs now expose transport selection and query options for finer control over daemon communication. ([#6491](https://github.com/QwenLM/qwen-code/pull/6491)) by @juhuan
- The web shell session sidebar is now configurable, letting embedders choose which session metadata and actions to display. ([#6750](https://github.com/QwenLM/qwen-code/pull/6750)) by @dreamWB
- Workspace transcript reader now provides persisted conversation history per workspace for server-side session browsing. ([#6740](https://github.com/QwenLM/qwen-code/pull/6740)) by @doudouOUC
- Session groups in the web shell now support custom Hex color codes for easier visual organization. ([#6752](https://github.com/QwenLM/qwen-code/pull/6752)) by @samuelhsin
- The composer model selector has been redesigned with clearer model metadata and faster switching. ([#6758](https://github.com/QwenLM/qwen-code/pull/6758)) by @dreamWB
- Code review now includes procedural correctness checks, adjustable effort levels, and guardrails that verify findings before posting. ([#6711](https://github.com/QwenLM/qwen-code/pull/6711)) by @wenshao
- Multi-workspace split view now supports cross-workspace sessions, workspace labels, and a responsive layout for side-by-side editing. ([#6746](https://github.com/QwenLM/qwen-code/pull/6746)) by @wenshao
- Scheduled tasks from all workspaces are now aggregated into a single view in the web shell for easier monitoring. ([#6759](https://github.com/QwenLM/qwen-code/pull/6759)) by @wenshao
- The composer now accepts custom placeholder text, allowing embedders to show context-specific prompts to users. ([#6765](https://github.com/QwenLM/qwen-code/pull/6765)) by @dreamWB
- Release notes are now drafted with AI assistance, summarizing changes from the full commit range into categorized, user-facing bullets. ([#6756](https://github.com/QwenLM/qwen-code/pull/6756)) by @yiliang114
- Web shell now ships a shadcn-based UI foundation with consistent design tokens and accessible component primitives. ([#6760](https://github.com/QwenLM/qwen-code/pull/6760)) by @ytahdn
- Sub-agent activity is now shown as a chronological transcript with a parallel-agent timeline for easier multi-task inspection. ([#6772](https://github.com/QwenLM/qwen-code/pull/6772)) by @wenshao
- The CLI can now start, stop, and list daemon channel workers at runtime without restarting the daemon process. ([#6741](https://github.com/QwenLM/qwen-code/pull/6741)) by @doudouOUC
- Persisted conversation transcripts are now bounded to prevent unbounded disk growth. ([#6769](https://github.com/QwenLM/qwen-code/pull/6769)) by @doudouOUC
- Web shell fires a callback when a new session is created, enabling custom integrations. ([#6703](https://github.com/QwenLM/qwen-code/pull/6703)) by @ytahdn
- Skill installation paths are now exposed so users can see where skills are stored. ([#6811](https://github.com/QwenLM/qwen-code/pull/6811)) by @callmeYe
- Multi-workspace sidebar redesigned with a cleaner, more modern layout. ([#6804](https://github.com/QwenLM/qwen-code/pull/6804)) by @ytahdn
- Settings page refreshed with a modern component library for a polished look and feel. ([#6817](https://github.com/QwenLM/qwen-code/pull/6817)) by @ytahdn
- User-scope settings can now be edited directly in the panel, with in-panel model management. ([#6768](https://github.com/QwenLM/qwen-code/pull/6768)) by @wenshao
- Rewind and shell actions now work across multiple workspaces. ([#6826](https://github.com/QwenLM/qwen-code/pull/6826)) by @doudouOUC
- Workspaces can now be removed at runtime without restarting the server. ([#6745](https://github.com/QwenLM/qwen-code/pull/6745)) by @doudouOUC
- Code review now captures untracked files, resolves anchors from snippets, and gates posting in code. ([#6771](https://github.com/QwenLM/qwen-code/pull/6771)) by @wenshao
- PR triage comments now include a confidence score, sequence diagram, files overview, and review footer. ([#6789](https://github.com/QwenLM/qwen-code/pull/6789)) by @wenshao
- Explore subagent now inherits the main model by default instead of using a fixed smaller model. ([#6807](https://github.com/QwenLM/qwen-code/pull/6807)) by @tanzhenxin
- Daemon status now reports model API error counts and retry metrics. ([#6837](https://github.com/QwenLM/qwen-code/pull/6837)) by @wenshao
- New API endpoint lets you toggle workspace skills programmatically. ([#6816](https://github.com/QwenLM/qwen-code/pull/6816)) by @callmeYe
- Added xAI Grok as a built-in model provider preset. ([#6805](https://github.com/QwenLM/qwen-code/pull/6805)) by @TianYuan1024
- Extension management upgraded to v2 with improved install, update, and removal flows. ([#6825](https://github.com/QwenLM/qwen-code/pull/6825)) by @doudouOUC
- Voice input is now qualified per workspace for better multi-workspace support. ([#6839](https://github.com/QwenLM/qwen-code/pull/6839)) by @doudouOUC
- Session export is now workspace-qualified so exports stay organized across workspaces. ([#6844](https://github.com/QwenLM/qwen-code/pull/6844)) by @doudouOUC
- Markdown tables in web shell now show row, column, and cell selection statistics. ([#6838](https://github.com/QwenLM/qwen-code/pull/6838)) by @jifeng

#### Bug Fixes

- YOLO approval mode is no longer silently disabled when the model enters plan mode. ([#6630](https://github.com/QwenLM/qwen-code/pull/6630)) by @Nas01010101
- Approval mode UI labels and notices are now localized, preventing mixed-language output when cycling modes with Shift+Tab in non-English interfaces. ([#6592](https://github.com/QwenLM/qwen-code/pull/6592)) by @han-dreamer
- Channel delivery now filters out nested subagent output, preventing intermediate research reports from being sent to messaging platforms before the root agent's final answer. ([#6696](https://github.com/QwenLM/qwen-code/pull/6696)) by @qqqys
- Raised prepared npm package size limit from 80 MB to 96 MB to accommodate natural growth and unblock Docker sandbox builds. ([#6691](https://github.com/QwenLM/qwen-code/pull/6691)) by @qwen-code-dev-bot
- Fixed Docker sandbox networking for protocol tag retry tests, enabling CLI to reach test servers via host.docker.internal when running in container sandbox mode. ([#6692](https://github.com/QwenLM/qwen-code/pull/6692)) by @qwen-code-dev-bot
- Fixed cursor position being incorrectly overridden when set to the start of a line in VS Code. ([#2971](https://github.com/QwenLM/qwen-code/pull/2971)) by @chinesepowered
- Fixes out-of-memory crashes on exit during long interactive sessions by running periodic memory-pressure checks even when no tool calls occur. ([#6682](https://github.com/QwenLM/qwen-code/pull/6682)) by @yiliang114
- Reduces token usage in mobile UI dumps by stripping bounds attributes with negative coordinates for partially off-screen elements. ([#6624](https://github.com/QwenLM/qwen-code/pull/6624)) by @chinesepowered
- Fixes leaked protocol tags in responses by discarding and retrying invalid assistant turns during max-token escalation and continuation recovery. ([#6683](https://github.com/QwenLM/qwen-code/pull/6683)) by @yiliang114
- Updates test expectations to match the new automated PR review workflow timeout values, resolving continuous integration failures. ([#6720](https://github.com/QwenLM/qwen-code/pull/6720)) by @yiliang114
- Improves plan mode reliability by returning a clear error response when non-read-only tools are blocked, preventing the model from attempting workarounds. ([#6667](https://github.com/QwenLM/qwen-code/pull/6667)) by @Alex-ai-future
- Adds an Approve button to the /mcp server detail view, allowing users to approve pending or previously rejected workspace servers. ([#6518](https://github.com/QwenLM/qwen-code/pull/6518)) by @LaZzyMan
- Fixes remote MCP connection failures by preserving URL query parameters and fragments that end with a trailing slash during normalization. ([#6587](https://github.com/QwenLM/qwen-code/pull/6587)) by @VectorPeak
- Fixes subagent startup failures by restricting template placeholders to valid identifiers, treating numeric patterns like ${0} as literal text. ([#6672](https://github.com/QwenLM/qwen-code/pull/6672)) by @ksws00684315
- When running as an ACP agent, the user's typed instruction is now placed after attached file content so models prioritize the actual request. ([#6607](https://github.com/QwenLM/qwen-code/pull/6607)) by @kaymeer
- The ACP readTextFile fallback now rejects fractional line and limit values, returning consistent invalid parameter errors for malformed read windows. ([#6704](https://github.com/QwenLM/qwen-code/pull/6704)) by @VectorPeak
- The Add Workspace dialog now respects light and dark themes, and multi-workspace session lists restore full row features and per-session actions. ([#6705](https://github.com/QwenLM/qwen-code/pull/6705)) by @wenshao
- DingTalk Stream connections are now treated as ready when the socket is open, preventing healthy sessions from being disconnected due to missing registration frames. ([#6715](https://github.com/QwenLM/qwen-code/pull/6715)) by @qqqys
- Trusted non-primary workspaces can now update session pin, group, and color state via a new workspace-scoped organization endpoint. ([#6724](https://github.com/QwenLM/qwen-code/pull/6724)) by @doudouOUC
- Claude Opus 4.6, 4.7, and 4.8 models now default to a 1M context window and 128K output limit, preventing premature compaction. ([#6718](https://github.com/QwenLM/qwen-code/pull/6718)) by @yiliang114
- Clipboard image pasting now works correctly in standalone desktop builds. ([#6708](https://github.com/QwenLM/qwen-code/pull/6708)) by @zjunothing
- Saved memory instructions are now refreshed immediately after using the remember command. ([#6497](https://github.com/QwenLM/qwen-code/pull/6497)) by @han-dreamer
- Goal evaluation is now lifecycle-safe, preventing errors during session teardown. ([#6681](https://github.com/QwenLM/qwen-code/pull/6681)) by @qqqys
- Managed memory entries are now preserved during microcompaction instead of being dropped. ([#6714](https://github.com/QwenLM/qwen-code/pull/6714)) by @yiliang114
- Claude output token limits now use decimal values for more accurate context budgeting. ([#6735](https://github.com/QwenLM/qwen-code/pull/6735)) by @yiliang114
- Model and approval-mode changes now apply correctly to non-primary workspace sessions in the web shell. ([#6737](https://github.com/QwenLM/qwen-code/pull/6737)) by @wenshao
- The agent no longer crashes when receiving repeated invalid model streams and recovers gracefully. ([#6712](https://github.com/QwenLM/qwen-code/pull/6712)) by @yiliang114
- OAuth authentication for MCP servers now recovers automatically after an HTTP 401 response. ([#6732](https://github.com/QwenLM/qwen-code/pull/6732)) by @yiliang114
- Inline tag tooltips in the web shell no longer appear as duplicates. ([#6729](https://github.com/QwenLM/qwen-code/pull/6729)) by @dreamWB
- Goal judge verdicts now ignore reasoning content and evaluate only the final answer. ([#6738](https://github.com/QwenLM/qwen-code/pull/6738)) by @qqqys
- The Scheduled Tasks dialog now shows correct tag icons instead of stale references. ([#6748](https://github.com/QwenLM/qwen-code/pull/6748)) by @wenshao
- The Git branch chip in the composer no longer pushes toolbar controls off-screen on narrow windows. ([#6753](https://github.com/QwenLM/qwen-code/pull/6753)) by @wenshao
- Chat recording failures are now persisted and surfaced to the user instead of failing silently. ([#6743](https://github.com/QwenLM/qwen-code/pull/6743)) by @doudouOUC
- Malformed streamed responses from the model are now retried automatically. ([#6754](https://github.com/QwenLM/qwen-code/pull/6754)) by @yiliang114
- When plan mode blocks write actions the agent is guided to use read-only tools instead of stopping. ([#6764](https://github.com/QwenLM/qwen-code/pull/6764)) by @Alex-ai-future
- Feishu credentials are now validated before starting the WebSocket connection, preventing silent failures. ([#6780](https://github.com/QwenLM/qwen-code/pull/6780)) by @BenGuanRan
- Desktop release notes are now truncated to avoid oversized payloads in CI. ([#6792](https://github.com/QwenLM/qwen-code/pull/6792)) by @DragonnZhang
- Session actions are now routed to the correct owning workspace in multi-workspace setups. ([#6798](https://github.com/QwenLM/qwen-code/pull/6798)) by @doudouOUC
- The web UI now links to the workspace-local SDK package, unblocking SDK publishing. ([#6823](https://github.com/QwenLM/qwen-code/pull/6823)) by @qwen-code-dev-bot
- Code review no longer drops live blockers and now verifies that new tests actually gate the changed code. ([#6790](https://github.com/QwenLM/qwen-code/pull/6790)) by @wenshao
- Slash-command output in channels is now visually distinguished from regular messages. ([#6818](https://github.com/QwenLM/qwen-code/pull/6818)) by @qqqys
- Packaged dialog styles are restored under React 18 in the web shell. ([#6827](https://github.com/QwenLM/qwen-code/pull/6827)) by @ytahdn
- Reasoning duration displays now show more accurate and refined timing information. ([#6793](https://github.com/QwenLM/qwen-code/pull/6793)) by @tanzhenxin
- Session continue, language selection, and artifact actions are now routed to the correct workspace owner. ([#6833](https://github.com/QwenLM/qwen-code/pull/6833)) by @doudouOUC
- LRU cache entries are now correctly reordered on access even when the stored value is falsy. ([#6787](https://github.com/QwenLM/qwen-code/pull/6787)) by @chinesepowered
- The latest-active timestamp for sessions is now computed from the real activity time, not the current wall clock. ([#6834](https://github.com/QwenLM/qwen-code/pull/6834)) by @chinesepowered
- Rewrites queued while waiting for pending rewrites to finish are now fully drained before proceeding. ([#6800](https://github.com/QwenLM/qwen-code/pull/6800)) by @chinesepowered
- The LLM rewriter now limits its output history to the configured context turn window. ([#6799](https://github.com/QwenLM/qwen-code/pull/6799)) by @chinesepowered
- Only a trailing .git suffix is stripped from GitHub repo names, preserving internal .git segments. ([#6797](https://github.com/QwenLM/qwen-code/pull/6797)) by @chinesepowered
- Dotfiles such as .eslintrc are now detected and assigned the correct language from their file path. ([#6785](https://github.com/QwenLM/qwen-code/pull/6785)) by @chinesepowered
- Fixed a security issue where angle brackets in insight report data could break out of script contexts. ([#6802](https://github.com/QwenLM/qwen-code/pull/6802)) by @chinesepowered
- Review chunk agents now receive properly constructed prompts so they no longer run without context. ([#6840](https://github.com/QwenLM/qwen-code/pull/6840)) by @wenshao
- Reintroduced retry logic for malformed streaming responses with more precise detection to avoid false positives. ([#6794](https://github.com/QwenLM/qwen-code/pull/6794)) by @yiliang114
- Review coverage is now verified using the test harness's own records for accurate results. ([#6843](https://github.com/QwenLM/qwen-code/pull/6843)) by @wenshao
- Increased the browser daemon bundle size limit to 156 KB to accommodate larger builds. ([#6852](https://github.com/QwenLM/qwen-code/pull/6852)) by @qwen-code-dev-bot

#### Performance

- Improved startup performance by lazy-loading the tree-sitter parser runtime. ([#6747](https://github.com/QwenLM/qwen-code/pull/6747)) by @dexhunter
- Reduced the number of Git snapshot processes spawned during sessions for better performance. ([#6784](https://github.com/QwenLM/qwen-code/pull/6784)) by @dexhunter

#### Documentation

- Development workflow now includes a bounded self-audit step between build and review, requiring authors to verify changes with full context before declaring work complete. ([#6685](https://github.com/QwenLM/qwen-code/pull/6685)) by @wenshao
- Corrected inaccurate token limit comment and fixed typos in core package code comments with no behavior changes. ([#6698](https://github.com/QwenLM/qwen-code/pull/6698)) by @chinesepowered

#### Internal Changes

- Increases the default automated PR review timeout to 180 minutes and allows overrides up to 240 minutes to prevent timeouts on large pull requests. ([#6706](https://github.com/QwenLM/qwen-code/pull/6706)) by @wenshao
- Removed obsolete DingTalk planning integration artifacts. ([#6722](https://github.com/QwenLM/qwen-code/pull/6722)) by @qqqys
- Reverted the malformed streamed response retry logic due to issues. ([#6783](https://github.com/QwenLM/qwen-code/pull/6783)) by @wenshao
- Stabilized end-to-end test cases for tool control and subagent scenarios. ([#6803](https://github.com/QwenLM/qwen-code/pull/6803)) by @yiliang114
- Removed a flaky headless child-process recording test. ([#6830](https://github.com/QwenLM/qwen-code/pull/6830)) by @yiliang114
- Review test-efficacy probes now run in isolated disposable worktrees. ([#6836](https://github.com/QwenLM/qwen-code/pull/6836)) by @wenshao
- Shared a common worktree path helper across review probes and improved stale worktree cleanup. ([#6841](https://github.com/QwenLM/qwen-code/pull/6841)) by @wenshao

### New Contributors

- @juhuan made their first contribution in [#6492](https://github.com/QwenLM/qwen-code/pull/6492)
- @ksws00684315 made their first contribution in [#6672](https://github.com/QwenLM/qwen-code/pull/6672)
- @kaymeer made their first contribution in [#6607](https://github.com/QwenLM/qwen-code/pull/6607)
- @destire-mio made their first contribution in [#6709](https://github.com/QwenLM/qwen-code/pull/6709)
- @yanchenko made their first contribution in [#6489](https://github.com/QwenLM/qwen-code/pull/6489)
- @ever-o made their first contribution in [#6537](https://github.com/QwenLM/qwen-code/pull/6537)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.19.9...v0.19.10

## [0.19.9](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.9) - 2026-07-10

### Added

- memory: make background memory agent timeouts configurable ([#6459](https://github.com/QwenLM/qwen-code/pull/6459))
- cli: Add session owner index for workspace runtimes ([#6540](https://github.com/QwenLM/qwen-code/pull/6540))
- web-shell: polish stats table layout and todo panel UI ([#6559](https://github.com/QwenLM/qwen-code/pull/6559))
- cli: List persisted sessions for trusted workspaces ([#6558](https://github.com/QwenLM/qwen-code/pull/6558))
- core: render PDF pages to images when text extraction overflows or fails ([#6585](https://github.com/QwenLM/qwen-code/pull/6585))
- scheduled-tasks: add isolated run mode via create_sub_session tool ([#6535](https://github.com/QwenLM/qwen-code/pull/6535))
- cli: VP mode — inline thought expand on click + auto-hiding scrollbar ([#6079](https://github.com/QwenLM/qwen-code/pull/6079))
- review: post Suggestion findings as inline comments ([#6593](https://github.com/QwenLM/qwen-code/pull/6593))
- daemon: persist session artifacts across restarts ([#6557](https://github.com/QwenLM/qwen-code/pull/6557))
- cli: Add channel worker settings reload for serve --channel ([#6598](https://github.com/QwenLM/qwen-code/pull/6598))
- web-shell: add bottom status items ([#6613](https://github.com/QwenLM/qwen-code/pull/6613))
- cli: Add workspace-qualified core REST routes ([#6567](https://github.com/QwenLM/qwen-code/pull/6567))
- add `qwen update` and `/update` commands with auto-update support ([#5780](https://github.com/QwenLM/qwen-code/pull/5780))
- tui: Ctrl+O frozen transcript view and unified tool output rendering ([#5666](https://github.com/QwenLM/qwen-code/pull/5666))
- web-shell: add assistant turn footer slot ([#6611](https://github.com/QwenLM/qwen-code/pull/6611))
- scheduled-tasks: gate an isolated run behind a precondition ([#6619](https://github.com/QwenLM/qwen-code/pull/6619))
- cli: List archived and organized sessions for non-primary workspaces ([#6631](https://github.com/QwenLM/qwen-code/pull/6631))
- web-shell: add context mention customization ([#6578](https://github.com/QwenLM/qwen-code/pull/6578))
- daemon: expose session runtime status ([#6645](https://github.com/QwenLM/qwen-code/pull/6645))
- web-shell: add collapse/expand toggle to AskUserQuestion panel ([#6588](https://github.com/QwenLM/qwen-code/pull/6588))
- cli: allow long /goal conditions ([#6665](https://github.com/QwenLM/qwen-code/pull/6665))
- channels: support webhook-triggered channel tasks ([#6495](https://github.com/QwenLM/qwen-code/pull/6495))
- review: give every line of a large diff an accountable reviewer ([#6612](https://github.com/QwenLM/qwen-code/pull/6612))
- web-shell: improve markdown table readability ([#6626](https://github.com/QwenLM/qwen-code/pull/6626))
- web-shell: workspace management sidebar with dynamic registration (daemon multi-workspace phase 4) ([#6625](https://github.com/QwenLM/qwen-code/pull/6625))
- serve: Add cursor-paged transcript replay endpoint ([#6525](https://github.com/QwenLM/qwen-code/pull/6525))
- core: add forceGlobalCacheScope for Anthropic proxy providers ([#6643](https://github.com/QwenLM/qwen-code/pull/6643))
- qqbot: group message handling and cron-msg-experimental ([#6457](https://github.com/QwenLM/qwen-code/pull/6457))
- daemon: record & query sub-session parentSessionId; drop isolated scheduled-task mode ([#6676](https://github.com/QwenLM/qwen-code/pull/6676))

### Fixed

- session: detect and mark broken history chains instead of silently truncating ([#6502](https://github.com/QwenLM/qwen-code/pull/6502))
- cli: prefer command name match over alias match regardless of recentScore ([#6504](https://github.com/QwenLM/qwen-code/pull/6504))
- channels: add chat payload diagnostics ([#6539](https://github.com/QwenLM/qwen-code/pull/6539))
- core: configurable vision bridge timeout + retry with fresh budget ([#6541](https://github.com/QwenLM/qwen-code/pull/6541))
- shell: avoid self-kill from pgrep selectors ([#6544](https://github.com/QwenLM/qwen-code/pull/6544))
- extension: clean tempDir before fallback git clone on Windows ([#6545](https://github.com/QwenLM/qwen-code/pull/6545))
- cli: align memory dialog with managed memory ([#6434](https://github.com/QwenLM/qwen-code/pull/6434))
- daemon: surface workspace memory task error details ([#6431](https://github.com/QwenLM/qwen-code/pull/6431))
- serve: stop cdp-mcp-command reading process.env directly ([#6562](https://github.com/QwenLM/qwen-code/pull/6562))
- mobile-mcp: strip bounds from UI hierarchy dump ([#6568](https://github.com/QwenLM/qwen-code/pull/6568))
- web-shell: make dialog backdrop z-index configurable ([#6572](https://github.com/QwenLM/qwen-code/pull/6572))
- ci: add retry logic to VSCode IDE Companion publish steps ([#6574](https://github.com/QwenLM/qwen-code/pull/6574))
- ci: detect silent triage failures with empty-response check ([#6566](https://github.com/QwenLM/qwen-code/pull/6566))
- cli: forward user input to MCP prompts with no declared arguments ([#6571](https://github.com/QwenLM/qwen-code/pull/6571))
- cua-driver: complete coordinate normalization for zoom/scroll/mouse tools ([#6610](https://github.com/QwenLM/qwen-code/pull/6610))
- channels: align memory access with channel gates ([#6620](https://github.com/QwenLM/qwen-code/pull/6620))
- vscode: normalize NOTICES.txt line endings to LF ([#6634](https://github.com/QwenLM/qwen-code/pull/6634))
- web-shell: align split view chat interactions ([#6633](https://github.com/QwenLM/qwen-code/pull/6633))
- cli: stabilize flaky UI tests ([#6622](https://github.com/QwenLM/qwen-code/pull/6622))
- mobile-mcp: reject out-of-range normalized coordinates ([#6656](https://github.com/QwenLM/qwen-code/pull/6656))
- channels: return only final ACP response text ([#6615](https://github.com/QwenLM/qwen-code/pull/6615))
- mobile-mcp: coord-norm audit fixes for 0.1.3 ([#6659](https://github.com/QwenLM/qwen-code/pull/6659))
- triage: require explicit defer comment and prevent hygiene-based defer on re-runs ([#6652](https://github.com/QwenLM/qwen-code/pull/6652))
- cli,core: Restore default debug log file output ([#6605](https://github.com/QwenLM/qwen-code/pull/6605))
- sdk: escalate process abort termination ([#6653](https://github.com/QwenLM/qwen-code/pull/6653))
- core: honor NO_PROXY for model requests ([#6640](https://github.com/QwenLM/qwen-code/pull/6640))
- core: apply cron step to a single starting value (N/step) ([#6627](https://github.com/QwenLM/qwen-code/pull/6627))
- channels: enable DingTalk stream keepalive ([#6668](https://github.com/QwenLM/qwen-code/pull/6668))
- dingtalk: preserve markdown tables ([#6673](https://github.com/QwenLM/qwen-code/pull/6673))
- channels: cap channel memory recall prompt ([#6617](https://github.com/QwenLM/qwen-code/pull/6617))
- core: fix tool_use/tool_result pairing for Anthropic-compatible providers ([#6651](https://github.com/QwenLM/qwen-code/pull/6651))
- channels: manage stale DingTalk Stream connections ([#6675](https://github.com/QwenLM/qwen-code/pull/6675))
- core: clamp max_tokens to the context window; retire the output reservation ([#6556](https://github.com/QwenLM/qwen-code/pull/6556))
- web-shell: polyfill Range layout APIs in tests ([#6677](https://github.com/QwenLM/qwen-code/pull/6677))
- core: retry leaked protocol turns ([#6603](https://github.com/QwenLM/qwen-code/pull/6603))
- release: raise package size budget to 85 MiB ([#6688](https://github.com/QwenLM/qwen-code/pull/6688))
- interactive: configure Docker sandbox networking for protocol tag retry test ([#6689](https://github.com/QwenLM/qwen-code/pull/6689))

### Performance

- core: add pure-ASCII fast path to text token estimation ([#6551](https://github.com/QwenLM/qwen-code/pull/6551))

### Documentation

- fix model-provider config shape and refresh feature/setting drift ([#6552](https://github.com/QwenLM/qwen-code/pull/6552))
- core: fix typos in ide notification comments ([#6623](https://github.com/QwenLM/qwen-code/pull/6623))
- document tools.disabled and tools.visible settings ([#6641](https://github.com/QwenLM/qwen-code/pull/6641))
- channels: add setup screenshots to WeCom robot guide ([#6648](https://github.com/QwenLM/qwen-code/pull/6648))

### Other

- Stop repeated subagent tool-call loops ([#6543](https://github.com/QwenLM/qwen-code/pull/6543))
- Gate browser automation MCP on external adapter ([#6472](https://github.com/QwenLM/qwen-code/pull/6472))
- chore(core): remove stale refreshStartupContextReminder mocks from tool-search tests ([#6423](https://github.com/QwenLM/qwen-code/pull/6423))
- ci(autofix): Add single-target scheduler ([#6547](https://github.com/QwenLM/qwen-code/pull/6547))
- Add harness infrastructure for web-shell package ([#6517](https://github.com/QwenLM/qwen-code/pull/6517))
- Fix workspace skills for disabled extensions and ACP preheat ([#6534](https://github.com/QwenLM/qwen-code/pull/6534))
- Fix long session timeline scrolling ([#6526](https://github.com/QwenLM/qwen-code/pull/6526))
- Support voiceBridge for ACP audio prompts ([#6576](https://github.com/QwenLM/qwen-code/pull/6576))
- ci(autofix): per-issue concurrency, route cancel-in-progress, assigned trigger ([#6609](https://github.com/QwenLM/qwen-code/pull/6609))
- chore(cua-driver): update version refs to 0.7.1 + add fix doc ([#6616](https://github.com/QwenLM/qwen-code/pull/6616))
- ci: route full CI follow-up jobs to selected runner ([#6608](https://github.com/QwenLM/qwen-code/pull/6608))
- test(core): stabilize file history eviction test ([#6637](https://github.com/QwenLM/qwen-code/pull/6637))
- test(cli): isolate cli entry fallback fixture ([#6658](https://github.com/QwenLM/qwen-code/pull/6658))
- ci: add suspicious comment attachment guard ([#6599](https://github.com/QwenLM/qwen-code/pull/6599))
- Bound glob result collection ([#6618](https://github.com/QwenLM/qwen-code/pull/6618))
- test(mobile-mcp): fix coord-norm tests for 0.1.3 ([#6664](https://github.com/QwenLM/qwen-code/pull/6664))

## [0.19.8](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.8) - 2026-07-08

### Added

- cli: Add serve env isolation and total admission ([#6416](https://github.com/QwenLM/qwen-code/pull/6416))
- cli: review auto-generated skills with an inline preview, editor handoff, and an in-dialog off switch ([#6393](https://github.com/QwenLM/qwen-code/pull/6393))
- cli: Show permission mode badge in footer for DEFAULT mode ([#6498](https://github.com/QwenLM/qwen-code/pull/6498))
- serve: Bound replay snapshot history ([#6482](https://github.com/QwenLM/qwen-code/pull/6482))
- web-shell: restore the full composer in split-view panes ([#6510](https://github.com/QwenLM/qwen-code/pull/6510))
- hooks: inject background tasks and cron jobs status into Stop/SubagentStop hook payloads ([#6531](https://github.com/QwenLM/qwen-code/pull/6531))
- cli: Enable multi-workspace session routing ([#6511](https://github.com/QwenLM/qwen-code/pull/6511))
- cli: auto-retry next port when serve port is in use ([#6513](https://github.com/QwenLM/qwen-code/pull/6513))
- extension file reload — watch for plugin changes and hot-reload runtime ([#6347](https://github.com/QwenLM/qwen-code/pull/6347))
- channels: add dmPolicy config to disable private/DM messages ([#6521](https://github.com/QwenLM/qwen-code/pull/6521))
- web-shell: expose external split controls ([#6523](https://github.com/QwenLM/qwen-code/pull/6523))
- core: add working_dir to the Agent tool for pinning subagents to an existing worktree ([#6456](https://github.com/QwenLM/qwen-code/pull/6456))
- autofix: extend review loop to all dev-bot PRs, add real-time triggers ([#6528](https://github.com/QwenLM/qwen-code/pull/6528))

### Fixed

- core: reject fractional LSP limit inputs ([#6455](https://github.com/QwenLM/qwen-code/pull/6455))
- core: Match hook display-name matchers to tool ids ([#6373](https://github.com/QwenLM/qwen-code/pull/6373))
- web-shell: hide sidebar settings text when width is insufficient ([#6494](https://github.com/QwenLM/qwen-code/pull/6494))
- web-shell: count daemon sessions in Daemon Status usage dashboard ([#6493](https://github.com/QwenLM/qwen-code/pull/6493))
- channel: Relay ACP permission requests ([#6446](https://github.com/QwenLM/qwen-code/pull/6446))
- core: reject Windows-style workspace artifact paths ([#6483](https://github.com/QwenLM/qwen-code/pull/6483))
- cli: show file path in compact tool summary for single collapsible tools ([#6448](https://github.com/QwenLM/qwen-code/pull/6448))
- cua-driver: migrate Windows scripts + README rewrite ([#6515](https://github.com/QwenLM/qwen-code/pull/6515))
- cli: bound the live streaming-table pending height (fix scroll-to-top lock, stall-then-dump, header flash) ([#6421](https://github.com/QwenLM/qwen-code/pull/6421))
- cli: clean up IDE client after deferred timeout ([#6509](https://github.com/QwenLM/qwen-code/pull/6509))
- web-shell: prevent sidebar footer overflow ([#6522](https://github.com/QwenLM/qwen-code/pull/6522))
- web-shell: refine markdown table interactions ([#6500](https://github.com/QwenLM/qwen-code/pull/6500))
- web-shell: i18n for ~43 hardcoded English strings across 15 files ([#6516](https://github.com/QwenLM/qwen-code/pull/6516))
- cli: keep status line on session model ([#6514](https://github.com/QwenLM/qwen-code/pull/6514))
- cli: allow approval-mode changes without bearer token ([#6527](https://github.com/QwenLM/qwen-code/pull/6527))
- memory: allow forget to remove user managed memory ([#6432](https://github.com/QwenLM/qwen-code/pull/6432))
- core: omit deprecated temperature param for Claude 4.8+ ([#6520](https://github.com/QwenLM/qwen-code/pull/6520))
- core: detect non-SSE HTTP 200 responses in OpenAI streaming pipeline ([#6466](https://github.com/QwenLM/qwen-code/pull/6466))
- scripts: handle missing NPM dist-tags gracefully in release versioning (#6476) ([#6481](https://github.com/QwenLM/qwen-code/pull/6481))
- cli: fixed-width elapsed time below one minute to stop status-line jitter ([#6533](https://github.com/QwenLM/qwen-code/pull/6533))
- memory: give each linked git worktree its own auto-memory root ([#6462](https://github.com/QwenLM/qwen-code/pull/6462))
- cli: unblock /clear after task cancellation and surface the blocked reason ([#6499](https://github.com/QwenLM/qwen-code/pull/6499))
- web-shell: stabilize slash command i18n in split-view panes ([#6546](https://github.com/QwenLM/qwen-code/pull/6546))

### Documentation

- channels: add WeCom to channels overview ([#6490](https://github.com/QwenLM/qwen-code/pull/6490))

## [0.19.7](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.7) - 2026-07-07

### Added

- review: route suggestion-level findings to an updatable PR comment ([#5786](https://github.com/QwenLM/qwen-code/pull/5786))
- serve: Add runtime.activity fields to daemon status API ([#6270](https://github.com/QwenLM/qwen-code/pull/6270))
- web-shell: add a daemon status page backed by GET /daemon/status ([#6272](https://github.com/QwenLM/qwen-code/pull/6272))
- web-shell: add MCP mentions and iconized @ references ([#6279](https://github.com/QwenLM/qwen-code/pull/6279))
- web-shell: manage sessions from the sidebar (archive, unarchive, delete) ([#6293](https://github.com/QwenLM/qwen-code/pull/6293))
- daemon: Add session export endpoint ([#6297](https://github.com/QwenLM/qwen-code/pull/6297))
- acp: advertise vision-bridge image capability in initialize response ([#6269](https://github.com/QwenLM/qwen-code/pull/6269))
- web-shell: support compact echarts full data blocks ([#6232](https://github.com/QwenLM/qwen-code/pull/6232))
- acp: Batch session load replay ([#6309](https://github.com/QwenLM/qwen-code/pull/6309))
- web-shell: add custom at mention panel ([#6242](https://github.com/QwenLM/qwen-code/pull/6242))
- acp-bridge: Add EventBus subscriber byte cap ([#6314](https://github.com/QwenLM/qwen-code/pull/6314))
- web-shell: time-series metrics charts on Daemon Status ([#6307](https://github.com/QwenLM/qwen-code/pull/6307))
- daemon: Add session organization ([#6305](https://github.com/QwenLM/qwen-code/pull/6305))
- cli: Surface daemon prompt queue status ([#6325](https://github.com/QwenLM/qwen-code/pull/6325))
- scheduler: opt-in per-tool-call execution timeout ([#6124](https://github.com/QwenLM/qwen-code/pull/6124))
- web-shell: add onSessionChange and onSubmitBefore callbacks ([#6333](https://github.com/QwenLM/qwen-code/pull/6333))
- core: stabilize tool schema declaration order ([#6339](https://github.com/QwenLM/qwen-code/pull/6339))
- core: model fallback chain — auto-switch to backup models on overload ([#6273](https://github.com/QwenLM/qwen-code/pull/6273))
- cli: support multi-folder workspaces in file system boundary checks ([#6278](https://github.com/QwenLM/qwen-code/pull/6278))
- web-shell: support icon chips for mention tags ([#6337](https://github.com/QwenLM/qwen-code/pull/6337))
- LSP Server support hot reload ([#5953](https://github.com/QwenLM/qwen-code/pull/5953))
- cli: Add large pipe frame measurement ([#6335](https://github.com/QwenLM/qwen-code/pull/6335))
- web-shell: named session groups and color tags in the sidebar ([#6350](https://github.com/QwenLM/qwen-code/pull/6350))
- web-shell: add a Scheduled Tasks management page ([#6348](https://github.com/QwenLM/qwen-code/pull/6348))
- web-shell: show Settings and Daemon Status as an in-place panel ([#6341](https://github.com/QwenLM/qwen-code/pull/6341))
- web-shell: add token-usage analytics dashboard to Daemon Status ([#6388](https://github.com/QwenLM/qwen-code/pull/6388))
- cli: Add Phase 1 workspace runtime registry ([#6394](https://github.com/QwenLM/qwen-code/pull/6394))
- core: surface PreToolUse hook 'ask' as a TUI confirmation ([#5629](https://github.com/QwenLM/qwen-code/pull/5629))
- review: add issue-fidelity and root-cause ownership gate to /review ([#6395](https://github.com/QwenLM/qwen-code/pull/6395))
- cli: Add Phase 2a workspace foundation ([#6410](https://github.com/QwenLM/qwen-code/pull/6410))
- web-shell: add Session Overview panel and in-window split view ([#6400](https://github.com/QwenLM/qwen-code/pull/6400))
- cli: add --project and --global flags to /model for per-project model persistence ([#6060](https://github.com/QwenLM/qwen-code/pull/6060))
- core: add maxSubAgents setting to limit parallel sub-agent count ([#6354](https://github.com/QwenLM/qwen-code/pull/6354))
- scheduled-tasks: run each task in its own dedicated, named session ([#6389](https://github.com/QwenLM/qwen-code/pull/6389))
- cli: support stacked slash-skill invocations ([#6361](https://github.com/QwenLM/qwen-code/pull/6361))
- core: add Tool(param:value) permission syntax for parameter-level access control ([#6106](https://github.com/QwenLM/qwen-code/pull/6106))
- core: add tools.visible config for selective deferred-tool visibility at startup ([#6372](https://github.com/QwenLM/qwen-code/pull/6372))
- web-shell: add Qwen logo beside the sidebar new-chat button ([#6437](https://github.com/QwenLM/qwen-code/pull/6437))
- web-shell: add column reorder, resize, and freeze controls to markdown table ([#6444](https://github.com/QwenLM/qwen-code/pull/6444))
- channels: add WeCom intelligent robot channel ([#6436](https://github.com/QwenLM/qwen-code/pull/6436))
- web-shell: unify scheduled task sessions — bind chat-created tasks + clock icon ([#6453](https://github.com/QwenLM/qwen-code/pull/6453))

### Changed

- core: centralize extension runtime refresh ([#6152](https://github.com/QwenLM/qwen-code/pull/6152))

### Fixed

- triage: strengthen PR gate with batch detection, problem existence check, and red flag patterns ([#5723](https://github.com/QwenLM/qwen-code/pull/5723))
- autofix: unconditionally restore tracked files before branch checkout (#6281) ([#6286](https://github.com/QwenLM/qwen-code/pull/6286))
- vscode: keep auth quick inputs open on focus loss ([#6274](https://github.com/QwenLM/qwen-code/pull/6274))
- cache: preserve tools prefix in side-query for Anthropic prompt-cache hits ([#6225](https://github.com/QwenLM/qwen-code/pull/6225))
- core: give Stop-hook continuations a fresh per-turn tool-call budget; make the cap configurable ([#6238](https://github.com/QwenLM/qwen-code/pull/6238))
- web-shell: use theme color for @ group titles ([#6294](https://github.com/QwenLM/qwen-code/pull/6294))
- acp: pass per-session settings explicitly instead of racing on this.settings ([#6292](https://github.com/QwenLM/qwen-code/pull/6292))
- core: improve debug txt diagnostics ([#6277](https://github.com/QwenLM/qwen-code/pull/6277))
- ci: require maintainer-applied `autofix/approved` label for tier-1 fast-path ([#6276](https://github.com/QwenLM/qwen-code/pull/6276))
- auth: prevent persistent 401 after API key change ([#6284](https://github.com/QwenLM/qwen-code/pull/6284))
- cli: stream long responses into scrollback to stop scroll-to-top lock ([#6170](https://github.com/QwenLM/qwen-code/pull/6170))
- qqbot: streaming idle-flush with tool-call and stale-callback protection ([#6204](https://github.com/QwenLM/qwen-code/pull/6204))
- openai: preserve descriptionless tools ([#6243](https://github.com/QwenLM/qwen-code/pull/6243))
- core: enforce agent concurrency cap on foreground sub-agents ([#6300](https://github.com/QwenLM/qwen-code/pull/6300))
- ci: Stop review bots for closed PRs ([#6304](https://github.com/QwenLM/qwen-code/pull/6304))
- core: skip abbreviations in multiple_sentences filter (#6077) ([#6193](https://github.com/QwenLM/qwen-code/pull/6193))
- ci: skip stale PR review runs ([#6313](https://github.com/QwenLM/qwen-code/pull/6313))
- core: treat request timeout of 0 as disabled instead of aborting immediately ([#6288](https://github.com/QwenLM/qwen-code/pull/6288))
- serve: resolve false auth warning in preflight when API key is set via settings ([#6296](https://github.com/QwenLM/qwen-code/pull/6296))
- core: treat @-attached files as read for prior-read enforcement ([#6295](https://github.com/QwenLM/qwen-code/pull/6295))
- cli: preserve partial remote input JSONL records ([#6317](https://github.com/QwenLM/qwen-code/pull/6317))
- core: disable qwen thinking via chat_template_kwargs on non-DashScope servers ([#6271](https://github.com/QwenLM/qwen-code/pull/6271))
- web-shell: keep skill slash commands after starting a new session ([#6319](https://github.com/QwenLM/qwen-code/pull/6319))
- web-shell: localize built-in command and skill descriptions in the slash menu ([#6326](https://github.com/QwenLM/qwen-code/pull/6326))
- desktop: enforce transform_data isolation ([#6285](https://github.com/QwenLM/qwen-code/pull/6285))
- core: skip no-op max_tokens escalation ([#6234](https://github.com/QwenLM/qwen-code/pull/6234))
- core: avoid null OpenAPI schema types ([#6323](https://github.com/QwenLM/qwen-code/pull/6323))
- core: preserve OpenAI reasoning as raw thoughts ([#6192](https://github.com/QwenLM/qwen-code/pull/6192))
- core: add UTF-8 prefix for cmd.exe on Windows ([#6216](https://github.com/QwenLM/qwen-code/pull/6216))
- cli: allow queued input during compression ([#6336](https://github.com/QwenLM/qwen-code/pull/6336))
- web-shell: finalize deferred gated submissions ([#6342](https://github.com/QwenLM/qwen-code/pull/6342))
- cli: smoother live streaming preview — drop "generating more" cue, hold back partial table rows ([#6340](https://github.com/QwenLM/qwen-code/pull/6340))
- desktop: preserve glued automation history records ([#6344](https://github.com/QwenLM/qwen-code/pull/6344))
- web-shell: suppress stale pending prompt refresh errors ([#6352](https://github.com/QwenLM/qwen-code/pull/6352))
- web-shell: constrain virtual scroll rows ([#6362](https://github.com/QwenLM/qwen-code/pull/6362))
- cli: Allow ACP local fallback reads from /tmp ([#6370](https://github.com/QwenLM/qwen-code/pull/6370))
- core: default context windows to 200k ([#6387](https://github.com/QwenLM/qwen-code/pull/6387))
- triage: exclude test files from core module size gate and distinguish feat from refactor ([#6369](https://github.com/QwenLM/qwen-code/pull/6369))
- cli: Keep model picker entries contiguous in short terminals ([#6359](https://github.com/QwenLM/qwen-code/pull/6359))
- core: Include request IDs in OpenAI error logs ([#6379](https://github.com/QwenLM/qwen-code/pull/6379))
- cli: ignore current review run in presubmit CI ([#6397](https://github.com/QwenLM/qwen-code/pull/6397))
- autofix: improve review addressing and verification ([#6382](https://github.com/QwenLM/qwen-code/pull/6382))
- core: require integer ReadFile pagination params ([#6381](https://github.com/QwenLM/qwen-code/pull/6381))
- core: resolve symlinks when matching conditional rules and skills ([#6371](https://github.com/QwenLM/qwen-code/pull/6371))
- web-shell: refine tool detail presentation ([#6399](https://github.com/QwenLM/qwen-code/pull/6399))
- core: preserve no-argument tool calls that stream an empty arguments string ([#6250](https://github.com/QwenLM/qwen-code/pull/6250))
- cli: use EnvHttpProxyAgent in channel proxy to respect NO_PROXY (#6401) ([#6405](https://github.com/QwenLM/qwen-code/pull/6405))
- daemon: Handle settings reload events outside transcript ([#6407](https://github.com/QwenLM/qwen-code/pull/6407))
- memory: don't advance AutoMemory extract cursor when the agent makes zero tool calls ([#6398](https://github.com/QwenLM/qwen-code/pull/6398))
- core: gate image payload replacement behind threshold ([#6380](https://github.com/QwenLM/qwen-code/pull/6380))
- review: remove qwen-code-specific core-infra gate from bundled /review ([#6412](https://github.com/QwenLM/qwen-code/pull/6412))
- web-shell: polish scheduled task timeline UI ([#6386](https://github.com/QwenLM/qwen-code/pull/6386))
- cli: smoother streaming table rendering ([#6345](https://github.com/QwenLM/qwen-code/pull/6345))
- core: Gate large PDF text extraction ([#6409](https://github.com/QwenLM/qwen-code/pull/6409))
- core: allow rewind after compressed history ([#6358](https://github.com/QwenLM/qwen-code/pull/6358))
- core: align monitor limit parameter schemas ([#6413](https://github.com/QwenLM/qwen-code/pull/6413))
- core: prevent KV-cache invalidation on tool_search by reordering reminderParts ([#6420](https://github.com/QwenLM/qwen-code/pull/6420))
- shell: avoid Unix pager default on Windows ([#6390](https://github.com/QwenLM/qwen-code/pull/6390))
- daemon: preserve user message source metadata ([#6385](https://github.com/QwenLM/qwen-code/pull/6385))
- core: prevent re-invoking loaded skill from appending duplicate content ([#6430](https://github.com/QwenLM/qwen-code/pull/6430))
- web-shell: keep split-view session list fresh and preserve panes across view switches ([#6418](https://github.com/QwenLM/qwen-code/pull/6418))
- web-shell: Improve user tags and mobile menu layout ([#6441](https://github.com/QwenLM/qwen-code/pull/6441))
- web-shell: keep errored turns expanded ([#6424](https://github.com/QwenLM/qwen-code/pull/6424))
- web-shell: clear stale floating todos ([#6425](https://github.com/QwenLM/qwen-code/pull/6425))
- web-shell: hide rotating loading phrase in split-view pane status ([#6447](https://github.com/QwenLM/qwen-code/pull/6447))
- core: Support large text range reads ([#6404](https://github.com/QwenLM/qwen-code/pull/6404))
- core: strip system-reminder blocks from session title and recap side-query prompts ([#6435](https://github.com/QwenLM/qwen-code/pull/6435))
- autofix: report review handoff failures ([#6415](https://github.com/QwenLM/qwen-code/pull/6415))
- monitor: preserve inherited git pager ([#6429](https://github.com/QwenLM/qwen-code/pull/6429))
- serve: classify interrupted model stream errors ([#6422](https://github.com/QwenLM/qwen-code/pull/6422))
- web-shell: refine tool call summaries ([#6450](https://github.com/QwenLM/qwen-code/pull/6450))
- web-shell: split-view pane fixes (remove "current" badge, clear composer on send) ([#6454](https://github.com/QwenLM/qwen-code/pull/6454))

### Performance

- glob: prune ignored directories during traversal, not just post-filter ([#6123](https://github.com/QwenLM/qwen-code/pull/6123))
- cli: cache LoadedSettings per workspace with stat-based invalidation ([#6310](https://github.com/QwenLM/qwen-code/pull/6310))
- ci: optimize autofix pipeline — fast-track, skip duplicate build, scoped tests ([#6315](https://github.com/QwenLM/qwen-code/pull/6315))
- memoize skill scans, debounce sleep-inhibitor log, guard IDE readdir ([#6155](https://github.com/QwenLM/qwen-code/pull/6155))
- core: Add session start profiler ([#6349](https://github.com/QwenLM/qwen-code/pull/6349))
- cli: defer startup prefetch tasks ([#6303](https://github.com/QwenLM/qwen-code/pull/6303))

### Documentation

- design: daemon side-channel coordination (A1/A2/A4/A5) ([#4511](https://github.com/QwenLM/qwen-code/pull/4511))
- fix skill invocation syntax and include Feishu in channel lists ([#6320](https://github.com/QwenLM/qwen-code/pull/6320))
- fix settings.json reference drift against schema ([#6351](https://github.com/QwenLM/qwen-code/pull/6351))
- web-shell: document chart renderer integration ([#6353](https://github.com/QwenLM/qwen-code/pull/6353))
- document PreToolUse hook permissionDecision "ask" behavior ([#6411](https://github.com/QwenLM/qwen-code/pull/6411))
- consolidate design docs and plans under docs/ ([#6417](https://github.com/QwenLM/qwen-code/pull/6417))

### Other

- ci(audio): clarify macOS prebuild artifact suffix ([#6275](https://github.com/QwenLM/qwen-code/pull/6275))
- test(e2e): make fake OpenAI reachable from Docker sandbox ([#6302](https://github.com/QwenLM/qwen-code/pull/6302))
- test(core): cover full:false branch of recordAttachedFileRead for truncated @-attachments ([#6324](https://github.com/QwenLM/qwen-code/pull/6324))
- Notify model when extension capabilities change ([#6245](https://github.com/QwenLM/qwen-code/pull/6245))
- Restart stalled ACP bridge for channels ([#6330](https://github.com/QwenLM/qwen-code/pull/6330))
- Fix incorrect context window calculation for custom models ([#6266](https://github.com/QwenLM/qwen-code/pull/6266))
- [codex] add proactive channel loop tools ([#6287](https://github.com/QwenLM/qwen-code/pull/6287))
- ci(autofix): move agent prompts into a project skill ([#6306](https://github.com/QwenLM/qwen-code/pull/6306))
- test(core): keep context warning test aligned with default token limit ([#6391](https://github.com/QwenLM/qwen-code/pull/6391))
- Handle missing web-shell sessions without redirecting ([#6357](https://github.com/QwenLM/qwen-code/pull/6357))
- Avoid refreshing session activity on load ([#6439](https://github.com/QwenLM/qwen-code/pull/6439))
- Upgrade GitHub Actions for Node 24 compatibility ([#5157](https://github.com/QwenLM/qwen-code/pull/5157))
- [codex] add natural channel memory intents ([#6376](https://github.com/QwenLM/qwen-code/pull/6376))

## [0.19.6](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.6) - 2026-07-03

### Added

- core: add dataviz bundled skill ([#6198](https://github.com/QwenLM/qwen-code/pull/6198))
- core: allow sub-agents to spawn nested sub-agents up to a configurable depth ([#6189](https://github.com/QwenLM/qwen-code/pull/6189))
- web-shell: add daemon UI support for vision model selection ([#6209](https://github.com/QwenLM/qwen-code/pull/6209))
- cua-driver: sync vendored cua-driver 0.6.8 → 0.7.0 ([#6212](https://github.com/QwenLM/qwen-code/pull/6212))
- scheduler: make recurring cron/loop job expiration configurable ([#6173](https://github.com/QwenLM/qwen-code/pull/6173))
- mobile-mcp: vendor mobile-mcp with opt-in 0-1000 relative coordinates ([#6235](https://github.com/QwenLM/qwen-code/pull/6235))
- web-shell: show the qwen-code version in the sidebar footer ([#6222](https://github.com/QwenLM/qwen-code/pull/6222))
- daemon: add session artifact APIs ([#5895](https://github.com/QwenLM/qwen-code/pull/5895))
- web-shell: display nested sub-agents as a tree in the tasks panel ([#6239](https://github.com/QwenLM/qwen-code/pull/6239))
- web-shell: improve slash command discovery (taller menu, group counts, fuzzy search) ([#6267](https://github.com/QwenLM/qwen-code/pull/6267))
- daemon: expose visionModelId in workspace provider status and web-shell model dialog ([#6262](https://github.com/QwenLM/qwen-code/pull/6262))

### Fixed

- web-shell: cut mobile session-switch jank (memoized timeline signature, replay-first dispatch) ([#6183](https://github.com/QwenLM/qwen-code/pull/6183))
- resolve macOS seatbelt profile path from bundle dir, not chunks/ ([#6172](https://github.com/QwenLM/qwen-code/pull/6172))
- cli: add bootstrap fast paths ([#6188](https://github.com/QwenLM/qwen-code/pull/6188))
- core: Reduce multimodal history payload size ([#6045](https://github.com/QwenLM/qwen-code/pull/6045))
- core: prevent subagent crash when ${hook_context} placeholder has no hook configured ([#6180](https://github.com/QwenLM/qwen-code/pull/6180))
- scheduler: add opt-in per-tool-call execution timeout ([#6136](https://github.com/QwenLM/qwen-code/pull/6136))
- web-shell: keep the user-selectable wrapper out of flex layout ([#6229](https://github.com/QwenLM/qwen-code/pull/6229))
- core: raise stream idle timeout default and hint the env knob ([#6107](https://github.com/QwenLM/qwen-code/pull/6107))
- serve: respect disabled skill settings ([#6223](https://github.com/QwenLM/qwen-code/pull/6223))
- align vscode-ide-companion curly rule with root config ([#6221](https://github.com/QwenLM/qwen-code/pull/6221))
- qqbot: security hardening — gateway validation, atomic state, sanitized logging ([#6200](https://github.com/QwenLM/qwen-code/pull/6200))
- cua-driver: bump BAKED_VERSION to 0.7.0 ([#6241](https://github.com/QwenLM/qwen-code/pull/6241))
- web-shell: improve session restore and loading feedback ([#6220](https://github.com/QwenLM/qwen-code/pull/6220))
- avoid vsce secret scanner false positive on regex patterns ([#6247](https://github.com/QwenLM/qwen-code/pull/6247))
- web-shell: encode vision model picker selection & polish dispatch ([#6236](https://github.com/QwenLM/qwen-code/pull/6236))
- serve: Optimize daemon NDJSON stream handling ([#6263](https://github.com/QwenLM/qwen-code/pull/6263))
- qqbot: markdown-first send, replyMsgId TTL, and dead code removal ([#6201](https://github.com/QwenLM/qwen-code/pull/6201))

### Documentation

- correct stale CLI flags/keybinding and document model.reasoningEffort ([#6219](https://github.com/QwenLM/qwen-code/pull/6219))

### Other

- [codex] Revert GLM tagged thinking parsing for DashScope ([#6248](https://github.com/QwenLM/qwen-code/pull/6248))
- Add sessionless workspace memory forget and dream ([#6227](https://github.com/QwenLM/qwen-code/pull/6227))
- ci(autofix): restore sandbox image flow ([#6261](https://github.com/QwenLM/qwen-code/pull/6261))

## [0.19.5](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.5) - 2026-07-02

### Added

- cli: Harden daemon-managed channel worker ([#6098](https://github.com/QwenLM/qwen-code/pull/6098))
- serve: support HTTPS/TLS via --tls-cert and --tls-key flags ([#6032](https://github.com/QwenLM/qwen-code/pull/6032))
- cli: show description and level in /skills ACP output ([#6117](https://github.com/QwenLM/qwen-code/pull/6117))
- core,cli: unified reasoning effort with /effort command ([#6072](https://github.com/QwenLM/qwen-code/pull/6072))
- core: Add leader approval for plan-required teammates ([#6138](https://github.com/QwenLM/qwen-code/pull/6138))
- channels: add DingTalk proactive send for channel loops ([#6174](https://github.com/QwenLM/qwen-code/pull/6174))
- channels: add identity and task lifecycle metadata ([#6105](https://github.com/QwenLM/qwen-code/pull/6105))
- core: add retry with backoff for MCP capability discovery ([#6158](https://github.com/QwenLM/qwen-code/pull/6158))
- channels: add listSessions to ChannelAgentBridge ([#6182](https://github.com/QwenLM/qwen-code/pull/6182))
- channels: show lifecycle status in adapters ([#6114](https://github.com/QwenLM/qwen-code/pull/6114))
- web-shell: overhaul list-dialog interaction, keyboard nav & a11y ([#6128](https://github.com/QwenLM/qwen-code/pull/6128))
- cli: add credential redaction for worker stderr forwarding ([#6146](https://github.com/QwenLM/qwen-code/pull/6146))

### Fixed

- web-shell: defer session creation until first prompt ([#6066](https://github.com/QwenLM/qwen-code/pull/6066))
- cli: clip live markdown to the viewport to stop non-VP scrollback replay ([#6081](https://github.com/QwenLM/qwen-code/pull/6081))
- cli: yield to React after addItem to reduce input lag ([#6059](https://github.com/QwenLM/qwen-code/pull/6059))
- diff: show whitespace-only edits instead of 'No changes detected' ([#6141](https://github.com/QwenLM/qwen-code/pull/6141))
- ci: grant PR review precheck permissions ([#6147](https://github.com/QwenLM/qwen-code/pull/6147))
- ci: list workflow comments with GET ([#6148](https://github.com/QwenLM/qwen-code/pull/6148))
- ci: use CI_BOT_PAT for precheck comment on fork PRs ([#6151](https://github.com/QwenLM/qwen-code/pull/6151))
- cli: Avoid blocking WebUI sessions on MCP readiness ([#6161](https://github.com/QwenLM/qwen-code/pull/6161))
- ci: allow prechecked fork PR automation ([#6160](https://github.com/QwenLM/qwen-code/pull/6160))
- ci: fall back to latest autofix sandbox image ([#6159](https://github.com/QwenLM/qwen-code/pull/6159))
- ci: create precheck comments via REST ([#6156](https://github.com/QwenLM/qwen-code/pull/6156))
- web-shell: show skill slash commands (e.g. /review) before first prompt ([#6153](https://github.com/QwenLM/qwen-code/pull/6153))
- web-shell: only show scroll-to-bottom button when content overflows ([#6150](https://github.com/QwenLM/qwen-code/pull/6150))
- web-shell: improve disconnected composer handling ([#6166](https://github.com/QwenLM/qwen-code/pull/6166))
- ci: diagnose autofix publish credentials ([#6162](https://github.com/QwenLM/qwen-code/pull/6162))
- release: reduce npm package scan triggers ([#6164](https://github.com/QwenLM/qwen-code/pull/6164))
- channels: replace setTimeout(0) drain with turn_complete SSE barrier ([#6165](https://github.com/QwenLM/qwen-code/pull/6165))
- lazy-load memory prompt when indexes are empty (#6097) ([#6104](https://github.com/QwenLM/qwen-code/pull/6104))
- cli: skip MCP approval dialogs in YOLO mode ([#6177](https://github.com/QwenLM/qwen-code/pull/6177))
- serve: keep skill slash commands available when the ACP child is unavailable ([#6169](https://github.com/QwenLM/qwen-code/pull/6169))
- web-shell: polish session timeline rail ([#6171](https://github.com/QwenLM/qwen-code/pull/6171))
- web-shell: mobile UX — safe areas, overscroll, native-app feel ([#6142](https://github.com/QwenLM/qwen-code/pull/6142))
- cli: drop /effort tier autocompletion for an argument-hint placeholder ([#6179](https://github.com/QwenLM/qwen-code/pull/6179))
- ci: limit fork PR precheck to safety signals ([#6178](https://github.com/QwenLM/qwen-code/pull/6178))

### Documentation

- document model/auth settings, /model --vision, and --safe-mode ([#6028](https://github.com/QwenLM/qwen-code/pull/6028))
- document the /config slash command ([#6145](https://github.com/QwenLM/qwen-code/pull/6145))

### Other

- ci: add fork PR safety precheck ([#5926](https://github.com/QwenLM/qwen-code/pull/5926))
- ci: persist npm cache on self-hosted runners ([#6130](https://github.com/QwenLM/qwen-code/pull/6130))
- Add compact session timeline rail ([#6078](https://github.com/QwenLM/qwen-code/pull/6078))
- ci: Add prepare-pr skill for autofix PR bodies ([#6184](https://github.com/QwenLM/qwen-code/pull/6184))
- test: stabilize plan mode tool-control E2E ([#6176](https://github.com/QwenLM/qwen-code/pull/6176))

## [0.19.4](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.4) - 2026-07-01

### Added

- core: add configurable auto-compact threshold and Stop hook context usage (#4025) ([#5868](https://github.com/QwenLM/qwen-code/pull/5868))
- core,cli,sdk: resume an interrupted turn without a synthetic "continue" message ([#5030](https://github.com/QwenLM/qwen-code/pull/5030))
- desktop: voice dictation in the desktop app ([#5856](https://github.com/QwenLM/qwen-code/pull/5856))
- browser-ext: revive Chrome extension via daemon-direct architecture ([#5777](https://github.com/QwenLM/qwen-code/pull/5777))
- loop: inject a .qwen/loop.md task file at fire time via sentinels ([#5890](https://github.com/QwenLM/qwen-code/pull/5890))
- channels: qwen tag — RFC + Phase 0 (multiplayer channel-resident agent) ([#5888](https://github.com/QwenLM/qwen-code/pull/5888))
- channels: Add channel agent bridge abstraction ([#5978](https://github.com/QwenLM/qwen-code/pull/5978))
- core: add --insecure flag to skip TLS verification for self-signed endpoints (#3535) ([#5962](https://github.com/QwenLM/qwen-code/pull/5962))
- cli: add --safe-mode flag to disable all customizations for troubleshooting ([#4943](https://github.com/QwenLM/qwen-code/pull/4943))
- daemon: support @extension mentions ([#6008](https://github.com/QwenLM/qwen-code/pull/6008))
- web-shell: friendlier Esc interruption + queued-prompt UX ([#6025](https://github.com/QwenLM/qwen-code/pull/6025))
- daemon,sdk: resumable /acp session stream (Last-Event-ID) + opt-in SDK transports export ([#5852](https://github.com/QwenLM/qwen-code/pull/5852))
- ui: add ui.history.collapsePreviewCount to show last N turns when resuming collapsed sessions ([#5848](https://github.com/QwenLM/qwen-code/pull/5848))
- core: support glob patterns in mcp.allowed and mcp.excluded ([#6012](https://github.com/QwenLM/qwen-code/pull/6012))
- loop: add autonomous mode for a bare /loop ([#5991](https://github.com/QwenLM/qwen-code/pull/5991))
- web-shell: queue prompts while turns are running ([#6005](https://github.com/QwenLM/qwen-code/pull/6005))
- web-shell: add mobile sidebar drawer with session list ([#6003](https://github.com/QwenLM/qwen-code/pull/6003))
- cli: support inline one-shot model override in /model (#5967) ([#6022](https://github.com/QwenLM/qwen-code/pull/6022))
- cli: Add daemon-managed channel worker for serve --channel ([#6031](https://github.com/QwenLM/qwen-code/pull/6031))
- serve: add sessionless workspace remember ([#5884](https://github.com/QwenLM/qwen-code/pull/5884))
- ui: add mouse click & hover in alternate-screen mode ([#6011](https://github.com/QwenLM/qwen-code/pull/6011))
- web-shell: add browser tab favicon ([#6091](https://github.com/QwenLM/qwen-code/pull/6091))
- cli: add /config key=value slash command to set any setting from the prompt ([#5773](https://github.com/QwenLM/qwen-code/pull/5773))
- core: Disallow plan lifecycle tools in subagents ([#6087](https://github.com/QwenLM/qwen-code/pull/6087))
- channel: add channel loop support ([#6073](https://github.com/QwenLM/qwen-code/pull/6073))
- web-shell: polish chat UI and table rendering ([#6099](https://github.com/QwenLM/qwen-code/pull/6099))
- auto-mode: add classifyAllShell setting to route all shell commands through classifier ([#6040](https://github.com/QwenLM/qwen-code/pull/6040))
- channels: add group history backfill ([#6074](https://github.com/QwenLM/qwen-code/pull/6074))
- daemon: Add session archive support ([#6058](https://github.com/QwenLM/qwen-code/pull/6058))
- cli: add tabbed Settings dialog with Status and Stats tabs ([#6044](https://github.com/QwenLM/qwen-code/pull/6044))
- core: add configurable idle timeout for MCP tool calls ([#6061](https://github.com/QwenLM/qwen-code/pull/6061))

### Changed

- cli: Remove serve bridge re-export shims ([#5955](https://github.com/QwenLM/qwen-code/pull/5955))
- review: drop deterministic-analysis and autofix steps ([#6092](https://github.com/QwenLM/qwen-code/pull/6092))

### Fixed

- core: halt repeated shell inspection variants ([#5944](https://github.com/QwenLM/qwen-code/pull/5944))
- cli: auto-select custom input on Enter in multi-select questions ([#5791](https://github.com/QwenLM/qwen-code/pull/5791))
- core: only spawn memory recall when auto-memory is enabled ([#5963](https://github.com/QwenLM/qwen-code/pull/5963))
- release: use relative postinstall patch dir ([#5973](https://github.com/QwenLM/qwen-code/pull/5973))
- standalone: Route serve shim through cli-entry ([#5977](https://github.com/QwenLM/qwen-code/pull/5977))
- ui: display output tokens instead of cumulative API throughput for subagents ([#5972](https://github.com/QwenLM/qwen-code/pull/5972))
- cli: Avoid ACP runtime preload on serve fast path ([#5989](https://github.com/QwenLM/qwen-code/pull/5989))
- web-shell: prefer raw file diffs in tool output ([#5992](https://github.com/QwenLM/qwen-code/pull/5992))
- web-shell: improve follow-up suggestion handling ([#5996](https://github.com/QwenLM/qwen-code/pull/5996))
- ci: cover release integration regressions ([#5994](https://github.com/QwenLM/qwen-code/pull/5994))
- core: filter thought parts from Stop hook last_assistant_message ([#6009](https://github.com/QwenLM/qwen-code/pull/6009))
- cli: fix thought viewer truncation, layout gaps, and choppy scrolling in VP mode ([#6002](https://github.com/QwenLM/qwen-code/pull/6002))
- cli: Guard serve fast-path bundle closure ([#5995](https://github.com/QwenLM/qwen-code/pull/5995))
- cli: make the non-VP transcript scrollable during multi-agent runs ([#6015](https://github.com/QwenLM/qwen-code/pull/6015))
- core: Allow subagents to exit plan mode ([#6026](https://github.com/QwenLM/qwen-code/pull/6026))
- ci: stabilize merge queue checks ([#6056](https://github.com/QwenLM/qwen-code/pull/6056))
- cli: Keep serve health responsive before runtime load ([#6013](https://github.com/QwenLM/qwen-code/pull/6013))
- cli: Handle ACP read_file for managed local paths ([#6021](https://github.com/QwenLM/qwen-code/pull/6021))
- ci: create isolated home before tests ([#6071](https://github.com/QwenLM/qwen-code/pull/6071))
- channels: structure DingTalk stream logs ([#5998](https://github.com/QwenLM/qwen-code/pull/5998))
- cli: Support Windows-style tilde paths ([#6029](https://github.com/QwenLM/qwen-code/pull/6029))
- cli: replace all emoji with Unicode text symbols in TUI rendering ([#5999](https://github.com/QwenLM/qwen-code/pull/5999))
- daemon: resolve ACP permission votes across connections ([#5912](https://github.com/QwenLM/qwen-code/pull/5912))
- cli: switch TUI prefix ✦→◆ to fix glyph overflow on some terminals ([#5974](https://github.com/QwenLM/qwen-code/pull/5974))
- core: Parse tagged thinking for GLM responses ([#6033](https://github.com/QwenLM/qwen-code/pull/6033))
- core: subtract reserved output tokens from context window for compression thresholds ([#5957](https://github.com/QwenLM/qwen-code/pull/5957))
- cli: validate ask_user_question TUI option input ([#6042](https://github.com/QwenLM/qwen-code/pull/6042))
- core: keep plan mode and require approval when plan gate is unavailable ([#6046](https://github.com/QwenLM/qwen-code/pull/6046))
- deps: clear critical runtime audit findings ([#6065](https://github.com/QwenLM/qwen-code/pull/6065))
- remove accidentally committed OpenClaw-Query-Submit submodule ([#6109](https://github.com/QwenLM/qwen-code/pull/6109))
- scripts: avoid shell injection in sandbox command detection ([#6108](https://github.com/QwenLM/qwen-code/pull/6108))
- web-shell: fix InsightProgress layout and clean up UI elements ([#6115](https://github.com/QwenLM/qwen-code/pull/6115))
- daemon: Route ACP images through the vision bridge ([#6111](https://github.com/QwenLM/qwen-code/pull/6111))
- ci: stabilize Windows loop tests ([#6082](https://github.com/QwenLM/qwen-code/pull/6082))
- cli: load browser MCP tools by default ([#6006](https://github.com/QwenLM/qwen-code/pull/6006))
- model: disambiguate vision model endpoints ([#6070](https://github.com/QwenLM/qwen-code/pull/6070))

### Documentation

- daemon: refresh daemon docs for recent PRs (wave 2) ([#5954](https://github.com/QwenLM/qwen-code/pull/5954))
- telemetry: comprehensive documentation update to match current implementation ([#5960](https://github.com/QwenLM/qwen-code/pull/5960))
- qc-helper: add daemon mode docs and fix system settings path ([#5981](https://github.com/QwenLM/qwen-code/pull/5981))
- refresh settings, MCP glob, auth alias, and autonomous loop docs ([#6090](https://github.com/QwenLM/qwen-code/pull/6090))

### Other

- ci(review): increase PR review timeout from 90 to 120 minutes ([#5959](https://github.com/QwenLM/qwen-code/pull/5959))
- ci: allow longer PR review timeout retries ([#5961](https://github.com/QwenLM/qwen-code/pull/5961))
- ci(autofix): loosen issue candidate filters so the agent finds work ([#5860](https://github.com/QwenLM/qwen-code/pull/5860))
- [codex] fix daemon specialized model filtering ([#5993](https://github.com/QwenLM/qwen-code/pull/5993))
- test(ci): stabilize cron interactive release check ([#6016](https://github.com/QwenLM/qwen-code/pull/6016))
- Sanitize subagent result tags ([#6027](https://github.com/QwenLM/qwen-code/pull/6027))
- Avoid full-history clones in OOM-prone paths ([#6018](https://github.com/QwenLM/qwen-code/pull/6018))
- Stop repeated invalid tool parameter loops in ACP ([#6076](https://github.com/QwenLM/qwen-code/pull/6076))
- ci(workflows): remind authors not to force-push active PRs ([#6035](https://github.com/QwenLM/qwen-code/pull/6035))
- Fix ACP daemon loop review follow-ups ([#6085](https://github.com/QwenLM/qwen-code/pull/6085))
- ci(autofix): fix scheduled and labeled issue triggers ([#6080](https://github.com/QwenLM/qwen-code/pull/6080))
- ci: stabilize actionlint on self-hosted runners ([#6113](https://github.com/QwenLM/qwen-code/pull/6113))
- [codex] Add explicit channel memory for messaging channels ([#6051](https://github.com/QwenLM/qwen-code/pull/6051))
- test(core): fix MCP idle timeout config stubs ([#6120](https://github.com/QwenLM/qwen-code/pull/6120))

## [0.19.3](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.3) - 2026-06-28

### Added

- serve: Add daemon workspace voice and control APIs ([#5765](https://github.com/QwenLM/qwen-code/pull/5765))
- cli: Add skill usage stats ([#5826](https://github.com/QwenLM/qwen-code/pull/5826))
- memory: confirm auto-generated skills before persisting ([#5616](https://github.com/QwenLM/qwen-code/pull/5616))
- cli: Show model thinking intent in loading indicator ([#5668](https://github.com/QwenLM/qwen-code/pull/5668))
- core: decouple /remember from auto-extract, stop writing to QWEN.md ([#5814](https://github.com/QwenLM/qwen-code/pull/5814))
- web-shell: enhance assistant markdown tables with Excel-style interactions ([#5650](https://github.com/QwenLM/qwen-code/pull/5650))
- cli: enable built-in status line preset by default for new users ([#5792](https://github.com/QwenLM/qwen-code/pull/5792))
- config: map provider id to SDK protocol via providerProtocol (#5758) ([#5793](https://github.com/QwenLM/qwen-code/pull/5793))
- telemetry: Make sensitive span attribute limit configurable ([#5804](https://github.com/QwenLM/qwen-code/pull/5804))
- core: QWEN_STREAM_IDLE_TIMEOUT_MS env knob for the stream idle timeout ([#5845](https://github.com/QwenLM/qwen-code/pull/5845))
- cli: support a user-configurable keyterms file for voice dictation ([#5817](https://github.com/QwenLM/qwen-code/pull/5817))
- cli: simplify auto mode startup text and remove emoji (#4584) ([#5824](https://github.com/QwenLM/qwen-code/pull/5824))
- web-shell: show duration on finished thinking summary ([#5864](https://github.com/QwenLM/qwen-code/pull/5864))
- tui: partition tool display by type — collapse read/search, show mutation tools individually ([#5661](https://github.com/QwenLM/qwen-code/pull/5661))
- mcp: reconcile MCP servers live on settings change ([#5561](https://github.com/QwenLM/qwen-code/pull/5561))
- serve: query a single session's status by id ([#5857](https://github.com/QwenLM/qwen-code/pull/5857))
- core: make self-paced /loop lean on monitor/background-task notifications ([#5844](https://github.com/QwenLM/qwen-code/pull/5844))
- cli: tighten response timestamp consistency and tests ([#5850](https://github.com/QwenLM/qwen-code/pull/5850))
- core: add bundled extension creator skill ([#5828](https://github.com/QwenLM/qwen-code/pull/5828))
- cli: support @extension mention in input autocomplete ([#5849](https://github.com/QwenLM/qwen-code/pull/5849))
- cua-driver: vendor qwen-cua-driver with opt-in 0–1000 relative coordinates ([#5896](https://github.com/QwenLM/qwen-code/pull/5896))
- web-shell: polish chat UI ([#5893](https://github.com/QwenLM/qwen-code/pull/5893))
- telemetry: wire recordApiRequestBreakdown into endLLMRequestSpan (Phase 4c) ([#5904](https://github.com/QwenLM/qwen-code/pull/5904))
- web-shell: browse MCP server resources in the /mcp dialog ([#5879](https://github.com/QwenLM/qwen-code/pull/5879))
- web-shell: allow host to override streaming loading phrases ([#5900](https://github.com/QwenLM/qwen-code/pull/5900))
- web-shell: stream-highlight code blocks and fix fence-language aliases ([#5869](https://github.com/QwenLM/qwen-code/pull/5869))
- core: warn before foreground shell timeout ([#5918](https://github.com/QwenLM/qwen-code/pull/5918))
- web-shell: add manual toggle for enhanced markdown tables ([#5917](https://github.com/QwenLM/qwen-code/pull/5917))
- memory: add a git-shared team memory tier ([#5886](https://github.com/QwenLM/qwen-code/pull/5886))
- web-shell: add workspace session sidebar ([#5931](https://github.com/QwenLM/qwen-code/pull/5931))
- cli: add /model --vision for a fallback vision model ([#5778](https://github.com/QwenLM/qwen-code/pull/5778))
- cli: show scheduled task count in footer ([#5921](https://github.com/QwenLM/qwen-code/pull/5921))
- acp: support /cd command in ACP sessions ([#5903](https://github.com/QwenLM/qwen-code/pull/5903))
- channels: register Telegram bot command menu ([#5919](https://github.com/QwenLM/qwen-code/pull/5919))
- web-shell: add error boundaries so a render crash can't white-screen the embed ([#5943](https://github.com/QwenLM/qwen-code/pull/5943))
- web-shell: add mobile responsive view for TodoPanel ([#5948](https://github.com/QwenLM/qwen-code/pull/5948))
- web-shell: add 'voice' to ComposerToolbarAction for external visibility control ([#5947](https://github.com/QwenLM/qwen-code/pull/5947))

### Changed

- cli: Split serve server routes ([#5809](https://github.com/QwenLM/qwen-code/pull/5809))
- cli: Split serve server assembly ([#5937](https://github.com/QwenLM/qwen-code/pull/5937))

### Fixed

- core: allow web_fetch JSON fallback ([#5660](https://github.com/QwenLM/qwen-code/pull/5660))
- ide: validate QWEN_CODE_IDE_SERVER_PORT before reading lock file ([#5805](https://github.com/QwenLM/qwen-code/pull/5805))
- core: add streaming inactivity timeout to the OpenAI pipeline ([#5827](https://github.com/QwenLM/qwen-code/pull/5827))
- cli: prevent scroll snap-back and flicker in non-VP mode during multi-agent runs ([#5799](https://github.com/QwenLM/qwen-code/pull/5799))
- cli: cancel pending self-paced loop wakeups on user abort ([#5808](https://github.com/QwenLM/qwen-code/pull/5808))
- core: preserve reasoning_content when merging assistant turns ([#5815](https://github.com/QwenLM/qwen-code/pull/5815))
- web-shell: stabilize active prompt loading state ([#5818](https://github.com/QwenLM/qwen-code/pull/5818))
- cli: stop repeated duplicate provider responses ([#5657](https://github.com/QwenLM/qwen-code/pull/5657))
- web-shell: defer transcript-appending local commands while a turn streams ([#5822](https://github.com/QwenLM/qwen-code/pull/5822))
- packaging: bundle audio capture for mirror installs ([#5747](https://github.com/QwenLM/qwen-code/pull/5747))
- core: reject userinfo URLs in WebFetch validation ([#5783](https://github.com/QwenLM/qwen-code/pull/5783))
- cli: make alt+t expand thinking on macOS Option-compose terminals ([#5872](https://github.com/QwenLM/qwen-code/pull/5872))
- cli: show ⌥T instead of alt+T on macOS for thinking expansion ([#5802](https://github.com/QwenLM/qwen-code/pull/5802))
- cli: improve token speed accounting ([#5811](https://github.com/QwenLM/qwen-code/pull/5811))
- core: stream chat-compression side-query to survive gateway timeout ([#5865](https://github.com/QwenLM/qwen-code/pull/5865))
- web-shell: reword the Chinese tool-group summary (执行了 → 调用了) ([#5876](https://github.com/QwenLM/qwen-code/pull/5876))
- release: skip dist/node_modules when building standalone archives ([#5878](https://github.com/QwenLM/qwen-code/pull/5878))
- test: raise timeout for cold-import suites to stop CI flake ([#5880](https://github.com/QwenLM/qwen-code/pull/5880))
- core: tree-kill PTY shell tree on Windows to stop pwsh leak (#5873) ([#5892](https://github.com/QwenLM/qwen-code/pull/5892))
- core: ignore IDE configs from other workspaces ([#5807](https://github.com/QwenLM/qwen-code/pull/5807))
- cli: wrap tool call descriptions instead of truncating ([#5891](https://github.com/QwenLM/qwen-code/pull/5891))
- serve: reject negative cleanupPeriodDays values ([#5906](https://github.com/QwenLM/qwen-code/pull/5906))
- desktop: reject unsafe source slugs before deletion ([#5829](https://github.com/QwenLM/qwen-code/pull/5829))
- core: clear tool display after completion errors ([#5916](https://github.com/QwenLM/qwen-code/pull/5916))
- desktop: harden remaining source path validation ([#5914](https://github.com/QwenLM/qwen-code/pull/5914))
- core: preserve rewind parents after resume ([#5923](https://github.com/QwenLM/qwen-code/pull/5923))
- core: parse workflow stall env as decimal seconds ([#5930](https://github.com/QwenLM/qwen-code/pull/5930))
- cli: align MCP dialog border ([#5935](https://github.com/QwenLM/qwen-code/pull/5935))
- core: improve cron tool search intents ([#5927](https://github.com/QwenLM/qwen-code/pull/5927))
- core: silence unknown schema format warnings ([#5915](https://github.com/QwenLM/qwen-code/pull/5915))
- core: stop computer use driver when idle ([#5925](https://github.com/QwenLM/qwen-code/pull/5925))
- core: stop repeated truncated write_file/edit retries from looping ([#5934](https://github.com/QwenLM/qwen-code/pull/5934))
- core: preserve the selected model when re-applying a provider install plan ([#5835](https://github.com/QwenLM/qwen-code/pull/5835))
- serve: reject non-positive sessionRecapAwayThresholdMinutes values ([#5945](https://github.com/QwenLM/qwen-code/pull/5945))
- core: isolate Anthropic SDK abort listener leak with per-request child controllers ([#5946](https://github.com/QwenLM/qwen-code/pull/5946))
- desktop: normalize source slug validation errors ([#5911](https://github.com/QwenLM/qwen-code/pull/5911))

### Performance

- cli: skip spawnSync wrapper for `qwen serve` ([#5874](https://github.com/QwenLM/qwen-code/pull/5874))
- cli: enable compile cache and defer getCliVersion for serve ([#5938](https://github.com/QwenLM/qwen-code/pull/5938))

### Documentation

- add vertex-ai auth, missing commands, and qc-helper index entries ([#5727](https://github.com/QwenLM/qwen-code/pull/5727))
- add provider preset governance policy to CONTRIBUTING.md ([#5631](https://github.com/QwenLM/qwen-code/pull/5631))

### Other

- ci: split platform test matrix into named jobs so PRs can enter the merge queue ([#5833](https://github.com/QwenLM/qwen-code/pull/5833))
- ci: give each CI job one home in the merge-queue flow ([#5842](https://github.com/QwenLM/qwen-code/pull/5842))
- Revert "feat(cli): Show model thinking intent in loading indicator" ([#5846](https://github.com/QwenLM/qwen-code/pull/5846))
- ci(release): make release flow merge-queue-safe and keep release PRs out of notes ([#5832](https://github.com/QwenLM/qwen-code/pull/5832))
- ci: add `@qwen-code /resolve` ([#5779](https://github.com/QwenLM/qwen-code/pull/5779))
- test(cli): add daemon startup benchmark ([#5825](https://github.com/QwenLM/qwen-code/pull/5825))
- ci(triage): run triage on the self-hosted ECS pool instead of GitHub-hosted ([#5851](https://github.com/QwenLM/qwen-code/pull/5851))
- ci: route the merge queue's Linux jobs onto ECS ([#5854](https://github.com/QwenLM/qwen-code/pull/5854))
- test(cli): raise i18n ToolMessage test timeout to 15s to stop merge-queue flake ([#5858](https://github.com/QwenLM/qwen-code/pull/5858))
- ci: take CodeQL and E2E off the per-merge push path ([#5859](https://github.com/QwenLM/qwen-code/pull/5859))
- ci(qwen-resolve): run the /resolve job on a hosted runner ([#5862](https://github.com/QwenLM/qwen-code/pull/5862))
- ci(qwen-resolve): support fork PRs and slim /resolve to conflict-only ([#5870](https://github.com/QwenLM/qwen-code/pull/5870))
- chore(cli): drop redundant home-directory startup warning ([#5839](https://github.com/QwenLM/qwen-code/pull/5839))
- ci: isolate per-run agent state for triage and PR review ([#5885](https://github.com/QwenLM/qwen-code/pull/5885))
- [codex] test(ci): cover post-merge review follow-ups ([#5899](https://github.com/QwenLM/qwen-code/pull/5899))
- Fix mid-input skill command completion ([#5898](https://github.com/QwenLM/qwen-code/pull/5898))
- Upgrade GitHub Actions to latest versions ([#3683](https://github.com/QwenLM/qwen-code/pull/3683))

## [0.19.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.2) - 2026-06-24

### Added

- serve: Add remote LSP status route ([#5741](https://github.com/QwenLM/qwen-code/pull/5741))
- vision-bridge: transcribe images to text for text-only models ([#5126](https://github.com/QwenLM/qwen-code/pull/5126))
- core: add deterministic guards for destructive commands in auto mode ([#5754](https://github.com/QwenLM/qwen-code/pull/5754))
- cli: add extension operation polling ([#5753](https://github.com/QwenLM/qwen-code/pull/5753))
- cli: match MCP resources globally on bare @ and show full references ([#5774](https://github.com/QwenLM/qwen-code/pull/5774))
- cli: Add workspace permissions rules API ([#5743](https://github.com/QwenLM/qwen-code/pull/5743))
- serve: voice dictation over the daemon for the Web Shell ([#5755](https://github.com/QwenLM/qwen-code/pull/5755))
- voice: refine ASR transcripts with the fast model before insert ([#5794](https://github.com/QwenLM/qwen-code/pull/5794))

### Changed

- web-shell: restructure chat UI ([#5775](https://github.com/QwenLM/qwen-code/pull/5775))

### Fixed

- agent: cap fork turns and bubble fork permission prompts ([#5737](https://github.com/QwenLM/qwen-code/pull/5737))
- vscode: always show chat view in the Activity Bar sidebar ([#5757](https://github.com/QwenLM/qwen-code/pull/5757))
- cli: source /context token total from the per-session chat ([#5764](https://github.com/QwenLM/qwen-code/pull/5764))
- core: Disambiguate duplicate model display names ([#5769](https://github.com/QwenLM/qwen-code/pull/5769))
- cli: remove theme background fills from input box and user messages ([#5772](https://github.com/QwenLM/qwen-code/pull/5772))
- cli: stabilize VP mouse interactions ([#5751](https://github.com/QwenLM/qwen-code/pull/5751))
- vscode: clamp open file positions ([#5711](https://github.com/QwenLM/qwen-code/pull/5711))
- config: fall back to user env files ([#5731](https://github.com/QwenLM/qwen-code/pull/5731))
- core: require integer stop hook cap ([#5667](https://github.com/QwenLM/qwen-code/pull/5667))
- core: require integer microcompaction keep count ([#5652](https://github.com/QwenLM/qwen-code/pull/5652))
- core: Align MCP OAuth guidance and docs ([#5589](https://github.com/QwenLM/qwen-code/pull/5589))
- cli: replace emoji thinking/summary icons with Unicode text symbols ([#5788](https://github.com/QwenLM/qwen-code/pull/5788))
- cli: restore saved custom model IDs when re-entering the auth wizard ([#5654](https://github.com/QwenLM/qwen-code/pull/5654))
- daemon: Reject stale prompt client admission ([#5784](https://github.com/QwenLM/qwen-code/pull/5784))
- core: parse QWEN_SERVE_MCP_CLIENT_BUDGET strictly as a decimal integer ([#5752](https://github.com/QwenLM/qwen-code/pull/5752))
- sdk: self-heal stale clientId on invalid_client_id prompts ([#5797](https://github.com/QwenLM/qwen-code/pull/5797))
- cli: promote pasted image paths to attachments ([#5803](https://github.com/QwenLM/qwen-code/pull/5803))
- sdk: raise browser daemon bundle budget to 126 KiB ([#5801](https://github.com/QwenLM/qwen-code/pull/5801))
- cli: correctly map Claude MCP server transport types on import and in .mcp.json ([#5812](https://github.com/QwenLM/qwen-code/pull/5812))

### Performance

- cli: Optimize serve daemon startup ([#5785](https://github.com/QwenLM/qwen-code/pull/5785))

### Documentation

- fix config/command/auth drift and surface the model-providers page ([#5735](https://github.com/QwenLM/qwen-code/pull/5735))

### Other

- ci: collapse PR checks into Ubuntu gate ([#5767](https://github.com/QwenLM/qwen-code/pull/5767))
- ci: harden Linux CI reliability (shallow ECS checkout + CodeQL timeout) ([#5810](https://github.com/QwenLM/qwen-code/pull/5810))
- Expose MCP resource read tool ([#5781](https://github.com/QwenLM/qwen-code/pull/5781))
- ci: move macOS/Windows tests and CodeQL off the per-PR path ([#5813](https://github.com/QwenLM/qwen-code/pull/5813))

## [0.19.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.1) - 2026-06-23

### Added

- cli: match MCP resource completions by name and discover servers ([#5733](https://github.com/QwenLM/qwen-code/pull/5733))

### Changed

- core: revert Protocol enum & model-identity decoupling (#5089) ([#5745](https://github.com/QwenLM/qwen-code/pull/5745))

### Fixed

- cli: skip unusable A2UI configs ([#5685](https://github.com/QwenLM/qwen-code/pull/5685))
- cli: avoid duplicate ACP write BOM ([#5688](https://github.com/QwenLM/qwen-code/pull/5688))
- cli: enable /lsp in ACP mode ([#5689](https://github.com/QwenLM/qwen-code/pull/5689))
- core: require integer inline media byte limit ([#5671](https://github.com/QwenLM/qwen-code/pull/5671))
- cli: reject invalid session list cursors ([#5709](https://github.com/QwenLM/qwen-code/pull/5709))
- cli: reject unsupported extension scopes ([#5714](https://github.com/QwenLM/qwen-code/pull/5714))
- core: reject blank cron prompts ([#5716](https://github.com/QwenLM/qwen-code/pull/5716))
- cli: validate channel credential types ([#5718](https://github.com/QwenLM/qwen-code/pull/5718))
- cli: use high-contrast software cursor ([#5720](https://github.com/QwenLM/qwen-code/pull/5720))
- core: require integer compaction counts ([#5646](https://github.com/QwenLM/qwen-code/pull/5646))
- core: parse agent & workflow integer env vars strictly ([#5679](https://github.com/QwenLM/qwen-code/pull/5679))
- serve: validate list maxEntries as a positive integer ([#5719](https://github.com/QwenLM/qwen-code/pull/5719))
- workflows: validate runId before recursive prune delete (path-traversal dir wipe) ([#5740](https://github.com/QwenLM/qwen-code/pull/5740))
- triage: never auto-approve cross-repo refactor PRs ([#5744](https://github.com/QwenLM/qwen-code/pull/5744))
- cli: only paint theme background when it matches the terminal ([#5746](https://github.com/QwenLM/qwen-code/pull/5746))

### Other

- ci: retry merge-ref checkout to fix transient "not our ref" failures ([#5732](https://github.com/QwenLM/qwen-code/pull/5732))

## [0.19.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.0) - 2026-06-23

### Added

- lint: enforce kebab-case filenames with ESLint ([#4797](https://github.com/QwenLM/qwen-code/pull/4797))
- extensions: support archive install sources ([#4909](https://github.com/QwenLM/qwen-code/pull/4909))
- voice: voice dictation with native capture, streaming, and biasing ([#5502](https://github.com/QwenLM/qwen-code/pull/5502))
- revivable background sub-agents and subagent transcript TTL ([#5556](https://github.com/QwenLM/qwen-code/pull/5556))
- core: add Artifact tool to publish interactive HTML pages ([#5557](https://github.com/QwenLM/qwen-code/pull/5557))
- cli: add optional [HH:MM:SS] timestamp before each assistant turn ([#5001](https://github.com/QwenLM/qwen-code/pull/5001))
- tui: remove tool group borders and collapse completed tool results ([#5003](https://github.com/QwenLM/qwen-code/pull/5003))
- workflows: finish Dynamic Workflows port — resume, saved workflows, keyword trigger, notifications (#4721) ([#5600](https://github.com/QwenLM/qwen-code/pull/5600))
- web-shell: support daemon session branching ([#5613](https://github.com/QwenLM/qwen-code/pull/5613))
- cli: browse MCP server resources in the /mcp dialog ([#5635](https://github.com/QwenLM/qwen-code/pull/5635))
- core: default-on preserve_thinking for DashScope provider ([#5637](https://github.com/QwenLM/qwen-code/pull/5637))
- tui: add thinking block viewer with Alt+T expand/collapse ([#5627](https://github.com/QwenLM/qwen-code/pull/5627))
- desktop: show file preview in a resizable side panel instead of fullscreen ([#5730](https://github.com/QwenLM/qwen-code/pull/5730))
- core: respect configurable agent ignore files ([#4653](https://github.com/QwenLM/qwen-code/pull/4653))
- core: add fastOnly/voiceOnly flags to hide models from main model list ([#5632](https://github.com/QwenLM/qwen-code/pull/5632))

### Changed

- cli: Rename serve files to kebab-case ([#5592](https://github.com/QwenLM/qwen-code/pull/5592))
- core: replace OpenRouter/Requesty provider classes with customHeaders in preset ([#5539](https://github.com/QwenLM/qwen-code/pull/5539))
- cli: Finish serve kebab-case filenames ([#5604](https://github.com/QwenLM/qwen-code/pull/5604))
- core: extract Protocol enum and decouple model identity from auth type ([#5089](https://github.com/QwenLM/qwen-code/pull/5089))

### Fixed

- cli: render full resume preview history ([#5565](https://github.com/QwenLM/qwen-code/pull/5565))
- cli: fill content area background on wrapped input lines ([#5568](https://github.com/QwenLM/qwen-code/pull/5568))
- cli: fail non-interactive runs on loop detection ([#5564](https://github.com/QwenLM/qwen-code/pull/5564))
- core: respect zero OpenAI log file limit ([#5569](https://github.com/QwenLM/qwen-code/pull/5569))
- core: keep bare fast model on current auth ([#5553](https://github.com/QwenLM/qwen-code/pull/5553))
- cli: prefer command name over alias in slash completion ranking ([#5577](https://github.com/QwenLM/qwen-code/pull/5577))
- core: require confirmation when user manually enters plan mode ([#5595](https://github.com/QwenLM/qwen-code/pull/5595))
- core: always-on guard for consecutive identical tool calls (#5019) ([#5573](https://github.com/QwenLM/qwen-code/pull/5573))
- ci: harden tmux triage reporting ([#5548](https://github.com/QwenLM/qwen-code/pull/5548))
- voice: surface native recorder fallback so missing prebuilds aren't silent ([#5605](https://github.com/QwenLM/qwen-code/pull/5605))
- core: prevent GLM on DashScope from dropping web_fetch content ([#5599](https://github.com/QwenLM/qwen-code/pull/5599))
- core: backend-aware artifact publish confirmation + cancel handling ([#5615](https://github.com/QwenLM/qwen-code/pull/5615))
- cli: Fail dangling replayed tool calls ([#5624](https://github.com/QwenLM/qwen-code/pull/5624))
- voice: bundle native audio addon into standalone archives ([#5628](https://github.com/QwenLM/qwen-code/pull/5628))
- cli: harden ACP session list pagination params ([#5618](https://github.com/QwenLM/qwen-code/pull/5618))
- cli: parse serve rate limit env strictly ([#5612](https://github.com/QwenLM/qwen-code/pull/5612))
- core: parse API timeout env strictly ([#5602](https://github.com/QwenLM/qwen-code/pull/5602))
- serve: validate readText line limits ([#5639](https://github.com/QwenLM/qwen-code/pull/5639))
- core: escape backslashes and quotes in emacs ediff paths ([#5630](https://github.com/QwenLM/qwen-code/pull/5630))
- cli: detect USE_OPENAI auth when the model is set via QWEN_MODEL ([#5647](https://github.com/QwenLM/qwen-code/pull/5647))
- webui: stop auto-recreating session on user-initiated delete ([#5633](https://github.com/QwenLM/qwen-code/pull/5633))
- cli: keep settings v5 migration idempotent ([#5676](https://github.com/QwenLM/qwen-code/pull/5676))
- test: restore openai model selection in ACP set_config_option test ([#5721](https://github.com/QwenLM/qwen-code/pull/5721))
- test: isolate ACP integration agents via QWEN_HOME to end parallel-settings race ([#5724](https://github.com/QwenLM/qwen-code/pull/5724))
- test: make ACP set_config_option test use a deterministic openai provider model ([#5728](https://github.com/QwenLM/qwen-code/pull/5728))
- core: keep active runtime model in default getAllConfiguredModels listing ([#5729](https://github.com/QwenLM/qwen-code/pull/5729))
- core: remove redundant reportSuggestionUsage causing double-counted stats ([#5684](https://github.com/QwenLM/qwen-code/pull/5684))
- core: validate ask_user_question answer indexes ([#5622](https://github.com/QwenLM/qwen-code/pull/5622))
- daemon: Refresh workspace provider defaults ([#5638](https://github.com/QwenLM/qwen-code/pull/5638))

### Documentation

- mcp: correct mcp add scope default ([#5593](https://github.com/QwenLM/qwen-code/pull/5593))

### Other

- ci(release): Auto-publish VSCode companion after stable releases ([#5572](https://github.com/QwenLM/qwen-code/pull/5572))
- [codex] Fix legacy filename allowlist for kebab-case lint ([#5578](https://github.com/QwenLM/qwen-code/pull/5578))
- test(integration): add fake OpenAI server for no-AK daemon tests ([#5560](https://github.com/QwenLM/qwen-code/pull/5560))
- Fix native voice recorder retry after stop errors ([#5609](https://github.com/QwenLM/qwen-code/pull/5609))
- [codex] ci(triage): acknowledge slash triage requests ([#5594](https://github.com/QwenLM/qwen-code/pull/5594))
- [codex] Support artifact auto-open setting ([#5617](https://github.com/QwenLM/qwen-code/pull/5617))
- test(integration): run no-AK smoke tests on PRs ([#5607](https://github.com/QwenLM/qwen-code/pull/5607))
- ci: route in-repo PRs' Linux test to self-hosted runner ([#5620](https://github.com/QwenLM/qwen-code/pull/5620))
- ci(release): queue release failures for autofix ([#5551](https://github.com/QwenLM/qwen-code/pull/5551))
- ci(audio-capture): cross-compile darwin-x64 prebuild on arm64, drop macos-13 runner ([#5643](https://github.com/QwenLM/qwen-code/pull/5643))
- ci: harden self-hosted runner routing (follow-up to #5620 review) ([#5644](https://github.com/QwenLM/qwen-code/pull/5644))
- test(integration): skip qwen serve streaming suite under container sandbox ([#5655](https://github.com/QwenLM/qwen-code/pull/5655))

## [0.18.5](https://github.com/QwenLM/qwen-code/releases/tag/v0.18.5) - 2026-06-21

### Added

- core: add Requesty provider ([#5478](https://github.com/QwenLM/qwen-code/pull/5478))
- ci: on-demand tmux real-user testing for PRs ([#5203](https://github.com/QwenLM/qwen-code/pull/5203))
- mcp: support MCP resources and reliably surface prompts ([#5544](https://github.com/QwenLM/qwen-code/pull/5544))

### Fixed

- core: require opt-in for plan mode prompt ([#5433](https://github.com/QwenLM/qwen-code/pull/5433))
- core: evaluate ignore files named with dot prefixes ([#5458](https://github.com/QwenLM/qwen-code/pull/5458))
- core: enforce shell directory workspace boundary ([#5454](https://github.com/QwenLM/qwen-code/pull/5454))
- core: validate lsp socket ports ([#5493](https://github.com/QwenLM/qwen-code/pull/5493))
- core: parse max output token env strictly ([#5491](https://github.com/QwenLM/qwen-code/pull/5491))
- core: detect providers by hostname ([#5450](https://github.com/QwenLM/qwen-code/pull/5450))
- cli: validate ACP glob max results ([#5480](https://github.com/QwenLM/qwen-code/pull/5480))
- core: allow dot-prefixed plans directories ([#5460](https://github.com/QwenLM/qwen-code/pull/5460))
- extensions: fetch http marketplaces with http client ([#5452](https://github.com/QwenLM/qwen-code/pull/5452))
- cli: parse FORCE_HYPERLINK strictly ([#5489](https://github.com/QwenLM/qwen-code/pull/5489))
- core: parse tool concurrency env strictly ([#5496](https://github.com/QwenLM/qwen-code/pull/5496))
- cli: enforce custom theme home boundary ([#5456](https://github.com/QwenLM/qwen-code/pull/5456))
- dingtalk: skip uppercase webhook reaction targets ([#5466](https://github.com/QwenLM/qwen-code/pull/5466))
- desktop: accept uppercase icon URL schemes ([#5470](https://github.com/QwenLM/qwen-code/pull/5470))
- cli: reject partial session size values ([#5475](https://github.com/QwenLM/qwen-code/pull/5475))
- telegram: clear typing intervals on disconnect ([#5477](https://github.com/QwenLM/qwen-code/pull/5477))
- cli: respect installation path boundaries ([#5441](https://github.com/QwenLM/qwen-code/pull/5441))
- accept uppercase endpoint URL schemes ([#5443](https://github.com/QwenLM/qwen-code/pull/5443))
- core: reject fractional computer-use integer strings ([#5500](https://github.com/QwenLM/qwen-code/pull/5500))
- core: match provider base URL slash variants ([#5448](https://github.com/QwenLM/qwen-code/pull/5448))
- cli: enforce temp path boundaries for at-file ([#5446](https://github.com/QwenLM/qwen-code/pull/5446))
- desktop: preserve uppercase favicon URLs ([#5463](https://github.com/QwenLM/qwen-code/pull/5463))
- desktop: parse NO_PROXY ports strictly ([#5498](https://github.com/QwenLM/qwen-code/pull/5498))
- serve: validate session reaper timeouts ([#5484](https://github.com/QwenLM/qwen-code/pull/5484))
- extensions: handle uppercase npm registry schemes ([#5437](https://github.com/QwenLM/qwen-code/pull/5437))
- core: add missing Token Plan models (qwen3.7-plus, glm-5.2, kimi-k2.7-code) ([#5505](https://github.com/QwenLM/qwen-code/pull/5505))
- cli: wire ACP model-invocable commands ([#5504](https://github.com/QwenLM/qwen-code/pull/5504))
- cli: reject partial cpu profile durations ([#5486](https://github.com/QwenLM/qwen-code/pull/5486))
- desktop: restore locale parity ([#5537](https://github.com/QwenLM/qwen-code/pull/5537))
- extension: accept uppercase URL schemes in Claude plugin sources ([#5461](https://github.com/QwenLM/qwen-code/pull/5461))
- desktop: parse server ports strictly ([#5509](https://github.com/QwenLM/qwen-code/pull/5509))
- desktop: validate generic oauth token responses ([#5511](https://github.com/QwenLM/qwen-code/pull/5511))
- core: don't treat an empty-parts message as a function call/response ([#5494](https://github.com/QwenLM/qwen-code/pull/5494))
- desktop: allow double dots in bundle filenames ([#5515](https://github.com/QwenLM/qwen-code/pull/5515))
- cli: handle truncated remote input files ([#5473](https://github.com/QwenLM/qwen-code/pull/5473))
- vscode: keep UNC paths absolute ([#5542](https://github.com/QwenLM/qwen-code/pull/5542))
- desktop: keep sibling paths absolute ([#5517](https://github.com/QwenLM/qwen-code/pull/5517))
- cli: allow dotfile paths in Web Shell sendFile ([#5541](https://github.com/QwenLM/qwen-code/pull/5541))
- cli: allow double dots in update archives ([#5521](https://github.com/QwenLM/qwen-code/pull/5521))
- desktop: separate transform data output lines ([#5525](https://github.com/QwenLM/qwen-code/pull/5525))
- desktop: handle Windows file mentions ([#5523](https://github.com/QwenLM/qwen-code/pull/5523))
- desktop: consolidate path boundary checks ([#5545](https://github.com/QwenLM/qwen-code/pull/5545))
- desktop: reject fractional transfer sizes ([#5527](https://github.com/QwenLM/qwen-code/pull/5527))
- cli: validate ACP file read windows ([#5482](https://github.com/QwenLM/qwen-code/pull/5482))
- extensions: accept uppercase marketplace source schemes ([#5435](https://github.com/QwenLM/qwen-code/pull/5435))

### Performance

- core: read current git branch directly from .git instead of spawning git ([#5432](https://github.com/QwenLM/qwen-code/pull/5432))

### Documentation

- triage: Add reuse-before-new-code review check ([#5547](https://github.com/QwenLM/qwen-code/pull/5547))

### Other

- test(core): drop duplicate gitdiff untracked count case ([#5468](https://github.com/QwenLM/qwen-code/pull/5468))
- test(desktop): update blocked scheme open-url assertion ([#5529](https://github.com/QwenLM/qwen-code/pull/5529))
- test(core): wait for cron lock probe takeover ([#5535](https://github.com/QwenLM/qwen-code/pull/5535))
- test(desktop): align interceptor packaging contract ([#5531](https://github.com/QwenLM/qwen-code/pull/5531))
- test(desktop): enable feedback flag in permission tests ([#5533](https://github.com/QwenLM/qwen-code/pull/5533))
- ci(release): trigger CI from release branch pushes ([#5543](https://github.com/QwenLM/qwen-code/pull/5543))
- Use VS Code theme tokens for companion scrollbar ([#5488](https://github.com/QwenLM/qwen-code/pull/5488))

## [0.18.4](https://github.com/QwenLM/qwen-code/releases/tag/v0.18.4) - 2026-06-20

### Added

- serve: make ACP permission timeout configurable ([#5260](https://github.com/QwenLM/qwen-code/pull/5260))
- i18n: localize tool display names in TUI and web-shell badges ([#5220](https://github.com/QwenLM/qwen-code/pull/5220))
- serve: add daemon idle detection to GET /health?deep=true ([#4934](https://github.com/QwenLM/qwen-code/pull/4934))
- hooks: pass original API call ID (toolCallId) to hook system ([#4918](https://github.com/QwenLM/qwen-code/pull/4918))
- core,cli: Workflow tool token budget + per-run UI surfacing (P5) ([#5231](https://github.com/QwenLM/qwen-code/pull/5231))
- extensions: add i18n support for extension displayName and description ([#5289](https://github.com/QwenLM/qwen-code/pull/5289))
- loop: wire prompt-only /loop to self-paced wakeups ([#5197](https://github.com/QwenLM/qwen-code/pull/5197))
- loop: add second-resolution session wakeup engine ([#5182](https://github.com/QwenLM/qwen-code/pull/5182))
- desktop: compile macOS 26+ Liquid Glass Assets.car in brand-create ([#5284](https://github.com/QwenLM/qwen-code/pull/5284))
- channel: add QQ Bot (QQ机器人) channel adapter ([#5202](https://github.com/QwenLM/qwen-code/pull/5202))
- core: auto-reveal exit_plan_mode tool when entering plan mode ([#5311](https://github.com/QwenLM/qwen-code/pull/5311))
- skills: add desktop-pet skill for creating pixel-art companions ([#4808](https://github.com/QwenLM/qwen-code/pull/4808))
- stats: expose token usage for cost visibility ([#4564](https://github.com/QwenLM/qwen-code/pull/4564))
- cli: show follow-up suggestion in input placeholder ([#5145](https://github.com/QwenLM/qwen-code/pull/5145))
- config: add settings file change detection via chokidar watcher… ([#4933](https://github.com/QwenLM/qwen-code/pull/4933))
- cli: show optional response token rate ([#5401](https://github.com/QwenLM/qwen-code/pull/5401))
- cli: serve the Web Shell UI from `qwen serve` ([#5392](https://github.com/QwenLM/qwen-code/pull/5392))
- cli: add persistent history collapse on resume with refined commands ([#4085](https://github.com/QwenLM/qwen-code/pull/4085))
- web-shell: add extension management ([#5398](https://github.com/QwenLM/qwen-code/pull/5398))
- extensions: interactive multi-tab /extensions manager (Installed / Discover / Sources) ([#4850](https://github.com/QwenLM/qwen-code/pull/4850))

### Changed

- tools: rename TodoWrite tool display name to TodoList ([#5319](https://github.com/QwenLM/qwen-code/pull/5319))
- serve: unify session title/displayName into single displayName field ([#5002](https://github.com/QwenLM/qwen-code/pull/5002))

### Fixed

- core: Track supported sed edits in file history ([#5141](https://github.com/QwenLM/qwen-code/pull/5141))
- vscode-ide-companion: create independent McpServer per IDE session ([#5264](https://github.com/QwenLM/qwen-code/pull/5264))
- core: read BMP height as signed int32 for top-down bitmaps ([#5227](https://github.com/QwenLM/qwen-code/pull/5227))
- cli: Preserve mid-turn image messages ([#5183](https://github.com/QwenLM/qwen-code/pull/5183))
- core: detect dat files by content ([#5256](https://github.com/QwenLM/qwen-code/pull/5256))
- model: remember selected provider when multiple share a model id (#5173) ([#5179](https://github.com/QwenLM/qwen-code/pull/5179))
- daemon: centralize mid-turn event constant + recover timed-out drains ([#5266](https://github.com/QwenLM/qwen-code/pull/5266))
- core: keep DeepSeek presets text-only ([#5268](https://github.com/QwenLM/qwen-code/pull/5268))
- cli: drop AgentView cleanup setState that can trip React #185 (#5199) ([#5286](https://github.com/QwenLM/qwen-code/pull/5286))
- core: read WebP VP8X canvas height from the correct byte offset ([#5194](https://github.com/QwenLM/qwen-code/pull/5194))
- cli: support Ctrl+P/N in completions ([#5259](https://github.com/QwenLM/qwen-code/pull/5259))
- core: never let telemetry file exporters crash the process ([#5246](https://github.com/QwenLM/qwen-code/pull/5246))
- cli: correct context filename settings schema ([#5269](https://github.com/QwenLM/qwen-code/pull/5269))
- core: per-turn tool-call circuit breaker — always-on cap + opt-in loop heuristics (#5234) ([#5279](https://github.com/QwenLM/qwen-code/pull/5279))
- desktop: handle git branch badge edge cases ([#5247](https://github.com/QwenLM/qwen-code/pull/5247))
- cli: correct sandbox settings schema ([#5272](https://github.com/QwenLM/qwen-code/pull/5272))
- weixin: show allowed image directories ([#5296](https://github.com/QwenLM/qwen-code/pull/5296))
- cli: reject malformed OSC rgb colors ([#5307](https://github.com/QwenLM/qwen-code/pull/5307))
- web-shell: summarize grep_search results ([#5294](https://github.com/QwenLM/qwen-code/pull/5294))
- core: read short VP8L WebP dimensions ([#5292](https://github.com/QwenLM/qwen-code/pull/5292))
- core: track attached stdout fd redirects ([#5317](https://github.com/QwenLM/qwen-code/pull/5317))
- dingtalk: split oversized markdown lines ([#5299](https://github.com/QwenLM/qwen-code/pull/5299))
- cli: preserve multiline shell history ([#5335](https://github.com/QwenLM/qwen-code/pull/5335))
- cli: validate GitHub remote hosts ([#5327](https://github.com/QwenLM/qwen-code/pull/5327))
- core: preserve migrated command description strings ([#5321](https://github.com/QwenLM/qwen-code/pull/5321))
- cli: enforce stdin byte limit ([#5331](https://github.com/QwenLM/qwen-code/pull/5331))
- core: respect home path boundary when tildeifying ([#5333](https://github.com/QwenLM/qwen-code/pull/5333))
- cli: truncate session picker text by display width ([#5338](https://github.com/QwenLM/qwen-code/pull/5338))
- core: support GIF image token metadata ([#5340](https://github.com/QwenLM/qwen-code/pull/5340))
- cli: handle session search graphemes ([#5342](https://github.com/QwenLM/qwen-code/pull/5342))
- cli: normalize english output language ([#5346](https://github.com/QwenLM/qwen-code/pull/5346))
- core: parse OAuth resource metadata params ([#5344](https://github.com/QwenLM/qwen-code/pull/5344))
- core: handle stale worktree session markers ([#5229](https://github.com/QwenLM/qwen-code/pull/5229))
- core: ignore duplicate provider tool-call ids ([#5038](https://github.com/QwenLM/qwen-code/pull/5038))
- cli: show thinking in full transcript mode ([#5354](https://github.com/QwenLM/qwen-code/pull/5354))
- cli: return fresh empty mcp json results ([#5349](https://github.com/QwenLM/qwen-code/pull/5349))
- weixin: normalize markdown image syntax ([#5297](https://github.com/QwenLM/qwen-code/pull/5297))
- core: skip sleep inhibitor in headless ssh ([#5295](https://github.com/QwenLM/qwen-code/pull/5295))
- cli: reject malformed terminal sequences ([#5305](https://github.com/QwenLM/qwen-code/pull/5305))
- cli: expand windows-style tilde paths ([#5298](https://github.com/QwenLM/qwen-code/pull/5298))
- core: validate oauth expires_in values ([#5356](https://github.com/QwenLM/qwen-code/pull/5356))
- core: reject malformed cron numeric fields ([#5352](https://github.com/QwenLM/qwen-code/pull/5352))
- cli: parse sandbox image registry ports ([#5325](https://github.com/QwenLM/qwen-code/pull/5325))
- cli: preserve empty MCP prompt args ([#5323](https://github.com/QwenLM/qwen-code/pull/5323))
- core: reject invalid cron task entries ([#5309](https://github.com/QwenLM/qwen-code/pull/5309))
- cli: avoid agent composer unmount reset ([#5302](https://github.com/QwenLM/qwen-code/pull/5302))
- cli: validate channel service pidfile ([#5300](https://github.com/QwenLM/qwen-code/pull/5300))
- core: preserve invalid schema length strings ([#5312](https://github.com/QwenLM/qwen-code/pull/5312))
- weixin: confirm the WEBP signature, not just the RIFF prefix ([#5285](https://github.com/QwenLM/qwen-code/pull/5285))
- cli: reject malformed ACP timeout strings ([#5315](https://github.com/QwenLM/qwen-code/pull/5315))
- cli: import extension channels via file urls ([#5301](https://github.com/QwenLM/qwen-code/pull/5301))
- cli: bound streaming thought render buffers ([#5314](https://github.com/QwenLM/qwen-code/pull/5314))
- cli: window title shows session name instead of model activity status ([#5288](https://github.com/QwenLM/qwen-code/pull/5288))
- core: keep qwen3.6-flash and kimi-k2.6 presets text-only ([#5328](https://github.com/QwenLM/qwen-code/pull/5328))
- cli: render a sub-minute duration that rounds to 60s as "1m" ([#5287](https://github.com/QwenLM/qwen-code/pull/5287))
- Expand Windows ~\\ home paths and hide phantom (session) entries in the desktop session list ([#5253](https://github.com/QwenLM/qwen-code/pull/5253))
- plan-gate: isolate gate agent AbortSignal from parent signal chain ([#5185](https://github.com/QwenLM/qwen-code/pull/5185))
- core: honor output language in side queries ([#4519](https://github.com/QwenLM/qwen-code/pull/4519))
- cli: avoid stale git branch watcher setup ([#5271](https://github.com/QwenLM/qwen-code/pull/5271))
- desktop: detect WebP and AVI in RIFF magic-byte sniffing ([#5336](https://github.com/QwenLM/qwen-code/pull/5336))
- input: restore IME cursor positioning reverted in #4779 ([#4993](https://github.com/QwenLM/qwen-code/pull/4993))
- cli: close @path completion dropdown on Enter accept ([#4841](https://github.com/QwenLM/qwen-code/pull/4841))
- core: fall back to encrypted-file storage for extension secrets when keychain is unavailable ([#5221](https://github.com/QwenLM/qwen-code/pull/5221))
- core: support whitespace in session metadata fields ([#5353](https://github.com/QwenLM/qwen-code/pull/5353))
- core: prevent OOM in auto-memory extraction during /quit (#5147) ([#5181](https://github.com/QwenLM/qwen-code/pull/5181))
- core: expire tokens at buffer boundary ([#5360](https://github.com/QwenLM/qwen-code/pull/5360))
- cli: validate restore checkpoints before mutation ([#5358](https://github.com/QwenLM/qwen-code/pull/5358))
- core: honor ripgrep builtin setting at runtime ([#5362](https://github.com/QwenLM/qwen-code/pull/5362))
- core: create token file on first save ([#5367](https://github.com/QwenLM/qwen-code/pull/5367))
- cli: preserve workspace trust state for extensions ([#5369](https://github.com/QwenLM/qwen-code/pull/5369))
- cli: Stop after cancelled permissions ([#5258](https://github.com/QwenLM/qwen-code/pull/5258))
- core: resolve tilde paths before search permission checks ([#5378](https://github.com/QwenLM/qwen-code/pull/5378))
- cli: respect sandbox path boundaries ([#5375](https://github.com/QwenLM/qwen-code/pull/5375))
- cli: update acp cancel test flag ([#5384](https://github.com/QwenLM/qwen-code/pull/5384))
- core: avoid reconnecting on MCP tool errors ([#5382](https://github.com/QwenLM/qwen-code/pull/5382))
- core: accept uppercase web fetch schemes ([#5391](https://github.com/QwenLM/qwen-code/pull/5391))
- cli: preserve equals in mcp env values ([#5377](https://github.com/QwenLM/qwen-code/pull/5377))
- core: avoid glob prefix cache reuse ([#5364](https://github.com/QwenLM/qwen-code/pull/5364))
- core: validate grep result limits ([#5389](https://github.com/QwenLM/qwen-code/pull/5389))
- core: parse grep results with colon paths ([#5372](https://github.com/QwenLM/qwen-code/pull/5372))
- acp: scrub simple env for spawned children ([#5395](https://github.com/QwenLM/qwen-code/pull/5395))
- core: pass --no-ask-password to systemd-inhibit to prevent TUI corruption ([#5318](https://github.com/QwenLM/qwen-code/pull/5318))
- cli: parse sandbox mounts with windows drives ([#5388](https://github.com/QwenLM/qwen-code/pull/5388))
- core: add GLM-5.2 to Z.AI preset ([#5397](https://github.com/QwenLM/qwen-code/pull/5397))
- openai: add string tool result compatibility mode ([#5399](https://github.com/QwenLM/qwen-code/pull/5399))
- cli: clarify cumulative statusline token labels ([#5400](https://github.com/QwenLM/qwen-code/pull/5400))
- cli: reduce retained interactive tool output memory ([#4971](https://github.com/QwenLM/qwen-code/pull/4971))
- cli: calculate response rate from phase token delta ([#5402](https://github.com/QwenLM/qwen-code/pull/5402))
- cli: clarify unavailable model configuration hint ([#5403](https://github.com/QwenLM/qwen-code/pull/5403))
- cli: gate cron scheduler startup on config initialization (#5022) ([#5230](https://github.com/QwenLM/qwen-code/pull/5230))
- core: keep estimated token split summing to total ([#5420](https://github.com/QwenLM/qwen-code/pull/5420))
- core: share memory filename config state ([#5419](https://github.com/QwenLM/qwen-code/pull/5419))
- channel: scope qqbot session backup path ([#5417](https://github.com/QwenLM/qwen-code/pull/5417))
- channel: track qqbot close reconnect timer ([#5416](https://github.com/QwenLM/qwen-code/pull/5416))
- auth: preserve custom provider models on install ([#5404](https://github.com/QwenLM/qwen-code/pull/5404))
- core: target microcompaction cache disarms ([#5407](https://github.com/QwenLM/qwen-code/pull/5407))
- channel: keep qqbot token refresh retrying ([#5414](https://github.com/QwenLM/qwen-code/pull/5414))
- cli: keep keypress handlers current ([#5421](https://github.com/QwenLM/qwen-code/pull/5421))
- cli: narrow settings enum schemas ([#5418](https://github.com/QwenLM/qwen-code/pull/5418))
- channel: bound qqbot gateway reconnect retries ([#5415](https://github.com/QwenLM/qwen-code/pull/5415))
- core: block broad shell self-kill commands ([#5409](https://github.com/QwenLM/qwen-code/pull/5409))
- cli: preserve trustedFolders comments on save ([#4746](https://github.com/QwenLM/qwen-code/pull/4746))
- hooks: remove the dead updatedMCPToolOutput field (#5422) ([#5423](https://github.com/QwenLM/qwen-code/pull/5423))
- cli: accept uppercase URL schemes in mcp add transport detection ([#5426](https://github.com/QwenLM/qwen-code/pull/5426))
- extensions: accept uppercase URL schemes when parsing install sources ([#5429](https://github.com/QwenLM/qwen-code/pull/5429))
- core: provide escape path when plan gate is unavailable ([#5430](https://github.com/QwenLM/qwen-code/pull/5430))
- cli: stabilize extension list spacing ([#5445](https://github.com/QwenLM/qwen-code/pull/5445))
- weixin: handle uppercase CDN upload schemes ([#5439](https://github.com/QwenLM/qwen-code/pull/5439))

### Documentation

- add CLI subcommands section with qwen sessions list ([#5254](https://github.com/QwenLM/qwen-code/pull/5254))
- fix SSE ring size errors and add /workflows command ([#5205](https://github.com/QwenLM/qwen-code/pull/5205))
- Revamp README for clarity and focus ([#5257](https://github.com/QwenLM/qwen-code/pull/5257))
- cli: document tmux scroll workaround ([#5248](https://github.com/QwenLM/qwen-code/pull/5248))

### Other

- test(cli): enable load config model selection coverage ([#5274](https://github.com/QwenLM/qwen-code/pull/5274))
- test(cli): cover selection list scroll up ([#5276](https://github.com/QwenLM/qwen-code/pull/5276))
- test(cli): enable table foreground reset coverage ([#5278](https://github.com/QwenLM/qwen-code/pull/5278))
- test(core): enable agent headless termination coverage ([#5282](https://github.com/QwenLM/qwen-code/pull/5282))
- test(cli): enable command search long suggestion coverage ([#5283](https://github.com/QwenLM/qwen-code/pull/5283))

## [0.18.3](https://github.com/QwenLM/qwen-code/releases/tag/v0.18.3) - 2026-06-17

### Fixed

- cli: Stop after cancelled ask_user_question ([#5218](https://github.com/QwenLM/qwen-code/pull/5218))
- cli: render slash suggestion descriptions on a single truncated line ([#5236](https://github.com/QwenLM/qwen-code/pull/5236))
- core: always declare exit_plan_mode so plan mode can call it (#5210) ([#5251](https://github.com/QwenLM/qwen-code/pull/5251))

### Other

- ci(release): report required Test checks on release PRs and auto-approve ([#5250](https://github.com/QwenLM/qwen-code/pull/5250))

## [0.18.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.18.2) - 2026-06-17

### Added

- web-shell: support custom footer renderer ([#5166](https://github.com/QwenLM/qwen-code/pull/5166))
- web-shell: add imperative composer API for external text, tag, and submit control ([#5161](https://github.com/QwenLM/qwen-code/pull/5161))
- web-shell: per-turn time & tokens on the collapse seam, below the prompt ([#5163](https://github.com/QwenLM/qwen-code/pull/5163))
- cli: Add daemon status API ([#5174](https://github.com/QwenLM/qwen-code/pull/5174))
- core+cli: Workflow P4 — meta + /workflows + phase-tree (#4721) ([#5094](https://github.com/QwenLM/qwen-code/pull/5094))
- daemon: deliver web-shell mid-turn messages into the running turn ([#5175](https://github.com/QwenLM/qwen-code/pull/5175))
- tui: collapsible thinking blocks with duration timer ([#4598](https://github.com/QwenLM/qwen-code/pull/4598))
- web-shell: expose transcript event changes ([#5193](https://github.com/QwenLM/qwen-code/pull/5193))
- cli: add sessions list command with --json and --limit flags ([#5187](https://github.com/QwenLM/qwen-code/pull/5187))

### Fixed

- warn on oversized context instructions ([#5073](https://github.com/QwenLM/qwen-code/pull/5073))
- core: simplify edit tool description to path only ([#5140](https://github.com/QwenLM/qwen-code/pull/5140))
- monitor: batch-drain notifications to reduce token waste ([#5165](https://github.com/QwenLM/qwen-code/pull/5165))
- core: coerce numeric string params in SchemaValidator for MCP tools ([#4967](https://github.com/QwenLM/qwen-code/pull/4967))
- channels: match sender id as a full segment in SessionRouter ([#5116](https://github.com/QwenLM/qwen-code/pull/5116))
- agent: make forking explicit; keep omitted subagent_type awaitable ([#5155](https://github.com/QwenLM/qwen-code/pull/5155))
- core: auto-retry transport stream errors before the first chunk ([#5171](https://github.com/QwenLM/qwen-code/pull/5171))
- Qwen PR review proxy bypass, stale-worktree cleanup, and footer line break ([#5168](https://github.com/QwenLM/qwen-code/pull/5168))
- dingtalk: reopen code fences without inserting a blank line ([#5204](https://github.com/QwenLM/qwen-code/pull/5204))
- cli: hide unconfigured discontinued OAuth model ([#5167](https://github.com/QwenLM/qwen-code/pull/5167))
- permissions: do not model /dev/tcp and /dev/udp redirects as file I/O ([#5196](https://github.com/QwenLM/qwen-code/pull/5196))
- core: strengthen exit_plan_mode descriptions to prevent empty plan parameter ([#5188](https://github.com/QwenLM/qwen-code/pull/5188))
- desktop: keep latest feed stable-only ([#5149](https://github.com/QwenLM/qwen-code/pull/5149))
- core: read SHORT-typed TIFF dimensions correctly on big-endian files ([#5209](https://github.com/QwenLM/qwen-code/pull/5209))
- cli: skip highlightAuto for unlabeled code blocks with box-drawing/CJK content ([#5198](https://github.com/QwenLM/qwen-code/pull/5198))
- coerce non-string tool params to strings for self-hosted LLMs ([#4793](https://github.com/QwenLM/qwen-code/pull/4793))
- cli: keep sudo-required npm installs on npm instead of migrating to standalone ([#5207](https://github.com/QwenLM/qwen-code/pull/5207))
- e2e: add daemon_status to serve capabilities baseline; run E2E on PRs ([#5211](https://github.com/QwenLM/qwen-code/pull/5211))
- web-shell: localize remaining hardcoded UI strings ([#5189](https://github.com/QwenLM/qwen-code/pull/5189))
- acp: load extension commands in daemon sessions ([#5216](https://github.com/QwenLM/qwen-code/pull/5216))
- web-shell: simplify collapse metadata display ([#5223](https://github.com/QwenLM/qwen-code/pull/5223))
- ci: gate PR review and triage on write permission ([#5191](https://github.com/QwenLM/qwen-code/pull/5191))

### Documentation

- fix stale defaults, CLI syntax, and tool naming drift ([#5158](https://github.com/QwenLM/qwen-code/pull/5158))
- daemon: Refresh daemon docs in English ([#5144](https://github.com/QwenLM/qwen-code/pull/5144))
- design: DaemonTransport abstraction — pluggable transport for SDK ([#5026](https://github.com/QwenLM/qwen-code/pull/5026))
- add Qwen Code Desktop release link ([#5152](https://github.com/QwenLM/qwen-code/pull/5152))
- fix MCP token path, daemon UI event count, add Feishu channel ([#5172](https://github.com/QwenLM/qwen-code/pull/5172))
- channels: add screenshots to Feishu setup guide ([#4983](https://github.com/QwenLM/qwen-code/pull/4983))
- fix missing spaces before parentheses in README ([#4796](https://github.com/QwenLM/qwen-code/pull/4796))

### Other

- ci: publish autofix PRs as qwen-code-ci-bot ([#5137](https://github.com/QwenLM/qwen-code/pull/5137))
- Polish web-shell execution display ([#5190](https://github.com/QwenLM/qwen-code/pull/5190))
- Fix completed prompt lifecycle race ([#5192](https://github.com/QwenLM/qwen-code/pull/5192))
- ci(autofix): prioritize recent unattended bugs over stale ones ([#5178](https://github.com/QwenLM/qwen-code/pull/5178))
- Revert "fix(core): skip auto-title generation when history has no user message" ([#5200](https://github.com/QwenLM/qwen-code/pull/5200))
- ci: run CLI integration tests in the merge queue ([#5224](https://github.com/QwenLM/qwen-code/pull/5224))
- ci(autofix): unify issue-fix and review-response into one lifecycle workflow ([#5233](https://github.com/QwenLM/qwen-code/pull/5233))
- ci(e2e): stop running the E2E matrix on every PR push ([#5238](https://github.com/QwenLM/qwen-code/pull/5238))

## [0.18.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.18.1) - 2026-06-15

### Added

- daemon: gate direct session shell behind explicit opt-in ([#5031](https://github.com/QwenLM/qwen-code/pull/5031))
- core: persist oversized tool results to disk (#4095 Phase 4) ([#5042](https://github.com/QwenLM/qwen-code/pull/5042))
- core,cli: bubble background subagent permission prompts to the parent session ([#4955](https://github.com/QwenLM/qwen-code/pull/4955))
- core: let grep results satisfy prior-read checks ([#5043](https://github.com/QwenLM/qwen-code/pull/5043))
- skills: support user-invocable frontmatter ([#5037](https://github.com/QwenLM/qwen-code/pull/5037))
- serve: deliver A2UI surfaces over MCP — bridge extraction and action endpoint ([#4961](https://github.com/QwenLM/qwen-code/pull/4961))
- mcp: project .mcp.json + workspace approval gating with aligned scope precedence (#4615) ([#4713](https://github.com/QwenLM/qwen-code/pull/4713))
- web-shell: daemon web-shell improvements — token usage, settings, retry, streaming metrics, hidden commands ([#5066](https://github.com/QwenLM/qwen-code/pull/5066))
- web-shell: revamp floating todo panel interactions ([#5069](https://github.com/QwenLM/qwen-code/pull/5069))
- web-shell: show message time on hover ([#5079](https://github.com/QwenLM/qwen-code/pull/5079))
- core: durable cron jobs — /loop tasks that survive restarts ([#5004](https://github.com/QwenLM/qwen-code/pull/5004))
- web-shell: show time on parallel-agents box and sub-agent tools ([#5084](https://github.com/QwenLM/qwen-code/pull/5084))
- sdk,serve: DaemonTransport abstraction + ACP standard compliance ([#5040](https://github.com/QwenLM/qwen-code/pull/5040))
- core: Workflow P3 — agent({schema, agentType, model, isolation:'worktree'}) (#4721) ([#5034](https://github.com/QwenLM/qwen-code/pull/5034))
- core: migrate Computer Use to cua-driver (cross-platform) ([#5051](https://github.com/QwenLM/qwen-code/pull/5051))
- web-shell: reveal full tool detail and auto-collapse finished tools ([#5088](https://github.com/QwenLM/qwen-code/pull/5088))
- web-shell: make input shortcuts discoverable and clickable ([#5096](https://github.com/QwenLM/qwen-code/pull/5096))
- cli,web-shell: persist goal status in daemon transcript events ([#5098](https://github.com/QwenLM/qwen-code/pull/5098))
- acp: dedicated agent permission dialog via _meta.toolName (follow-up to #5085) ([#5105](https://github.com/QwenLM/qwen-code/pull/5105))
- cli: import Claude MCP servers ([#5095](https://github.com/QwenLM/qwen-code/pull/5095))
- cli: improve /copy command argumentHint and description ([#5110](https://github.com/QwenLM/qwen-code/pull/5110))
- web-shell: collapsible TodoWrite history with status diff ([#5109](https://github.com/QwenLM/qwen-code/pull/5109))
- computer-use: configurable screenshot max dimension (setting + env) ([#5122](https://github.com/QwenLM/qwen-code/pull/5122))
- web-shell: per-task token & time detail on completed todos ([#5118](https://github.com/QwenLM/qwen-code/pull/5118))
- web-shell: collapse completed turns to prompt + final answer ([#5125](https://github.com/QwenLM/qwen-code/pull/5125))
- desktop: show git branch in working directory badge ([#5082](https://github.com/QwenLM/qwen-code/pull/5082))
- triage: make minimal-change an explicit PR review check ([#5146](https://github.com/QwenLM/qwen-code/pull/5146))

### Changed

- web-shell: remove duplicate agents panel, contain SubAgent views ([#5059](https://github.com/QwenLM/qwen-code/pull/5059))
- core: unify retry delay policy ([#3827](https://github.com/QwenLM/qwen-code/pull/3827))

### Fixed

- telemetry: Propagate daemon ACP trace context ([#5047](https://github.com/QwenLM/qwen-code/pull/5047))
- docs: update Coding Plan model list and fix stale references in developer docs ([#5054](https://github.com/QwenLM/qwen-code/pull/5054))
- daemon: Sanitize logs and type MCP restarts ([#5006](https://github.com/QwenLM/qwen-code/pull/5006))
- memory: avoid stale tool schema recall ([#5058](https://github.com/QwenLM/qwen-code/pull/5058))
- core: eliminate OOM from debugResponses accumulation ([#4982](https://github.com/QwenLM/qwen-code/pull/4982))
- enable fork subagents by default ([#4963](https://github.com/QwenLM/qwen-code/pull/4963))
- core: preserve background agent launch flags ([#5061](https://github.com/QwenLM/qwen-code/pull/5061))
- web-shell: improve slash command panel layering ([#5078](https://github.com/QwenLM/qwen-code/pull/5078))
- serve: Add prompt queue backpressure ([#5033](https://github.com/QwenLM/qwen-code/pull/5033))
- cli: show full plan for gate failures ([#5077](https://github.com/QwenLM/qwen-code/pull/5077))
- cli: submit fast tool results after stream end ([#5071](https://github.com/QwenLM/qwen-code/pull/5071))
- cli: ignore expired live agents in focus navigation ([#5070](https://github.com/QwenLM/qwen-code/pull/5070))
- cli: drop tool calls after cancellation ([#5020](https://github.com/QwenLM/qwen-code/pull/5020))
- core: Persist file history snapshot updates ([#5057](https://github.com/QwenLM/qwen-code/pull/5057))
- cli: add OSC 52 clipboard fallback for SSH environments ([#4929](https://github.com/QwenLM/qwen-code/pull/4929))
- webui: defer DaemonClient disposal to survive React StrictMode ([#5091](https://github.com/QwenLM/qwen-code/pull/5091))
- cli,core: harden OOM prevention — idempotent compaction tests, explicit GC, debug log defaults ([#4914](https://github.com/QwenLM/qwen-code/pull/4914))
- cli: wrap long status lines ([#5093](https://github.com/QwenLM/qwen-code/pull/5093))
- acp: add internal Kind.Agent, keep ACP wire on 'other' (no-regression) ([#5085](https://github.com/QwenLM/qwen-code/pull/5085))
- ci: fail PR review job when the run aborts mid-review ([#5053](https://github.com/QwenLM/qwen-code/pull/5053))
- core: default GLM-5.2+ and GLM-6.x onward to 1M context ([#5103](https://github.com/QwenLM/qwen-code/pull/5103))
- daemon: Avoid replaying truncated session diffs ([#5108](https://github.com/QwenLM/qwen-code/pull/5108))
- core: Repair duplicate tool call IDs ([#5107](https://github.com/QwenLM/qwen-code/pull/5107))
- core: hard-stop repeated identical tool calls ([#5036](https://github.com/QwenLM/qwen-code/pull/5036))
- core: keep token escalation warm across agent rounds ([#5062](https://github.com/QwenLM/qwen-code/pull/5062))
- core: bound hard rescue compression retries ([#4526](https://github.com/QwenLM/qwen-code/pull/4526))
- core: bound foreground shell output capture ([#4524](https://github.com/QwenLM/qwen-code/pull/4524))
- core: compress when usage metadata is missing ([#4528](https://github.com/QwenLM/qwen-code/pull/4528))
- core: ignore agent names without active teams ([#5115](https://github.com/QwenLM/qwen-code/pull/5115))
- core: include response tokens in prompt estimate ([#4525](https://github.com/QwenLM/qwen-code/pull/4525))
- dual-output: prevent FIFO blocking on startup when no reader connected ([#4894](https://github.com/QwenLM/qwen-code/pull/4894))
- core: honor skipLoopDetection for the deterministic tool-call loop ([#5128](https://github.com/QwenLM/qwen-code/pull/5128))
- core: Bound active tool result history ([#5111](https://github.com/QwenLM/qwen-code/pull/5111))
- desktop: isolate update feed from CLI releases ([#5139](https://github.com/QwenLM/qwen-code/pull/5139))
- web-shell: remove redundant sanitizeSvg, fix mermaid render failure ([#5123](https://github.com/QwenLM/qwen-code/pull/5123))
- core: skip auto-title generation when history has no user message ([#5120](https://github.com/QwenLM/qwen-code/pull/5120))
- release: allow cli-entry.js in standalone dist allowlist ([#5153](https://github.com/QwenLM/qwen-code/pull/5153))

### Documentation

- Refresh daemon developer docs ([#4412](https://github.com/QwenLM/qwen-code/pull/4412))
- rewrite CLAUDE.md to point to AGENTS.md as authoritative source ([#5138](https://github.com/QwenLM/qwen-code/pull/5138))

### Other

- chore: sync package-lock.json with packages/cli ws dependencies ([#5023](https://github.com/QwenLM/qwen-code/pull/5023))
- test(cli): Cover rewind selection and confirm flow ([#5044](https://github.com/QwenLM/qwen-code/pull/5044))
- test: stabilize simple MCP integration check ([#5072](https://github.com/QwenLM/qwen-code/pull/5072))
- ci: add scheduled autofix workflow for stale bug issues ([#4989](https://github.com/QwenLM/qwen-code/pull/4989))
- fix release integration env controls ([#5121](https://github.com/QwenLM/qwen-code/pull/5121))

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
