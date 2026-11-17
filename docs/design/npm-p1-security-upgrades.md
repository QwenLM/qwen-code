# P1 npm security upgrades

[English](npm-p1-security-upgrades.md) | [简体中文](npm-p1-security-upgrades.zh-CN.md)

## Problem and scope

Issue #17099 tracks consumer security findings. The baseline locks DOMPurify
3.4.14, MCP SDK 1.30.0 (Mobile MCP 1.26.0), and body-parser 2.3.0. A malformed
compressed request can terminate the daemon; the MCP client can forward
credentials across origins. DOMPurify's reported shadow-root template bypass
requires non-default options, not the current Generated UI configuration.

This change addresses these three P1 dependencies. ExcelJS/inflight, minimatch
advisory reconciliation, and unrelated P2 findings remain separate work.

## Decisions and consumers

- Raise every direct MCP SDK declaration, including standalone extension
  examples, to 1.32.2 within 1.x. Preserve Mobile MCP's exact-version policy.
  Consumers are Core/CLI, SDK and daemon SDK, Node REPL, Mobile MCP, the IDE
  companion, Generated UI, external context, Mem0, and the failure explorer.
- Upgrade Generated UI's direct DOMPurify pin to 3.4.17. Add matching npm/pnpm
  overrides so Mermaid's bundled sanitizer is also rebuilt with a fixed copy.
- Add matching body-parser 2.4.0 overrides for the Express 5 dependency paths.
  Keep compressed request support and the existing request-size limits.
- Enable `maxToolInputElements: 100_000` at every owned production MCP server
  constructor, including runnable examples; isolated test fixtures are excluded.
  The SDK fix leaves the limit disabled by default. Count
  object members and array elements before schema parsing; over-budget calls
  return an invalid-parameters error without invoking the handler. This is an
  element limit, not a byte, string-length, or total-process-memory limit.
  The generous fixed ceiling accommodates normal scalar arguments and bulk
  inputs while bounding collection traversal. No new public configuration is
  introduced. External servers supplied by SDK users remain their responsibility.
- No production caller uses SDK bearer middleware or taskStore. Do not invent
  audience or task-store configuration. If introduced later, bearer middleware
  must set expectedResource and return AuthInfo.resource; upgrading alone does
  not enable audience validation.

## Compatibility and delivery

All three dependency upgrades retain their major versions and Node 22 support.
Cross-origin MCP redirects now fail rather than forwarding custom credentials;
same-origin redirects and normal tool calls must continue working. Calls with
more than 100,000 input elements are intentionally rejected. Published SDK
consumers receive the raised MCP minimum; CLI and Web Shell must be rebuilt
because overrides cannot rewrite dependencies embedded in old artifacts.

## Validation and acceptance

Reproduce the compressed-body daemon crash, cross-origin credential forwarding,
and the conditional sanitizer bypass before upgrading. Verify the same probes
against patched dependencies and the built CLI, including healthy requests
after malformed input. Test the exact MCP element boundary and recovery in both
SDK factories. Regress Core OAuth/transports, SDK schemas, Mobile MCP, IDE,
Generated UI, Mermaid/math, and XLSX preview. Run full build/typecheck/bundle,
targeted unit tests, browser smoke tests, frozen-lockfile verification, and
inspect shipped bundles and license notices. Record actual platforms and any
limitations in the PR; publishing and consumer deployment are follow-up steps.

Acceptance requires no old copies of the three P1 dependencies in the workspace
lockfile, the applicable security probes passing, normal MCP/browser workflows
passing, and no unaccounted dependency or notice changes.
