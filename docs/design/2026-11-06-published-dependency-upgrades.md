# Published dependency upgrades

[中文](2026-11-06-published-dependency-upgrades.zh-CN.md)

## Scope

Issue #16434 concerns dependencies installed by SDK and Web Shell consumers,
including code embedded in their bundles. Root overrides alone do not change a
consumer's dependency tree. Preserve the existing spreadsheet preview and math
rendering behavior while removing the affected shipped dependencies.

## Implementation contract

- Untrusted inputs include SDK options, ACP messages, Markdown math, Mermaid
  diagrams and uploaded spreadsheets. Dependency metadata is not evidence that
  a prebuilt browser bundle contains patched code.
- Upgrade Zod at SDK and bundled CLI entry points and their workspace
  dependencies. Keep the current ACP protocol version; verify its Zod error
  classification with malformed requests. Invalid input must still be rejected
  before reaching a handler. A validation failure is an invalid-params error,
  not an internal server error.
- Keep the existing Markdown and Mermaid parsers. Bundle their adapters while
  retaining a patched KaTeX runtime dependency, so downstream installs cannot
  restore the adapters' old KaTeX ranges. Keep the current Mermaid major version
  to preserve browser support, layout and appearance.
- Keep ExcelJS's existing workbook parser and preview bounds. Build its browser
  entry from source with patched dependencies instead of consuming the opaque
  upstream browser bundle. ExcelJS becomes a build dependency; Node-only archive
  dependencies must not enter the published worker or consumer dependency tree.
- Preserve KaTeX's default untrusted mode and the spreadsheet worker's error
  response and limits. No new parsing implementation, permissive fallback or
  public configuration option is introduced.

SDK MCP tool schemas now use Zod 4, including their public TypeScript types;
callers supplying Zod 3 schemas must migrate them. ACP malformed-parameter
responses change from `-32603` to `-32602` as its existing Zod error handler
becomes effective. Browserify's runtime shims are included in bundled notices.

## Verification

Compare clean published consumers with locally packed packages: inspect resolved
Zod, KaTeX, UUID, inflight and minimatch versions, production audit results and
shipped browser/CLI code. Regress SDK schema validation and MCP tool inference,
malformed ACP messages, inline/display and Mermaid math, KaTeX trust rejection,
and the spreadsheet worker's existing values, formatting and bounds. Run the
repository build/typecheck and focused tests; retain unsupported checks as
explicit limitations. Do not raise bundle budgets to conceal regressions.

Implementation and package publication are separate: a PR cannot establish that
new npm releases have reached consumers. Record release versions and repeat the
clean-consumer checks after the normal release process.
