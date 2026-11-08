# Markdown Chart Skill Integration

Status: accepted

## Integration contract

Qwen Code WebShell owns the rendering side of the contract:

- `@qwen-code/web-shell` includes the `markdown-chart` renderer and ECharts
  runtime.
- Hosts install the canonical
  [`markdown-chart` skill](https://github.com/datafe/markdown-chart/tree/main/skills/markdown-chart)
  so the model emits renderable chart blocks.
- Qwen Code core does not bundle or inject the skill. A project can install it
  at `.qwen/skills/markdown-chart/SKILL.md`; user-level skill installation is
  also supported.

For the normal `data.kind="inline"` output produced by the skill, the WebShell
host needs no chart-specific code:

```tsx
import { WebShellWithProviders } from '@qwen-code/web-shell';

<WebShellWithProviders
  baseUrl="http://127.0.0.1:4170"
  token={token}
  sessionId={sessionId}
/>;
```

## Referenced data

If the host exposes real controlled datasets to the skill and allows
`data.kind="ref"`, it provides `resolveDataRef` through a custom registry:

```tsx
import {
  createMarkdownChartRegistry,
  WebShellWithProviders,
} from '@qwen-code/web-shell';

const chartRegistry = createMarkdownChartRegistry({
  resolveDataRef: async (ref, context) =>
    loadControlledChartDataset(ref, context),
});
const markdown = { chart: { registry: chartRegistry } };

<WebShellWithProviders
  baseUrl="http://127.0.0.1:4170"
  token={token}
  sessionId={sessionId}
  markdown={markdown}
/>;
```

The renderer never fetches a ref or reads a local path by itself.
`resolveDataRef` is the host-owned boundary from a model-visible reference to a
trusted dataset. The default registry accepts normalized `artifact://` and
`session-file://` refs, parses the block as JSON, validates the option, and then
passes the normalized ref plus declared format and dimensions to the resolver.
Resolver waits are bounded to 30 seconds. Keep `markdown`, `chart`, and
`labels` overrides referentially stable while charts are mounted.

## Streaming behavior

The shared React adapter distinguishes a closed chart fence from the active
unterminated tail fence:

- A closed `markdown-chart` block renders immediately and remains mounted while
  later answer text streams, including when the fence is inside a blockquote.
- Only the active unterminated chart fence displays the loading state.

## Scope

- The skill defines the model output contract; it does not load the renderer.
- WebShell defines the rendering contract; it does not automatically install
  the skill.
- No daemon, ACP, or client-capability negotiation change is required.
- No automatic network or filesystem access is introduced.
