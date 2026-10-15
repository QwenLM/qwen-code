# Managed Workspace search tools

[English](2026-10-15-managed-workspace-search-tools.md) | [简体中文](2026-10-15-managed-workspace-search-tools.zh-CN.md)

## Status and scope

This design extends public API and WebShell Workspace Sessions with `glob`, `grep_search` and `list_directory`. The baseline is `a0e6678d66`. Web Fetch and Web Search are out of scope. Implementation and local validation do not constitute production rollout acceptance.

At the baseline, `/2` profiles already provide bounded glob execution, while the Runtime worker does not register grep or directory listing. Ordinary grep fallbacks and directory listing cannot simply be registered: they do not provide the required Session containment, cancellation and resource bounds. Several Hosted recovery and lifecycle readers also recognize only the original file profile or tool names.

## Profiles and admission

Add `hosted-workspace-files/3` and `hosted-workspace-shell/3`. Files/3 contains Read, Write, Edit, Glob, Grep and directory listing. Shell/3 adds the same read-only tools to the existing Shell vocabulary and retains existing foreground, background, Monitor, approval and public lifecycle admission rules. The `/1` and `/2` vocabularies remain unchanged.

`QWEN_MANAGED_AGENT_WORKSPACE_SEARCH_ENABLED` defaults to `false`. For new built-in `qwen-code` Workspace Sessions, it selects files/3 or shell/3 according to the existing Shell opt-in. Otherwise creation retains its current selection. The switch does not alter an existing Session, including on retry, load, later Turn or recovery. Stored AgentDefinitions continue to select one profile through the existing deployment allowlist; this switch does not override their definitions.

Persist the selected profile using the existing Session column and definition resource. No new database migration, public request field or route is needed. Creation, load, checkpoint recovery, approval continuation, Workspace migration and lifecycle consumers must recognize the new profiles explicitly. Files/3 inherits the file lifecycle; Shell/3 retains the current public Shell lifecycle restrictions. Unsupported profiles fail closed without a Legacy or weaker-profile fallback.

## Tool contracts

| Tool             | Parameters and behavior                                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `glob`           | Existing `pattern` and optional `path`; preserve current semantics.                                                                                                                                                                                                                                      |
| `grep_search`    | Required `pattern`; optional `path` (file or directory), `glob` and `limit`. The default limit is 200 and the maximum is 1000. Regex and case handling follow Core RipGrep. `glob` is an rg file filter, including exclusions and brace alternatives, not a second search root.                          |
| `list_directory` | Optional `path`, defaulting to the saved Session directory. List direct children only. Collect at most 1000 entries, sort collected entries with directories first and then by name, and display at most 100. Report collection and display truncation explicitly. No ignore-bypass options are exposed. |

All model-facing paths are relative to the saved Session directory. The Harness rejects absolute paths and `..` traversal before acquiring a Runtime; the worker independently resolves paths, rejects real-path escapes, and enforces the existing installed-directory ownership checks. A search root covering another installed Session's private descendant is refused before scanning, regardless of its pattern or filters; callers can narrow the path to an unowned directory. Grep does not follow symlinks. Listing may show a link name without inspecting its target. Validate all collected result paths before slicing the displayed output, including nested and sibling Session ownership. Do not advertise this as a new OS sandbox or cross-worker confidentiality boundary.

Grep changes only structured result paths during formatting. It must not replace directory strings in matched file content. Search hits do not satisfy complete read-before-write checks; do not add a new persistent file-read cache. The native tools are preapproved in the appropriate search profiles under default/auto-edit approval. The allowance must not authorize same-named MCP tools.

## Runtime execution and durable results

Reuse Core GlobTool, RipGrepTool and LSTool with explicit internal Managed restrictions; ordinary CLI callers retain their existing behavior. Grep uses only the bundled rg binary, with `--no-config` and `--no-follow`, never shell interpolation, system grep, Git grep or JS regex fallback. Missing rg is an explicit tool failure.

Each operation has a five-second execution deadline. Grep cancellation/deadline must stop and join the actual child process. Directory enumeration uses a terminable worker, following Glob's existing approach, rather than resolving a timeout while enumeration continues. Directory handles and subprocesses must be gone before reporting a known cancelled/failed execution.

Bound raw grep output to 1 MiB. An overflow fails with a narrowing hint instead of claiming no matches. Bound the encoded worker result to 48 KiB, including status metadata. Ownership paths remain internal, are checked before display truncation, and do not enter the worker response. The Harness additionally checks the existing 64 KiB outcome-resource and complete-tool-message budgets using actual UTF-8/JSON encoding. Keep useful prefixes and an explicit truncation marker. Preserve the original execution status; byte limits must handle long lines, unusual names and multibyte content.

Use the existing Harness → Broker → selected Runtime prepare/dispatch/status/cancel/result pipeline. Extend native read, approval continuation and replay allowlists plus result truncation for the new tools. Durable results are committed before inference continues. After a lost dispatch response, observe the original execution identity; never start the search again as recovery. Unknown outcomes and failed durable writes remain blocked. Ordinary execution of a new model-requested call is unaffected.

## Validation and rollout

Implement in two reviewable slices: bounded Core/Runtime execution, followed by Hosted profiles and public admission. Keep this bilingual design synchronized and maintain the E2E plan/results under `.qwen/e2e-tests/managed-workspace-search-tools.md`.

Validate directory/file grep, filters, invalid regex, empty results, ignore rules, symlinks, path escapes, sibling/nested Session ownership, roots containing private child directories, and hidden matches beyond the visible slice. Cover large directories, long and multibyte output, each byte ceiling, running cancellation, deadline cleanup, and subsequent successful calls. Preserve matched content containing physical-root strings.

Exercise public API and WebShell creation, later Turns, rendering, cancellation, cold replay, lost-response recovery and file lifecycle. Verify switch-on/off creation, immutable `/1`, `/2` and `/3` Sessions, AgentDefinition selection, and native-versus-MCP approval separation. Run focused Core/CLI/Java tests, build, typecheck, bundle and Checkstyle. Baseline the global `qwen` binary first and distinguish unavailable prerequisites from failed feature behavior.

Upgrade Java, Harness and every worker/provisioner, verify bundled rg, and drain old workers before enabling the switch. As with `/2`, the current worker capability identity does not prove search support; successful public-path probes are an operator rollout gate. Turning the switch off affects new built-in Sessions only; keep compatible binaries for existing `/3` Sessions. Real MySQL/deployment acceptance must be reported separately from local test evidence.
