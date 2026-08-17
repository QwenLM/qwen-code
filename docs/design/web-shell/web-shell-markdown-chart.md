# Web Shell Markdown Chart Integration

## Problem

Qwen Code Web Shell currently owns a standalone `echarts-fulldata` parser,
sanitizer, data-ref resolver, chart lifecycle, styling, and Chart/Data view in
`EchartsFullDataBlock.tsx`. The same behavior is now maintained and published
by `@datafe-open/markdown-chart*`.

Keeping both implementations makes the Web Shell renderer drift from the shared
Markdown chart protocol and duplicates security, streaming, and ECharts
lifecycle fixes. In particular, Web Shell only knows whether the whole
assistant message is streaming, while the shared component distinguishes a
closed chart fence from the active incomplete tail fence.

## Proposed changes

### Shared renderer

- Wrap Web Shell's existing `ReactMarkdown` with
  `@datafe-open/markdown-chart-react`'s provider and route registered chart
  fences through its `pre` adapter and block component.
- Build the default ECharts registry with
  `@datafe-open/markdown-chart` and
  `@datafe-open/markdown-chart-echarts`.
- Enable a stable default ECharts registry inside Web Shell, so embedded and
  standalone consumers render canonical `markdown-chart` fences and registered
  aliases, including `echarts-fulldata`, without importing ECharts or supplying
  host customization.
- Keep `markdown.chart.registry` and `createMarkdownChartRegistry` as explicit
  override APIs for controlled data refs, custom labels/loading/error behavior,
  or a host-selected runtime.
- Keep `createEchartsFullDataRenderer` and `EchartsFullDataBlock` as deprecated
  compatibility surfaces. They delegate rendering to the shared component
  instead of retaining a second parser or chart lifecycle.

### Streaming boundary

- Preserve `WebShellCodeBlockRenderInfo.isStreaming` as the whole-message state
  used by existing custom renderers.
- Let the shared React adapter derive per-fence completeness from the full
  transformed Markdown source and AST offsets. Closed chart fences therefore
  render immediately and remain mounted while later text streams.
- Also expose `isIncomplete` to legacy/custom `renderCodeBlock` callbacks so the
  deprecated compatibility renderer can use the same block-level boundary.

### Compatibility and safety

- Adapt the legacy `loadEcharts` and `resolveDataRef` callback shapes to the
  shared renderer.
- Preserve the legacy Web Shell ref allowlist (`artifact://` and
  `session-file://`) and normalized-path checks as the default registry policy
  and in the deprecated adapter.
- Preserve legacy `markdown.renderCodeBlock` precedence when no explicit
  `markdown.chart` override is supplied. Existing
  `createEchartsFullDataRenderer({ loadEcharts, resolveDataRef })` integrations
  therefore continue to use their host callbacks unchanged.
- Keep the model-facing skill separate from the renderer. Hosts install the
  canonical `markdown-chart` skill; Web Shell renders its output by default but
  does not inject or auto-load the skill.
- Use the shared package's strict JSON parser, option validation, bounded data
  handling, data materialization, Chart/Data view, resize, and disposal.

### Packaging

- Add the public `@datafe-open/markdown-chart*` packages and `echarts` as Web
  Shell runtime dependencies.
- Keep them external in the library build, matching the package's existing
  dependency strategy. A standalone host that uses the registry's default
  runtime loader can bundle ECharts lazily.

## Files affected

| Area                             | Files                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Shared adapter                   | `packages/web-shell/client/components/messages/MarkdownChartRenderer.tsx`                                                    |
| Removed duplicate implementation | `packages/web-shell/client/components/messages/EchartsFullDataBlock.tsx`, its CSS module, and its implementation-heavy tests |
| Streaming metadata               | `packages/web-shell/client/components/messages/Markdown.tsx`, `packages/web-shell/client/customization.tsx`                  |
| Public API and docs              | `packages/web-shell/client/index.tsx`, `packages/web-shell/client/main.tsx`, `packages/web-shell/README.md`                  |
| Packaging                        | `packages/web-shell/package.json`, `packages/web-shell/vite.lib.config.ts`, root lockfile                                    |
| Validation                       | focused Web Shell renderer and Markdown tests                                                                                |

## Scope boundaries

- No change to the daemon, ACP protocol, transcript model, or model prompts.
- No automatic network or filesystem reads for chart data refs.
- No new chart renderer beyond ECharts.
- No PR, release, or package publication in this task.

## Decisions

- Use the published `@datafe-open/markdown-chart*` `0.1.12` packages, which
  include localized labels, blockquote-aware streaming fence completion, and
  restored tooltip safety invariants.
- Document only the canonical `markdown-chart` skill for new integrations.
- Preserve the old Web Shell exports as compatibility wrappers to avoid an
  unrelated breaking package API change.
- Treat canonical `markdown-chart` as the integration protocol while retaining
  legacy fenced blocks internally for existing hosts.

## Open questions

- A future breaking release can remove the deprecated
  `EchartsFullDataBlock`-specific types after downstream usage is audited.
- Embedded consumers continue to decide whether to override the built-in
  renderer and which data refs their host resolves.
