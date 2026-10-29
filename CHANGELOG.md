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

## [0.26.3](https://github.com/QwenLM/qwen-code/releases/tag/v0.26.3) - 2026-10-28

### Highlights

- Generated UI cards keep inputs and state across navigation and split views, show live views after initial calculation, and appear only for clients that can render MCP Apps. ([#15611](https://github.com/QwenLM/qwen-code/pull/15611), [#15787](https://github.com/QwenLM/qwen-code/pull/15787), [#15720](https://github.com/QwenLM/qwen-code/pull/15720), [#15790](https://github.com/QwenLM/qwen-code/pull/15790))
- Persistent session Workflow mode can be enabled with --workflow-mode on, /workflows mode on, SDK, or ACP, and workflow switches now reach the CLI sandbox. ([#15422](https://github.com/QwenLM/qwen-code/pull/15422), [#15743](https://github.com/QwenLM/qwen-code/pull/15743))
- Tool results shrink to remaining headroom before auto-compaction, and qwen-latest-series- or qwen4 aliases are detected with 1M-token context windows. ([#13599](https://github.com/QwenLM/qwen-code/pull/13599), [#15758](https://github.com/QwenLM/qwen-code/pull/15758), [#15762](https://github.com/QwenLM/qwen-code/pull/15762))
- Valid XML tool calls are recovered when parameters quote other call markup, malformed blocks are isolated, and quoted examples are not dispatched. ([#13579](https://github.com/QwenLM/qwen-code/pull/13579))
- ACP and daemon clients keep rewind identity consistent across retries, cancellations, checkpoints, recordings, and notifications, while SDK frames preserve subagent identity. ([#15441](https://github.com/QwenLM/qwen-code/pull/15441), [#15657](https://github.com/QwenLM/qwen-code/pull/15657))
- /autofix-pr start stops when the PR head branch has unpushed commits or uncommitted changes, preventing the watch from overwriting unseen work. ([#15736](https://github.com/QwenLM/qwen-code/pull/15736))

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- feat(memory): opt-in extraction cadence after a no-op run ([#13571](https://github.com/QwenLM/qwen-code/pull/13571)) by @yiliang114
- Shrinks tool results to remaining headroom before auto-compaction, respecting explicit truncation settings and protected content to reduce unnecessary compaction. ([#13599](https://github.com/QwenLM/qwen-code/pull/13599)) by @yiliang114
- Keeps eligible Generated UI cards alive across history navigation, session switching, and split-view changes in the same page, preserving inputs, controls, and runtime state. ([#15611](https://github.com/QwenLM/qwen-code/pull/15611)) by @qqqys
- Adds persistent session Workflow mode through --workflow-mode on, /workflows mode on, SDK, and ACP controls, with saved mode shown in Ink and OpenTUI. ([#15422](https://github.com/QwenLM/qwen-code/pull/15422)) by @qqqys
- Adds opt-in composerVariant simple to Web Shell, providing a compact input with a limited add menu and shared editor, attachments, and session actions. ([#15663](https://github.com/QwenLM/qwen-code/pull/15663)) by @samuelhsin
- /autofix-pr start now stops if the PR head branch has unpushed commits or uncommitted changes, preventing the watch from overwriting unseen work. ([#15736](https://github.com/QwenLM/qwen-code/pull/15736)) by @wenshao
- Adds administrator-driven reclamation and reuse of idle resident CSI Workspaces with cleanup verification and atomic release. ([#15729](https://github.com/QwenLM/qwen-code/pull/15729)) by @doudouOUC
- OpenTUI terminals now draw the Mods band above the prompt and run Mod ui.render hooks there, matching the Ink terminal experience. ([#15699](https://github.com/QwenLM/qwen-code/pull/15699)) by @qqqys
- ACP live frames, persisted replays, SDK normalization, and transcript reduction now preserve subagent identity for thoughts, messages, and tool frames. ([#15657](https://github.com/QwenLM/qwen-code/pull/15657)) by @yiliang114
- Archived conversations are now managed in Settings → Archived conversations in Web Shell, keeping archive groups, filters, and lifecycle actions. ([#15557](https://github.com/QwenLM/qwen-code/pull/15557)) by @deggs7
- Managed Agent can now be embedded opt-in in a Java host's JVM and Spring context, with dedicated connection pooling or a supplied DataSource. ([#15718](https://github.com/QwenLM/qwen-code/pull/15718)) by @yiliang114
- /verify-pr now supports a failures ledger and rejects findings or blocked verdicts unless failures are attributed to the PR. ([#15764](https://github.com/QwenLM/qwen-code/pull/15764)) by @wenshao
- Adds the qwen-managed-agent-admin launcher for running managed-agent offline maintenance commands by name, with help and unknown-command handling. ([#15772](https://github.com/QwenLM/qwen-code/pull/15772)) by @wenshao
- feat(generated-ui): check a view's initial calculation before display ([#15790](https://github.com/QwenLM/qwen-code/pull/15790)) by @qqqys

#### Bug Fixes

- Recovers valid XML tool calls when parameters quote other call markup, isolates malformed blocks, and prevents quoted examples from being dispatched. ([#13579](https://github.com/QwenLM/qwen-code/pull/13579)) by @yiliang114
- Carries rewind identity through ACP/daemon clients so retries, cancellations, checkpoint resolution, recording, and notifications stay consistent. ([#15441](https://github.com/QwenLM/qwen-code/pull/15441)) by @yiliang114
- Fixes release publishing checkout failures by using the run-scoped GitHub token for read-only checkout while keeping the bot PAT for write steps. ([#15728](https://github.com/QwenLM/qwen-code/pull/15728)) by @qwen-code-dev-bot
- Pins pull request CI retries to the head SHA from the triggering event so reruns test the intended commit. ([#15734](https://github.com/QwenLM/qwen-code/pull/15734)) by @yiliang114
- fix(cli): forward workflow switches into the CLI sandbox (#15740) ([#15743](https://github.com/QwenLM/qwen-code/pull/15743)) by @qwen-code-dev-bot
- Recognizes invite-only qwen-latest-series- model aliases as 1M-context models in the context-window detector. ([#15758](https://github.com/QwenLM/qwen-code/pull/15758)) by @wenshao
- Makes daemon-managed channels honor approvalMode even when no webhooks are configured, matching standalone startup. ([#15754](https://github.com/QwenLM/qwen-code/pull/15754)) by @qqqys
- Shows the exception class in managed-agent scan summaries for non-first row failures that have no message. ([#15725](https://github.com/QwenLM/qwen-code/pull/15725)) by @yiliang114
- Workspace Skill inventory queries now return a retained snapshot immediately and refresh in the background, while cold reads, deletion, and enablement wait for fresh data. ([#14890](https://github.com/QwenLM/qwen-code/pull/14890)) by @callmeYe
- qwen4 model identifiers are now sized with a 1,000,000-token context window by default when no upstream catalog entry defines them. ([#15762](https://github.com/QwenLM/qwen-code/pull/15762)) by @wenshao
- Acceptance tests now wait for the focused shell Tab byte to reach the child process before asserting exact input bytes, preventing flaky failures. ([#15763](https://github.com/QwenLM/qwen-code/pull/15763)) by @yiliang114
- Managed runtime distribution now publishes verified server artifacts to GitHub Releases and OSS without requiring Maven Central, keeping CLI downloads unchanged. ([#15782](https://github.com/QwenLM/qwen-code/pull/15782)) by @doudouOUC
- Generated UI is now offered only to sessions whose client can render MCP Apps, while unsupported clients receive a clear unsupported-client reason. ([#15720](https://github.com/QwenLM/qwen-code/pull/15720)) by @qqqys
- In Web Shell, live Generated UI cards now attach and show their interactive view immediately when tool results arrive instead of requiring reopen. ([#15787](https://github.com/QwenLM/qwen-code/pull/15787)) by @qqqys
- Desktop release preparation now resets Git metadata on self-hosted runners before checkout to avoid stale-workspace failures. ([#15761](https://github.com/QwenLM/qwen-code/pull/15761)) by @yiliang114

#### Documentation

- Documents managed-agent shared-Session queue behavior and advises giving slow-probed gated definitions their own Session. ([#15724](https://github.com/QwenLM/qwen-code/pull/15724)) by @yiliang114

#### Internal Changes

- Internal tests now compare git worktree prune dry-run results as an unordered set, making them insensitive to git output order. ([#15767](https://github.com/QwenLM/qwen-code/pull/15767)) by @yiliang114
- Managed snapshot pool test setup now allows a three-second database connection lease so schema creation on busy CI runners is less likely to fail. ([#15749](https://github.com/QwenLM/qwen-code/pull/15749)) by @yiliang114
- Installed npm and private Bun acceptance tests now run nightly and by manual dispatch instead of on every PR update, while source TUI PR behavior stays unchanged. ([#15719](https://github.com/QwenLM/qwen-code/pull/15719)) by @yiliang114
- Improved Managed Agent reliability testing by adding terminal recovery fault gates for failover scenarios. ([#15756](https://github.com/QwenLM/qwen-code/pull/15756)) by @wenshao
- Improved CLI test stability for review cleanup orphan-process handling by making process liveness deterministic. ([#15751](https://github.com/QwenLM/qwen-code/pull/15751)) by @yiliang114
- Hosted gates now use a shared zombie-aware liveness check, improving consistency when waiting for processes to stop. ([#15777](https://github.com/QwenLM/qwen-code/pull/15777)) by @wenshao

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.26.2...v0.26.3

## [0.26.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.26.2) - 2026-10-27

### Highlights

_See the complete change list below._

### Breaking Changes

- fix(managed-agent)!: simplify Web Shell controls and retire cwd submissions ([#15616](https://github.com/QwenLM/qwen-code/pull/15616)) by @doudouOUC

### Complete Change List

#### Features

- feat(managed): add session permission rules and Auto approval ([#15448](https://github.com/QwenLM/qwen-code/pull/15448)) by @doudouOUC
- feat(core): add an experimental shared agent loop and run headless on it ([#15369](https://github.com/QwenLM/qwen-code/pull/15369)) by @qqqys
- Adds X-DashScope-Source-Config to matching QwenCloud and Qianwen AI Platform requests to identify site and client, without changing authentication or retries. ([#15041](https://github.com/QwenLM/qwen-code/pull/15041)) by @yiliang114
- Resumed OpenTUI sessions now retain recorded text, images, tool results, and prompt identities, while rewind restores transcript, request, and draft. ([#15384](https://github.com/QwenLM/qwen-code/pull/15384)) by @chiga0
- OpenTUI now captures complete checkpoints at edit approvals and restores them safely, preserving conversation metadata and blocking stale or cancelled owners. ([#15389](https://github.com/QwenLM/qwen-code/pull/15389)) by @chiga0
- Adds automation.scanner-threads to run managed automation scanner rows on a dedicated pool and leases rows from claim time. ([#15442](https://github.com/QwenLM/qwen-code/pull/15442)) by @yiliang114
- Adds Continue analysis with current parameters so Generated UI users can review and send frozen parameters to the original session. ([#15333](https://github.com/QwenLM/qwen-code/pull/15333)) by @qqqys
- Adds an opt-in external-scratch Runtime provider that lets an operator-run HTTP service place Session workers while preserving attestation and recovery. ([#15261](https://github.com/QwenLM/qwen-code/pull/15261)) by @yiliang114
- Adds a prompt argument hint for /verify-pr so users can see the PR number and supported flags such as --publish and --watch. ([#15463](https://github.com/QwenLM/qwen-code/pull/15463)) by @wenshao
- Adds a durable queue for messages sent during a Managed Turn, allowing queued text and file references to be delivered, edited, withdrawn, or resumed safely. ([#15449](https://github.com/QwenLM/qwen-code/pull/15449)) by @doudouOUC
- Adds /autofix-pr status to list all watches in a clone and lets users resume a watch in a later session. ([#15510](https://github.com/QwenLM/qwen-code/pull/15510)) by @wenshao
- Adds a Git URL source to the Web Shell Add-workspace dialog so users can clone a repository and open it as a workspace in the browser. ([#15361](https://github.com/QwenLM/qwen-code/pull/15361)) by @wenshao
- Enables image and PDF delivery for managed runtime providers with a 768 KiB base64 media limit and a 896 KiB tool-result limit. ([#13606](https://github.com/QwenLM/qwen-code/pull/13606)) by @water-in-stone
- feat(managed-agent): give the Hosted Harness its Broker through the environment ([#15244](https://github.com/QwenLM/qwen-code/pull/15244)) by @wenshao
- Adds an operator endpoint to register immutable, idempotent EXTERNAL Workspace storage ownership with provider identity and tenant alias. ([#15516](https://github.com/QwenLM/qwen-code/pull/15516)) by @yiliang114
- UserPromptSubmit hooks no longer re-append byte-identical additionalContext within a session, avoiding duplicate context and keeping transcripts accurate. ([#14129](https://github.com/QwenLM/qwen-code/pull/14129)) by @yiliang114
- Mods can now observe turn.start and turn.complete events in headless and terminal runs, and use $.turn.abort to end a running turn. ([#15443](https://github.com/QwenLM/qwen-code/pull/15443)) by @qqqys
- Web Shell Settings now lets you list, add, and remove extra workspace directories, applying changes to live sessions and informing the model of new roots. ([#15393](https://github.com/QwenLM/qwen-code/pull/15393)) by @wenshao
- feat(autofix-pr): run the helpers through a tool, and let a confirmed watch's fixes run unattended ([#15548](https://github.com/QwenLM/qwen-code/pull/15548)) by @wenshao
- feat(managed-agent): let the bootstrap set the service account and MySQL up ([#15543](https://github.com/QwenLM/qwen-code/pull/15543)) by @wenshao
- feat(managed-agent): add pinned extension package management ([#15490](https://github.com/QwenLM/qwen-code/pull/15490)) by @doudouOUC
- feat(managed-agent): support Workspace file uploads ([#15586](https://github.com/QwenLM/qwen-code/pull/15586)) by @doudouOUC
- feat(core): Add durable terminal identity lookup ([#15566](https://github.com/QwenLM/qwen-code/pull/15566)) by @doudouOUC
- When experimental.unifiedAgentLoop is enabled, fresh ACP user prompts run their model round on the shared agent loop while ACP keeps its own tool-step handling. ([#15509](https://github.com/QwenLM/qwen-code/pull/15509)) by @qqqys
- The Mod runtime adds ui.render, $.ui.resolve, and $.ui.invalidate support, enabling render-site hooks and terminal element resolution before hosts draw UI. ([#15591](https://github.com/QwenLM/qwen-code/pull/15591)) by @qqqys
- feat(web-shell): add plain-text and Markdown reply copying ([#15345](https://github.com/QwenLM/qwen-code/pull/15345)) by @ytahdn
- feat(cli): connect OpenTUI voice input to the shared pipeline ([#15617](https://github.com/QwenLM/qwen-code/pull/15617)) by @chiga0
- feat(ci): canary-split the PR review model by PR number ([#15538](https://github.com/QwenLM/qwen-code/pull/15538)) by @yiliang114
- feat(daemon): add cached workspace artifact queries and batch removal ([#15594](https://github.com/QwenLM/qwen-code/pull/15594)) by @BZ-D
- feat(managed-agent): add native snapshots and HTTP recovery ([#15569](https://github.com/QwenLM/qwen-code/pull/15569)) by @doudouOUC
- feat(cli): admit Managed Runtime boot-v2 with external storage and publication surface in container mode ([#15522](https://github.com/QwenLM/qwen-code/pull/15522)) by @yiliang114
- feat(tools): let an explicitly configured search backend name its host ([#15638](https://github.com/QwenLM/qwen-code/pull/15638)) by @yiliang114
- feat(cli): align OpenTUI foreground shell controls with Ink ([#15642](https://github.com/QwenLM/qwen-code/pull/15642)) by @chiga0
- feat(acp): run the tool batches of fresh prompts on the shared agent loop ([#15627](https://github.com/QwenLM/qwen-code/pull/15627)) by @qqqys
- feat(serve): allow secondary sessions to cd within their workspace ([#15323](https://github.com/QwenLM/qwen-code/pull/15323)) by @rockybot2026
- feat(mods): draw the band above the prompt in the Ink terminal ([#15619](https://github.com/QwenLM/qwen-code/pull/15619)) by @qqqys
- feat(autofix-pr): run an unattended watch's fix agent in the background ([#15578](https://github.com/QwenLM/qwen-code/pull/15578)) by @wenshao
- feat(core): add local managed journal snapshot recovery ([#15626](https://github.com/QwenLM/qwen-code/pull/15626)) by @doudouOUC
- feat(verify-pr): add a local preflight and a verdict check ([#15614](https://github.com/QwenLM/qwen-code/pull/15614)) by @wenshao
- feat(web-shell): show /autofix-pr watches and stop them from the Web Shell ([#15668](https://github.com/QwenLM/qwen-code/pull/15668)) by @wenshao
- feat(mods): compile JSX in .tsx and .jsx Mod modules ([#15624](https://github.com/QwenLM/qwen-code/pull/15624)) by @qqqys
- feat(cli): bind the PR named by a /verify-pr prompt ([#15625](https://github.com/QwenLM/qwen-code/pull/15625)) by @wenshao
- feat(cli): complete OpenTUI extension discovery and source management ([#15671](https://github.com/QwenLM/qwen-code/pull/15671)) by @chiga0
- feat(managed-agent): add the external-workspace provisioning prerequisite (#15512) ([#15654](https://github.com/QwenLM/qwen-code/pull/15654)) by @yiliang114
- feat(web-shell): nest derived sessions under their parent in the sidebar ([#15714](https://github.com/QwenLM/qwen-code/pull/15714)) by @wenshao
- feat(web-shell): name new sessions from the first prompt ([#15689](https://github.com/QwenLM/qwen-code/pull/15689)) by @wenshao
- feat(managed-agent): check Harness compatibility, leftover workers and a live service in preflight ([#15564](https://github.com/QwenLM/qwen-code/pull/15564)) by @wenshao
- feat(web-shell): stream BTW answers with reconnect and scroll following ([#15709](https://github.com/QwenLM/qwen-code/pull/15709)) by @ytahdn
- feat(cli): run only the tests related to the diff in review build-test ([#15547](https://github.com/QwenLM/qwen-code/pull/15547)) by @wenshao

#### Bug Fixes

- fix(cli): harden serve token resolution against project env injection ([#15228](https://github.com/QwenLM/qwen-code/pull/15228)) by @yiliang114
- fix(cli): align OpenTUI cancellation and retry with Ink ([#15283](https://github.com/QwenLM/qwen-code/pull/15283)) by @chiga0
- test(managed-agent): assert web_fetch in the Hosted workspace gate fixture ([#15451](https://github.com/QwenLM/qwen-code/pull/15451)) by @yiliang114
- fix(vscode): leave edit mode after a refused edit ([#15439](https://github.com/QwenLM/qwen-code/pull/15439)) by @yiliang114
- fix(rewind): resolve legacy turns by source identity ([#13737](https://github.com/QwenLM/qwen-code/pull/13737)) by @yiliang114
- Retires registered Linux zombie workers before startup waits, preventing a 30-second delay and returning a prompt terminal conflict instead. ([#15459](https://github.com/QwenLM/qwen-code/pull/15459)) by @doudouOUC
- Preserves arrival order of direct-mode stream-json startup messages so pipelined client requests execute and return results in the intended order. ([#15378](https://github.com/QwenLM/qwen-code/pull/15378)) by @yiliang114
- Restores managed-agent module and CLI build lanes by correcting the schema inventory column total after new permission-rule columns were added. ([#15455](https://github.com/QwenLM/qwen-code/pull/15455)) by @yiliang114
- Makes the team-lead Hosted MySQL integration boot retry when the harness loses its reserved port, reducing flaky test timeouts. ([#15224](https://github.com/QwenLM/qwen-code/pull/15224)) by @qwen-code-dev-bot
- CLI checkpoint restores now preserve ownership, Read permissions, and prompt history so cold resume and later rewind behave consistently. ([#15386](https://github.com/QwenLM/qwen-code/pull/15386)) by @chiga0
- Eligible npm sessions using OpenTUI now run on private Bun 1.4.4 while preserving Node for npm subprocesses and existing encrypted settings. ([#15387](https://github.com/QwenLM/qwen-code/pull/15387)) by @chiga0
- The main CI failure reporter now files issues even when a newer main run is still pending, adding a provisional note instead of dropping the failure. ([#15471](https://github.com/QwenLM/qwen-code/pull/15471)) by @yiliang114
- Web Shell permission-rule declarations are now self-contained so package publishing no longer fails on unresolvable core-module imports. ([#15501](https://github.com/QwenLM/qwen-code/pull/15501)) by @yiliang114
- CLI preserves OpenTUI clipboard source attribution and collapsed large pastes during draft recovery, queue restoration, cancellation, and recall. ([#15396](https://github.com/QwenLM/qwen-code/pull/15396)) by @chiga0
- Hosted MySQL test isolation preserves the original table-truncation error when foreign-key restore also fails. ([#15505](https://github.com/QwenLM/qwen-code/pull/15505)) by @yiliang114
- CLI cost estimates no longer double-count reasoning tokens for OpenAI Chat Completions, OpenAI Responses, and Qwen OAuth usage. ([#15464](https://github.com/QwenLM/qwen-code/pull/15464)) by @yiliang114
- Release automation limits release-note summary requests to three concurrent waves, keeps result order, and refreshes release PRs from main before automated approvals. ([#15500](https://github.com/QwenLM/qwen-code/pull/15500)) by @yiliang114
- Managed Web Shell prevents duplicate message composers and keeps drafts stable during Session polling or permission-rule rerenders. ([#15496](https://github.com/QwenLM/qwen-code/pull/15496)) by @doudouOUC
- On Linux, Web Shell no longer shows the native directory Browse button when the X11 display is unreachable. ([#15434](https://github.com/QwenLM/qwen-code/pull/15434)) by @yiliang114
- Raises timeout budgets for the standalone Node/Bun regression suite on the release pool and cleans up outdated exemptions. ([#15102](https://github.com/QwenLM/qwen-code/pull/15102)) by @qwen-code-dev-bot
- Refuses to start pull-request autofix watch from a checkout that cannot run it and reports the required working directory. ([#15506](https://github.com/QwenLM/qwen-code/pull/15506)) by @wenshao
- Simplifies Web Shell status display when loading phrases are hidden and improves status text contrast. ([#15423](https://github.com/QwenLM/qwen-code/pull/15423)) by @deggs7
- Keeps incremental lint history fetching lightweight and surfaces fallback as a CI warning and step summary. ([#15511](https://github.com/QwenLM/qwen-code/pull/15511)) by @yiliang114
- Gives eligible main push SHAs separate CI concurrency groups so independent main validations are not displaced by newer pending runs. ([#15508](https://github.com/QwenLM/qwen-code/pull/15508)) by @yiliang114
- Authenticates managed-runtime OSS preflight checks so release publishing can verify existing artifacts and avoid failed uploads. ([#15504](https://github.com/QwenLM/qwen-code/pull/15504)) by @yiliang114
- Runs the self-hosted SDK Java test suite before taking the host lock to reduce timeouts and lock contention in CI. ([#15254](https://github.com/QwenLM/qwen-code/pull/15254)) by @qwen-code-dev-bot
- Prevents the main CI failure tracker from filing issues for post-merge PR reruns that do not reflect the merged tree. ([#15250](https://github.com/QwenLM/qwen-code/pull/15250)) by @qwen-code-dev-bot
- Hides unavailable Managed background tools so Background Shell and Monitor appear only when the session can run them. ([#15497](https://github.com/QwenLM/qwen-code/pull/15497)) by @doudouOUC
- Fixes a managed-agent shutdown error caused by lifecycle renewal scheduling. ([#15231](https://github.com/QwenLM/qwen-code/pull/15231)) by @qwen-code-dev-bot
- Unblocks independent same-tenant resident workspaces blocked by an unreclaimed binding and fixes hosted file tool admission. ([#15457](https://github.com/QwenLM/qwen-code/pull/15457)) by @doudouOUC
- In Web Shell standalone sessions, Language: UI is now a user setting, so changing it no longer fails with workspace-scope errors. ([#15521](https://github.com/QwenLM/qwen-code/pull/15521)) by @wenshao
- Failed queued automatic memory extraction now logs a debug warning instead of causing an unhandled rejection. ([#15338](https://github.com/QwenLM/qwen-code/pull/15338)) by @wenshao
- Credential-free release preparation jobs now run on shared ECS runners in the official repository, with existing fallbacks preserved. ([#15517](https://github.com/QwenLM/qwen-code/pull/15517)) by @yiliang114
- Headless CLI retries now show a retry classification on stderr, making transport failures and restart reasons easier to diagnose. ([#15515](https://github.com/QwenLM/qwen-code/pull/15515)) by @yiliang114
- In Web Shell, /autofix-pr watches now persist as durable tasks, so they survive idle session reclamation and appear in Scheduled tasks. ([#15523](https://github.com/QwenLM/qwen-code/pull/15523)) by @wenshao
- Deletes a turn's memory catalog snapshot record when the turn is removed, preventing orphaned snapshots while preserving catalog continuity. ([#15540](https://github.com/QwenLM/qwen-code/pull/15540)) by @yiliang114
- Fixes ARM64 CI lane pricing so self-hosted lanes get correct ceilings: lint 45 to 90 minutes and no-AK integration 30 to 60 minutes. ([#15529](https://github.com/QwenLM/qwen-code/pull/15529)) by @yiliang114
- Hosted sessions now persist Todo and project committed task lists, showing them in Managed WebShell so later turns use the latest state. ([#15155](https://github.com/QwenLM/qwen-code/pull/15155)) by @yiliang114
- Incremental lint CI now deepens history until the merge base is provable, reducing unnecessary full-repository scans on long-lived pull requests. ([#15525](https://github.com/QwenLM/qwen-code/pull/15525)) by @yiliang114
- Incremental Prettier checks now group files by the nearest configuration directory, so formatting rules and ignores apply correctly across touched paths. ([#15531](https://github.com/QwenLM/qwen-code/pull/15531)) by @yiliang114
- Kubernetes Harness pool now passes qwen serve the managed runtime broker URL and token environment pair, with clearer errors for missing, invalid, or non-HTTPS Broker URLs. ([#15394](https://github.com/QwenLM/qwen-code/pull/15394)) by @wenshao
- The tui-parity Check TUI impact gate now runs on the persistent ECS pool for trusted PRs, while untrusted fork PRs stay on GitHub-hosted runners. ([#15561](https://github.com/QwenLM/qwen-code/pull/15561)) by @yiliang114
- UserPromptSubmit hook context is no longer duplicated on the next turn after automatic compaction, and compression checkpoints are protected from later rescue mutations. ([#15575](https://github.com/QwenLM/qwen-code/pull/15575)) by @yiliang114
- The Mod runtime now targets Claude Code 2.1.310, accepts tool.check answers with setting fields, and reports that version from $.session.version(). ([#15560](https://github.com/QwenLM/qwen-code/pull/15560)) by @qqqys
- UserPromptSubmit hook context remains deduplicated after memory catalog snapshots or added message parts, preventing repeated hook context copies in CLI requests. ([#15556](https://github.com/QwenLM/qwen-code/pull/15556)) by @yiliang114
- fix(ci): resolve the pool's Maven dependencies through a domestic mirror ([#15610](https://github.com/QwenLM/qwen-code/pull/15610)) by @yiliang114
- fix(ci): stop failing the Maven bootstrap on a rate-limited pool egress ([#15539](https://github.com/QwenLM/qwen-code/pull/15539)) by @yiliang114
- fix(managed-agent): retry read-only attestation after EOF ([#15608](https://github.com/QwenLM/qwen-code/pull/15608)) by @doudouOUC
- fix(ci): resolve libfaketime for the host architecture ([#15609](https://github.com/QwenLM/qwen-code/pull/15609)) by @yiliang114
- fix(ci): bound setup-java on the pool and fall back to the tool cache ([#15605](https://github.com/QwenLM/qwen-code/pull/15605)) by @yiliang114
- fix(web-shell): match cancellation duration to turn summary ([#15615](https://github.com/QwenLM/qwen-code/pull/15615)) by @ytahdn
- fix(web-shell): hide turn navigation without sufficient gutters ([#15604](https://github.com/QwenLM/qwen-code/pull/15604)) by @ytahdn
- fix(core): stop warning about a placeholder in the attribution header ([#15636](https://github.com/QwenLM/qwen-code/pull/15636)) by @yiliang114
- fix(ci): resolve the pool's Maven dependencies from the intranet mirror ([#15641](https://github.com/QwenLM/qwen-code/pull/15641)) by @yiliang114
- fix: preserve interleaved reasoning in TUI and Chat replay ([#15621](https://github.com/QwenLM/qwen-code/pull/15621)) by @DragonnZhang
- fix(cli): preserve previews and verify installed OpenTUI distribution ([#15655](https://github.com/QwenLM/qwen-code/pull/15655)) by @chiga0
- fix(ci): Isolate Managed runtime release test classes ([#15676](https://github.com/QwenLM/qwen-code/pull/15676)) by @doudouOUC
- fix(ci): deepen until the lint scope's own acceptance holds ([#15644](https://github.com/QwenLM/qwen-code/pull/15644)) by @yiliang114
- fix(release): extend standalone runtime download retries ([#15673](https://github.com/QwenLM/qwen-code/pull/15673)) by @qwen-code-dev-bot
- fix(ci): preserve setup-java JDKs during pool fallback ([#15623](https://github.com/QwenLM/qwen-code/pull/15623)) by @yiliang114
- fix(ci): keep the sdk-java cache write-back on a failed suite ([#15555](https://github.com/QwenLM/qwen-code/pull/15555)) by @wenshao
- fix(serve): Fix Hosted local state and foreground Shell validation ([#15670](https://github.com/QwenLM/qwen-code/pull/15670)) by @doudouOUC
- fix(release): close the failure issue once a re-run passes ([#15711](https://github.com/QwenLM/qwen-code/pull/15711)) by @yiliang114
- fix(ci): refresh the stale ci.yml workflow-size baseline ([#15717](https://github.com/QwenLM/qwen-code/pull/15717)) by @wenshao
- fix(web-shell): keep session rename responsive ([#15688](https://github.com/QwenLM/qwen-code/pull/15688)) by @wenshao
- fix(cli): preserve OpenTUI extension update state ([#15716](https://github.com/QwenLM/qwen-code/pull/15716)) by @chiga0
- fix(ci): Preserve canonical artifacts across job retries ([#15713](https://github.com/QwenLM/qwen-code/pull/15713)) by @doudouOUC

#### Performance

- Runs web-shell and standalone tests concurrently with the main CLI test suite to shorten required Linux CI time. ([#15438](https://github.com/QwenLM/qwen-code/pull/15438)) by @wenshao
- Keeps unchanged legacy memory catalog snapshots stable in history to improve DashScope cache reuse, resume, and retry behavior. ([#15246](https://github.com/QwenLM/qwen-code/pull/15246)) by @yiliang114

#### Documentation

- Updates scheduled-task gate examples so copied first-run commands include required repository and PR options. ([#15452](https://github.com/QwenLM/qwen-code/pull/15452)) by @sxl-lucky7
- docs(design): external Hosted Workspace profile (phase 2) ([#15520](https://github.com/QwenLM/qwen-code/pull/15520)) by @yiliang114
- docs(managed): describe gate scanner capacity under the row pool ([#15571](https://github.com/QwenLM/qwen-code/pull/15571)) by @wenshao
- docs: clarify usage statistics across authentication methods ([#15554](https://github.com/QwenLM/qwen-code/pull/15554)) by @sxl-lucky7
- docs(qwencloud): document the forced attribution header and pin the admission split ([#15633](https://github.com/QwenLM/qwen-code/pull/15633)) by @yiliang114

#### Internal Changes

- test(cli): cover remaining Managed Workspace activation refusals ([#15460](https://github.com/QwenLM/qwen-code/pull/15460)) by @doudouOUC
- Corrects the managed-agent CSI inventory column count so test suites pass after permission-rule columns were added. ([#15469](https://github.com/QwenLM/qwen-code/pull/15469)) by @yiliang114
- test(ci): pin the disk-pressure collector revision and FULL_PAYLOAD run bodies ([#15475](https://github.com/QwenLM/qwen-code/pull/15475)) by @yiliang114
- Adds an integration test verifying the removeScratchDir retry budget removes busy scratch directories without logging cleanup warnings. ([#15488](https://github.com/QwenLM/qwen-code/pull/15488)) by @yiliang114
- Tests now capture expected disk-full log output so real CI disk-full failures are easier to distinguish from deliberate test errors. ([#8549](https://github.com/QwenLM/qwen-code/pull/8549)) by @EthDing
- Managed Agent tests now wait for a dead worker to become unusable before checking lease identity reuse or reconciling its loss. ([#15503](https://github.com/QwenLM/qwen-code/pull/15503)) by @yiliang114
- SDK Java CI retains Surefire and Failsafe failure reports and preserves original SQL causes in channel ownership race tests. ([#14910](https://github.com/QwenLM/qwen-code/pull/14910)) by @Aling33
- Adds CI regression coverage to keep JUnit report paths where CI collects them. ([#15502](https://github.com/QwenLM/qwen-code/pull/15502)) by @barry166
- Applies the slow-host policy to hosted approval test waits so slow runners get longer approval-test timeouts. ([#15183](https://github.com/QwenLM/qwen-code/pull/15183)) by @qwen-code-dev-bot
- Adjusts hosted approval test waits based on runner load policies to improve CI reliability on slower hosts. ([#15101](https://github.com/QwenLM/qwen-code/pull/15101)) by @qwen-code-dev-bot
- Adds automated checks for memory recovery and hard-rescue catalog accounting to prevent regressions. ([#15535](https://github.com/QwenLM/qwen-code/pull/15535)) by @yiliang114
- Adds automated checks for managed-agent row pool fan-out and corrects design documentation on shutdown and task limits. ([#15528](https://github.com/QwenLM/qwen-code/pull/15528)) by @yiliang114
- Adds a repeatable Harness Kubernetes qualification workflow for deploying, verifying, and exercising shared pools. ([#15519](https://github.com/QwenLM/qwen-code/pull/15519)) by @doudouOUC
- test(cli): pin the lifecycle-protocol refusal on the load route ([#15536](https://github.com/QwenLM/qwen-code/pull/15536)) by @yiliang114
- Adds tests verifying the lint --setup guard installs only required linters and installs nothing when no lane is selected. ([#15533](https://github.com/QwenLM/qwen-code/pull/15533)) by @yiliang114
- Consolidates catalog visibility rules so curated history reads consistently hide catalog snapshots when legacy memory is suppressed. ([#15534](https://github.com/QwenLM/qwen-code/pull/15534)) by @yiliang114
- Centralizes QwenCloud MaaS host list usage for telemetry classification and DashScope admission to keep host handling consistent. ([#15532](https://github.com/QwenLM/qwen-code/pull/15532)) by @yiliang114
- Hosted harness tests now use longer adaptive wait budgets for interrupted-model checks, reducing flaky timeouts without changing asserted behavior. ([#15551](https://github.com/QwenLM/qwen-code/pull/15551)) by @yiliang114
- test(managed-agent): align S1 acceptance fixtures with runtime contracts ([#15585](https://github.com/QwenLM/qwen-code/pull/15585)) by @doudouOUC
- Managed Agent workspace upload admission tests now use valid binary upload parameters and upload-status queries, and expect precise not-found errors for unknown uploads. ([#15588](https://github.com/QwenLM/qwen-code/pull/15588)) by @doudouOUC
- test(runtime-broker): build the extension-profile fixture paths portably ([#15598](https://github.com/QwenLM/qwen-code/pull/15598)) by @yiliang114
- test(cli): budget the skill-recovery poll through the settle policy ([#15589](https://github.com/QwenLM/qwen-code/pull/15589)) by @yiliang114
- test(lint): pin the .gitignore grouping arm and the batch stride ([#15640](https://github.com/QwenLM/qwen-code/pull/15640)) by @yiliang114
- Pin unknown sed long options ([#15223](https://github.com/QwenLM/qwen-code/pull/15223)) by @waybarrios
- ci: run every suite but CLI and core in the side test lane ([#15570](https://github.com/QwenLM/qwen-code/pull/15570)) by @wenshao
- test(cli): read xn-- hosts by the running URL parser in the Broker URL fixture ([#15544](https://github.com/QwenLM/qwen-code/pull/15544)) by @wenshao
- test(integration): widen the ready-prompt budget on GitHub-hosted macOS x64 ([#15692](https://github.com/QwenLM/qwen-code/pull/15692)) by @yiliang114
- chore(goal): remove an unused evidence helper and stale /goal hook comments ([#15693](https://github.com/QwenLM/qwen-code/pull/15693)) by @qqqys
- test(web-shell): raise the 200-record history-viewport smoke budget to 300s ([#15656](https://github.com/QwenLM/qwen-code/pull/15656)) by @yiliang114
- refactor(managed-agent): close the scanner row-pool residues (#15527) ([#15632](https://github.com/QwenLM/qwen-code/pull/15632)) by @yiliang114
- test(managed-agent): initialize the snapshot pool connection synchronously ([#15715](https://github.com/QwenLM/qwen-code/pull/15715)) by @doudouOUC
- test(cli): close the deferred review Suggestions from #15625 ([#15710](https://github.com/QwenLM/qwen-code/pull/15710)) by @wenshao

### New Contributors

- @sxl-lucky7 made their first contribution in [#15452](https://github.com/QwenLM/qwen-code/pull/15452)
- @EthDing made their first contribution in [#8549](https://github.com/QwenLM/qwen-code/pull/8549)
- @Aling33 made their first contribution in [#14910](https://github.com/QwenLM/qwen-code/pull/14910)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.26.1...v0.26.2

## [0.26.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.26.1) - 2026-10-24

### Highlights

_See the complete change list below._

### Breaking Changes

- fix(qqbot)!: restore per-group session isolation under thread scope ([#13882](https://github.com/QwenLM/qwen-code/pull/13882)) by @Eric-GoodBoy-Tech

### Complete Change List

#### Features

- Adds opt-in daemon token persistence: qwen daemon start --save-token stores the bearer token in an owner-only file, qwen daemon token manages it, and daemon stop removes it. ([#15023](https://github.com/QwenLM/qwen-code/pull/15023)) by @wenshao
- Adds idle-only manual context compression for Workspace-bound Managed Sessions via public API and the WebShell context-usage popover, preserving audit history. ([#15104](https://github.com/QwenLM/qwen-code/pull/15104)) by @doudouOUC
- Aligns OpenTUI input, editing, drafts, and /statusline behavior with Ink, adding configurable status lines and more predictable completion, queue, and cancel handling. ([#14964](https://github.com/QwenLM/qwen-code/pull/14964)) by @chiga0
- feat(shell): remind the model to record files a command writes ([#15055](https://github.com/QwenLM/qwen-code/pull/15055)) by @zjgzx1988
- Managed Workspace recovery now waits for durable settlement before continuing, shows recovery reasons and valid actions in WebShell, and gates message sending. ([#15131](https://github.com/QwenLM/qwen-code/pull/15131)) by @doudouOUC
- Embedding hosts can now show unavailable models as disabled rows in the composer picker, with hover or focus hints and optional host-provided actions. ([#15015](https://github.com/QwenLM/qwen-code/pull/15015)) by @callmeYe
- feat(managed-agent): Add session lifecycle UI and reading exports ([#15100](https://github.com/QwenLM/qwen-code/pull/15100)) by @doudouOUC
- feat(generated-ui): expose interaction outcomes and applied parameter snapshots ([#15004](https://github.com/QwenLM/qwen-code/pull/15004)) by @qqqys
- feat(managed-agent): expose durable capacity observations ([#15162](https://github.com/QwenLM/qwen-code/pull/15162)) by @yiliang114
- Pages Managed checkpoint history, adds durable model API error codes, and shows running indicators in Managed sidebar rows for clearer session feedback. ([#15170](https://github.com/QwenLM/qwen-code/pull/15170)) by @doudouOUC
- feat(core): gate scheduled tasks on a shell command run outside the model ([#15069](https://github.com/QwenLM/qwen-code/pull/15069)) by @wenshao
- Session lists now support case-insensitive title filtering before pagination, with archive filtering and a WebShell title search box. ([#15157](https://github.com/QwenLM/qwen-code/pull/15157)) by @yiliang114
- feat(managed-agent): read the Harness credentials from one file ([#15063](https://github.com/QwenLM/qwen-code/pull/15063)) by @wenshao
- feat(managed-agent): manage MCP servers without recreating sessions ([#15119](https://github.com/QwenLM/qwen-code/pull/15119)) by @doudouOUC
- feat(cli): align OpenTUI Vim, history and live output with Ink ([#15067](https://github.com/QwenLM/qwen-code/pull/15067)) by @chiga0
- feat(managed-agent): Enable public subagent delegation by default ([#15171](https://github.com/QwenLM/qwen-code/pull/15171)) by @doudouOUC
- feat(managed-agent): Start daemon and Managed locally with one command ([#14928](https://github.com/QwenLM/qwen-code/pull/14928)) by @doudouOUC
- feat(cli): ship private Bun and preserve interpreter boundaries ([#14959](https://github.com/QwenLM/qwen-code/pull/14959)) by @chiga0
- feat(mods): skip hooks for Claude Code events this runtime does not run ([#15273](https://github.com/QwenLM/qwen-code/pull/15273)) by @qqqys
- feat(mods): send a Mod's own tool.check ask to the user ([#15306](https://github.com/QwenLM/qwen-code/pull/15306)) by @qqqys
- feat(serve): carry a scheduled-task gate through the daemon and Web Shell ([#15211](https://github.com/QwenLM/qwen-code/pull/15211)) by @wenshao
- feat(ci): switchable Linux runner fleet (hosted/arm64) via LINUX_RUNNER_FLEET variable + dispatch option ([#15329](https://github.com/QwenLM/qwen-code/pull/15329)) by @yiliang114
- feat(serve): bind reviewed PR when a /review prompt is admitted ([#15207](https://github.com/QwenLM/qwen-code/pull/15207)) by @wenshao
- feat(cli): add a capability parity matrix against the Managed Agent path ([#15085](https://github.com/QwenLM/qwen-code/pull/15085)) by @wenshao
- feat(managed-agent): Enable unified Shell session lifecycle ([#15330](https://github.com/QwenLM/qwen-code/pull/15330)) by @doudouOUC
- feat(managed): gate managed automations on a Runtime probe run before the claim ([#15218](https://github.com/QwenLM/qwen-code/pull/15218)) by @wenshao
- feat(web-shell): let users reorder sidebar workspaces ([#15360](https://github.com/QwenLM/qwen-code/pull/15360)) by @wenshao
- feat(managed-agent): Add web_fetch to Workspace Sessions ([#15313](https://github.com/QwenLM/qwen-code/pull/15313)) by @doudouOUC
- feat(cli): add the PR watch probes behind the scheduled-task gate ([#15057](https://github.com/QwenLM/qwen-code/pull/15057)) by @qqqys
- feat(managed-agent): Add a shared Harness pool for Kubernetes ([#15255](https://github.com/QwenLM/qwen-code/pull/15255)) by @doudouOUC
- feat(verify-pr): configure the assets host and branch once ([#15377](https://github.com/QwenLM/qwen-code/pull/15377)) by @wenshao
- feat(web-shell): expose model output language in settings panel ([#15363](https://github.com/QwenLM/qwen-code/pull/15363)) by @wenshao
- feat(serve): give managed workspace sessions todo_write (#15076) ([#15089](https://github.com/QwenLM/qwen-code/pull/15089)) by @wenshao
- feat(serve): persist max-sessions in settings.json ([#15419](https://github.com/QwenLM/qwen-code/pull/15419)) by @wenshao
- feat(web-shell): add unified recent sessions sidebar ([#14904](https://github.com/QwenLM/qwen-code/pull/14904)) by @deggs7
- feat(mods): read session facts and the clock ([#15348](https://github.com/QwenLM/qwen-code/pull/15348)) by @qqqys
- feat(verify-pr): add a watch mode backed by the PR probe gate ([#15409](https://github.com/QwenLM/qwen-code/pull/15409)) by @wenshao
- feat(memory): add scoped external import jobs for CLI and HTTP ([#14281](https://github.com/QwenLM/qwen-code/pull/14281)) by @callmeYe
- feat(ci): fail fast when a pool host drifts off the font baseline ([#15410](https://github.com/QwenLM/qwen-code/pull/15410)) by @yiliang114
- feat(cli): attach a terminal to daemon sessions ([#15209](https://github.com/QwenLM/qwen-code/pull/15209)) by @wenshao
- feat(cli): add the /autofix-pr reaction layer: guarded push, sync, replies, re-runs and the skill ([#15385](https://github.com/QwenLM/qwen-code/pull/15385)) by @wenshao

#### Bug Fixes

- Release tarball checks now verify execute bits for every spawned vendored binary, including the Landlock runner, preventing silent permission regressions. ([#15008](https://github.com/QwenLM/qwen-code/pull/15008)) by @yiliang114
- Fixes an issue where directory changes could make a completed session appear interrupted, while keeping real pending prompts and tool calls recoverable. ([#15012](https://github.com/QwenLM/qwen-code/pull/15012)) by @ytahdn
- Fixes CI by enrolling OpenTUI parity integration tests in the no-AK lane so required test selection passes. ([#15142](https://github.com/QwenLM/qwen-code/pull/15142)) by @yiliang114
- Fixes a core TypeScript build failure by removing a duplicate import in a chat test, with no product behavior change. ([#15146](https://github.com/QwenLM/qwen-code/pull/15146)) by @ytahdn
- Gives fast Java CI jobs priority for SDK Java host-lock tickets while preventing starvation of full-tier jobs. ([#15035](https://github.com/QwenLM/qwen-code/pull/15035)) by @qwen-code-dev-bot
- Workflow agent subagent IDs now include the Workflow tool call ID when available, helping Web Shell link subagents to the call that started them. ([#15145](https://github.com/QwenLM/qwen-code/pull/15145)) by @qqqys
- Official DeepSeek support now uses deepseek-flash, accepts images for that exact model, and aligns effort mapping with DeepSeek's API. ([#15164](https://github.com/QwenLM/qwen-code/pull/15164)) by @qqqys
- The lint lane failure dump now reports swap alongside RAM and falls back to df -h when df -T is unavailable, improving resource diagnostics. ([#15095](https://github.com/QwenLM/qwen-code/pull/15095)) by @yiliang114
- The MariaDB lane now writes back only Maven artifacts fetched in that job and raises its timeout ceiling from 200 to 280 minutes. ([#15064](https://github.com/QwenLM/qwen-code/pull/15064)) by @yiliang114
- fix(web-shell): show actionable skill installation errors ([#15013](https://github.com/QwenLM/qwen-code/pull/15013)) by @callmeYe
- fix(web-shell): reduce table menu opening latency ([#15179](https://github.com/QwenLM/qwen-code/pull/15179)) by @ytahdn
- Restores a MariaDB integration leg in CI so the non-Hosted integration tests run against MariaDB 10.11.18 and MySQL 8.4. ([#15003](https://github.com/QwenLM/qwen-code/pull/15003)) by @yiliang114
- Aligns managed-checkpoint budgets, improves resource publication error details, and detects recovery-blocked Harness sessions even when heartbeats continue. ([#15094](https://github.com/QwenLM/qwen-code/pull/15094)) by @doudouOUC
- Updates Alibaba ModelStudio Token Plan models and thinking controls, adding deepseek-v4.1-flash variants and glm-5.3 while removing unavailable entries. ([#15184](https://github.com/QwenLM/qwen-code/pull/15184)) by @qqqys
- Refreshes the Alibaba ModelStudio Standard preset, enables model discovery, removes unavailable models, and adds deepseek-v4.1-flash and glm-5.3. ([#15189](https://github.com/QwenLM/qwen-code/pull/15189)) by @qqqys
- Anthropic global prompt-cache scope is now opt-in on every base URL, keeping per-session caching by default. ([#15053](https://github.com/QwenLM/qwen-code/pull/15053)) by @yiliang114
- Improves CI reliability by limiting the sdk-java host lock to Maven cache write-back and extending the integration timeout. ([#15128](https://github.com/QwenLM/qwen-code/pull/15128)) by @qwen-code-dev-bot
- fix(mods): exclude native waits from root execution budget ([#14986](https://github.com/QwenLM/qwen-code/pull/14986)) by @qqqys
- fix(core): cap MiniMax-M2.5 output at the DashScope endpoint limit ([#15210](https://github.com/QwenLM/qwen-code/pull/15210)) by @qqqys
- fix(serve): fall back to an available Local Control port ([#12352](https://github.com/QwenLM/qwen-code/pull/12352)) by @Sumire-no-kai
- fix(core): stop sed simulation from misreading backslashes in brackets ([#13557](https://github.com/QwenLM/qwen-code/pull/13557)) by @MohammedAlkindi
- test(managed-agent): poll ToolTurn producers instead of waiting on onExit() ([#15065](https://github.com/QwenLM/qwen-code/pull/15065)) by @wenshao
- fix(cli): recover from hosted send_message encoding limits ([#14726](https://github.com/QwenLM/qwen-code/pull/14726)) by @water-in-stone
- fix(web-shell): preserve composer draft attachments across views ([#15025](https://github.com/QwenLM/qwen-code/pull/15025)) by @ytahdn
- fix(cli): reject malformed hosted shell Unicode before admission ([#13678](https://github.com/QwenLM/qwen-code/pull/13678)) by @water-in-stone
- fix(web-shell): prevent artifact card overlap on narrow screens ([#15300](https://github.com/QwenLM/qwen-code/pull/15300)) by @ytahdn
- fix(managed-agent): refuse `;` comments in the Harness credentials file ([#15236](https://github.com/QwenLM/qwen-code/pull/15236)) by @wenshao
- fix(managed-agent): drop removed publication constructor argument ([#15314](https://github.com/QwenLM/qwen-code/pull/15314)) by @qwen-code-dev-bot
- fix(ci): reuse open workflow failure issues ([#15256](https://github.com/QwenLM/qwen-code/pull/15256)) by @yiliang114
- fix(ci): gate the Windows Hosted suite on a successful install ([#15290](https://github.com/QwenLM/qwen-code/pull/15290)) by @qwen-code-dev-bot
- fix(web-shell): preserve draft attachments through refresh and allocation ([#15303](https://github.com/QwenLM/qwen-code/pull/15303)) by @ytahdn
- fix(core): bind session PRs when gh is outside PATH ([#15212](https://github.com/QwenLM/qwen-code/pull/15212)) by @wenshao
- fix(acp): stop blanking replay App html that cannot reclaim bytes ([#15279](https://github.com/QwenLM/qwen-code/pull/15279)) by @yiliang114
- fix(ci): refuse a partial jobs page list before reporting ([#15174](https://github.com/QwenLM/qwen-code/pull/15174)) by @wenshao
- fix(web-shell): honor loading phrase visibility setting ([#15337](https://github.com/QwenLM/qwen-code/pull/15337)) by @ytahdn
- fix(web-shell): Align Managed sidebar with daemon navigation ([#15331](https://github.com/QwenLM/qwen-code/pull/15331)) by @doudouOUC
- fix(mods): refuse values nested too deeply to cross the Mod boundary ([#15317](https://github.com/QwenLM/qwen-code/pull/15317)) by @qqqys
- fix(ci): install linters on linux/arm64 runners ([#15350](https://github.com/QwenLM/qwen-code/pull/15350)) by @wenshao
- fix(cli): kill a timed-out review command's process tree ([#15352](https://github.com/QwenLM/qwen-code/pull/15352)) by @wenshao
- fix(managed-agent): resume collection blockers at their own clearing instant ([#15195](https://github.com/QwenLM/qwen-code/pull/15195)) by @wenshao
- fix(cli): drop the removed V2 tool lists from the parity test ([#15362](https://github.com/QwenLM/qwen-code/pull/15362)) by @wenshao
- test(web-shell): cover reopened session details focus handoff ([#15351](https://github.com/QwenLM/qwen-code/pull/15351)) by @Jun516
- fix(release): skip cua-sdk publish dry-run when the version is already on npm ([#15355](https://github.com/QwenLM/qwen-code/pull/15355)) by @yiliang114
- fix(ci): annotate the temp short-alias guard's failing branches ([#15366](https://github.com/QwenLM/qwen-code/pull/15366)) by @yiliang114
- fix(ci): stabilize TUI attachment wait and allow full acceptance run ([#15372](https://github.com/QwenLM/qwen-code/pull/15372)) by @yiliang114
- test(core): give the paged-outcomes turn a CI-sized timeout ([#15374](https://github.com/QwenLM/qwen-code/pull/15374)) by @yiliang114
- fix(ci): route web shell smoke to ARM64 independently ([#15364](https://github.com/QwenLM/qwen-code/pull/15364)) by @yiliang114
- fix(node-repl): let the kernel exit promptly on shutdown ([#15160](https://github.com/QwenLM/qwen-code/pull/15160)) by @wenshao
- fix(ci): pin and cache the standalone runtime archives ([#15159](https://github.com/QwenLM/qwen-code/pull/15159)) by @wenshao
- fix(cli): install the reaping traps before the review command starts ([#15367](https://github.com/QwenLM/qwen-code/pull/15367)) by @wenshao
- fix(cli): keep reaping a review command's tree on a busy machine and under old bash ([#15375](https://github.com/QwenLM/qwen-code/pull/15375)) by @wenshao
- fix(ci): file new main CI failure signatures as their own issues ([#15405](https://github.com/QwenLM/qwen-code/pull/15405)) by @yiliang114
- fix(vscode): keep transcript selection alive during host-driven webview copy ([#15403](https://github.com/QwenLM/qwen-code/pull/15403)) by @yar3333
- fix(web-shell): move group creation into workspace menu ([#15320](https://github.com/QwenLM/qwen-code/pull/15320)) by @deggs7
- test(integration): give the skill-hook parity E2E the docker startup budget (#15226) ([#15237](https://github.com/QwenLM/qwen-code/pull/15237)) by @qwen-code-dev-bot
- fix(ci): raise the sdk-java test-lane lock wait above the longest hold ([#15257](https://github.com/QwenLM/qwen-code/pull/15257)) by @qwen-code-dev-bot
- fix(acp): refuse an edit whose arguments were cut off or arrived incomplete ([#15346](https://github.com/QwenLM/qwen-code/pull/15346)) by @qqqys
- fix(ci): skip stale main CI failure issues after main advances ([#15272](https://github.com/QwenLM/qwen-code/pull/15272)) by @qwen-code-dev-bot
- fix(cua): sign Windows UIAccess workers before publishing ([#12442](https://github.com/QwenLM/qwen-code/pull/12442)) by @yiliang114
- fix(cli): Replace synthesized tool-result placeholders with late real results ([#15308](https://github.com/QwenLM/qwen-code/pull/15308)) by @yiliang114
- fix(ci): skip the font baseline gate when the checkout predates it ([#15436](https://github.com/QwenLM/qwen-code/pull/15436)) by @yiliang114
- fix(cli): let review build-test reach the test phase on this monorepo ([#15332](https://github.com/QwenLM/qwen-code/pull/15332)) by @wenshao
- fix(core): count only well-formed snapshots toward the workflow retention cap ([#15391](https://github.com/QwenLM/qwen-code/pull/15391)) by @yiliang114

#### Performance

- Parallelizes MySQL and MariaDB integration tests, removes redundant validation work, and consolidates load scenarios to speed up CI. ([#15200](https://github.com/QwenLM/qwen-code/pull/15200)) by @doudouOUC
- perf(ci): scope PR lint and reuse static build outputs ([#15381](https://github.com/QwenLM/qwen-code/pull/15381)) by @yiliang114

#### Documentation

- Adds documentation for .agents/skills locations, the skills.directories setting, precedence, and reusing one skills folder with other agents. ([#15086](https://github.com/QwenLM/qwen-code/pull/15086)) by @shpaker
- Adds a bilingual design proposal for an opt-in Linux local-process confinement profile for Managed Agent, including qualification and fail-closed behavior. ([#15163](https://github.com/QwenLM/qwen-code/pull/15163)) by @yiliang114
- test(managed-agent): pin both worker launch paths to the env filter ([#15051](https://github.com/QwenLM/qwen-code/pull/15051)) by @wenshao
- test(managed-agent): align the FG12d reload comment with the lease expiry ([#15234](https://github.com/QwenLM/qwen-code/pull/15234)) by @wenshao
- docs(mods): propose the Claude Code compatibility baseline ([#15270](https://github.com/QwenLM/qwen-code/pull/15270)) by @qqqys
- docs(design): add the unified agent loop design ([#15343](https://github.com/QwenLM/qwen-code/pull/15343)) by @qqqys
- docs(verify-pr): add a --publish shorthand for maintainer rounds ([#15357](https://github.com/QwenLM/qwen-code/pull/15357)) by @wenshao
- docs(managed): document the PR watch probes as Managed automation gates ([#15420](https://github.com/QwenLM/qwen-code/pull/15420)) by @wenshao

#### Internal Changes

- Adds a test verifying that repeating a managed-agent cancel with the same idempotency key reuses the existing cancellation and starts no new work. ([#14997](https://github.com/QwenLM/qwen-code/pull/14997)) by @wenshao
- Internal test cleanup: shares the quote and camel helpers across managed-agent gate tests without changing behavior. ([#15047](https://github.com/QwenLM/qwen-code/pull/15047)) by @wenshao
- Updates Hosted fault gate tests to verify execution ownership, membership clearing, and scoped shutdown behavior. ([#15066](https://github.com/QwenLM/qwen-code/pull/15066)) by @doudouOUC
- Adds a CI guard ensuring every runnable integration test is selected by the no-AK gate or explicitly exempted, preventing accidental omissions. ([#14989](https://github.com/QwenLM/qwen-code/pull/14989)) by @zonemeen
- Improves internal CLI test reliability by resolving temporary Git fixture paths under symlinked directories. ([#15133](https://github.com/QwenLM/qwen-code/pull/15133)) by @wenshao
- test(managed-agent): refuse a second fire while the turn runs (FG11d) ([#14998](https://github.com/QwenLM/qwen-code/pull/14998)) by @wenshao
- Java SDK tests now mark body-less 404 responses as non-persistent so follow-up submissions use a fresh connection and avoid pooled connection failures. ([#15172](https://github.com/QwenLM/qwen-code/pull/15172)) by @qwen-code-dev-bot
- test(managed-agent): keep a sibling run alive past a cancel (FG11d) ([#14999](https://github.com/QwenLM/qwen-code/pull/14999)) by @wenshao
- test(core): pin that setTools writes the tool declarations ([#15118](https://github.com/QwenLM/qwen-code/pull/15118)) by @yiliang114
- test(managed-agent): pin durable recovery park acceptance ([#15154](https://github.com/QwenLM/qwen-code/pull/15154)) by @yiliang114
- Makes Hosted MCP fault test fixtures claim close operations atomically, preventing race conditions from interfering with intended fault scenarios. ([#15158](https://github.com/QwenLM/qwen-code/pull/15158)) by @yiliang114
- Adds a test ensuring the branch picker shows the Sets upstream on push hint when a branch has no upstream configured. ([#15073](https://github.com/QwenLM/qwen-code/pull/15073)) by @yiliang114
- Corrects the daemon E2E install warning and adds safeguards that keep Build, Bundle, and Java daemon E2E steps in the expected order. ([#14884](https://github.com/QwenLM/qwen-code/pull/14884)) by @qwen-code-dev-bot
- Adds a regression test ensuring the VS Code webview language attribute is HTML-escaped correctly. ([#10492](https://github.com/QwenLM/qwen-code/pull/10492)) by @CanReader
- Stabilizes the SDK Java idle-watchdog timing test without changing runtime watchdog behavior. ([#15103](https://github.com/QwenLM/qwen-code/pull/15103)) by @qwen-code-dev-bot
- test(managed-agent): keep the FG12d lifecycle cells' writer lease past the close window ([#15068](https://github.com/QwenLM/qwen-code/pull/15068)) by @wenshao
- test(managed-agent): pin the queue_one reachability (FG11d) ([#15187](https://github.com/QwenLM/qwen-code/pull/15187)) by @wenshao
- test(managed-agent): replace the Runtime MCP connection mid-stream (FG12e) ([#15198](https://github.com/QwenLM/qwen-code/pull/15198)) by @wenshao
- test(e2e): isolate permission-control suite from shared QWEN_HOME memory state ([#11401](https://github.com/QwenLM/qwen-code/pull/11401)) by @he-yufeng
- test(integration): give the resume gate E2E its CI startup budget (#15185) ([#15188](https://github.com/QwenLM/qwen-code/pull/15188)) by @qwen-code-dev-bot
- refactor(managed-agent): Remove pre-release compatibility paths ([#15263](https://github.com/QwenLM/qwen-code/pull/15263)) by @doudouOUC
- test(web-shell): pin which binding the session PR badge renders ([#15238](https://github.com/QwenLM/qwen-code/pull/15238)) by @wenshao
- test(managed-agent): fix ToolPublicationStore constructor call in HostedWorkspaceToolTurnIT ([#15305](https://github.com/QwenLM/qwen-code/pull/15305)) by @yiliang114
- test(managed-agent): share the Hosted gate attachment lookup ([#15295](https://github.com/QwenLM/qwen-code/pull/15295)) by @wenshao
- test(cli): cover workspace-scope aux model persistence in ModelDialog ([#15356](https://github.com/QwenLM/qwen-code/pull/15356)) by @yiliang114
- test(cli): stop assuming one build's CA loader and sleep semantics ([#15370](https://github.com/QwenLM/qwen-code/pull/15370)) by @yiliang114
- test(web-shell): pin running title cue spinner parity ([#15371](https://github.com/QwenLM/qwen-code/pull/15371)) by @Jun516
- test(web-shell): stop pinning hero header wrap in token usage min-width check ([#15399](https://github.com/QwenLM/qwen-code/pull/15399)) by @yiliang114
- test(web-shell): stop requiring the token-usage meta to wrap at min width ([#15400](https://github.com/QwenLM/qwen-code/pull/15400)) by @yiliang114
- test(web-shell): cross the hover-menu corridor with raw pointer moves ([#15404](https://github.com/QwenLM/qwen-code/pull/15404)) by @yiliang114
- ci: reduce redundant TUI parity runs and build scope ([#15383](https://github.com/QwenLM/qwen-code/pull/15383)) by @yiliang114
- refactor(web-shell): share the openable-PR filter with the details tooltip ([#15373](https://github.com/QwenLM/qwen-code/pull/15373)) by @wenshao
- test(scripts): pin newline-bearing takeover round seed bodies ([#15390](https://github.com/QwenLM/qwen-code/pull/15390)) by @yiliang114
- test(cli): widen held-expiry margins in the peer listing stale test ([#15413](https://github.com/QwenLM/qwen-code/pull/15413)) by @wenshao
- test(review): witness the unasserted halves of two Aone routing pins ([#15395](https://github.com/QwenLM/qwen-code/pull/15395)) by @yiliang114
- test(cli): pin the reaping shell's trap order and tighten its interrupt test ([#15415](https://github.com/QwenLM/qwen-code/pull/15415)) by @wenshao
- test(cli): poll the held-expiry assertions instead of sleeping ([#15417](https://github.com/QwenLM/qwen-code/pull/15417)) by @wenshao
- test(feishu): cover inbound file attachment lifecycle ([#13278](https://github.com/QwenLM/qwen-code/pull/13278)) by @jabrailkhalil
- test(managed-agent): retry the Hosted boot when a probed port is taken ([#15432](https://github.com/QwenLM/qwen-code/pull/15432)) by @yiliang114
- test(core): isolate outcomes-test retries from the dispatch gate ([#15429](https://github.com/QwenLM/qwen-code/pull/15429)) by @yiliang114
- test(runtime-broker): show what the rig saw when an execution wait times out ([#15437](https://github.com/QwenLM/qwen-code/pull/15437)) by @wenshao

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.26.0...v0.26.1

## [0.26.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.26.0) - 2026-10-21

### Highlights

_See the complete change list below._

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- feat(daemon): support session-targeted Skill and Extension refresh ([#14050](https://github.com/QwenLM/qwen-code/pull/14050)) by @callmeYe
- feat(runtime-broker): Session-create warm for Workspace-isolated bound Sessions ([#14599](https://github.com/QwenLM/qwen-code/pull/14599)) by @doudouOUC
- feat(managed-agent): ship a configuration template in the reference distribution ([#14631](https://github.com/QwenLM/qwen-code/pull/14631)) by @wenshao
- feat(serve): run private CSI file turns through Hosted Harness ([#14487](https://github.com/QwenLM/qwen-code/pull/14487)) by @doudouOUC
- feat(managed-agent): support local and SSH workspace file references ([#14639](https://github.com/QwenLM/qwen-code/pull/14639)) by @doudouOUC
- Adds a read-only --check preflight that prints PASS, WARN, FAIL, or SKIP for managed-agent deployment checks and exits nonzero on failure. ([#14632](https://github.com/QwenLM/qwen-code/pull/14632)) by @wenshao
- Lets a successor Hosted owner finish private CSI file turns that already have durable receipts, preserving tool responses and avoiding repeated file operations. ([#14523](https://github.com/QwenLM/qwen-code/pull/14523)) by @doudouOUC
- Managed Agent submissions now accept up to 8 MiB of attachment input, preserve large pending requests across refresh, and let users discard unrecoverable drafts. ([#14628](https://github.com/QwenLM/qwen-code/pull/14628)) by @doudouOUC
- Hosted Turn recovery now asks the Runtime Broker for execution evidence and treats unprovable outcomes as unknown instead of transient faults. ([#14669](https://github.com/QwenLM/qwen-code/pull/14669)) by @wenshao
- Adds systemd units and setup guidance for single-host managed-agent deployments so Runtime workers stay running when Broker restarts ([#14633](https://github.com/QwenLM/qwen-code/pull/14633)) by @wenshao
- Parks managed-agent turns with unknown Runtime outcomes for later rechecks instead of repeatedly retrying cancellation, keeping them active and avoiding false FAILED results ([#14681](https://github.com/QwenLM/qwen-code/pull/14681)) by @wenshao
- feat(artifacts): record files the agent creates or edits ([#14292](https://github.com/QwenLM/qwen-code/pull/14292)) by @zjgzx1988
- Adds a managed-agent credential bootstrap that generates required deployment tokens and writes protected configuration to simplify secure setup. ([#14634](https://github.com/QwenLM/qwen-code/pull/14634)) by @wenshao
- Completes private CSI cold recovery so settled file work can resume from saved results without repeating file effects or extra model requests. ([#14695](https://github.com/QwenLM/qwen-code/pull/14695)) by @doudouOUC
- Adds an optional Generated UI extension that renders model-generated HTML/CSS cards with bounded local JavaScript, letting users adjust inputs without another model turn. ([#14338](https://github.com/QwenLM/qwen-code/pull/14338)) by @qqqys
- feat(workflow): authorize daemon ancestor workflows ([#14646](https://github.com/QwenLM/qwen-code/pull/14646)) by @qqqys
- feat(web-shell): show per-model TTFT and output speed in Token Usage ([#14728](https://github.com/QwenLM/qwen-code/pull/14728)) by @qqqys
- feat(runtime): add original CSI application retirement ([#14698](https://github.com/QwenLM/qwen-code/pull/14698)) by @doudouOUC
- feat(telemetry): Record reasoning effort on LLM spans ([#14718](https://github.com/QwenLM/qwen-code/pull/14718)) by @zonemeen
- feat(serve): add local daemon discovery and control commands ([#14739](https://github.com/QwenLM/qwen-code/pull/14739)) by @wenshao
- feat(web-shell): Polish advanced table controls and copying ([#14707](https://github.com/QwenLM/qwen-code/pull/14707)) by @ytahdn
- feat(core): account tool result sizes from producer to injection ([#14545](https://github.com/QwenLM/qwen-code/pull/14545)) by @yiliang114
- feat(web-shell): add trajectory follow and pause controls (PR7B) ([#14723](https://github.com/QwenLM/qwen-code/pull/14723)) by @qqqys
- feat(web-shell): delete selected message groups from session history ([#14297](https://github.com/QwenLM/qwen-code/pull/14297)) by @ytahdn
- feat(core): honor preview budgets and make truncated previews recoverable ([#14546](https://github.com/QwenLM/qwen-code/pull/14546)) by @yiliang114
- feat(web-shell): Preview collapsed Home content on hover ([#14826](https://github.com/QwenLM/qwen-code/pull/14826)) by @ytahdn
- feat(web-shell): preview PDFs with the native browser viewer ([#14825](https://github.com/QwenLM/qwen-code/pull/14825)) by @ytahdn
- feat(web-shell): improve token usage hierarchy ([#14648](https://github.com/QwenLM/qwen-code/pull/14648)) by @ytahdn
- feat(mods): support tool middleware in interactive terminals ([#14565](https://github.com/QwenLM/qwen-code/pull/14565)) by @qqqys
- feat(web-shell): show background shell task runtime details ([#14831](https://github.com/QwenLM/qwen-code/pull/14831)) by @ytahdn
- feat(core): report why loop protection stopped a turn ([#14858](https://github.com/QwenLM/qwen-code/pull/14858)) by @qqqys
- feat(serve): add qwen daemon start ([#14869](https://github.com/QwenLM/qwen-code/pull/14869)) by @wenshao
- feat(channels): add WeCom application callback support ([#13976](https://github.com/QwenLM/qwen-code/pull/13976)) by @callmeYe
- feat(serve): add daemon status detail ([#14902](https://github.com/QwenLM/qwen-code/pull/14902)) by @wenshao
- feat(cli): expose experimental Mods in settings ([#14889](https://github.com/QwenLM/qwen-code/pull/14889)) by @qqqys
- feat(web-shell): preview DOCX files across file entry points ([#14868](https://github.com/QwenLM/qwen-code/pull/14868)) by @ytahdn
- feat(web-shell): refresh model catalogs from the model selector ([#14685](https://github.com/QwenLM/qwen-code/pull/14685)) by @callmeYe
- feat(serve): add daemon start --wait ([#14914](https://github.com/QwenLM/qwen-code/pull/14914)) by @wenshao
- feat(managed-agent): expose session MCP catalog in WebShell ([#14916](https://github.com/QwenLM/qwen-code/pull/14916)) by @doudouOUC
- feat(runtime): add explicit idle resident Workspace retirement ([#14765](https://github.com/QwenLM/qwen-code/pull/14765)) by @doudouOUC
- feat(web-shell): consolidate trajectory chrome into a summary bar and toolbar ([#14913](https://github.com/QwenLM/qwen-code/pull/14913)) by @qqqys
- feat(managed-agent): Support approval changes during a turn ([#14920](https://github.com/QwenLM/qwen-code/pull/14920)) by @doudouOUC
- feat(managed-agent): simplify existing local project onboarding ([#14970](https://github.com/QwenLM/qwen-code/pull/14970)) by @doudouOUC
- feat(generated-ui): bundle Generated UI behind an experimental flag ([#14888](https://github.com/QwenLM/qwen-code/pull/14888)) by @qqqys
- feat(web-shell): show model refresh as an icon beside search ([#14983](https://github.com/QwenLM/qwen-code/pull/14983)) by @callmeYe
- feat(managed-agent): import enabled skills at session creation ([#14930](https://github.com/QwenLM/qwen-code/pull/14930)) by @doudouOUC
- feat(serve): add daemon restart ([#14929](https://github.com/QwenLM/qwen-code/pull/14929)) by @wenshao
- feat(cua): streamline computer use and port native reliability fixes ([#14846](https://github.com/QwenLM/qwen-code/pull/14846)) by @LaZzyMan
- feat(web-shell): support managed session rename ([#14987](https://github.com/QwenLM/qwen-code/pull/14987)) by @doudouOUC
- feat(serve): add persisted workspace artifact library ([#14867](https://github.com/QwenLM/qwen-code/pull/14867)) by @BZ-D
- feat(workflow): add per-turn human-origin workflow hints ([#14876](https://github.com/QwenLM/qwen-code/pull/14876)) by @qqqys
- feat(web-shell): open trajectory record details as a drill-in or side panel ([#14984](https://github.com/QwenLM/qwen-code/pull/14984)) by @qqqys
- feat(core): add a real PTY backend for the Bun runtime ([#14046](https://github.com/QwenLM/qwen-code/pull/14046)) by @chiga0
- feat(managed-agent): allow concurrent sessions on shared workspace storage ([#15026](https://github.com/QwenLM/qwen-code/pull/15026)) by @doudouOUC
- feat(managed-agent): derive Session Store wiring on a single host ([#15005](https://github.com/QwenLM/qwen-code/pull/15005)) by @wenshao
- feat(serve): make paired Web Shell devices listable and revocable ([#15000](https://github.com/QwenLM/qwen-code/pull/15000)) by @yiliang114
- feat(core): add model.loopProtection and remind instead of stopping loops by default ([#15016](https://github.com/QwenLM/qwen-code/pull/15016)) by @qqqys
- feat(cli): paste clipboard text with Ctrl+V on Linux ([#14172](https://github.com/QwenLM/qwen-code/pull/14172)) by @qwen-code-dev-bot
- feat(web-shell): unify daemon and managed workspace navigation ([#15061](https://github.com/QwenLM/qwen-code/pull/15061)) by @doudouOUC

#### Bug Fixes

- fix(managed-agent): bound initial publication guard waits ([#14563](https://github.com/QwenLM/qwen-code/pull/14563)) by @yiliang114
- test(cli): retry ENOTEMPTY in hosted harness teardowns ([#14636](https://github.com/QwenLM/qwen-code/pull/14636)) by @ZedingZhang
- Automatically recovers public Sessions with committed, unconsumed inputs after managed-agent writer loss so pending wakes are replayed instead of dropped. ([#14603](https://github.com/QwenLM/qwen-code/pull/14603)) by @doudouOUC
- Session creation and worktree reset via the daemon HTTP API now use the daemon's session budget deadline, preventing in-progress initialization from timing out too early. ([#14588](https://github.com/QwenLM/qwen-code/pull/14588)) by @yiliang114
- On POSIX, Hosted stdio MCP servers now run in their own process group with supervised shutdown, improving cleanup; Windows behavior is unchanged. ([#14640](https://github.com/QwenLM/qwen-code/pull/14640)) by @wenshao
- Hosted Session journals now recover after a lapsed writer lease, applying committed entries once and retrying missing ones instead of failing. ([#14570](https://github.com/QwenLM/qwen-code/pull/14570)) by @wenshao
- Hosted PostToolUse, PostToolUseFailure, and PostToolBatch hooks now report the tool input left by PreToolUse, excluding refused or invalid replacements. ([#14650](https://github.com/QwenLM/qwen-code/pull/14650)) by @qqqys
- fix(ci): repair Java gates and report failures on PRs ([#14522](https://github.com/QwenLM/qwen-code/pull/14522)) by @yiliang114
- Hosted sessions now continue recovered child-result and monitor notification turns after a crash instead of waiting for new input. ([#14679](https://github.com/QwenLM/qwen-code/pull/14679)) by @doudouOUC
- Raises Playwright wait limits for web-shell smoke tests from 10 to 20 seconds to reduce false failures on busy shared CI hosts ([#14643](https://github.com/QwenLM/qwen-code/pull/14643)) by @yiliang114
- Fixes managed-agent tool cards so expanding a settled ReadFile or Shell card loads saved arguments, output, and errors ([#14604](https://github.com/QwenLM/qwen-code/pull/14604)) by @doudouOUC
- Preserves keyboard focus in the web-shell trajectory panel when recent execution views are removed or evicted ([#14641](https://github.com/QwenLM/qwen-code/pull/14641)) by @qqqys
- fix(cli): reconcile managed recovery failure reasons ([#14567](https://github.com/QwenLM/qwen-code/pull/14567)) by @yiliang114
- fix(hooks): reap a Hook command unit when its worker dies (#14502) ([#14675](https://github.com/QwenLM/qwen-code/pull/14675)) by @wenshao
- fix(config): let a Managed host restore its own session ([#14688](https://github.com/QwenLM/qwen-code/pull/14688)) by @wenshao
- Widens interactive E2E wait budgets for saved workflow slash-command completion replies to 120 seconds to reduce flaky CI stalls. ([#14202](https://github.com/QwenLM/qwen-code/pull/14202)) by @qwen-code-dev-bot
- Prevents a pending user cancellation from being recorded as a failed turn when recovery is not ready, allowing it to remain cancelling or settle as cancelled. ([#14694](https://github.com/QwenLM/qwen-code/pull/14694)) by @wenshao
- Bounds managed-agent publication placement waits to prevent unlimited blocking and long lock timeouts during dispatch, completion, claim, and verification. ([#14542](https://github.com/QwenLM/qwen-code/pull/14542)) by @yiliang114
- Managed Agent image attachments now accept PNG, JPEG, GIF, WebP, and the image/jpg alias, matching Qwen Code image handling. ([#14704](https://github.com/QwenLM/qwen-code/pull/14704)) by @doudouOUC
- Stabilizes the FG12b released-store fault gate so it reliably verifies owner-release resend behavior without depending on CI load. ([#14711](https://github.com/QwenLM/qwen-code/pull/14711)) by @qwen-code-dev-bot
- Fixes CI so Java failure summaries can be posted as pull request comments by granting the comment writer job pull-request write permission. ([#14717](https://github.com/QwenLM/qwen-code/pull/14717)) by @yiliang114
- fix(managed-agent): reject an incomplete Workspace tool path in --check ([#14635](https://github.com/QwenLM/qwen-code/pull/14635)) by @wenshao
- fix(cli): hold pre-runtime /acp WebSocket upgrades instead of falling through to a 406 (#13995) ([#13997](https://github.com/QwenLM/qwen-code/pull/13997)) by @qwen-code-dev-bot
- fix: align DeepSeek reasoning controls across official and MaaS routes ([#14689](https://github.com/QwenLM/qwen-code/pull/14689)) by @qqqys
- fix(web-shell): surface the fix witness in the review artifact viewer ([#14725](https://github.com/QwenLM/qwen-code/pull/14725)) by @yiliang114
- fix(managed-agent): align fault gates with unsettled-append recovery ([#14716](https://github.com/QwenLM/qwen-code/pull/14716)) by @yiliang114
- test(managed-agent): widen the hosted recovery and hook-cancel gate windows (#14729) ([#14741](https://github.com/QwenLM/qwen-code/pull/14741)) by @qwen-code-dev-bot
- fix(web-shell): preserve slash highlighting in user messages ([#14171](https://github.com/QwenLM/qwen-code/pull/14171)) by @Lilian0122
- fix(managed-agent): prove a zombie-only group stopped ([#14738](https://github.com/QwenLM/qwen-code/pull/14738)) by @wenshao
- test(managed-agent): drive the FG12b releasing gate until the fault fires (#14782) ([#14799](https://github.com/QwenLM/qwen-code/pull/14799)) by @qwen-code-dev-bot
- test(managed-agent): pin the FG13c worker-kill reaper contract ([#14802](https://github.com/QwenLM/qwen-code/pull/14802)) by @qwen-code-dev-bot
- test(managed-agent): give the failed-spawn test a realistic deadline (#14779) ([#14783](https://github.com/QwenLM/qwen-code/pull/14783)) by @qwen-code-dev-bot
- fix(core): Compact managed activation and inbox journals ([#14760](https://github.com/QwenLM/qwen-code/pull/14760)) by @doudouOUC
- fix(managed-agent): Reconcile parked Turn cancels from durable results ([#14763](https://github.com/QwenLM/qwen-code/pull/14763)) by @doudouOUC
- fix(ci): repair main's Prettier step and deflake the hook-cancel fence test (#14581) ([#14590](https://github.com/QwenLM/qwen-code/pull/14590)) by @qwen-code-dev-bot
- fix(ci): wait 90 minutes for the sdk-java host lock (#14787) ([#14801](https://github.com/QwenLM/qwen-code/pull/14801)) by @qwen-code-dev-bot
- perf(core): Index managed Session history reads ([#14767](https://github.com/QwenLM/qwen-code/pull/14767)) by @doudouOUC
- fix(managed-agent): park a cancel over an unobserved Turn (D7-2) ([#14700](https://github.com/QwenLM/qwen-code/pull/14700)) by @wenshao
- fix(ci): include updatedInput hook integration tests in PR checks ([#14747](https://github.com/QwenLM/qwen-code/pull/14747)) by @yiliang114
- fix(ci): allow fault gates to outlive the Surefire fork timeout ([#14745](https://github.com/QwenLM/qwen-code/pull/14745)) by @yiliang114
- fix(cli): keep one-shot system reminders out of the user's own message ([#14740](https://github.com/QwenLM/qwen-code/pull/14740)) by @yiliang114
- fix(ci): raise the build heap cap from 4096 to 6144 MB ([#14822](https://github.com/QwenLM/qwen-code/pull/14822)) by @yiliang114
- fix(acp): avoid splitting surrogate pairs when truncating turn text ([#14744](https://github.com/QwenLM/qwen-code/pull/14744)) by @yiliang114
- fix(managed-agent): Preserve original owners for owed Hosted cleanup ([#14764](https://github.com/QwenLM/qwen-code/pull/14764)) by @doudouOUC
- fix(core): keep a producer-declared truncation bit when raw size is unknown ([#14830](https://github.com/QwenLM/qwen-code/pull/14830)) by @yiliang114
- fix(ci): cap the prepare build heap and share the self-hosted Node preflight ([#14827](https://github.com/QwenLM/qwen-code/pull/14827)) by @wenshao
- fix(ci): skip failure reports for superseded run attempts (#14768) ([#14771](https://github.com/QwenLM/qwen-code/pull/14771)) by @qwen-code-dev-bot
- fix(managed-agent): answer self-healing Harness conflicts as retryable 503 ([#14645](https://github.com/QwenLM/qwen-code/pull/14645)) by @wenshao
- fix(web-shell): avoid flashing the credential form during boot token verification ([#14770](https://github.com/QwenLM/qwen-code/pull/14770)) by @BigDaddy1337
- fix(core): stop double-truncating web_fetch and keep the full text recoverable ([#14547](https://github.com/QwenLM/qwen-code/pull/14547)) by @yiliang114
- fix(managed-agent): keep the CSI retirement key mode-independent on MariaDB (#14832) ([#14853](https://github.com/QwenLM/qwen-code/pull/14853)) by @yiliang114
- fix(hosted): bind execution to the final hook input ([#14708](https://github.com/QwenLM/qwen-code/pull/14708)) by @qqqys
- test(managed-agent): stabilize the FG12b intent and cwd hosted gates ([#14730](https://github.com/QwenLM/qwen-code/pull/14730)) by @qwen-code-dev-bot
- fix(managed-agent): treat hosted_turn_active as a lifecycle wait (#14492) ([#14806](https://github.com/QwenLM/qwen-code/pull/14806)) by @qwen-code-dev-bot
- fix(ci): retry transient pnpm installs in the SDK Java workflow (#14845) ([#14851](https://github.com/QwenLM/qwen-code/pull/14851)) by @qwen-code-dev-bot
- fix(channels): preserve Markdown structure when splitting messages ([#14043](https://github.com/QwenLM/qwen-code/pull/14043)) by @callmeYe
- fix(memory): report the real cause and drop set when MEMORY.md exceeds its budget ([#14841](https://github.com/QwenLM/qwen-code/pull/14841)) by @yiliang114
- fix(ci): skip Managed Agent reviews after the PR closes (#14774) ([#14777](https://github.com/QwenLM/qwen-code/pull/14777)) by @qwen-code-dev-bot
- fix(managed-agent): bound settled runtime dispatch entries ([#14657](https://github.com/QwenLM/qwen-code/pull/14657)) by @wenshao
- fix(ci): skip prepare's duplicate build in the daemon E2E install (#14861) ([#14873](https://github.com/QwenLM/qwen-code/pull/14873)) by @qwen-code-dev-bot
- fix(cli): keep workspace skill status aligned after session load ([#14840](https://github.com/QwenLM/qwen-code/pull/14840)) by @callmeYe
- test(managed-agent): Measure the post-commit gate as per-round growth (#14197) ([#14207](https://github.com/QwenLM/qwen-code/pull/14207)) by @qwen-code-dev-bot
- fix(managed-agent): refresh schema upgrade expectations for V12/V13 ([#14893](https://github.com/QwenLM/qwen-code/pull/14893)) by @qwen-code-dev-bot
- fix(managed-agent): bound and harden session resource storage ([#14656](https://github.com/QwenLM/qwen-code/pull/14656)) by @wenshao
- fix(managed-agent): stop activation renewal after persistent failure ([#14658](https://github.com/QwenLM/qwen-code/pull/14658)) by @wenshao
- test(cli): give resident model recovery waits the slow-host budget (#14922) ([#14927](https://github.com/QwenLM/qwen-code/pull/14927)) by @qwen-code-dev-bot
- fix(ci): hold the MariaDB lane's sdk-java lock once per job (#14896) ([#14903](https://github.com/QwenLM/qwen-code/pull/14903)) by @qwen-code-dev-bot
- fix(ci): hold chosen RocketMQ ports until the JVMs bind them ([#14860](https://github.com/QwenLM/qwen-code/pull/14860)) by @yiliang114
- fix(release): publish the generated CLI with npm so vendored ripgrep keeps its exec bit ([#14907](https://github.com/QwenLM/qwen-code/pull/14907)) by @yiliang114
- test(managed-agent): run the MariaDB lane's fixtures on MariaDB ([#14906](https://github.com/QwenLM/qwen-code/pull/14906)) by @yiliang114
- test(ci): pin the heap caps that failed the Managed Agent fast tier (#14862) ([#14874](https://github.com/QwenLM/qwen-code/pull/14874)) by @qwen-code-dev-bot
- test(integration): wait for the CLI PTY to exit before resetting a case directory (#14957) ([#14960](https://github.com/QwenLM/qwen-code/pull/14960)) by @qwen-code-dev-bot
- fix(ci): isolate hosted MySQL integration test classes ([#14875](https://github.com/QwenLM/qwen-code/pull/14875)) by @doudouOUC
- test(managed-agent): widen the held-approval lease margins against CI scheduler jitter ([#14478](https://github.com/QwenLM/qwen-code/pull/14478)) by @qwen-code-dev-bot
- fix(core): preserve compressed context during recovery ([#14702](https://github.com/QwenLM/qwen-code/pull/14702)) by @ytahdn
- test(integration): give each workflow completion case its own test directory ([#14792](https://github.com/QwenLM/qwen-code/pull/14792)) by @qwen-code-dev-bot
- fix(cli): restore bounded OpenTUI dialogs and add migration gates ([#14933](https://github.com/QwenLM/qwen-code/pull/14933)) by @chiga0
- fix(test): keep E2E CI runs off the pool host's auth state ([#14972](https://github.com/QwenLM/qwen-code/pull/14972)) by @qwen-code-dev-bot
- fix(web-shell): align Managed Session titles, file access and the Workspace row ([#14924](https://github.com/QwenLM/qwen-code/pull/14924)) by @yiliang114
- fix(ci): queue the sdk-java host lock first-come-first-serve (#14743) ([#14912](https://github.com/QwenLM/qwen-code/pull/14912)) by @yiliang114
- fix(cli): preserve runtime boundaries during standalone updates ([#14934](https://github.com/QwenLM/qwen-code/pull/14934)) by @chiga0
- fix(cua): restore release version validation from README ([#15001](https://github.com/QwenLM/qwen-code/pull/15001)) by @LaZzyMan
- fix(cli): keep review's gh reads machine-readable under forced colour ([#14944](https://github.com/QwenLM/qwen-code/pull/14944)) by @yiliang114
- fix(cli): report a zenity 4 display failure instead of a silent cancel ([#14923](https://github.com/QwenLM/qwen-code/pull/14923)) by @yiliang114
- fix(serve): admit loopback origins on any port via --allow-origin ([#15002](https://github.com/QwenLM/qwen-code/pull/15002)) by @yiliang114
- fix(core): preserve Responses cache boundaries before auto-memory context ([#15006](https://github.com/QwenLM/qwen-code/pull/15006)) by @LaZzyMan
- fix(web-shell): preserve reading position across SSE reconnects ([#15009](https://github.com/QwenLM/qwen-code/pull/15009)) by @ytahdn
- fix(managed-agent): keep control-plane settings out of Runtime workers ([#15024](https://github.com/QwenLM/qwen-code/pull/15024)) by @wenshao
- fix(core): place DashScope conversation cache before the attachment-bearing message ([#15020](https://github.com/QwenLM/qwen-code/pull/15020)) by @yiliang114
- fix(core): keep a close admitted mid-request from wedging the Hosted writer ([#15010](https://github.com/QwenLM/qwen-code/pull/15010)) by @wenshao
- fix(web-shell): keep the sidebar PR badge still when row actions appear ([#14994](https://github.com/QwenLM/qwen-code/pull/14994)) by @wenshao
- test(cli): keep daemon workflow intent E2E off the container sandbox ([#15029](https://github.com/QwenLM/qwen-code/pull/15029)) by @qwen-code-dev-bot
- fix(core): pluralize the Goal token budget stop reason ([#15062](https://github.com/QwenLM/qwen-code/pull/15062)) by @yiliang114
- fix(ci): align Java integration database and lock lifetime ([#14936](https://github.com/QwenLM/qwen-code/pull/14936)) by @yiliang114
- fix(ci): name the sdk-java host lock holder when a ticket starves ([#15031](https://github.com/QwenLM/qwen-code/pull/15031)) by @yiliang114

#### Performance

- Shell tool receipt lookups are faster because committed receipts are indexed by execution call instead of scanning full history. ([#14660](https://github.com/QwenLM/qwen-code/pull/14660)) by @wenshao
- Improves web-shell performance by incrementally updating managed session messages when new events append, avoiding full history rebuilds ([#14562](https://github.com/QwenLM/qwen-code/pull/14562)) by @yiliang114
- perf(managed-agent): bound the held-Runtime inventory read cost (#13930) ([#14691](https://github.com/QwenLM/qwen-code/pull/14691)) by @wenshao

#### Documentation

- Adds a bilingual design document proposing bounded retention, replay floors, snapshots, and windowed event storage for managed-agent session state. ([#14659](https://github.com/QwenLM/qwen-code/pull/14659)) by @wenshao
- Clarifies VS Code documentation on why embedded webviews cannot use the standalone Web Shell same-origin exception for daemon URLs. ([#14684](https://github.com/QwenLM/qwen-code/pull/14684)) by @Jun516
- test(managed-agent): finish the FG13f decision-delivery arms ([#14736](https://github.com/QwenLM/qwen-code/pull/14736)) by @wenshao
- docs(managed-agent): name the pre-dispatch commit-spy assertion ([#14756](https://github.com/QwenLM/qwen-code/pull/14756)) by @wenshao
- docs(managed-agent): record the D7-2 report as closed out ([#14800](https://github.com/QwenLM/qwen-code/pull/14800)) by @wenshao
- docs(managed-agent): scope the FG11f publication fault gates ([#14734](https://github.com/QwenLM/qwen-code/pull/14734)) by @wenshao
- docs(managed-agent): pin the reconcile-before-refusal and the OBJECT_PUT admission ([#14811](https://github.com/QwenLM/qwen-code/pull/14811)) by @wenshao
- docs(managed-agent): record the FG13f remaining-arm coverage ([#14814](https://github.com/QwenLM/qwen-code/pull/14814)) by @wenshao
- docs(managed-agent): close out the D7 report statuses ([#14813](https://github.com/QwenLM/qwen-code/pull/14813)) by @wenshao
- docs(runtime): simplify CSI delivery around resident Workspaces ([#14758](https://github.com/QwenLM/qwen-code/pull/14758)) by @doudouOUC
- docs(telemetry): clarify OTLP HTTP uses JSON encoding ([#14664](https://github.com/QwenLM/qwen-code/pull/14664)) by @Jun516
- docs(managed-agent): scope the FG11e stream-gap gate ([#14881](https://github.com/QwenLM/qwen-code/pull/14881)) by @wenshao
- docs(managed-agent): record what the remaining FG11d cells answer ([#14882](https://github.com/QwenLM/qwen-code/pull/14882)) by @wenshao
- docs(managed-agent): locate the FG11e replay branch and gap contract ([#14899](https://github.com/QwenLM/qwen-code/pull/14899)) by @wenshao
- docs(managed-agent): name the replay contract document ([#14905](https://github.com/QwenLM/qwen-code/pull/14905)) by @wenshao
- docs(mcp): clarify restrictive prefixes and legacy grants ([#14683](https://github.com/QwenLM/qwen-code/pull/14683)) by @Jun516
- docs(managed-agent): propose where a late reply settles after the connection is gone ([#14926](https://github.com/QwenLM/qwen-code/pull/14926)) by @wenshao
- docs(board): clarify suggested task owner semantics ([#14967](https://github.com/QwenLM/qwen-code/pull/14967)) by @Jun516
- docs(ci): correct stale MariaDB CI claims and host reaper bound ([#14995](https://github.com/QwenLM/qwen-code/pull/14995)) by @yiliang114

#### Internal Changes

- test(cli): give turn-settling waits the slow-host budget ([#14598](https://github.com/QwenLM/qwen-code/pull/14598)) by @yiliang114
- Raises CLI hosted probe-start test guards from 1 second to 10 seconds to tolerate scheduling delays and reduce false failures. ([#14662](https://github.com/QwenLM/qwen-code/pull/14662)) by @yiliang114
- Adds a managed-agent test verifying DELETE drains a held async PreToolUse hook before SessionEnd and SessionDelete lifecycle hooks run. ([#14638](https://github.com/QwenLM/qwen-code/pull/14638)) by @wenshao
- Internal tests now verify automation recovery after Spring crashes and scanner lease races. ([#14649](https://github.com/QwenLM/qwen-code/pull/14649)) by @wenshao
- Internal cleanup that shares CSI runtime marker reads without changing managed-agent behavior ([#14571](https://github.com/QwenLM/qwen-code/pull/14571)) by @yiliang114
- Adds a managed-agent fault test ensuring a lost hook-catalog reply before registration does not create duplicate or stale Hook registrations ([#14668](https://github.com/QwenLM/qwen-code/pull/14668)) by @wenshao
- test(managed-agent): assert G3 approval identities and pin drift ([#14673](https://github.com/QwenLM/qwen-code/pull/14673)) by @wenshao
- test(managed-agent): drop the FG13a HTTP Hook reply after the request ([#14692](https://github.com/QwenLM/qwen-code/pull/14692)) by @wenshao
- test(managed-agent): scope the FG11c crash assertions and fix the race fixture ([#14682](https://github.com/QwenLM/qwen-code/pull/14682)) by @wenshao
- Adds tests confirming the Session-close drain flag is sent and handled correctly during managed-agent release requests. ([#14712](https://github.com/QwenLM/qwen-code/pull/14712)) by @wenshao
- Adds a regression test ensuring session labels are recovered only from verified Goal records, not lines that merely mention the marker. ([#14705](https://github.com/QwenLM/qwen-code/pull/14705)) by @yiliang114
- Removes the fixed JavaScript size ceiling for read-only transcript artifact checks to reduce recurring test maintenance and merge conflicts. ([#14703](https://github.com/QwenLM/qwen-code/pull/14703)) by @ytahdn
- Reorganizes Managed Agent Server internal packages by responsibility without changing deployment or service behavior. ([#14710](https://github.com/QwenLM/qwen-code/pull/14710)) by @doudouOUC
- Adds G3 approval fault-point end-to-end arms that verify durable approval recovery after crashes, lost replies, and dispatch failures. ([#14687](https://github.com/QwenLM/qwen-code/pull/14687)) by @wenshao
- Synchronizes scheduler disposal fault-injection testing to reliably count failed claims before disposal without fake-clock interference. ([#14727](https://github.com/QwenLM/qwen-code/pull/14727)) by @yiliang114
- test(managed-agent): replay a denied Hook decision after a lost reply ([#14701](https://github.com/QwenLM/qwen-code/pull/14701)) by @wenshao
- test(cli): pin the FG13d pre-dispatch cancel in a unit test ([#14735](https://github.com/QwenLM/qwen-code/pull/14735)) by @wenshao
- test(managed-agent): witness the durable hold sweep across both families (#13930) ([#14719](https://github.com/QwenLM/qwen-code/pull/14719)) by @wenshao
- test(managed-agent): gate a disabled automation span (FG11d) ([#14731](https://github.com/QwenLM/qwen-code/pull/14731)) by @wenshao
- test(managed-agent): leave a v2 execution unknown across a Harness kill (D7-2) ([#14750](https://github.com/QwenLM/qwen-code/pull/14750)) by @wenshao
- test(managed-agent): cover the remaining FG12a reply-loss cells ([#14715](https://github.com/QwenLM/qwen-code/pull/14715)) by @wenshao
- test(managed-agent): replay a failClosed Hook failure after a lost reply ([#14803](https://github.com/QwenLM/qwen-code/pull/14803)) by @wenshao
- test(managed-agent): Verify private media retention boundaries ([#14766](https://github.com/QwenLM/qwen-code/pull/14766)) by @doudouOUC
- refactor(managed-agent): simplify the event transport package ([#14816](https://github.com/QwenLM/qwen-code/pull/14816)) by @doudouOUC
- test(managed-agent): refuse the first FG12d release before forwarding ([#14737](https://github.com/QwenLM/qwen-code/pull/14737)) by @wenshao
- test(ci): pin that the temp short-alias guard visits both keys ([#14805](https://github.com/QwenLM/qwen-code/pull/14805)) by @yiliang114
- test(managed-agent): Verify MCP retention through Session retirement ([#14762](https://github.com/QwenLM/qwen-code/pull/14762)) by @doudouOUC
- test(managed-agent): let the FG13f failClosed cell reach the Hook ([#14818](https://github.com/QwenLM/qwen-code/pull/14818)) by @wenshao
- test(managed-agent): settle a landed turn reply without a cold load ([#14820](https://github.com/QwenLM/qwen-code/pull/14820)) by @yiliang114
- test(managed-agent): crash the approval result-commit barrier ([#14733](https://github.com/QwenLM/qwen-code/pull/14733)) by @wenshao
- test(core): pin the durability snapshot after reactive compaction ([#14815](https://github.com/QwenLM/qwen-code/pull/14815)) by @wenshao
- test(managed-agent): reject Hook store commits (FG13b) ([#14817](https://github.com/QwenLM/qwen-code/pull/14817)) by @wenshao
- test(managed-agent): gate the FG11f lost-ack publication fault (FG11f) ([#14819](https://github.com/QwenLM/qwen-code/pull/14819)) by @wenshao
- test(managed-agent): gate FG12f result and catalog delivery ([#14829](https://github.com/QwenLM/qwen-code/pull/14829)) by @wenshao
- test(ci): pin the root build heap cap above the CLI compile ceiling (#14835) ([#14843](https://github.com/QwenLM/qwen-code/pull/14843)) by @qwen-code-dev-bot
- test(web-shell): stabilize branch picker workspace-switch focus test ([#14842](https://github.com/QwenLM/qwen-code/pull/14842)) by @qwen-code-dev-bot
- ci(gate): skip the Managed Agent gate run for reviews that are not approvals ([#14857](https://github.com/QwenLM/qwen-code/pull/14857)) by @yiliang114
- test(managed-agent): gate the FG11f refusing arms (FG11f) ([#14821](https://github.com/QwenLM/qwen-code/pull/14821)) by @wenshao
- test(managed-agent): wait for the landed reply's applied record ([#14833](https://github.com/QwenLM/qwen-code/pull/14833)) by @yiliang114
- test(managed-agent): ignore transient MySQL deadlocks in hosted gate waits ([#14812](https://github.com/QwenLM/qwen-code/pull/14812)) by @qwen-code-dev-bot
- style(managed-agent): clear the checkstyle violations in the result-delivery IT ([#14883](https://github.com/QwenLM/qwen-code/pull/14883)) by @wenshao
- test(managed-agent): reject Hook result and plan-result commits (FG13b) ([#14848](https://github.com/QwenLM/qwen-code/pull/14848)) by @wenshao
- test(managed-agent): pin which commit the plan rejection hit ([#14898](https://github.com/QwenLM/qwen-code/pull/14898)) by @wenshao
- test(managed-agent): gate the per-run cancel on a parked wake turn (FG11d) ([#14900](https://github.com/QwenLM/qwen-code/pull/14900)) by @wenshao
- test(integration): stop the session-id uniqueness E2E at the init message (#14579) ([#14585](https://github.com/QwenLM/qwen-code/pull/14585)) by @qwen-code-dev-bot
- test(managed-agent): gate a late conclusive reply after outcome_unknown ([#14892](https://github.com/QwenLM/qwen-code/pull/14892)) by @wenshao
- test(managed-agent): settle a claim retired at intent (FG11d) ([#14915](https://github.com/QwenLM/qwen-code/pull/14915)) by @wenshao
- test(managed-agent): skip a closed Session's automation slots (FG11d) ([#14931](https://github.com/QwenLM/qwen-code/pull/14931)) by @wenshao
- test(managed-agent): resume both Session streams across a held Hook (FG13e) ([#14917](https://github.com/QwenLM/qwen-code/pull/14917)) by @wenshao
- test(managed-agent): pin the close refusal while a turn is active (FG11d) ([#14974](https://github.com/QwenLM/qwen-code/pull/14974)) by @wenshao
- test(managed-agent): gate a pre-dispatch MCP operation cancel (FG12d) ([#14963](https://github.com/QwenLM/qwen-code/pull/14963)) by @wenshao
- test(managed-agent): keep a suppressed reply suppressed across a reload (FG13f) ([#14978](https://github.com/QwenLM/qwen-code/pull/14978)) by @wenshao
- test(managed-agent): reuse the run on a same-key retry (FG11d) ([#14981](https://github.com/QwenLM/qwen-code/pull/14981)) by @wenshao
- test(managed-agent): gate R1-1 owner-release recovery across a Spring restart (FG12d) ([#14990](https://github.com/QwenLM/qwen-code/pull/14990)) by @wenshao
- test(managed-agent): keep a settled run's outcome (FG11d) ([#14996](https://github.com/QwenLM/qwen-code/pull/14996)) by @wenshao
- test(managed-agent): lose the store ack after the result commit (FG13a) ([#14991](https://github.com/QwenLM/qwen-code/pull/14991)) by @wenshao
- test(managed-agent): keep the durable dispatch after a lost ack (FG13a) ([#14992](https://github.com/QwenLM/qwen-code/pull/14992)) by @wenshao
- test(managed-agent): reuse the pinned registration after a lost ack (FG13a) ([#14993](https://github.com/QwenLM/qwen-code/pull/14993)) by @wenshao
- test(managed-agent): resume the automation streams across a settle (FG11e) ([#15017](https://github.com/QwenLM/qwen-code/pull/15017)) by @wenshao
- test(web-shell): pin the openable session PR filter directly ([#15059](https://github.com/QwenLM/qwen-code/pull/15059)) by @wenshao
- test(managed-agent): wait for the D7-2 runtime park, not a takeover refusal ([#15046](https://github.com/QwenLM/qwen-code/pull/15046)) by @yiliang114

### New Contributors

- @Jun516 made their first contribution in [#14684](https://github.com/QwenLM/qwen-code/pull/14684)
- @BigDaddy1337 made their first contribution in [#14770](https://github.com/QwenLM/qwen-code/pull/14770)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.25.3...v0.26.0

## [0.25.3](https://github.com/QwenLM/qwen-code/releases/tag/v0.25.3) - 2026-10-19

### Highlights

_See the complete change list below._

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- Adds optional model-generated layouts to Test Failure Explorer, with validation and fallback to the fixed view ([#14269](https://github.com/QwenLM/qwen-code/pull/14269)) by @qqqys
- The Web Shell mobile composer no longer shows the ↑ and ↓ history buttons, reducing clutter while keeping history search available. ([#14220](https://github.com/QwenLM/qwen-code/pull/14220)) by @pomelo-nwu
- The Web Shell trajectory panel now includes a collapsible Recent executions section that shows live requests and tools with elapsed time and final durations. ([#14071](https://github.com/QwenLM/qwen-code/pull/14071)) by @qqqys
- Managed sessions created from published AgentDefinitions can now load static Skills and pass pinned MCP server and Hook catalog selections to Hosted Runtimes. ([#14319](https://github.com/QwenLM/qwen-code/pull/14319)) by @doudouOUC
- Files now offers New file and New folder actions, and folder Delete asks for a second confirmation before permanently removing the folder and its contents. ([#14169](https://github.com/QwenLM/qwen-code/pull/14169)) by @ytahdn
- Eligible legacy cancellations now require confirmation through the daemon or WebShell Continue flow before continuing, while explicitly user-cancelled work stays blocked. ([#14087](https://github.com/QwenLM/qwen-code/pull/14087)) by @yiliang114
- Hosted parent agents can launch snapshot-isolated child agents that read a frozen workspace copy without changing files, running commands, or affecting the parent. ([#14265](https://github.com/QwenLM/qwen-code/pull/14265)) by @wenshao
- Clicking the workspace folder beside the chat title now opens and selects the Files tree in the right panel, with keyboard and focus preserved. ([#14344](https://github.com/QwenLM/qwen-code/pull/14344)) by @ytahdn
- Managed sessions now integrate into the home and sidebar, supporting workspace creation, approval policy and model selection, and context usage in the composer. ([#14316](https://github.com/QwenLM/qwen-code/pull/14316)) by @doudouOUC
- The Files panel adds a Delete menu for regular files, requiring a permanent-deletion confirmation for the selected trusted local workspace. ([#14158](https://github.com/QwenLM/qwen-code/pull/14158)) by @ytahdn
- Adds resident Kubernetes Workspace file sessions that retain an original Pod and fixed CSI PVC so configured Workspaces preserve files across sessions. ([#14340](https://github.com/QwenLM/qwen-code/pull/14340)) by @doudouOUC
- Adds Shell Full Access and default/auto-edit/yolo switching for built-in Workspace-bound qwen-code Sessions without losing history, Workspace, or drafts. ([#14323](https://github.com/QwenLM/qwen-code/pull/14323)) by @doudouOUC
- feat(mods): support commands in interactive terminals (PR4a) ([#14268](https://github.com/QwenLM/qwen-code/pull/14268)) by @qqqys
- feat(providers): add QwenCloud as the first /auth entry ([#14073](https://github.com/QwenLM/qwen-code/pull/14073)) by @yiliang114
- feat(ci): route the release lane's hosted stragglers onto ECS runners ([#14336](https://github.com/QwenLM/qwen-code/pull/14336)) by @yiliang114
- feat(web-shell): add side task archive controls ([#14300](https://github.com/QwenLM/qwen-code/pull/14300)) by @yiliang114
- feat(managed-agent): Add SSH Tool Runtime support ([#14318](https://github.com/QwenLM/qwen-code/pull/14318)) by @doudouOUC
- feat(web-shell): list every Managed task kind in the task panel ([#14415](https://github.com/QwenLM/qwen-code/pull/14415)) by @wenshao
- feat(managed-agent): H4f-c public task cancel for background Shell and Monitor tasks ([#14412](https://github.com/QwenLM/qwen-code/pull/14412)) by @wenshao
- feat(managed-agent): link a child task to its child Session (#13746 F2) ([#14413](https://github.com/QwenLM/qwen-code/pull/14413)) by @wenshao
- feat(managed-agent): Improve workspace selection and tool progress ([#14405](https://github.com/QwenLM/qwen-code/pull/14405)) by @doudouOUC
- feat(managed-agent): project channel deliveries as tasks and serve their cancel (#13746 F3) ([#14414](https://github.com/QwenLM/qwen-code/pull/14414)) by @wenshao
- feat(managed-agent): record Turn input and cancel as durable command operations (D7-1) ([#14404](https://github.com/QwenLM/qwen-code/pull/14404)) by @wenshao
- feat(managed-agent): support native macOS workspace runtime ([#14442](https://github.com/QwenLM/qwen-code/pull/14442)) by @doudouOUC
- feat(qqbot): accept inbound files and voice messages ([#14343](https://github.com/QwenLM/qwen-code/pull/14343)) by @Eric-GoodBoy-Tech
- feat(managed-agent): reconcile acceptance-unknown operations through one rule (D7-2) ([#14443](https://github.com/QwenLM/qwen-code/pull/14443)) by @wenshao
- feat(managed-agent): reconcile a parked SSH Workspace registration (D7-2) ([#14456](https://github.com/QwenLM/qwen-code/pull/14456)) by @wenshao
- feat(runtime-broker): Workspace-resident Tool Runtime for bound Sessions ([#14435](https://github.com/QwenLM/qwen-code/pull/14435)) by @doudouOUC
- fix(ci): run three hosted control-plane jobs on the ECS pool ([#14469](https://github.com/QwenLM/qwen-code/pull/14469)) by @wenshao
- feat(managed-agent): add the opt-in java_durable admission profile (D7-3) ([#14470](https://github.com/QwenLM/qwen-code/pull/14470)) by @wenshao
- feat(ci): gate Managed Agent changes on a full SDK Java run before merge ([#14397](https://github.com/QwenLM/qwen-code/pull/14397)) by @yiliang114
- feat(serve): attach private CSI Sessions to Hosted text turns ([#14081](https://github.com/QwenLM/qwen-code/pull/14081)) by @doudouOUC
- feat(managed-agent): reconcile parked Session title deliveries (D7-2) ([#14475](https://github.com/QwenLM/qwen-code/pull/14475)) by @wenshao
- feat(managed-agent): register the Managed engine in paired daemons ([#14483](https://github.com/QwenLM/qwen-code/pull/14483)) by @wenshao
- feat(managed-agent): allow approval changes in stored agent sessions ([#14484](https://github.com/QwenLM/qwen-code/pull/14484)) by @doudouOUC
- feat(managed-agent): support Plan mode and inline attachments ([#14531](https://github.com/QwenLM/qwen-code/pull/14531)) by @doudouOUC
- feat(workflow): discover trusted ancestor workflows in local sessions ([#14369](https://github.com/QwenLM/qwen-code/pull/14369)) by @qqqys
- feat(managed-agent): Support per-run automation cancellation ([#14526](https://github.com/QwenLM/qwen-code/pull/14526)) by @doudouOUC
- feat(managed-agent): bound half-open Hosted event streams behind a keepalive capability (#14135) ([#14512](https://github.com/QwenLM/qwen-code/pull/14512)) by @wenshao
- feat(managed-agent): connect the composer to pinned Skills ([#14602](https://github.com/QwenLM/qwen-code/pull/14602)) by @doudouOUC
- feat(web-shell): add approval mode allowlist ([#14345](https://github.com/QwenLM/qwen-code/pull/14345)) by @ytahdn

#### Bug Fixes

- Fixes plan approval crashes during journal-only interrupted turns so takeover can settle the session instead of failing terminally ([#14160](https://github.com/QwenLM/qwen-code/pull/14160)) by @wenshao
- Fixes checkstyle build failures in the Java SDK by reordering FG8 test imports ([#14305](https://github.com/QwenLM/qwen-code/pull/14305)) by @wenshao
- Standardizes Managed Agent timestamps to Unix epoch milliseconds and updates query mappings for consistent data handling ([#14185](https://github.com/QwenLM/qwen-code/pull/14185)) by @doudouOUC
- Fixes CSI preparation failures by retaining input, tool declaration, and intent resources through the HTTP store ([#14180](https://github.com/QwenLM/qwen-code/pull/14180)) by @doudouOUC
- Managed Hosted model prompts now stay aligned with declared tools, including empty or changed tool sets, so tool guidance and examples remain accurate. ([#14306](https://github.com/QwenLM/qwen-code/pull/14306)) by @doudouOUC
- Closing a parent session now stops each child session's running Turn, reducing lingering background work and making close behavior more reliable. ([#14218](https://github.com/QwenLM/qwen-code/pull/14218)) by @wenshao
- Session close after a Harness restart or takeover now correctly tracks and releases held background Shell or Monitor runtimes, preventing abandoned runs. ([#13986](https://github.com/QwenLM/qwen-code/pull/13986)) by @wenshao
- fix(managed-agent): name the plan's size and room in the team-plan bound refusal ([#14057](https://github.com/QwenLM/qwen-code/pull/14057)) by @wenshao
- Windows merge checks now report known workspace and script failures as warnings while keeping installer, security, and Hosted process tests blocking. ([#14298](https://github.com/QwenLM/qwen-code/pull/14298)) by @yiliang114
- Managed-agent retry loops now have budgets and terminal states, letting stuck projections fail safely, reducing repeated log noise and preventing endless retries. ([#13219](https://github.com/QwenLM/qwen-code/pull/13219)) by @wenshao
- When a hosted member message reply times out, the CLI now advises not to resend because the recipient may already have it or receive it later. ([#14296](https://github.com/QwenLM/qwen-code/pull/14296)) by @yiliang114
- Dialogs opened over the mobile sidebar drawer remain touch-scrollable instead of being locked by the drawer's background scroll behavior. ([#14217](https://github.com/QwenLM/qwen-code/pull/14217)) by @pomelo-nwu
- Managed agent publication grants and background session close now work reliably for Shell and Monitor output. ([#14364](https://github.com/QwenLM/qwen-code/pull/14364)) by @doudouOUC
- Fixes CLI custom commands so injected file content is preserved during later shell and argument interpolation instead of being reinterpreted. ([#14295](https://github.com/QwenLM/qwen-code/pull/14295)) by @yiliang114
- Fixes Web Shell so Show Response Tokens Per Second displays an estimated t/s rate beside the streaming token counter when enabled. ([#14294](https://github.com/QwenLM/qwen-code/pull/14294)) by @yiliang114
- Polishes Web Shell file display and preview by showing safe file names, preserving paths, adding a close-preview action, and limiting syntax highlighting resources. ([#14143](https://github.com/QwenLM/qwen-code/pull/14143)) by @ytahdn
- Routes post-merge classifier jobs to ECS when enabled and lets CLI test workers yield between tests to drain queued progress replies. ([#14293](https://github.com/QwenLM/qwen-code/pull/14293)) by @yiliang114
- fix(hooks): gate headless file and skill prompts before expansion ([#14356](https://github.com/QwenLM/qwen-code/pull/14356)) by @qqqys
- fix(ci): make finalize-release second-bot approve non-blocking (#14341) ([#14342](https://github.com/QwenLM/qwen-code/pull/14342)) by @yiliang114
- fix(managed-agent): hold behind an older message whose body cannot be read ([#14299](https://github.com/QwenLM/qwen-code/pull/14299)) by @wenshao
- fix(managed-agent): tenant-wide InnoDB locks must not wedge unrelated Sessions ([#13918](https://github.com/QwenLM/qwen-code/pull/13918)) by @wenshao
- fix(managed-runtime): landed PR 12691 review follow-ups across providers, activator, core tools and runtime broker ([#13297](https://github.com/QwenLM/qwen-code/pull/13297)) by @wenshao
- fix(channels/email): re-register on a channel_disconnected answer ([#13768](https://github.com/QwenLM/qwen-code/pull/13768)) by @wenshao
- fix(sdk-java): Close Hosted Harness review criticals from #12654 ([#13314](https://github.com/QwenLM/qwen-code/pull/13314)) by @wenshao
- fix(managed-agent): hand back the Workspace mount when a tool turn goes recovery blocked ([#13816](https://github.com/QwenLM/qwen-code/pull/13816)) by @wenshao
- fix(managed-agent): Report merges deleting uncommitted parent content as conflicts ([#14058](https://github.com/QwenLM/qwen-code/pull/14058)) by @wenshao
- fix(ci): document the shared-group supersede policy and keep main uncancellable ([#14286](https://github.com/QwenLM/qwen-code/pull/14286)) by @yiliang114
- fix(serve): fan out never-started process probes ([#14303](https://github.com/QwenLM/qwen-code/pull/14303)) by @yiliang114
- fix(web-shell): inset the right edge of a label-only composer chip ([#13968](https://github.com/QwenLM/qwen-code/pull/13968)) by @Bug-killer-prog
- fix(web-shell): neutralise controls in the generic approval content block ([#13972](https://github.com/QwenLM/qwen-code/pull/13972)) by @Bug-killer-prog
- fix(web-shell): delete attachments from an empty composer ([#13947](https://github.com/QwenLM/qwen-code/pull/13947)) by @Zhangchenhao-111
- fix(managed-agent): close the deferred #13182 terminal-state suggestions ([#14358](https://github.com/QwenLM/qwen-code/pull/14358)) by @wenshao
- fix(managed-agent): log the check behind a refused internal request ([#14391](https://github.com/QwenLM/qwen-code/pull/14391)) by @wenshao
- fix(ci): assemble the reference distribution into a fresh directory ([#14421](https://github.com/QwenLM/qwen-code/pull/14421)) by @wenshao
- fix(daemon): preserve active work when deleting scheduled tasks ([#14276](https://github.com/QwenLM/qwen-code/pull/14276)) by @yiliang114
- fix(core): report a defunct session pid as dead instead of active ([#14301](https://github.com/QwenLM/qwen-code/pull/14301)) by @yiliang114
- fix(runtime-broker): support credential key rotation ([#14317](https://github.com/QwenLM/qwen-code/pull/14317)) by @yiliang114
- fix(ci): keep the setup-java Maven cache on hosted runners ([#14396](https://github.com/QwenLM/qwen-code/pull/14396)) by @yiliang114
- fix(managed-agent): run a merge recorded on a snapshot as a discard (#13905 items 33-36) ([#14432](https://github.com/QwenLM/qwen-code/pull/14432)) by @wenshao
- fix(ci): start the reference distribution MySQL without native AIO ([#14429](https://github.com/QwenLM/qwen-code/pull/14429)) by @yiliang114
- fix(web-shell): Distinguish unavailable shell output ([#14436](https://github.com/QwenLM/qwen-code/pull/14436)) by @doudouOUC
- fix(ci): stop re-running the H2 unit suite in every Hosted job step ([#14423](https://github.com/QwenLM/qwen-code/pull/14423)) by @yiliang114
- fix(managed-agent): address the H4f task cancel review follow-ups ([#14437](https://github.com/QwenLM/qwen-code/pull/14437)) by @wenshao
- fix(managed-agent): flush early reject responses before draining the unread body ([#14444](https://github.com/QwenLM/qwen-code/pull/14444)) by @wenshao
- fix(web-shell): improve favicon contrast on dark browser tabs ([#14417](https://github.com/QwenLM/qwen-code/pull/14417)) by @wenshao
- fix(managed-agent): answer a full tool publication reservation with its own code ([#14451](https://github.com/QwenLM/qwen-code/pull/14451)) by @wenshao
- fix(serve): answer a batch the publication limit refused instead of blocking the Session ([#14452](https://github.com/QwenLM/qwen-code/pull/14452)) by @wenshao
- fix(managed): Recover cancellation after process restarts ([#14377](https://github.com/QwenLM/qwen-code/pull/14377)) by @doudouOUC
- fix(managed-agent): skip the deletion probe when a resume owes nothing (#13905 items 50-52) ([#14462](https://github.com/QwenLM/qwen-code/pull/14462)) by @wenshao
- fix(vscode): avoid navigator reads in the extension host ([#14304](https://github.com/QwenLM/qwen-code/pull/14304)) by @zonemeen
- fix(managed-agent): address the record/contract review follow-ups of the H3 enablement (#13930) ([#14464](https://github.com/QwenLM/qwen-code/pull/14464)) by @wenshao
- test: fix the SDK Java suite's red jobs (FG6e frames, schema V8 pin, client flakes) ([#14457](https://github.com/QwenLM/qwen-code/pull/14457)) by @yiliang114
- fix(ci): give the hosted Test lane the same 120-minute ceiling as ECS ([#14474](https://github.com/QwenLM/qwen-code/pull/14474)) by @wenshao
- fix(ci): run the trusted web-shell browser smoke on the ECS pool ([#14471](https://github.com/QwenLM/qwen-code/pull/14471)) by @wenshao
- fix(ci): skip application tests for Markdown-only and CODEOWNERS-only changes ([#14284](https://github.com/QwenLM/qwen-code/pull/14284)) by @yiliang114
- fix(core): fill empty signature on unsigned thinking blocks for strict Anthropic-compatible proxies ([#13676](https://github.com/QwenLM/qwen-code/pull/13676)) by @4ekuct25
- fix(managed-agent): never re-drive an unsettled workflow Turn on the recovery path (#14387) ([#14461](https://github.com/QwenLM/qwen-code/pull/14461)) by @wenshao
- test(core): size the hosted cold-scan ceiling from the slowest hosted runners ([#14497](https://github.com/QwenLM/qwen-code/pull/14497)) by @wenshao
- test(managed-agent): stub the acquire provisioner overload the Broker calls ([#14498](https://github.com/QwenLM/qwen-code/pull/14498)) by @wenshao
- test(managed-agent): pin #14387's Turn-row accessors in the lock canary ([#14501](https://github.com/QwenLM/qwen-code/pull/14501)) by @wenshao
- fix(managed-agent): keep a crash-blocked workflow run unknown and honestly notified, gated by FG10d (#14165) ([#14506](https://github.com/QwenLM/qwen-code/pull/14506)) by @wenshao
- test(managed-agent): parse only complete rows in the wedge driver wire ([#14496](https://github.com/QwenLM/qwen-code/pull/14496)) by @wenshao
- fix(managed-agent): keep runtime MCP state and permission sync honest ([#14488](https://github.com/QwenLM/qwen-code/pull/14488)) by @wenshao
- fix(sdk-java): keep the snapshot flag when a load copy restates child Workspaces (#13905 item 40) ([#14519](https://github.com/QwenLM/qwen-code/pull/14519)) by @wenshao
- fix(acp-bridge): forget a replaced child's runtime MCP servers ([#14527](https://github.com/QwenLM/qwen-code/pull/14527)) by @wenshao
- fix(mods): skip catches for re-entered registrations ([#14489](https://github.com/QwenLM/qwen-code/pull/14489)) by @qqqys
- fix(ci): classify host lock starvation as infrastructure (#14550) ([#14552](https://github.com/QwenLM/qwen-code/pull/14552)) by @wenshao
- fix(channels/base): strip zero-ink code points from display projections ([#14510](https://github.com/QwenLM/qwen-code/pull/14510)) by @yiliang114
- fix(managed-agent): preserve rotated credential keys during operator recovery ([#14509](https://github.com/QwenLM/qwen-code/pull/14509)) by @yiliang114
- fix(managed-agent): verify ambiguous Linux workspace birth times ([#14505](https://github.com/QwenLM/qwen-code/pull/14505)) by @yiliang114
- fix(core): stamp an aged-out final cron fire with its own minute ([#14559](https://github.com/QwenLM/qwen-code/pull/14559)) by @yiliang114
- fix(serve): tell a batch its Session can never hold at once to send fewer calls ([#14575](https://github.com/QwenLM/qwen-code/pull/14575)) by @wenshao
- fix(managed-agent): wait out a wake pump pass before settling its input ([#14574](https://github.com/QwenLM/qwen-code/pull/14574)) by @wenshao
- fix(core): quiet the crawler's ripgrep probe and stop double-reporting one failed spawn ([#14573](https://github.com/QwenLM/qwen-code/pull/14573)) by @yiliang114
- fix(managed-agent): bound retention root and head waits ([#14558](https://github.com/QwenLM/qwen-code/pull/14558)) by @yiliang114
- fix(managed-agent): free Workspace storage after a refused release ([#14568](https://github.com/QwenLM/qwen-code/pull/14568)) by @wenshao
- test(e2e): widen the channel-worker sandbox budgets ([#14587](https://github.com/QwenLM/qwen-code/pull/14587)) by @wenshao
- fix(managed-agent): reindent the retired-holder close stage for checkstyle ([#14607](https://github.com/QwenLM/qwen-code/pull/14607)) by @yiliang114
- test(e2e): mount the fixture root into the container sandbox for workflow ancestor discovery (#14589) ([#14593](https://github.com/QwenLM/qwen-code/pull/14593)) by @qwen-code-dev-bot
- test(cli): give the Hosted MCP cancellation gates' waitFor an explicit timeout ([#14614](https://github.com/QwenLM/qwen-code/pull/14614)) by @qwen-code-dev-bot
- fix(managed-agent): accept MariaDB numeric booleans in CHECK validation and repair drain-chain indentation (#14615) ([#14618](https://github.com/QwenLM/qwen-code/pull/14618)) by @qwen-code-dev-bot

#### Performance

- perf(managed-agent): avoid redundant session root materialization ([#14557](https://github.com/QwenLM/qwen-code/pull/14557)) by @yiliang114

#### Documentation

- Design docs now describe the DingTalk permission field as a checkbox group with single-choice submission and fix a broken reference. ([#11774](https://github.com/QwenLM/qwen-code/pull/11774)) by @L4XB
- The README Ecosystem section now lists the qwen-audio-agent realtime voice frontend for connecting through ACP stdio mode. ([#8630](https://github.com/QwenLM/qwen-code/pull/8630)) by @x-lixu
- Adds documentation for looot as a supported MCP web search service, including CLI and settings.json setup. ([#13999](https://github.com/QwenLM/qwen-code/pull/13999)) by @walidboulanouar
- docs(memory): plan extraction baseline before input changes ([#14368](https://github.com/QwenLM/qwen-code/pull/14368)) by @yiliang114
- docs(managed-agent): require one child Workspace setting on every replica ([#14411](https://github.com/QwenLM/qwen-code/pull/14411)) by @wenshao
- docs(managed-agent): stop saying no lifecycle operation sets failure_code ([#14422](https://github.com/QwenLM/qwen-code/pull/14422)) by @wenshao
- docs(managed-agent): keep hooks on snapshot children (#13905 item 37) ([#14440](https://github.com/QwenLM/qwen-code/pull/14440)) by @wenshao
- docs(managed-agent): state the read-profile step-3 acceptance (#13905 item 45) ([#14450](https://github.com/QwenLM/qwen-code/pull/14450)) by @wenshao
- docs: clarify safe mode tool schemas for small contexts ([#14445](https://github.com/QwenLM/qwen-code/pull/14445)) by @cenab
- docs(managed-agent): specify the M6 engine registration and workspace-change contract ([#14479](https://github.com/QwenLM/qwen-code/pull/14479)) by @wenshao
- docs(managed-agent): record M6 as implemented in #14483 ([#14491](https://github.com/QwenLM/qwen-code/pull/14491)) by @wenshao
- docs(managed-agent): add the FG12b and FG12e fault-gate designs (#14447) ([#14560](https://github.com/QwenLM/qwen-code/pull/14560)) by @wenshao
- docs(managed-agent): format the FG12b design pair ([#14580](https://github.com/QwenLM/qwen-code/pull/14580)) by @wenshao

#### Internal Changes

- test(managed-agent): add the FG8e/FG8f monitor_run and background-shell fault gates ([#14120](https://github.com/QwenLM/qwen-code/pull/14120)) by @wenshao
- Uses the permission probe to skip chmod-based CLI tests only where permission bits are not enforced ([#14271](https://github.com/QwenLM/qwen-code/pull/14271)) by @wenshao
- Reuses standard utilities for Git output, XML escaping, and artifact byte-range parsing without changing existing behavior ([#14307](https://github.com/QwenLM/qwen-code/pull/14307)) by @doudouOUC
- Managed Agent server and Runtime Broker sources are consolidated into one module without changing public APIs or behavior. ([#14277](https://github.com/QwenLM/qwen-code/pull/14277)) by @doudouOUC
- Qwen Code now separates the CLI launcher from the JavaScript interpreter used by hooks, sandbox file writes, and code-mode execution. ([#14036](https://github.com/QwenLM/qwen-code/pull/14036)) by @chiga0
- Runtime Broker now determines Harness ownership by Runtime Session for shared Workspace bindings, preparing for shared workspace-resident tool runtimes. ([#14339](https://github.com/QwenLM/qwen-code/pull/14339)) by @doudouOUC
- Internal tests for hosted member commands now stay within fork timeout budgets and avoid unnecessary relay holds. ([#14061](https://github.com/QwenLM/qwen-code/pull/14061)) by @wenshao
- Adds internal acceptance tests for real extension processes, MCP servers, and Hooks in managed-agent sessions. ([#14357](https://github.com/QwenLM/qwen-code/pull/14357)) by @doudouOUC
- test(managed-agent): add the FG9a/FG9f session_message and session_command relay fault gates (#14164) ([#14333](https://github.com/QwenLM/qwen-code/pull/14333)) by @wenshao
- test: skip the chmod-based core, wecom and scripts tests where permission bits do not bind ([#14283](https://github.com/QwenLM/qwen-code/pull/14283)) by @wenshao
- refactor(managed-agent): Decouple tool publication storage from OSS ([#14370](https://github.com/QwenLM/qwen-code/pull/14370)) by @doudouOUC
- test(managed-agent): give WorkspaceCreationSchemaMySqlIT its own disposable catalog ([#14375](https://github.com/QwenLM/qwen-code/pull/14375)) by @wenshao
- test(managed-agent): expect legacy creation to refuse a CSI storage alias ([#14382](https://github.com/QwenLM/qwen-code/pull/14382)) by @wenshao
- test(managed-agent): add the FG8a/FG8b/FG8d monitor_run and background-shell fault gates (#14163) ([#14334](https://github.com/QwenLM/qwen-code/pull/14334)) by @wenshao
- test(managed-agent): add the FG9d/FG9e session relay cancellation and SSE-gap fault gates (#14164) ([#14402](https://github.com/QwenLM/qwen-code/pull/14402)) by @wenshao
- test: gate the remaining chmod-based root skips on the permission-bit probe ([#14403](https://github.com/QwenLM/qwen-code/pull/14403)) by @wenshao
- test(managed-agent): add the FG8c process-crash gates for monitor_run and background shells (#14163) ([#14407](https://github.com/QwenLM/qwen-code/pull/14407)) by @wenshao
- test(managed-agent): ground the FG8a/FG8b/FG8d gate choreography in Linux truth ([#14398](https://github.com/QwenLM/qwen-code/pull/14398)) by @wenshao
- test(managed-agent): keep the harness daemon log in Hosted shell lifecycle evidence ([#14401](https://github.com/QwenLM/qwen-code/pull/14401)) by @yiliang114
- test(serve): widen the Hosted Harness idle wait on loaded runners ([#14394](https://github.com/QwenLM/qwen-code/pull/14394)) by @yiliang114
- test(managed-agent): give FG8d Sessions a 10 s writer lease so drain-release gets a capture slot ([#14425](https://github.com/QwenLM/qwen-code/pull/14425)) by @wenshao
- test(managed-agent): add the FG10a workflow child_run digest-integrity fault gate (#14165) ([#14390](https://github.com/QwenLM/qwen-code/pull/14390)) by @wenshao
- test(managed-agent): add the FG9b/FG9c session relay store-failure and crash fault gates (#14164) ([#14420](https://github.com/QwenLM/qwen-code/pull/14420)) by @wenshao
- test(sdk-java): read the heartbeat scheduler queue on its own thread ([#14427](https://github.com/QwenLM/qwen-code/pull/14427)) by @yiliang114
- refactor(integration-tests): extract the shared helpers duplicated across the hosted gate drivers (#14147) ([#14439](https://github.com/QwenLM/qwen-code/pull/14439)) by @wenshao
- test(managed-agent): pin the read-profile Session's serve wiring (#13905 items 41-44) ([#14459](https://github.com/QwenLM/qwen-code/pull/14459)) by @wenshao
- test(managed-agent): add the FG10b/FG10f workflow relay lost-reply and delivery fault gates (#14165) ([#14468](https://github.com/QwenLM/qwen-code/pull/14468)) by @wenshao
- test(managed-agent): add the FG10c/FG10e workflow relay store-failure and cancellation fault gates (#14165) ([#14473](https://github.com/QwenLM/qwen-code/pull/14473)) by @wenshao
- ci(sdk-java): run the Hosted failover arms in their own job ([#14467](https://github.com/QwenLM/qwen-code/pull/14467)) by @wenshao
- test(managed-agent): pin that reconcile_run leaves a live wake turn's run alone ([#14480](https://github.com/QwenLM/qwen-code/pull/14480)) by @wenshao
- test(managed-agent): add the FG12a MCP reply-loss fault gates (#14447) ([#14499](https://github.com/QwenLM/qwen-code/pull/14499)) by @wenshao
- test(managed-agent): hold every Hosted IT class to the shared fork budget (#14148) ([#14521](https://github.com/QwenLM/qwen-code/pull/14521)) by @wenshao
- test(managed-agent): add the FG13c Hook owner-restart fault gates (#14449) ([#14490](https://github.com/QwenLM/qwen-code/pull/14490)) by @wenshao
- test(managed-agent): add the FG12c MCP restart fault gates (#14447) ([#14524](https://github.com/QwenLM/qwen-code/pull/14524)) by @wenshao
- test(managed-agent): add the FG13d Hook cancel and timeout fault gates ([#14533](https://github.com/QwenLM/qwen-code/pull/14533)) by @wenshao
- test(managed-agent): drive the FG12c configure recovery past running (#14447) ([#14535](https://github.com/QwenLM/qwen-code/pull/14535)) by @wenshao
- test(managed-agent): add the FG11a automation lost-reply fault gates (#14446) ([#14534](https://github.com/QwenLM/qwen-code/pull/14534)) by @wenshao
- test(managed-agent): pin the reconcile_run route's own crash repair ([#14529](https://github.com/QwenLM/qwen-code/pull/14529)) by @wenshao
- test(managed-agent): add the FG13d stopped-worker cancel gate ([#14541](https://github.com/QwenLM/qwen-code/pull/14541)) by @wenshao
- test(managed-agent): add the FG12d MCP release fault gate (#14447) ([#14549](https://github.com/QwenLM/qwen-code/pull/14549)) by @wenshao
- test(managed-agent): cover workspace-change request validation ([#14525](https://github.com/QwenLM/qwen-code/pull/14525)) by @wenshao
- test(core): witness the sealed Managed commit-proof clause ([#14514](https://github.com/QwenLM/qwen-code/pull/14514)) by @yiliang114
- test(managed-agent): add the FG11b Spring-side automation store-fault gates (#14446) ([#14551](https://github.com/QwenLM/qwen-code/pull/14551)) by @wenshao
- test(managed-agent): keep a workspace-scope permission change out of a worktree session ([#14554](https://github.com/QwenLM/qwen-code/pull/14554)) by @wenshao
- test(managed-agent): fix the FG12d post-merge evidence and ledger P3s ([#14553](https://github.com/QwenLM/qwen-code/pull/14553)) by @wenshao
- refactor(web-shell): drop the input-history nav state nothing consumed ([#14543](https://github.com/QwenLM/qwen-code/pull/14543)) by @yiliang114
- test(managed-agent): add the FG11b Harness-side automation store-fault gates (#14446) ([#14564](https://github.com/QwenLM/qwen-code/pull/14564)) by @wenshao
- test(managed-agent): drop the FG13d hook-cancel reply through a broker proxy ([#14555](https://github.com/QwenLM/qwen-code/pull/14555)) by @wenshao
- test(managed-agent): add FG12b Hosted MCP store fault gates ([#14569](https://github.com/QwenLM/qwen-code/pull/14569)) by @wenshao
- test(managed-agent): add the FG12f MCP stream-gap gates ([#14592](https://github.com/QwenLM/qwen-code/pull/14592)) by @wenshao
- test(managed-agent): drop the FG13a hook-execute reply through the broker proxy ([#14556](https://github.com/QwenLM/qwen-code/pull/14556)) by @wenshao
- test(managed-agent): add the FG11c Harness-crash fault gates (#14446) ([#14601](https://github.com/QwenLM/qwen-code/pull/14601)) by @wenshao
- test(managed-agent): witness the FG12d release ordering (#14447) ([#14624](https://github.com/QwenLM/qwen-code/pull/14624)) by @wenshao

### New Contributors

- @x-lixu made their first contribution in [#8630](https://github.com/QwenLM/qwen-code/pull/8630)
- @walidboulanouar made their first contribution in [#13999](https://github.com/QwenLM/qwen-code/pull/13999)
- @cenab made their first contribution in [#14445](https://github.com/QwenLM/qwen-code/pull/14445)
- @4ekuct25 made their first contribution in [#13676](https://github.com/QwenLM/qwen-code/pull/13676)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.25.2...v0.25.3

## [0.25.2](https://github.com/QwenLM/qwen-code/releases/tag/v0.25.2) - 2026-10-15

### Highlights

_See the complete change list below._

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- feat(managed-agent): H4e-b2 the lead's mailbox over Session messages ([#13892](https://github.com/QwenLM/qwen-code/pull/13892)) by @wenshao
- A new private extension imports Vitest 3.2 JSON reports and exposes failures, errors, counts, and diagnostics through MCP tools with search and pagination. ([#13854](https://github.com/QwenLM/qwen-code/pull/13854)) by @qqqys
- Opt-in headless Mods now support TypeScript authoring, relative imports, typed non-secret configuration, and dependency validation before startup. ([#13890](https://github.com/QwenLM/qwen-code/pull/13890)) by @qqqys
- Adds a default-off option allowing authorized public REST and WebShell sessions to use foreground Shell with mandatory approval. ([#13674](https://github.com/QwenLM/qwen-code/pull/13674)) by @doudouOUC
- feat(managed-agent): Introduce the EventTransport seam behind the after-commit publisher ([#13909](https://github.com/QwenLM/qwen-code/pull/13909)) by @wenshao
- feat(managed-agent): Stop Hosted team members with request_shutdown (H4e-b3a) ([#13923](https://github.com/QwenLM/qwen-code/pull/13923)) by @wenshao
- Opt-in headless Mod runtime gains ordered middleware dispatch, command interception, and bounded failure recovery without resetting module state. ([#13915](https://github.com/QwenLM/qwen-code/pull/13915)) by @qqqys
- Adds a Test Failure Explorer app that lets users browse, search, page through, and copy analysis requests for up to 20 selected test failures. ([#13916](https://github.com/QwenLM/qwen-code/pull/13916)) by @qqqys
- Enables H3 Monitor and background Shell capabilities, allowing background runs to outlive their turn and output artifacts. ([#13889](https://github.com/QwenLM/qwen-code/pull/13889)) by @wenshao
- Adds a Java mirror of the managed-event-envelope contract with derivation, validation, deduplication, and fixture tests, without changing runtime behavior. ([#13940](https://github.com/QwenLM/qwen-code/pull/13940)) by @wenshao
- Adds a selection menu to completed Web Shell assistant replies with Copy plain text and Copy Markdown actions while preserving selected formatting. ([#13833](https://github.com/QwenLM/qwen-code/pull/13833)) by @ytahdn
- Adds Web Shell task reminders for tool approval or AskUserQuestion answers, with notification controls, authorization prompts, and in-panel help. ([#13832](https://github.com/QwenLM/qwen-code/pull/13832)) by @ytahdn
- Enables opt-in Mods in trusted headless main sessions to intercept tool calls, rewrite arguments, refuse calls, return synthetic results, and check permissions. ([#13950](https://github.com/QwenLM/qwen-code/pull/13950)) by @qqqys
- feat(managed-agent): verify tool publications asynchronously ([#13654](https://github.com/QwenLM/qwen-code/pull/13654)) by @doudouOUC
- feat(web-shell): add Managed child Agent task panel ([#13936](https://github.com/QwenLM/qwen-code/pull/13936)) by @doudouOUC
- feat(managed-agent): recover Hosted G3 parked turns ([#13777](https://github.com/QwenLM/qwen-code/pull/13777)) by @doudouOUC
- feat(runtime): add private CSI file worker with local-process isolation ([#13899](https://github.com/QwenLM/qwen-code/pull/13899)) by @doudouOUC
- feat(managed-agent): member board tools ride the session_command channel end to end (H4e-b3b) ([#13928](https://github.com/QwenLM/qwen-code/pull/13928)) by @wenshao
- feat(web-shell): add read-only Excel artifact previews ([#13664](https://github.com/QwenLM/qwen-code/pull/13664)) by @ytahdn
- feat(managed-agent): H4 workflow child runtime ([#13858](https://github.com/QwenLM/qwen-code/pull/13858)) by @wenshao
- feat(managed-agent): member-to-member messages ride the session_command channel (H4e-b3c) ([#13955](https://github.com/QwenLM/qwen-code/pull/13955)) by @wenshao
- feat(managed-agent): give a Monitor auto-stop its remote exit evidence (#13896) ([#13929](https://github.com/QwenLM/qwen-code/pull/13929)) by @wenshao
- feat(web-shell): Reuse standard UI for Managed Agents ([#13973](https://github.com/QwenLM/qwen-code/pull/13973)) by @doudouOUC
- feat(managed-agent): add L4 Shell and MCP session lifecycle ([#13931](https://github.com/QwenLM/qwen-code/pull/13931)) by @doudouOUC
- feat(core): add a convergence reminder for read-only exploration ([#13601](https://github.com/QwenLM/qwen-code/pull/13601)) by @yiliang114
- feat(cli): add repeatable --disable-mcp-server to exclude servers per invocation ([#14003](https://github.com/QwenLM/qwen-code/pull/14003)) by @yiliang114
- feat(web-shell): Add workspace file browser and previews ([#13878](https://github.com/QwenLM/qwen-code/pull/13878)) by @ytahdn
- feat(managed-agent): add durable team plan approval (H4e-b3d) ([#13974](https://github.com/QwenLM/qwen-code/pull/13974)) by @wenshao
- feat(managed-agent): Add the LiteTopic journal-event transport (MQ2b) ([#14029](https://github.com/QwenLM/qwen-code/pull/14029)) by @wenshao
- feat(web-shell): bridge trajectory history and live lifecycle state ([#13952](https://github.com/QwenLM/qwen-code/pull/13952)) by @qqqys
- feat(web-shell): pulse the header environment entry while tasks run ([#14048](https://github.com/QwenLM/qwen-code/pull/14048)) by @ytahdn
- feat(web-shell,desktop): update Qwen Code logo to the current brand mark ([#14052](https://github.com/QwenLM/qwen-code/pull/14052)) by @pomelo-nwu
- feat(managed-agent): Add the public-event transport and the wake/materialization consumers (MQ2c) ([#14080](https://github.com/QwenLM/qwen-code/pull/14080)) by @wenshao
- feat(managed-agent): consolidate persistence into a 32-table baseline ([#14069](https://github.com/QwenLM/qwen-code/pull/14069)) by @doudouOUC
- feat(web-shell): open context details in the side panel from the ring ([#14086](https://github.com/QwenLM/qwen-code/pull/14086)) by @pomelo-nwu
- feat(runtime-broker): add bounded retention for terminal JDBC history ([#13642](https://github.com/QwenLM/qwen-code/pull/13642)) by @doudouOUC
- feat(web-shell): review MCP App messages before submission (PR3a) ([#13958](https://github.com/QwenLM/qwen-code/pull/13958)) by @qqqys
- feat(managed-agent): H4f public task cancel for workflow tasks ([#14076](https://github.com/QwenLM/qwen-code/pull/14076)) by @wenshao
- feat(mods): support selected Claude tool input contracts (PR3b) ([#14027](https://github.com/QwenLM/qwen-code/pull/14027)) by @qqqys
- feat(sdk-java): add private CSI Session and native SQL authority ([#13996](https://github.com/QwenLM/qwen-code/pull/13996)) by @doudouOUC
- feat(managed-agent): publish an experimental reference distribution ([#14176](https://github.com/QwenLM/qwen-code/pull/14176)) by @yiliang114
- feat(web-shell): show a reduced header on the new-task page ([#14159](https://github.com/QwenLM/qwen-code/pull/14159)) by @ytahdn
- feat(web-shell): upload files by dropping into the file tree ([#14145](https://github.com/QwenLM/qwen-code/pull/14145)) by @ytahdn
- feat(web-shell): open workflow agents in the detail panel ([#14175](https://github.com/QwenLM/qwen-code/pull/14175)) by @qqqys

#### Bug Fixes

- Runtime Broker now rejects closed or deleted managed-agent sessions with a non-retryable error, and closed Hosted Harness connectors fail immediately. ([#13330](https://github.com/QwenLM/qwen-code/pull/13330)) by @wenshao
- Child worktree runs now settle correctly after merges and stopped runs discard their worktrees, preventing stale workspace state. ([#13872](https://github.com/QwenLM/qwen-code/pull/13872)) by @wenshao
- Monitor admission and initial-call startup failures are now classified tool errors with full guidance instead of false success. ([#13460](https://github.com/QwenLM/qwen-code/pull/13460)) by @GoldArowana
- CLI now strips a leading UTF-8 BOM when reading MCP configuration files, including project .mcp.json and --mcp-config file input. ([#13596](https://github.com/QwenLM/qwen-code/pull/13596)) by @Bug-killer-prog
- Uses the server-reported context limit when retrying after a context-overflow rejection, making reactive compaction recover requests more reliably. ([#13788](https://github.com/QwenLM/qwen-code/pull/13788)) by @yiliang114
- Fixes a hang when closing Hosted event streams and canceling managed-agent tasks after a Hosted Harness restart, so cancellation completes promptly. ([#13877](https://github.com/QwenLM/qwen-code/pull/13877)) by @wenshao
- Improves CI routing and safety for the SDK Java MariaDB test lane on trusted triggers. ([#13627](https://github.com/QwenLM/qwen-code/pull/13627)) by @qwen-code-dev-bot
- Allows idle local managed-agent workspace sessions with original command Hooks to finish retirement after Broker restart, worker exit, or reboot. ([#13673](https://github.com/QwenLM/qwen-code/pull/13673)) by @doudouOUC
- Makes Claude MCP config import tolerate a leading UTF-8 BOM so configs saved by Windows editors can be imported. ([#13711](https://github.com/QwenLM/qwen-code/pull/13711)) by @Bug-killer-prog
- fix(managed-agent): e2e runner and image robustness from the #12692 R2 review ([#13344](https://github.com/QwenLM/qwen-code/pull/13344)) by @wenshao
- fix(managed-agent): return 404 for unknown tool publications ([#13602](https://github.com/QwenLM/qwen-code/pull/13602)) by @ZedingZhang
- fix(serve): name Hosted recovery-refusal branches in cold-load 409s ([#13276](https://github.com/QwenLM/qwen-code/pull/13276)) by @wenshao
- fix(cli): bound managed function-hook module evaluation and keep hold-fenced owners recoverable ([#13243](https://github.com/QwenLM/qwen-code/pull/13243)) by @wenshao
- Fixes a managed-agent publication issue by ensuring placement is selected before retention, quota, and session writer locks. ([#13894](https://github.com/QwenLM/qwen-code/pull/13894)) by @doudouOUC
- fix(managed-agent): settle provably never-started dispatches at session open (#13801) ([#13917](https://github.com/QwenLM/qwen-code/pull/13917)) by @wenshao
- Fixes /review Test Plan checks to correctly parse comma-grouped test counts such as 2,239 passed. ([#13881](https://github.com/QwenLM/qwen-code/pull/13881)) by @wenshao
- Fixes managed-agent config and API behavior with input-size aggregate limits, removed dead config, corrected defaults, and better duration handling. ([#13335](https://github.com/QwenLM/qwen-code/pull/13335)) by @wenshao
- Localizes Web Shell voice dictation feedback in English and Simplified Chinese, adds dismissible error and no-speech messages, and restores the microphone for retry. ([#13938](https://github.com/QwenLM/qwen-code/pull/13938)) by @ytahdn
- Repairs CLI CI tests by draining wake park before teardown and restoring shell gate guard expectations. ([#13959](https://github.com/QwenLM/qwen-code/pull/13959)) by @qwen-code-dev-bot
- fix(lsp): load .lsp.json files saved with a UTF-8 BOM ([#13946](https://github.com/QwenLM/qwen-code/pull/13946)) by @Shizoqua
- fix(desktop): preserve bundled runtime integrity in AppImage ([#13695](https://github.com/QwenLM/qwen-code/pull/13695)) by @hahahahahayesyeseys
- fix(release): anchor desktop release notes at the previous desktop release ([#13960](https://github.com/QwenLM/qwen-code/pull/13960)) by @Jay0130-a
- test(web-shell): re-measure the transcript entry ceiling (#13982) ([#13985](https://github.com/QwenLM/qwen-code/pull/13985)) by @qwen-code-dev-bot
- fix(cli): report a spawn failure of the CLI child instead of exiting silently ([#13077](https://github.com/QwenLM/qwen-code/pull/13077)) by @drakeo338
- fix(ci): double the sdk-java MariaDB lane's per-host lock budget (#13989) ([#13991](https://github.com/QwenLM/qwen-code/pull/13991)) by @qwen-code-dev-bot
- fix(cli): drop the stale gate-close from the restored-shell-gate test ([#13983](https://github.com/QwenLM/qwen-code/pull/13983)) by @yiliang114
- fix(core): clean the folded cause before getErrorMessage caps the retained subagent error text ([#14008](https://github.com/QwenLM/qwen-code/pull/14008)) by @yiliang114
- fix(cli): load TOML custom commands saved with a UTF-8 BOM ([#13945](https://github.com/QwenLM/qwen-code/pull/13945)) by @Shizoqua
- fix(ci): recover reused runner checkouts and Java lock waits ([#14017](https://github.com/QwenLM/qwen-code/pull/14017)) by @yiliang114
- fix(core): strip a leading BOM before converting a TOML command ([#13975](https://github.com/QwenLM/qwen-code/pull/13975)) by @Bug-killer-prog
- fix(cli): give bare ↑/↓ back to input history in Virtualized History ([#14016](https://github.com/QwenLM/qwen-code/pull/14016)) by @chiga0
- fix(web-shell): hide the discontinued built-in OAuth model in Settings ([#13971](https://github.com/QwenLM/qwen-code/pull/13971)) by @Bug-killer-prog
- fix(cli): window the OpenTUI transcript to fix the blank-screen resume ([#13669](https://github.com/QwenLM/qwen-code/pull/13669)) by @chiga0
- fix(cli): keep the OpenTUI composer caret steady ([#13693](https://github.com/QwenLM/qwen-code/pull/13693)) by @chiga0
- fix(managed-agent): share title blankness and pin the lease-renewal clamp ([#13979](https://github.com/QwenLM/qwen-code/pull/13979)) by @yiliang114
- fix(managed-agent): count http/function result Hooks at child admission ([#13978](https://github.com/QwenLM/qwen-code/pull/13978)) by @yiliang114
- fix(cli): stop OpenTUI slash commands reading their own dispatch as busy ([#12960](https://github.com/QwenLM/qwen-code/pull/12960)) by @MohammedAlkindi
- fix(cli): recognize markdown fences only on matching lines ([#13331](https://github.com/QwenLM/qwen-code/pull/13331)) by @GoldArowana
- fix(sdk): strip terminal escapes from plaintext tool previews ([#12751](https://github.com/QwenLM/qwen-code/pull/12751)) by @sxh313
- fix(cli): split comma-separated --include-tools/--exclude-tools in mcp add ([#12985](https://github.com/QwenLM/qwen-code/pull/12985)) by @yanyukang2003-ux
- fix(web-shell): Ignore standalone whitespace assistant chunks ([#14031](https://github.com/QwenLM/qwen-code/pull/14031)) by @ytahdn
- fix(managed-agent): order a sender's commands by commit sequence, and make the member restart IT interrupt a live wait ([#14014](https://github.com/QwenLM/qwen-code/pull/14014)) by @wenshao
- fix(desktop): let Web Shell receive OS file drops ([#14053](https://github.com/QwenLM/qwen-code/pull/14053)) by @pomelo-nwu
- fix(managed-agent): numeric parity and family-list hoisting for publication families, with end-to-end admission and wedge witnesses ([#13815](https://github.com/QwenLM/qwen-code/pull/13815)) by @wenshao
- fix(cli): reject batch plan targets that alias the same path ([#14055](https://github.com/QwenLM/qwen-code/pull/14055)) by @yiliang114
- fix(managed-agent): close shell profiles after native file calls ([#14045](https://github.com/QwenLM/qwen-code/pull/14045)) by @doudouOUC
- fix(managed-agent): recover lost lifecycle detach replies ([#14039](https://github.com/QwenLM/qwen-code/pull/14039)) by @doudouOUC
- fix(serve): resume committed file results after runtime retirement ([#14059](https://github.com/QwenLM/qwen-code/pull/14059)) by @doudouOUC
- fix(release): raise the npm package unpacked-size budget to 160 MiB ([#14066](https://github.com/QwenLM/qwen-code/pull/14066)) by @qwen-code-dev-bot
- test(managed-agent): widen process-death observation windows in the operator recovery probe (#14072) ([#14079](https://github.com/QwenLM/qwen-code/pull/14079)) by @qwen-code-dev-bot
- fix(managed-agent): passively reattach child relay sessions after control-plane restart ([#14020](https://github.com/QwenLM/qwen-code/pull/14020)) by @yiliang114
- fix(desktop): keep desktop-latest release notes pointing at the current release ([#13900](https://github.com/QwenLM/qwen-code/pull/13900)) by @shpaker
- test(managed-agent): handle the procfs exit race in the operator recovery probe ([#14090](https://github.com/QwenLM/qwen-code/pull/14090)) by @wenshao
- test(serve): widen hosted approval inline-limit windows for CI contention (#14084) ([#14091](https://github.com/QwenLM/qwen-code/pull/14091)) by @qwen-code-dev-bot
- fix(ci): raise the Hosted MySQL fork and step budgets past the L4 class (#14125) ([#14128](https://github.com/QwenLM/qwen-code/pull/14128)) by @qwen-code-dev-bot
- test(managed-agent): Pin the history response size boundary ([#14111](https://github.com/QwenLM/qwen-code/pull/14111)) by @loglapa
- fix(cli): bound short OpenTUI scroll dialogs (MYWO-3, MYWO-7) ([#14034](https://github.com/QwenLM/qwen-code/pull/14034)) by @chiga0
- fix(managed-agent): Repair the Hosted storage-guard fixtures red since #14069 ([#14131](https://github.com/QwenLM/qwen-code/pull/14131)) by @yiliang114
- fix(acp): preserve cancellation intent across session recovery ([#13436](https://github.com/QwenLM/qwen-code/pull/13436)) by @yiliang114
- test(managed-agent): register storage for Hosted admission gates ([#14154](https://github.com/QwenLM/qwen-code/pull/14154)) by @yiliang114
- test(managed-agent): stabilize retraction snapshot verification ([#14151](https://github.com/QwenLM/qwen-code/pull/14151)) by @yiliang114
- fix(managed-agent): settle journal-only parked Harness turns on takeover (#13847) ([#14078](https://github.com/QwenLM/qwen-code/pull/14078)) by @wenshao
- test(managed-agent): wait for the published Snapshot before naming its Items ([#14156](https://github.com/QwenLM/qwen-code/pull/14156)) by @yiliang114
- fix(managed-agent): Wire OSS capture budgets into Hosted sessions ([#14124](https://github.com/QwenLM/qwen-code/pull/14124)) by @doudouOUC
- test(managed-agent): cover coordinator-only Hosted restart ([#14155](https://github.com/QwenLM/qwen-code/pull/14155)) by @yiliang114
- fix(build): re-apply the ink patch when install skipped lifecycle scripts ([#14170](https://github.com/QwenLM/qwen-code/pull/14170)) by @yiliang114
- fix(cli): preserve Unicode queries in at completion ([#13866](https://github.com/QwenLM/qwen-code/pull/13866)) by @dakjdakd
- fix(sdk-python): resolve Windows command shims on the effective PATH ([#13862](https://github.com/QwenLM/qwen-code/pull/13862)) by @dakjdakd
- fix(cli): gate non-interactive /update installs on enableAutoUpdate ([#13665](https://github.com/QwenLM/qwen-code/pull/13665)) by @fengyue-xve
- fix(core): preserve fuzzy edit line boundaries ([#13484](https://github.com/QwenLM/qwen-code/pull/13484)) by @GoldArowana
- fix(sdk): release reconnect transports created after disposal ([#13864](https://github.com/QwenLM/qwen-code/pull/13864)) by @dakjdakd
- fix(sdk-java): get the MariaDB lane past #13996's schema, recovery IT and baseline witness ([#14177](https://github.com/QwenLM/qwen-code/pull/14177)) by @wenshao
- fix(core): resolve ${CLAUDE_PLUGIN_ROOT} in plugin markdown without hooks ([#14194](https://github.com/QwenLM/qwen-code/pull/14194)) by @yiliang114
- fix(ci): repair Java backlog and schema/Hosted test failures ([#14178](https://github.com/QwenLM/qwen-code/pull/14178)) by @yiliang114
- fix(ci): re-pin Java gate CI tests to the daily-trigger shape (#14223) ([#14227](https://github.com/QwenLM/qwen-code/pull/14227)) by @qwen-code-dev-bot
- fix(sdk-java): restore session-root materialization in acquireWriter (#14224) ([#14228](https://github.com/QwenLM/qwen-code/pull/14228)) by @qwen-code-dev-bot
- fix(core): keep Artifact guidance out of record_artifact description ([#14206](https://github.com/QwenLM/qwen-code/pull/14206)) by @zjgzx1988
- fix(managed-agent): settle the monitor loop when its resume finds a settled record ([#14074](https://github.com/QwenLM/qwen-code/pull/14074)) by @wenshao
- fix(ci): repair daily failure reporting and contract guards ([#14238](https://github.com/QwenLM/qwen-code/pull/14238)) by @yiliang114
- fix(ci): repin the sdk-java test job's MAVEN_ARGS count for the checkstyle gate (#14247) ([#14258](https://github.com/QwenLM/qwen-code/pull/14258)) by @qwen-code-dev-bot
- fix(sdk-java): Order the MQ3 gate's imports for the new checkstyle rules ([#14253](https://github.com/QwenLM/qwen-code/pull/14253)) by @wenshao
- fix(core): select the DashScope provider for Model Studio workspace domains ([#14245](https://github.com/QwenLM/qwen-code/pull/14245)) by @qqqys
- fix(managed-agent): close the critical R2 review findings on #12692 ([#13325](https://github.com/QwenLM/qwen-code/pull/13325)) by @wenshao
- fix(core): surface the provider request id on bodyless API errors ([#14133](https://github.com/QwenLM/qwen-code/pull/14133)) by @yiliang114
- fix(managed-agent): hand one run's session messages over in send order ([#14235](https://github.com/QwenLM/qwen-code/pull/14235)) by @wenshao
- fix(Managed agent): settle never-started background dispatches in the live turn ([#14021](https://github.com/QwenLM/qwen-code/pull/14021)) by @yiliang114
- fix(core): keep the git snapshot out of the system prompt ([#14255](https://github.com/QwenLM/qwen-code/pull/14255)) by @qqqys
- fix(ci): gate Desktop and Java SDK releases on checks of the release commit ([#14259](https://github.com/QwenLM/qwen-code/pull/14259)) by @yiliang114
- fix(serve): align Hosted team delivery answers ([#14267](https://github.com/QwenLM/qwen-code/pull/14267)) by @yiliang114
- fix(ci): drain Hosted test turns and repair nightly browser checks ([#14275](https://github.com/QwenLM/qwen-code/pull/14275)) by @yiliang114
- fix(cli): close post-merge takeover findings from the #13083 review ([#13188](https://github.com/QwenLM/qwen-code/pull/13188)) by @wenshao
- fix(vscode): move conversation payloads out of globalState ([#14285](https://github.com/QwenLM/qwen-code/pull/14285)) by @yiliang114

#### Documentation

- Adds design documentation for managed-agent team member commands, plan approval, and shutdown on the Hosted path. ([#13912](https://github.com/QwenLM/qwen-code/pull/13912)) by @wenshao
- docs(managed-agent): Resolve the EventTransport §5.1 LiteTopic verification ledger ([#13927](https://github.com/QwenLM/qwen-code/pull/13927)) by @wenshao
- docs(managed-agent): Resolve the EventTransport §11 routing and wake-carrier questions ([#13933](https://github.com/QwenLM/qwen-code/pull/13933)) by @wenshao
- Adds documentation planning the EventTransport MQ2 Java producer/consumer wiring into four independently reviewable sub-slices. ([#13939](https://github.com/QwenLM/qwen-code/pull/13939)) by @wenshao
- docs(sdk): clarify empty core-tool allowlists across SDKs ([#13949](https://github.com/QwenLM/qwen-code/pull/13949)) by @Zhangchenhao-111
- docs: record local tool visibility comparison and verification steps ([#13767](https://github.com/QwenLM/qwen-code/pull/13767)) by @yiliang114
- docs(readme): simplify evaluation overview and refine trend chart ([#14093](https://github.com/QwenLM/qwen-code/pull/14093)) by @pomelo-nwu
- docs(cli): stop naming Terminal.app in the arrowKeysScrollTranscript description ([#14092](https://github.com/QwenLM/qwen-code/pull/14092)) by @yiliang114
- docs(runtime-broker): design Workspace-resident Managed Tool Runtime ([#14214](https://github.com/QwenLM/qwen-code/pull/14214)) by @doudouOUC
- docs: remind to update workflow meta-tests when changing CI workflows ([#14239](https://github.com/QwenLM/qwen-code/pull/14239)) by @yiliang114
- docs(design): drop stray conflict markers from the actor-roles design ([#14270](https://github.com/QwenLM/qwen-code/pull/14270)) by @doudouOUC

#### Internal Changes

- Adds internal FG7 fault-gate tests that verify managed-agent channel behavior during control-plane and provider failures. ([#13839](https://github.com/QwenLM/qwen-code/pull/13839)) by @wenshao
- Improves test stability for child-Workspace Git layout validation by avoiding a possible directory-name collision. ([#13844](https://github.com/QwenLM/qwen-code/pull/13844)) by @qwen-code-dev-bot
- test(integration): sync the updatedInput ask approval on the dialog, not the tool row (#13849) ([#13855](https://github.com/QwenLM/qwen-code/pull/13855)) by @qwen-code-dev-bot
- Raises the Web Shell transcript entry size ceiling after selection-copy strings increased bundle size, with no production behavior change. ([#13964](https://github.com/QwenLM/qwen-code/pull/13964)) by @qwen-code-dev-bot
- test(runtime-broker): budget the 1 MiB tool round trips past the request deadline ([#13990](https://github.com/QwenLM/qwen-code/pull/13990)) by @yiliang114
- test(managed-agent): clean up recovery fixtures after probe failures ([#14018](https://github.com/QwenLM/qwen-code/pull/14018)) by @yiliang114
- test(managed-agent): stabilize publication and API contract fixtures ([#14012](https://github.com/QwenLM/qwen-code/pull/14012)) by @yiliang114
- test(managed-agent): land the deferred findings from the definition-execution review ([#13980](https://github.com/QwenLM/qwen-code/pull/13980)) by @yiliang114
- test(core): cover unfinished invocation guard before turn reclamation ([#13257](https://github.com/QwenLM/qwen-code/pull/13257)) by @jayfeng7
- refactor(core): one record/array gate for file-history snapshot payloads ([#13981](https://github.com/QwenLM/qwen-code/pull/13981)) by @yiliang114
- test(managed-agent): deflake the transient verification retry rescan (#14037) ([#14042](https://github.com/QwenLM/qwen-code/pull/14042)) by @qwen-code-dev-bot
- Add SerpApi to web search MCP services list ([#13104](https://github.com/QwenLM/qwen-code/pull/13104)) by @pulkitchowdry
- test(managed-agent): fix the shell lifecycle recovery journal-head assertions (#14103) ([#14108](https://github.com/QwenLM/qwen-code/pull/14108)) by @qwen-code-dev-bot
- test(serve): widen hosted recovery waitFor windows for CI contention (#14101) ([#14107](https://github.com/QwenLM/qwen-code/pull/14107)) by @qwen-code-dev-bot
- test(managed-agent): Run the EventTransport fault rows against a real RocketMQ broker (MQ2d) ([#14109](https://github.com/QwenLM/qwen-code/pull/14109)) by @wenshao
- test(integration): Cover a completing write_file tool call over ACP ([#14144](https://github.com/QwenLM/qwen-code/pull/14144)) by @yiliang114
- test(managed-agent): retry the team-lead hosted boot past the free-port race ([#14153](https://github.com/QwenLM/qwen-code/pull/14153)) by @yiliang114
- refactor(core): give the Code Mode tool-result stamp a single owner ([#13666](https://github.com/QwenLM/qwen-code/pull/13666)) by @fengyue-xve
- test(ci): pin the main-failure watcher's whole job condition ([#14233](https://github.com/QwenLM/qwen-code/pull/14233)) by @wenshao
- chore: adopt qwen-code-checks.xml and fix all checkstyle violations ([#14186](https://github.com/QwenLM/qwen-code/pull/14186)) by @doudouOUC
- test(managed-agent): Run the EventTransport fault matrix against two nodes (MQ3) ([#14242](https://github.com/QwenLM/qwen-code/pull/14242)) by @wenshao
- test(cli): skip the chmod-based tests where permission bits do not bind ([#14162](https://github.com/QwenLM/qwen-code/pull/14162)) by @wenshao
- refactor(runtime-broker): name the local-process kind and Workspace isolation policy ([#14254](https://github.com/QwenLM/qwen-code/pull/14254)) by @doudouOUC
- test(managed-agent): gate G3 Step 3 recovery, model-round takeover and control-plane fencing ([#14181](https://github.com/QwenLM/qwen-code/pull/14181)) by @wenshao
- diagnostics(ci): capture RocketMQ latency stages separately ([#14241](https://github.com/QwenLM/qwen-code/pull/14241)) by @yiliang114
- refactor(managed-agent): Reuse Apache Commons utilities ([#14280](https://github.com/QwenLM/qwen-code/pull/14280)) by @doudouOUC

### New Contributors

- @ZedingZhang made their first contribution in [#13602](https://github.com/QwenLM/qwen-code/pull/13602)
- @Zhangchenhao-111 made their first contribution in [#13949](https://github.com/QwenLM/qwen-code/pull/13949)
- @hahahahahayesyeseys made their first contribution in [#13695](https://github.com/QwenLM/qwen-code/pull/13695)
- @Jay0130-a made their first contribution in [#13960](https://github.com/QwenLM/qwen-code/pull/13960)
- @drakeo338 made their first contribution in [#13077](https://github.com/QwenLM/qwen-code/pull/13077)
- @MohammedAlkindi made their first contribution in [#12960](https://github.com/QwenLM/qwen-code/pull/12960)
- @jayfeng7 made their first contribution in [#13257](https://github.com/QwenLM/qwen-code/pull/13257)
- @yanyukang2003-ux made their first contribution in [#12985](https://github.com/QwenLM/qwen-code/pull/12985)
- @shpaker made their first contribution in [#13900](https://github.com/QwenLM/qwen-code/pull/13900)
- @pulkitchowdry made their first contribution in [#13104](https://github.com/QwenLM/qwen-code/pull/13104)
- @loglapa made their first contribution in [#14111](https://github.com/QwenLM/qwen-code/pull/14111)
- @dakjdakd made their first contribution in [#13866](https://github.com/QwenLM/qwen-code/pull/13866)
- @fengyue-xve made their first contribution in [#13665](https://github.com/QwenLM/qwen-code/pull/13665)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.25.1...v0.25.2

## [0.25.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.25.1) - 2026-10-11

### Highlights

_See the complete change list below._

### Breaking Changes

No known breaking changes.

### Complete Change List

#### Features

- Restores the selected text-only connection and validated session or workspace route after Android Activity recreation, while preserving explicit retry screens after failures. ([#12247](https://github.com/QwenLM/qwen-code/pull/12247)) by @jabrailkhalil
- Improves mobile profile screen accessibility with clearer connection actions, editor labels, validation announcements, and scrollable storage recovery. ([#12129](https://github.com/QwenLM/qwen-code/pull/12129)) by @jabrailkhalil
- Adds an experimental Kubernetes CSI-backed runtime that validates workspaces, persists pod identity, and records durable worker acknowledgements for managed sessions. ([#13289](https://github.com/QwenLM/qwen-code/pull/13289)) by @doudouOUC
- Adds background Shell and Monitor capabilities to the Managed Agent runtime, enabling durable background shell sessions and task event reporting. ([#13265](https://github.com/QwenLM/qwen-code/pull/13265)) by @wenshao
- Web Shell /btw side can now create independent side-task conversations in a parent session's secondary workspace, including while the parent is responding. ([#13468](https://github.com/QwenLM/qwen-code/pull/13468)) by @wenshao
- Agent and Goal coordination tools are now deferred by default and discovered on demand, reducing unnecessary tool declarations in ordinary tool-call sessions. ([#13033](https://github.com/QwenLM/qwen-code/pull/13033)) by @yiliang114
- Local Managed Agent runtime tool outcomes are now durably recorded, including parameters, receipts, and checkpoints, before results are returned to the model. ([#13291](https://github.com/QwenLM/qwen-code/pull/13291)) by @wenshao
- Hosted approval requests can now include bounded previews of file and shell input, exposed through public and WebShell APIs with truncation metadata. ([#13400](https://github.com/QwenLM/qwen-code/pull/13400)) by @yiliang114
- Lets creators change a Workspace-bound Managed Session's working directory through a durable, idempotent operation. ([#13247](https://github.com/QwenLM/qwen-code/pull/13247)) by @wenshao
- Adds read-only glob file discovery to Hosted Workspace /2 profiles while keeping searches inside the session working directory. ([#13166](https://github.com/QwenLM/qwen-code/pull/13166)) by @yiliang114
- Adds planned Stage H5 agent channel API route shapes and persistence tables for channel routes and outbound deliveries. ([#13497](https://github.com/QwenLM/qwen-code/pull/13497)) by @wenshao
- feat(web-shell): take back a cancelled prompt that produced nothing ([#13488](https://github.com/QwenLM/qwen-code/pull/13488)) by @wenshao
- feat(hosted): show captured inputs in native approval cards ([#13407](https://github.com/QwenLM/qwen-code/pull/13407)) by @yiliang114
- feat(managed-agent): EventTransport message-envelope contract ([#13498](https://github.com/QwenLM/qwen-code/pull/13498)) by @wenshao
- feat(managed-agent): adopt the next Hosted Harness generation (G3) ([#13174](https://github.com/QwenLM/qwen-code/pull/13174)) by @wenshao
- feat(managed-agent): enumerate the public and WebShell surface with an admission gate ([#13543](https://github.com/QwenLM/qwen-code/pull/13543)) by @wenshao
- feat(managed-agent): H4a child agent and child acceptance record contract ([#13505](https://github.com/QwenLM/qwen-code/pull/13505)) by @wenshao
- feat(managed-agent): give Hosted turns the Workspace's project context ([#13168](https://github.com/QwenLM/qwen-code/pull/13168)) by @yiliang114
- feat(managed-agent): H6a schedule and automation run record contract ([#13536](https://github.com/QwenLM/qwen-code/pull/13536)) by @wenshao
- feat(managed-agent): H5a channel route and delivery record contract ([#13548](https://github.com/QwenLM/qwen-code/pull/13548)) by @wenshao
- feat(web-shell): Add fullscreen viewing for history tables ([#13589](https://github.com/QwenLM/qwen-code/pull/13589)) by @wenshao
- feat(managed-agent): prove Shell process-group stops with a worker ledger (M5c) ([#13352](https://github.com/QwenLM/qwen-code/pull/13352)) by @wenshao
- feat(managed-agent): add W1c offline workspace migration ([#13260](https://github.com/QwenLM/qwen-code/pull/13260)) by @doudouOUC
- feat(agents): session-centric multi-agent collaboration ([#13467](https://github.com/QwenLM/qwen-code/pull/13467)) by @yiliang114
- feat(managed-agent): add reliable ACTIVE Workspace deletion (L3) ([#13354](https://github.com/QwenLM/qwen-code/pull/13354)) by @doudouOUC
- feat(hooks): apply PreToolUse updatedInput with full revalidation ([#13442](https://github.com/QwenLM/qwen-code/pull/13442)) by @qqqys
- feat(web-shell): add trajectory search and diagnostic filters ([#13264](https://github.com/QwenLM/qwen-code/pull/13264)) by @qqqys
- feat(web-shell): restore aggregated workspace hosts in sidebar ([#13677](https://github.com/QwenLM/qwen-code/pull/13677)) by @yiliang114
- feat(managed-agent): persist workspace actor roles and session owners ([#13544](https://github.com/QwenLM/qwen-code/pull/13544)) by @wenshao
- feat(managed-agent): H4b child Session runtime ([#13550](https://github.com/QwenLM/qwen-code/pull/13550)) by @wenshao
- feat(web-shell): browse earlier trajectory windows ([#13716](https://github.com/QwenLM/qwen-code/pull/13716)) by @qqqys
- feat(agents): remove the thread backend and run A2A on sessions ([#13583](https://github.com/QwenLM/qwen-code/pull/13583)) by @yiliang114
- feat(trajectory): preserve model request execution identity ([#13740](https://github.com/QwenLM/qwen-code/pull/13740)) by @qqqys
- feat(managed-agent): H5b/H5c channel runtime for the email reference adapter ([#13572](https://github.com/QwenLM/qwen-code/pull/13572)) by @wenshao
- feat(managed-agent): add opt-in production replay-floor advancement for Session event retention (#12380) ([#13621](https://github.com/QwenLM/qwen-code/pull/13621)) by @qwen-code-dev-bot
- feat(managed-agent): H4c workflow child kind and child launch budget ([#13754](https://github.com/QwenLM/qwen-code/pull/13754)) by @wenshao
- feat(managed-agent): enforce workspace actor roles across the bound-Session surface ([#13545](https://github.com/QwenLM/qwen-code/pull/13545)) by @wenshao
- feat(managed-agent): H6b/H6c automation runtime for persistent definitions ([#13598](https://github.com/QwenLM/qwen-code/pull/13598)) by @wenshao
- feat(core): record prompt execution context ([#13712](https://github.com/QwenLM/qwen-code/pull/13712)) by @ytahdn
- feat(managed-agent): H4d-a session message record contract and child continuation rules ([#13786](https://github.com/QwenLM/qwen-code/pull/13786)) by @wenshao
- feat(managed-agent): H4e-a team record contract ([#13811](https://github.com/QwenLM/qwen-code/pull/13811)) by @wenshao
- feat(managed-agent): child Workspace capability for managed child Sessions (#13753 I1) ([#13781](https://github.com/QwenLM/qwen-code/pull/13781)) by @wenshao
- feat(trajectory): record and replay request lifecycle (PR6B) ([#13755](https://github.com/QwenLM/qwen-code/pull/13755)) by @qqqys
- feat(managed-agent): restart-recoverable foreground child wait (fixes #13708) ([#13769](https://github.com/QwenLM/qwen-code/pull/13769)) by @wenshao
- feat(web-shell): connect saved daemons simultaneously, no-flash host switching (#13727) ([#13739](https://github.com/QwenLM/qwen-code/pull/13739)) by @yiliang114
- feat(managed-agent): H4e-b1 lead-side team runtime ([#13824](https://github.com/QwenLM/qwen-code/pull/13824)) by @wenshao
- feat(managed-agent): H4f public task cancel for child agent tasks ([#13823](https://github.com/QwenLM/qwen-code/pull/13823)) by @wenshao
- feat(trajectory): record native tool execution lifecycles ([#13836](https://github.com/QwenLM/qwen-code/pull/13836)) by @qqqys
- feat(managed-agent): worktree admission for managed child agents (#13753 I2) ([#13841](https://github.com/QwenLM/qwen-code/pull/13841)) by @wenshao
- feat(managed-agent): H4d-b session message runtime ([#13822](https://github.com/QwenLM/qwen-code/pull/13822)) by @wenshao
- feat(mods): run experimental headless Mod commands ([#13843](https://github.com/QwenLM/qwen-code/pull/13843)) by @qqqys
- feat(managed-agent): enable the H4e-b1 team domains after the physical pass ([#13846](https://github.com/QwenLM/qwen-code/pull/13846)) by @wenshao
- feat(managed-agent): Collect retired stream-capture tool outputs (#13534) ([#13554](https://github.com/QwenLM/qwen-code/pull/13554)) by @wenshao
- feat(managed-agent): execute pinned AgentDefinition revisions ([#13530](https://github.com/QwenLM/qwen-code/pull/13530)) by @yiliang114
- feat(core): Keep complete file reads on one opened source ([#13776](https://github.com/QwenLM/qwen-code/pull/13776)) by @doudouOUC
- feat(managed-agent): support WebShell session cwd changes ([#13760](https://github.com/QwenLM/qwen-code/pull/13760)) by @doudouOUC
- feat(web-shell): add Send now for queued mid-turn messages ([#13681](https://github.com/QwenLM/qwen-code/pull/13681)) by @wenshao

#### Bug Fixes

- Replaces a selected remote host in Web Shell without losing agent bindings by revoking the old credential and moving bindings to the new host. ([#13430](https://github.com/QwenLM/qwen-code/pull/13430)) by @yiliang114
- Adds a 60-second wait before retrying E2E build artifact downloads to reduce false failures from immediate back-to-back attempts. ([#13292](https://github.com/QwenLM/qwen-code/pull/13292)) by @qwen-code-dev-bot
- Makes yamllint and shellcheck CI lanes fail clearly when the git file list is empty instead of silently passing or showing misleading errors. ([#12650](https://github.com/QwenLM/qwen-code/pull/12650)) by @qwen-code-dev-bot
- Improves managed-agent SSE delivery by using Condition-based waiting instead of pinning virtual-thread carriers. ([#13402](https://github.com/QwenLM/qwen-code/pull/13402)) by @wenshao
- Prevents managed-agent harness attachment creation from blocking concurrent map monitors, avoiding virtual-thread carrier pinning under cold bursts. ([#13403](https://github.com/QwenLM/qwen-code/pull/13403)) by @wenshao
- Fixes /context detail so per-tool MCP rows are scaled consistently and add up to the MCP tools row on both estimate and provider-count paths. ([#13390](https://github.com/QwenLM/qwen-code/pull/13390)) by @Shizoqua
- Aligns memory-index prompt loading with the writer budget so oversized entries are omitted whole and later complete entries remain available in order. ([#13315](https://github.com/QwenLM/qwen-code/pull/13315)) by @beibeihk
- Fixes vim-mode clipboard paste on Windows by making clipboard reads more reliable with PowerShell UTF-8 output, a longer timeout, and normalized line endings. ([#13198](https://github.com/QwenLM/qwen-code/pull/13198)) by @Bug-killer-prog
- Stops automatic QWEN.md and AGENTS.md discovery at the Git root so files in parent directories above the repository no longer enter requests. ([#13381](https://github.com/QwenLM/qwen-code/pull/13381)) by @agammann
- Extension Git operations no longer stall waiting for interactive credentials; unauthenticated sources now fail immediately. ([#13454](https://github.com/QwenLM/qwen-code/pull/13454)) by @yiliang114
- Settings file replacement now preserves the existing file's POSIX permission bits under stricter umask, improving safety and consistency when saving settings. ([#13293](https://github.com/QwenLM/qwen-code/pull/13293)) by @doudouOUC
- Fixes WeChat login QR code generation by sending required iLink headers with the request. ([#13482](https://github.com/QwenLM/qwen-code/pull/13482)) by @yiliang114
- Recognizes llama.cpp context-overflow wording so compaction runs instead of looping on HTTP 400. ([#13421](https://github.com/QwenLM/qwen-code/pull/13421)) by @yiliang114
- Recovers complete function-style XML tool calls so they execute instead of remaining assistant text. ([#13437](https://github.com/QwenLM/qwen-code/pull/13437)) by @yiliang114
- Honors memory.agentMaxTurns in user-scoped memory dream and restricts turn/timeout limits to trusted operator settings. ([#13462](https://github.com/QwenLM/qwen-code/pull/13462)) by @yiliang114
- Prevents MCP permission rules for one server from authorizing a different colliding server. ([#12531](https://github.com/QwenLM/qwen-code/pull/12531)) by @yiliang114
- Fixes web-shell managed session UI correctness issues including stale error banners, turn settling, pending-prompt handling, session switching, and provider rebuild behavior. ([#13342](https://github.com/QwenLM/qwen-code/pull/13342)) by @wenshao
- Makes main-branch CI failures caused only by GitHub infrastructure issues rerun failed jobs once instead of filing an autofix issue. ([#13512](https://github.com/QwenLM/qwen-code/pull/13512)) by @qwen-code-dev-bot
- fix(core): keep nested tool_call arguments open on Responses; name the target in bridged validation errors ([#12901](https://github.com/QwenLM/qwen-code/pull/12901)) by @yiliang114
- Ensures memory agent budget settings are honored only from User, System, and SystemDefaults scopes, with workspace values ignored and warned. ([#13508](https://github.com/QwenLM/qwen-code/pull/13508)) by @yiliang114
- Prevents an XML tool call quoted inside a parameter value from being dispatched as a real tool call. ([#13515](https://github.com/QwenLM/qwen-code/pull/13515)) by @yiliang114
- fix(ci): raise the Hosted verify step ceiling above its failsafe fork timeout (#13503) ([#13504](https://github.com/QwenLM/qwen-code/pull/13504)) by @qwen-code-dev-bot
- fix(ci): sweep stale pool residue before sdk-java checkouts ([#13507](https://github.com/QwenLM/qwen-code/pull/13507)) by @qwen-code-dev-bot
- fix(managed-agent): check the replay before publishing a domain record ([#13376](https://github.com/QwenLM/qwen-code/pull/13376)) by @wenshao
- fix(core): key the models.dev catalog under dotted as well as dashed ids ([#13299](https://github.com/QwenLM/qwen-code/pull/13299)) by @yiliang114
- fix(mobile): resolve document providers once per selection ([#13147](https://github.com/QwenLM/qwen-code/pull/13147)) by @jabrailkhalil
- fix(managed-agent): close the three Critical H0c follow-ups from #13300 ([#13355](https://github.com/QwenLM/qwen-code/pull/13355)) by @wenshao
- fix(core): stop advertising unsupported LSP dynamic registration ([#13494](https://github.com/QwenLM/qwen-code/pull/13494)) by @shenyankm
- fix(core): stop JSONL prefix reads when their budget is met ([#13486](https://github.com/QwenLM/qwen-code/pull/13486)) by @GoldArowana
- fix(web-shell): escape control characters in the managed approval args preview ([#13549](https://github.com/QwenLM/qwen-code/pull/13549)) by @yiliang114
- fix(core): budget side-query output tokens against the resolved context window ([#13244](https://github.com/QwenLM/qwen-code/pull/13244)) by @yiliang114
- fix(agent): enforce per-model concurrency cap on foreground sub-agents ([#12461](https://github.com/QwenLM/qwen-code/pull/12461)) by @Andrea-Bruno
- fix(runtime-broker): keep the HTTP exchange cancel off the deadline completion path ([#13562](https://github.com/QwenLM/qwen-code/pull/13562)) by @wenshao
- fix(ci): skip millisecond latency budgets on the release ECS pool (#13541) ([#13547](https://github.com/QwenLM/qwen-code/pull/13547)) by @qwen-code-dev-bot
- fix(docs): apply Prettier formatting to the daemon event schema (#13573) ([#13580](https://github.com/QwenLM/qwen-code/pull/13580)) by @qwen-code-dev-bot
- fix(acp): preserve branch checkpoints after Code Mode turns ([#13574](https://github.com/QwenLM/qwen-code/pull/13574)) by @yiliang114
- fix(web-shell): allow deleting queued prompts during admission ([#13594](https://github.com/QwenLM/qwen-code/pull/13594)) by @yiliang114
- fix(serve): invalidate the Hosted Workspace context on instruction-file changes ([#13605](https://github.com/QwenLM/qwen-code/pull/13605)) by @yiliang114
- fix(web-shell): follow an accepted approval answer to its terminal operation ([#13609](https://github.com/QwenLM/qwen-code/pull/13609)) by @yiliang114
- fix(managed-agent): commit oversized message records as inline chunks ([#13375](https://github.com/QwenLM/qwen-code/pull/13375)) by @wenshao
- fix(ci): classify runner-acquisition failure as infrastructure (#13622) ([#13626](https://github.com/QwenLM/qwen-code/pull/13626)) by @qwen-code-dev-bot
- fix(web-shell): sanitise model-supplied text at the approval card's sibling render sites ([#13578](https://github.com/QwenLM/qwen-code/pull/13578)) by @yiliang114
- fix(feishu): preserve text and clean up failed inbound file writes ([#13337](https://github.com/QwenLM/qwen-code/pull/13337)) by @jabrailkhalil
- fix(managed-agent): clear successful Workspace migration diagnostics ([#13655](https://github.com/QwenLM/qwen-code/pull/13655)) by @doudouOUC
- fix(managed-agent): stop a bound Turn under refused authorization ([#13163](https://github.com/QwenLM/qwen-code/pull/13163)) by @yiliang114
- fix(acp): include stored attachment paths in model context ([#13668](https://github.com/QwenLM/qwen-code/pull/13668)) by @ytahdn
- fix(core): preserve GLM vision metadata for dashed model IDs ([#13651](https://github.com/QwenLM/qwen-code/pull/13651)) by @yiliang114
- fix(goals): separate aggregate summaries from external facts ([#13575](https://github.com/QwenLM/qwen-code/pull/13575)) by @yiliang114
- fix(core): hide the hook child console on Windows ([#13670](https://github.com/QwenLM/qwen-code/pull/13670)) by @yiliang114
- fix(acp-bridge): keep local published file artifacts ephemeral ([#12395](https://github.com/QwenLM/qwen-code/pull/12395)) by @zjgzx1988
- fix(workflow): show results and failures in /workflows run details ([#13646](https://github.com/QwenLM/qwen-code/pull/13646)) by @qqqys
- fix(core): gate discovery hints on registered capabilities ([#13576](https://github.com/QwenLM/qwen-code/pull/13576)) by @yiliang114
- fix(memory): preserve the prompt prefix when memory indexes change ([#13521](https://github.com/QwenLM/qwen-code/pull/13521)) by @yiliang114
- fix(core): surface PreToolUse ask content on MCP tool confirmations (#13687) ([#13697](https://github.com/QwenLM/qwen-code/pull/13697)) by @yiliang114
- fix(web-shell): preserve artifact cards during reconnect ([#13714](https://github.com/QwenLM/qwen-code/pull/13714)) by @ytahdn
- fix(web-shell): allow downloading changed workspace artifacts ([#13718](https://github.com/QwenLM/qwen-code/pull/13718)) by @ytahdn
- fix(browser-use): fail fast when no Native Messaging host can be registered ([#13699](https://github.com/QwenLM/qwen-code/pull/13699)) by @yiliang114
- fix(web-shell): Select worktree mode without extra confirmation ([#13607](https://github.com/QwenLM/qwen-code/pull/13607)) by @wenshao
- fix(web-shell): show workspace artifacts by their filename ([#13672](https://github.com/QwenLM/qwen-code/pull/13672)) by @zjgzx1988
- fix(cli): preserve complete Hosted no-tool model Parts ([#13750](https://github.com/QwenLM/qwen-code/pull/13750)) by @doudouOUC
- fix(ci): raise the O4 gate step ceiling above its failsafe fork timeout (#13684) ([#13688](https://github.com/QwenLM/qwen-code/pull/13688)) by @qwen-code-dev-bot
- fix(verify-pr): drop the stale "ships no JDK" claim from the Java lane guidance (#13791) ([#13792](https://github.com/QwenLM/qwen-code/pull/13792)) by @qwen-code-dev-bot
- fix(release): reclaim docker disk and gate the data root before the sandbox image build (#13479) ([#13481](https://github.com/QwenLM/qwen-code/pull/13481)) by @qwen-code-dev-bot
- fix(managed-agent): unblock H3 background Shell and Monitor start path ([#13789](https://github.com/QwenLM/qwen-code/pull/13789)) by @wenshao
- fix(core): leave unknown ${identifier} placeholders literal in subagent prompts ([#13694](https://github.com/QwenLM/qwen-code/pull/13694)) by @yiliang114
- fix(mcp): discover tools on the readResource lazy-spawn path ([#13806](https://github.com/QwenLM/qwen-code/pull/13806)) by @yiliang114
- fix(cli): match ink's OpenTUI popup geometry and completion truncation ([#12559](https://github.com/QwenLM/qwen-code/pull/12559)) by @chiga0
- fix(ci): bound E2E sandbox image cleanup ([#13686](https://github.com/QwenLM/qwen-code/pull/13686)) by @zonemeen
- fix(ci): reject unsupported Bash in workflow size checks ([#13470](https://github.com/QwenLM/qwen-code/pull/13470)) by @zonemeen
- fix(web-shell): collapse background results with turn steps ([#13825](https://github.com/QwenLM/qwen-code/pull/13825)) by @ytahdn
- fix(managed-agent): answer journal-only calls on every interrupted-turn route ([#13829](https://github.com/QwenLM/qwen-code/pull/13829)) by @wenshao
- fix(core): suppress trailing orphan thinking tags in prose ([#13600](https://github.com/QwenLM/qwen-code/pull/13600)) by @yiliang114
- fix(core): make lazy-spawn MCP discovery best-effort ([#13828](https://github.com/QwenLM/qwen-code/pull/13828)) by @yiliang114
- fix(browser-use): report Windows as unsupported instead of advising an install ([#13675](https://github.com/QwenLM/qwen-code/pull/13675)) by @yiliang114
- fix(managed-agent): observe background-process exits at Session re-acquire ([#13830](https://github.com/QwenLM/qwen-code/pull/13830)) by @wenshao
- fix(permissions): escalate repeated destructive-command denials to manual approval ([#13636](https://github.com/QwenLM/qwen-code/pull/13636)) by @yiliang114
- fix(core): surface failed or unavailable LSP diagnostics as errors ([#13128](https://github.com/QwenLM/qwen-code/pull/13128)) by @yiliang114
- fix(managed-agent): harden the managed panel failure lifecycle and worker path containment ([#13179](https://github.com/QwenLM/qwen-code/pull/13179)) by @wenshao
- fix(core): close Managed session correctness gaps from #12693 post-merge review ([#13332](https://github.com/QwenLM/qwen-code/pull/13332)) by @wenshao
- fix(session): reserve retained snapshot prompt identities on resume ([#13729](https://github.com/QwenLM/qwen-code/pull/13729)) by @yiliang114
- fix(runtime): retain CSI mount identity through directory resolution ([#13772](https://github.com/QwenLM/qwen-code/pull/13772)) by @doudouOUC
- fix(managed-agent): reconcile approval delivery and concurrent session titles ([#13682](https://github.com/QwenLM/qwen-code/pull/13682)) by @yiliang114
- fix(hosted): Count future result-hook mounts at child admission ([#13773](https://github.com/QwenLM/qwen-code/pull/13773)) by @yiliang114
- fix(managed-agent): settle the deferred review findings of PR #13352 ([#13630](https://github.com/QwenLM/qwen-code/pull/13630)) by @wenshao
- fix(core): tell the parent model why a foreground subagent stopped ([#13624](https://github.com/QwenLM/qwen-code/pull/13624)) by @yiliang114

#### Performance

- Speeds up full extension scans by loading extension directories in bounded parallel batches while preserving order and error behavior. ([#13379](https://github.com/QwenLM/qwen-code/pull/13379)) by @callmeYe

#### Documentation

- Adds Stage H4/H5/H6 slice design documents for managed agents, channels, and automation. ([#13499](https://github.com/QwenLM/qwen-code/pull/13499)) by @wenshao
- Adds English and Chinese design documentation for the optional cross-node EventTransport based on message queues. ([#13500](https://github.com/QwenLM/qwen-code/pull/13500)) by @wenshao
- Repairs managed-agent documentation findings from the R2 review, fixing stale links, port guidance, stage labels, and incorrect claims. ([#13343](https://github.com/QwenLM/qwen-code/pull/13343)) by @wenshao
- docs(serve): fix stale permission-route note and document pending-prompt events ([#13281](https://github.com/QwenLM/qwen-code/pull/13281)) by @LUOSENGWA
- docs(managed-agent): add the delivery ledger for #12380 ([#13565](https://github.com/QwenLM/qwen-code/pull/13565)) by @wenshao
- docs(troubleshooting): add a "connection resets on some networks" entry (TLS-stack-selective middleboxes) ([#13235](https://github.com/QwenLM/qwen-code/pull/13235)) by @LUOSENGWA
- docs(managed-agent): bring the delivery ledger up to main d0ddd020c8 ([#13593](https://github.com/QwenLM/qwen-code/pull/13593)) by @wenshao
- docs(serve): fix Prettier formatting in the daemon event schema (#13585) ([#13587](https://github.com/QwenLM/qwen-code/pull/13587)) by @qwen-code-dev-bot
- docs(managed-agent): link every PR and issue reference in the delivery ledger ([#13631](https://github.com/QwenLM/qwen-code/pull/13631)) by @wenshao
- docs(core): point the session-agents contract at its SDK mirror ([#13648](https://github.com/QwenLM/qwen-code/pull/13648)) by @yiliang114
- docs(verify-pr): add local-round publish, follow-up, mutation and rig rules ([#13756](https://github.com/QwenLM/qwen-code/pull/13756)) by @wenshao
- docs(managed-agent): record H3 Linux acceptance blockers and replay inputs ([#13764](https://github.com/QwenLM/qwen-code/pull/13764)) by @yiliang114
- docs(verify-pr): name scenario axes in scope selection and attribute merge-only reds ([#13813](https://github.com/QwenLM/qwen-code/pull/13813)) by @wenshao
- docs(managed-agent): H4e-b1 lead-side team runtime design ([#13817](https://github.com/QwenLM/qwen-code/pull/13817)) by @wenshao
- docs(managed-agent): Name RocketMQ LiteTopic (5.5.0+) as the preferred P2 EventTransport candidate ([#13826](https://github.com/QwenLM/qwen-code/pull/13826)) by @wenshao
- docs(verify-pr): key the turn-axes rule to the diff, not the central claim ([#13819](https://github.com/QwenLM/qwen-code/pull/13819)) by @wenshao
- docs(managed-agent): H4e-b2 team mailbox design ([#13879](https://github.com/QwenLM/qwen-code/pull/13879)) by @wenshao
- docs(verify-pr): budget the turn-axes secondary A/B as a harness slot ([#13850](https://github.com/QwenLM/qwen-code/pull/13850)) by @wenshao

#### Internal Changes

- Adds post-merge test coverage and hygiene checks for HTTP store integrity scenarios, including multi-page journals and restore refusal on inconsistent data. ([#13341](https://github.com/QwenLM/qwen-code/pull/13341)) by @wenshao
- Stabilizes the /hooks dialog E2E test by using CI-aware timeouts and asserting against the rendered dialog. ([#13427](https://github.com/QwenLM/qwen-code/pull/13427)) by @qwen-code-dev-bot
- Increases the waitFor timeout for hosted tool-turn approval tests to reduce flaky CI failures. ([#13399](https://github.com/QwenLM/qwen-code/pull/13399)) by @qwen-code-dev-bot
- test(integration): make the utf-bom defaultFileEncoding test deterministic ([#13196](https://github.com/QwenLM/qwen-code/pull/13196)) by @Bug-killer-prog
- test(managed-agent): pin untested contracts from the #12692 R2 review ([#13348](https://github.com/QwenLM/qwen-code/pull/13348)) by @wenshao
- test(integration): let the headless workflow-skill E2E inherit the suite timeout (#13518) ([#13520](https://github.com/QwenLM/qwen-code/pull/13520)) by @qwen-code-dev-bot
- test(managed-agent): commit authority-valid deltas in the restore byte-budget test ([#13551](https://github.com/QwenLM/qwen-code/pull/13551)) by @wenshao
- test(core): pin the limit-less alias shape the models.dev projection ships ([#13539](https://github.com/QwenLM/qwen-code/pull/13539)) by @yiliang114
- test(integration): require a successful monitor tool call ([#13452](https://github.com/QwenLM/qwen-code/pull/13452)) by @GoldArowana
- test(managed-agent): harden pinning witnesses and add renewal-arm pinning witness (#13388 follow-up) ([#13401](https://github.com/QwenLM/qwen-code/pull/13401)) by @wenshao
- test(integration): share the Hosted proxy header filter across all store relays ([#13431](https://github.com/QwenLM/qwen-code/pull/13431)) by @wenshao
- test: isolate hosted catalog refresh and verify ACP defaults ([#13653](https://github.com/QwenLM/qwen-code/pull/13653)) by @yiliang114
- test(desktop): pin both Linux release legs to the ubuntu-22.04 glibc floor ([#13616](https://github.com/QwenLM/qwen-code/pull/13616)) by @tonydzi
- test(managed-agent): tolerate scheduling slack in the detach heartbeat window ([#13658](https://github.com/QwenLM/qwen-code/pull/13658)) by @yiliang114
- test(integration): let workflow-completion reply waits inherit the helper default (#13552) ([#13555](https://github.com/QwenLM/qwen-code/pull/13555)) by @qwen-code-dev-bot
- refactor(transcript): centralize internal Code Mode result detection ([#13577](https://github.com/QwenLM/qwen-code/pull/13577)) by @yiliang114
- test(memory): cover request-tail catalog and protocol contracts ([#13736](https://github.com/QwenLM/qwen-code/pull/13736)) by @yiliang114
- test(managed-agent): verify Hosted Shell operator recovery on MySQL and MariaDB ([#13759](https://github.com/QwenLM/qwen-code/pull/13759)) by @yiliang114
- test(managed-agent): cover AgentDefinition review follow-ups ([#13757](https://github.com/QwenLM/qwen-code/pull/13757)) by @yiliang114
- ci(sdk-java): re-check open PRs for Flyway version collisions as main moves ([#13770](https://github.com/QwenLM/qwen-code/pull/13770)) by @wenshao
- ci(verify): provision a Java toolchain for sdk-java PRs ([#13763](https://github.com/QwenLM/qwen-code/pull/13763)) by @doudouOUC
- refactor(managed-agent): classify child Session run kinds by name ([#13779](https://github.com/QwenLM/qwen-code/pull/13779)) by @wenshao
- test(managed-agent): widen HostedHarnessMySqlIT lifecycle budgets for CI MySQL stalls (#13780) ([#13783](https://github.com/QwenLM/qwen-code/pull/13783)) by @qwen-code-dev-bot
- test(cli): bind ephemeral loopback port in container-mode tests (#13775) ([#13778](https://github.com/QwenLM/qwen-code/pull/13778)) by @qwen-code-dev-bot
- ci(sdk-java): stop the API contract version from regressing or stalling (#13804) ([#13808](https://github.com/QwenLM/qwen-code/pull/13808)) by @wenshao
- test(cli): avoid port conflicts in managed runtime container tests ([#13569](https://github.com/QwenLM/qwen-code/pull/13569)) by @zonemeen
- test(cli): pin the background capture pause across the launcher-exit flush ([#13834](https://github.com/QwenLM/qwen-code/pull/13834)) by @wenshao
- test(managed-agent): run the H4e-b1 team flow end to end in the Hosted MySQL lane ([#13867](https://github.com/QwenLM/qwen-code/pull/13867)) by @wenshao

### New Contributors

- @beibeihk made their first contribution in [#13315](https://github.com/QwenLM/qwen-code/pull/13315)
- @agammann made their first contribution in [#13381](https://github.com/QwenLM/qwen-code/pull/13381)
- @GoldArowana made their first contribution in [#13486](https://github.com/QwenLM/qwen-code/pull/13486)
- @LUOSENGWA made their first contribution in [#13281](https://github.com/QwenLM/qwen-code/pull/13281)
- @zonemeen made their first contribution in [#13686](https://github.com/QwenLM/qwen-code/pull/13686)

**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v0.25.0...v0.25.1

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
