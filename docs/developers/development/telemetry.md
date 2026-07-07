# Observability with OpenTelemetry

Learn how to enable and setup OpenTelemetry for Qwen Code.

- [Observability with OpenTelemetry](#observability-with-opentelemetry)
  - [Key Benefits](#key-benefits)
  - [OpenTelemetry Integration](#opentelemetry-integration)
  - [Configuration](#configuration)
  - [Aliyun Telemetry](#aliyun-telemetry)
    - [Manual OTLP Export](#manual-otlp-export)
  - [Local Telemetry](#local-telemetry)
    - [File-based Output (Recommended)](#file-based-output-recommended)
    - [Collector-Based Export (Advanced)](#collector-based-export-advanced)
  - [Logs and Metrics](#logs-and-metrics)
    - [Logs](#logs)
    - [Metrics](#metrics)
    - [Daemon Metrics](#daemon-metrics)
    - [Spans](#spans)
    - [Resource Metrics](#resource-metrics)
    - [Performance Monitoring (Reserved)](#performance-monitoring-reserved)

## Migration Notes

- `tool_output_truncated` was renamed to `qwen-code.tool_output_truncated` for namespace consistency — downstream consumers filtering on the old name should update their queries.

- The `tool.call.latency` histogram documentation previously listed a `decision` attribute — this was never set on the histogram (only `function_name` is recorded). The `tool.call.count` counter continues to include `decision`.

- The `qwen-code.file_operation` log event and `file.operation.count` metric documentation previously listed diff-stat attributes (`model_added_lines`, `model_removed_lines`, `user_added_lines`, `user_removed_lines`) — these were never set on either. Diff-stat data is available via the `tool_call` log event's `metadata` attribute.

## Key Benefits

- **🔍 Usage Analytics**: Understand interaction patterns and feature adoption
  across your team
- **⚡ Performance Monitoring**: Track response times, token consumption, and
  resource utilization
- **🐛 Real-time Debugging**: Identify bottlenecks, failures, and error patterns
  as they occur
- **📊 Workflow Optimization**: Make informed decisions to improve
  configurations and processes
- **🏢 Enterprise Governance**: Monitor usage across teams, track costs, ensure
  compliance, and integrate with existing monitoring infrastructure

## OpenTelemetry Integration

Built on **[OpenTelemetry]** — the vendor-neutral, industry-standard
observability framework — Qwen Code's observability system provides:

- **Universal Compatibility**: Export to any OpenTelemetry backend (Aliyun,
  Jaeger, Prometheus, Datadog, etc.)
- **Standardized Data**: Use consistent formats and collection methods across
  your toolchain
- **Future-Proof Integration**: Connect with existing and future observability
  infrastructure
- **No Vendor Lock-in**: Switch between backends without changing your
  instrumentation

[OpenTelemetry]: https://opentelemetry.io/
[aliyun-opentelemetry-overview]: https://www.alibabacloud.com/help/en/arms/tracing-analysis/product-overview/what-is-tracing-analysis
[aliyun-opentelemetry-get-started]: https://www.alibabacloud.com/help/en/arms/tracing-analysis/before-you-begin
[aliyun-opentelemetry-console-cn]: https://trace.console.aliyun.com
[aliyun-opentelemetry-console-cn-legacy]: https://tracing.console.aliyun.com
[aliyun-opentelemetry-console-intl]: https://arms.console.alibabacloud.com

## Configuration

All telemetry behavior is controlled through your `.qwen/settings.json` file.
These settings can be overridden by environment variables or CLI flags.

| Setting                           | Environment Variable                                 | CLI Flag                                                 | Description                                                                                                                                    | Values            | Default                 |
| --------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------- |
| `enabled`                         | `QWEN_TELEMETRY_ENABLED`                             | `--telemetry` / `--no-telemetry`                         | Enable or disable telemetry                                                                                                                    | `true`/`false`    | `false`                 |
| `target`                          | `QWEN_TELEMETRY_TARGET`                              | `--telemetry-target <local\|gcp>` _(deprecated)_         | Informational destination label; does not control exporter routing — set `otlpEndpoint` or `outfile` to configure where data is sent           | `"gcp"`/`"local"` | `"local"`               |
| `otlpEndpoint`                    | `QWEN_TELEMETRY_OTLP_ENDPOINT`                       | `--telemetry-otlp-endpoint <URL>`                        | OTLP collector endpoint                                                                                                                        | URL string        | `http://localhost:4317` |
| `otlpProtocol`                    | `QWEN_TELEMETRY_OTLP_PROTOCOL`                       | `--telemetry-otlp-protocol <grpc\|http>`                 | OTLP transport protocol                                                                                                                        | `"grpc"`/`"http"` | `"grpc"`                |
| `otlpTracesEndpoint`              | `QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT`                | -                                                        | Per-signal endpoint override for traces (HTTP only)                                                                                            | URL string        | -                       |
| `otlpLogsEndpoint`                | `QWEN_TELEMETRY_OTLP_LOGS_ENDPOINT`                  | -                                                        | Per-signal endpoint override for logs (HTTP only)                                                                                              | URL string        | -                       |
| `otlpMetricsEndpoint`             | `QWEN_TELEMETRY_OTLP_METRICS_ENDPOINT`               | -                                                        | Per-signal endpoint override for metrics (HTTP only)                                                                                           | URL string        | -                       |
| `outfile`                         | `QWEN_TELEMETRY_OUTFILE`                             | `--telemetry-outfile <path>`                             | Save telemetry to file (overrides OTLP export)                                                                                                 | file path         | -                       |
| `logPrompts`                      | `QWEN_TELEMETRY_LOG_PROMPTS`                         | `--telemetry-log-prompts` / `--no-telemetry-log-prompts` | Include prompts in telemetry logs                                                                                                              | `true`/`false`    | `true`                  |
| `includeSensitiveSpanAttributes`  | `QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES`   | -                                                        | Include user prompts, system prompts, tool I/O, and model output as native span attributes (in addition to log-to-span bridge spans)           | `true`/`false`    | `false`                 |
| `sensitiveSpanAttributeMaxLength` | `QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH` | -                                                        | Maximum JavaScript string length for each sensitive native span attribute content payload. Set lower if your backend rejects large attributes. | `1..104857600`    | `1048576`               |
| `resourceAttributes`              | `OTEL_RESOURCE_ATTRIBUTES` (+ `OTEL_SERVICE_NAME`)   | -                                                        | Static resource attributes attached to every exported span / log / metric. See [Resource attributes](#resource-attributes) below.              | `key=value,…`     | `{}`                    |
| `metrics.includeSessionId`        | `QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID`          | -                                                        | Include `session.id` on metric data points. **Disabled by default** to protect metric backends from time-series fan-out.                       | `true`/`false`    | `false`                 |

**Note on boolean environment variables:** For the boolean settings (`enabled`,
`logPrompts`, `includeSensitiveSpanAttributes`), setting the
corresponding environment variable to `true` or `1` will enable the feature. Any
other value will disable it.

**Note on integer environment variables:** `QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH`
must be a positive integer when set. Invalid values fail telemetry configuration
resolution instead of silently falling back.

**Sensitive span attributes:** When `includeSensitiveSpanAttributes` is enabled,
two things happen:

1. **Native span attributes (`qwen-code.interaction`, `api.generateContent*`,
   `tool.<name>`)** carry verbatim conversation content:
   - User prompts (`new_context`)
   - System prompts (`system_prompt` — full text once per session, deduped by
     SHA-256 hash; subsequent spans only carry `system_prompt_hash` +
     `system_prompt_preview` + `system_prompt_length`)
   - Tool schemas (emitted as `tool_schema` events, also hash-deduped)
   - Tool inputs (`tool_input`) and tool results (`tool_result`)
   - Model output (`response.model_output`)

   Each content payload is truncated at `sensitiveSpanAttributeMaxLength`
   JavaScript string units. The default is 1 MiB (`1048576`), raised from the
   previous 60 KiB default; set `61440` to preserve the old cap. The limit
   must be between `1` and `104857600` (100 MiB). For labeled attributes, fixed
   labels such as `[USER PROMPT]`, `[TOOL INPUT: ...]`, and
   `[TOOL RESULT: ...]` count against the cap; the truncation marker also counts
   against it. The limit is measured as JavaScript string length rather than
   UTF-8 bytes. Non-ASCII content can therefore occupy more bytes after OTLP
   export. For most payload types, truncation adds both `*_truncated` and
   `*_original_length`. System prompts also set `system_prompt_truncated` when
   truncated, but use the always-present `system_prompt_length` for the original
   length.

2. **Log-to-span bridge spans** (used when HTTP traces are exported without a
   logs endpoint) keep their existing `prompt`, `function_args`, and
   `response_text` fields, instead of being dropped.

⚠️ **Security warning:** enabling this flag streams full conversation history,
file contents read by `read_file`, shell commands and their output (including
secrets in env vars or arguments), and model responses to the configured OTLP
backend. Treat the backend as a privileged data sink. The flag defaults to
`false`.

**Cost / payload size:** A heavy turn at the default limit (1 MiB system prompt
plus 10 tool calls, each up to 1 MiB input + 1 MiB result, plus 1 MiB model
output) can produce up to ~22 MiB of attribute payload before OTLP compression,
plus up to 1 MiB per emitted tool schema in workspaces with large tool
definitions. This is Qwen Code's application-side cap, not a guarantee that
every collector or backend accepts a single attribute that large. If spans are
rejected or dropped, lower `sensitiveSpanAttributeMaxLength` (for example, to
`61440`) and monitor exporter throughput.

This setting does not disable sensitive data in OTel logs or other telemetry
sinks; non-internal API response telemetry can populate `response_text`, so
OTel logs, UI telemetry, and chat recording may receive response text
independently of this setting. QwenLogger does not include `response_text`.

**HTTP OTLP signal routing:** When using HTTP protocol (`otlpProtocol: "http"`),
Qwen Code automatically appends signal-specific paths (`/v1/traces`, `/v1/logs`,
`/v1/metrics`) to the base `otlpEndpoint`. For example, `http://collector:4318`
becomes `http://collector:4318/v1/traces` for traces. If the URL already ends
with a signal path, it is used as-is. Per-signal endpoint overrides
(`otlpTracesEndpoint`, etc.) take precedence over the base endpoint and are used
verbatim. gRPC protocol uses service-based routing and does not append paths.

The per-signal endpoint environment variables also accept the standard
OpenTelemetry names: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`.
The `QWEN_TELEMETRY_OTLP_*` variants take precedence over the `OTEL_*` variants.

For detailed information about all configuration options, see the
[Configuration Guide](../../users/configuration/settings.md).

### Resource attributes

Resource attributes are static key-value pairs attached to every span, log,
and metric exported via OTLP. Use them to slice telemetry by team, environment,
deployment region, or any other dimension your backend cares about.

Two sources, merged in priority order (lowest → highest):

1. The standard `OTEL_RESOURCE_ATTRIBUTES` env var
2. `telemetry.resourceAttributes` in `.qwen/settings.json` (overrides env on
   key conflict)

`OTEL_SERVICE_NAME` is a separate escape hatch — when set, it overrides
`service.name` from any other source (per the OpenTelemetry spec).

#### Examples

**Slice all telemetry by team / environment:**

```bash
export OTEL_RESOURCE_ATTRIBUTES="team=platform,env=prod,cost_center=eng-123"
```

**Route to a per-tenant collector via `service.name`:**

```bash
export OTEL_SERVICE_NAME=qwen-code-ci
```

**Fleet baseline (`~/.qwen/settings.json`) + per-host override:**

```json
{
  "telemetry": {
    "resourceAttributes": {
      "deployment.environment": "production",
      "service.namespace": "engineering-tooling"
    }
  }
}
```

```bash
# Add a one-off tag without touching settings:
export OTEL_RESOURCE_ATTRIBUTES="debug_run=true"
```

#### Reserved keys

Some keys are runtime-controlled and cannot be overridden:

- `service.version` — always set to the running CLI version. Setting it from
  any source is silently dropped with a warning.
- `session.id` — runtime-injected per session. User-provided values from
  either env or settings are dropped with a warning. The reason is that
  Resource attributes auto-attach to every metric data point; allowing user
  override would bypass [Cardinality controls](#cardinality-controls) below.
  Spans and logs always carry `session.id`.

`service.name` is **not** reserved; it follows the precedence chain above.

#### Format

`OTEL_RESOURCE_ATTRIBUTES` follows the OpenTelemetry spec:
`key1=value1,key2=value2` with values percent-encoded. Spaces in values must
be encoded as `%20`, **commas as `%2C`** (unencoded commas split the value at
the wrong boundary and the second half is dropped as malformed). Malformed
pairs are skipped with a warning rather than failing telemetry startup.

#### Troubleshooting: when a user-provided attribute appears not to take effect

Reserved keys (`service.version`, `session.id`), malformed pairs, non-string
settings values, and invalid percent-encoding are all silently dropped with a
warning logged via the OpenTelemetry diagnostics channel. That channel routes
to the debug log file (`~/.qwen/log/otel-*.log`), **not** the console, so the
behavior can look like silent failure.

If a custom resource attribute isn't appearing on exported telemetry:

1. Check `~/.qwen/log/otel-*.log` for lines matching `cannot override` (reserved
   key dropped), `Skipping malformed` (bad env var pair), or `must be a string`
   (non-string settings value).
2. Verify the env var is set in the qwen-code process's environment (not just
   your shell) and that values are percent-encoded.
3. Confirm `telemetry.enabled` is `true` — telemetry init only runs if enabled.

### Cardinality controls

Metrics are aggregated by attribute set at the backend — every distinct
combination of attribute values produces a new time series. Attaching a
high-cardinality field like `session.id` to a metric causes time-series fan-out
proportional to the number of sessions, which quickly exhausts metric backend
storage.

To prevent this, Qwen Code keeps high-cardinality attributes off metric data
points by default. Spans and logs are per-event and unaffected, so they
continue to carry `session.id` for trace and log correlation.

#### `telemetry.metrics.includeSessionId` (default: `false`)

Setting this to `true` (via settings or
`QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID=true`) re-attaches `session.id` to
every metric data point.

⚠️ **Warning:** each CLI session creates a new value. Leaving this on for a
fleet will blow up metric storage. Recommended only for short-term debugging.
For long-term session correlation, query trace or log backends instead.

#### Migration from earlier versions

Prior to this release, `session.id` was attached to metrics by default. If
your Prometheus queries / Grafana dashboards / alert rules reference
`session_id` on a metric, you have two options:

**Option A** — restore the previous behavior for short-term debugging:

```bash
export QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID=true
```

or:

```json
{
  "telemetry": {
    "metrics": { "includeSessionId": true }
  }
}
```

**Option B (recommended)** — move session-level analysis off metrics. Spans
and logs still carry `session.id`, and trace / log backends (Jaeger, Tempo,
Loki, Aliyun SLS / ARMS Tracing) handle per-session slicing natively without
cardinality pressure.

### Client-side HTTP span on outbound fetch

When telemetry is enabled, Qwen Code registers `UndiciInstrumentation`
which creates a client-side HTTP span for every outbound `fetch()`
request originated by the process — including the LLM SDKs (`openai`,
`@google/genai`, `@anthropic-ai/sdk`), the MCP StreamableHTTP client, the
`WebFetch` tool, and any IDE-extension out-of-process calls. The span
lets you see network latency (TTFB / response body transfer) separately
from upstream model processing time, which the existing
`api.generateContent` span alone can't distinguish.

These spans go to your **own** OTLP collector (or file outfile) just like
the rest of the telemetry — they do not affect what is written onto the
outbound HTTP request itself. Whether the W3C `traceparent` header is
also written into the outgoing request stream is controlled by a
**separate, security-relevant setting** documented in
[outbound correlation](#outbound-correlation-security-relevant) below.

**Feedback-loop avoidance.** OTel SDK uses `fetch` internally to upload OTLP
data. Without protection, instrumenting `fetch` would trace those uploads,
which would themselves be uploaded, causing an infinite loop. Qwen Code's
undici instrumentation is configured with an `ignoreRequestHook` that skips
URLs matching the configured `telemetry.otlpEndpoint` /
`telemetry.otlpTracesEndpoint` / `telemetry.otlpLogsEndpoint` /
`telemetry.otlpMetricsEndpoint` prefixes. In file-outfile mode there are no
outbound HTTP uploads, so the hook is a no-op.

## Outbound correlation (SECURITY-RELEVANT)

These settings live in a **separate top-level namespace** from `telemetry.*`
on purpose: telemetry controls data flow into the operator's own
observability backend, while `outboundCorrelation.*` controls what
client-side correlation data qwen-code writes **into outbound LLM API
request streams** that reach third-party LLM provider endpoints
(DashScope, OpenAI, Anthropic, etc.). Different recipients, different
consent decision. **All values default to off.** See PR #4390 review
discussion for the framing rationale.

### `outboundCorrelation.propagateTraceContext`

```jsonc
"outboundCorrelation": {
  "propagateTraceContext": false // default
}
```

When `false` (default), Qwen Code installs a no-op `TextMapPropagator` on
the OTel SDK. UndiciInstrumentation still creates client HTTP spans for
your OTLP collector, but `propagation.inject()` is a no-op so **no
`traceparent` is written onto outbound requests**. Trace IDs stay
internal to the operator's collector.

When `true`, the SDK's default W3C composite propagator
(`tracecontext` + `baggage`) is installed and the standard `traceparent`
header is written on every outbound `fetch`:

```
traceparent: 00-<32-hex traceId>-<16-hex parentSpanId>-<01-sampled | 00-not-sampled>
```

Additionally, `TRACEPARENT` and `TRACESTATE` environment variables are set in
shell child processes (Bash tool, hooks, monitor) so that spawned commands can
participate in the same distributed trace.

Opt in only when the LLM provider also reports into your OTel collector
for cross-process trace stitching — e.g. ARMS Tracing serving DashScope.
For most operators the value is `false`; cross-vendor trace continuation
is niche.

**Depends on `telemetry.enabled: true`.** The OTel SDK only initializes
when telemetry is enabled, so `propagateTraceContext` only takes effect
in that state. Setting it to `true` while telemetry is disabled is a
silent no-op — no SDK, no propagator, no `traceparent` on the wire.
Verify both flags when wiring an ARMS+DashScope correlation setup:

```jsonc
{
  "telemetry": {
    "enabled": true,
    "otlpTracesEndpoint": "http://tracing-analysis-...",
  },
  "outboundCorrelation": {
    "propagateTraceContext": true,
  },
}
```

### Other outbound correlation headers

`X-Qwen-Code-Session-Id` and `X-Qwen-Code-Request-Id` are **not part of
this PR**. They will be designed and proposed in their own follow-up
PR(s) under the same `outboundCorrelation.*` namespace, each with its
own threat model and operator-consent flow. PR #4390 review (LaZzyMan)
established the principle: "telemetry's scope of work doesn't include
sending identifiers to LLM providers"; correlation-header work moves to
its own design discussion rather than landing under telemetry.

## Aliyun Telemetry

### Manual OTLP Export

To view Qwen Code telemetry in Alibaba Cloud Managed Service for
OpenTelemetry, configure Qwen Code to export to the OTLP endpoint
provided by ARMS.

Setting `"target": "gcp"` alone does not configure the export
destination. If `otlpEndpoint` is not set, Qwen Code still defaults to
`http://localhost:4317`. If `outfile` is set, it overrides
`otlpEndpoint` and telemetry is written to the file instead of being
sent to Alibaba Cloud.

1. Enable telemetry in your `.qwen/settings.json` and set the OTLP
   endpoint:

   **Option A: gRPC protocol** (standard OTLP endpoint):

   ```json
   {
     "telemetry": {
       "enabled": true,
       "target": "gcp",
       "otlpEndpoint": "https://<your-otlp-endpoint>",
       "otlpProtocol": "grpc"
     }
   }
   ```

   **Option B: HTTP protocol with per-signal endpoints** (for backends
   that use non-standard paths, e.g., `/api/otlp/traces` instead of
   `/v1/traces`):

   ```json
   {
     "telemetry": {
       "enabled": true,
       "otlpProtocol": "http",
       "otlpTracesEndpoint": "http://<host>/<token>/api/otlp/traces",
       "otlpLogsEndpoint": "http://<host>/<token>/api/otlp/logs",
       "otlpMetricsEndpoint": "http://<host>/<token>/api/otlp/metrics"
     }
   }
   ```

   > **Note:** When using HTTP protocol with only `otlpEndpoint` (no
   > per-signal overrides), Qwen Code appends standard OTLP paths
   > (`/v1/traces`, `/v1/logs`, `/v1/metrics`) to the base URL. If your
   > backend uses different paths, use per-signal endpoint overrides as
   > shown in Option B.

2. If your Alibaba Cloud endpoint requires authentication, provide OTLP
   headers through standard OpenTelemetry environment variables such as
   `OTEL_EXPORTER_OTLP_HEADERS` (or the signal-specific variants). Qwen
   Code does not currently expose OTLP auth headers directly in
   `.qwen/settings.json`.
3. Run Qwen Code and send prompts.
4. View telemetry in Managed Service for OpenTelemetry:
   - Product overview:
     [What is Managed Service for OpenTelemetry?][aliyun-opentelemetry-overview]
   - Getting started:
     [Get started with Managed Service for OpenTelemetry][aliyun-opentelemetry-get-started]
   - Console entry points:
     - China mainland:
       [trace.console.aliyun.com][aliyun-opentelemetry-console-cn]
       (legacy console:
       [tracing.console.aliyun.com][aliyun-opentelemetry-console-cn-legacy])
     - International:
       [arms.console.alibabacloud.com][aliyun-opentelemetry-console-intl]
   - In the console, use `Applications` to inspect traces and service
     topology.
   - To locate the OTLP endpoint and access information:
     - **New console** (`trace.console.aliyun.com` or international):
       navigate to `Integration Center`.
     - **Legacy console** (`tracing.console.aliyun.com`): navigate to
       `Cluster Configurations` → `Access point information`.

## Local Telemetry

For local development and debugging, you can capture telemetry data locally:

### File-based Output (Recommended)

1. Enable telemetry in your `.qwen/settings.json`:

   ```json
   {
     "telemetry": {
       "enabled": true,
       "outfile": ".qwen/telemetry.log"
     }
   }
   ```

   > **Note:** When `outfile` is set, OTLP export is automatically disabled.
   > The `target` and `otlpEndpoint` settings are not needed for file-only
   > output and can be safely omitted from your config.

2. Run Qwen Code and send prompts.
3. View logs and metrics in the specified file (e.g., `.qwen/telemetry.log`).

### Collector-Based Export (Advanced)

1. Run the automation script:
   ```bash
   npm run telemetry -- --target=local
   ```
   This will:
   - Download and start Jaeger and OTEL collector
   - Configure your workspace for local telemetry
   - Provide a Jaeger UI at http://localhost:16686
   - Save logs/metrics to `~/.qwen/tmp/<projectHash>/otel/collector.log`
   - Stop collector on exit (e.g. `Ctrl+C`)
2. Run Qwen Code and send prompts.
3. View traces at http://localhost:16686 and logs/metrics in the collector log
   file.

## Logs and Metrics

The following section describes the structure of logs, metrics, and spans
generated for Qwen Code.

- A `sessionId` is included as a common attribute on all logs and metrics.

### Logs

Logs are timestamped records of specific events. All log records automatically include `event.name` and `event.timestamp` attributes.

The following events are logged:

#### Core Session Events

- `qwen-code.config`: Emitted once at startup with CLI configuration.
  - **Attributes**: `model`, `sandbox_enabled`, `core_tools_enabled`, `approval_mode`, `file_filtering_respect_git_ignore`, `debug_mode`, `truncate_tool_output_threshold`, `truncate_tool_output_lines`, `hooks` (comma-separated, omitted if disabled), `ide_enabled`, `interactive_shell_enabled`, `mcp_servers`, `mcp_servers_count`, `mcp_tools`, `mcp_tools_count`, `output_format`, `skills`, `subagents`

- `qwen-code.user_prompt`: User submits a prompt.
  - **Attributes**: `prompt_length` (int), `prompt_id` (string), `prompt` (string, excluded if `log_prompts_enabled` is false), `auth_type` (string)

- `qwen-code.user_retry`: User retries the last prompt.
  - **Attributes**: `prompt_id` (string)

- `qwen-code.conversation_finished`: A conversation turn sequence completes.
  - **Attributes**: `approvalMode` (string), `turnCount` (int)

- `qwen-code.user_feedback`: User submits session feedback.
  - **Attributes**: `session_id` (string), `rating` (int: 1=bad, 2=fine, 3=good), `model` (string), `approval_mode` (string), `prompt_id` (string, optional)

#### Tool Events

- `qwen-code.tool_call`: Each function/tool call.
  - **Attributes**: `function_name` (string), `function_args` (object), `duration_ms` (int), `status` (string: "success", "error", or "cancelled"), `success` (boolean), `decision` (string: "accept", "reject", "auto_accept", or "modify", optional), `error` (string, optional), `error_type` (string, optional), `prompt_id` (string), `response_id` (string, optional), `content_length` (int, optional), `tool_type` (string: "native" or "mcp"), `mcp_server_name` (string, optional), `metadata` (object, optional — for file-writing tools contains `model_added_lines`, `model_removed_lines`, `user_added_lines`, `user_removed_lines`, `model_added_chars`, `model_removed_chars`, `user_added_chars`, `user_removed_chars`)

- `qwen-code.file_operation`: Each file operation.
  - **Attributes**: `tool_name` (string), `operation` (string: "create", "read", "update"), `lines` (int, optional), `mimetype` (string, optional), `extension` (string, optional), `programming_language` (string, optional)

- `qwen-code.tool_output_truncated`: Tool output exceeded size threshold.
  - **Attributes**: `tool_name` (string), `original_content_length` (int), `truncated_content_length` (int), `threshold` (int), `lines` (int), `prompt_id` (string)

#### API Events

- `qwen-code.api_request`: Outgoing request to the LLM API.
  - **Attributes**: `model` (string), `prompt_id` (string), `request_text` (string, optional), `subagent_name` (string, optional)

- `qwen-code.api_response`: Response received from LLM API.
  - **Attributes**: `response_id` (string), `model` (string), `status_code` (int/string, optional), `duration_ms` (int), `input_token_count` (int), `output_token_count` (int), `cached_content_token_count` (int), `thoughts_token_count` (int), `total_token_count` (int), `prompt_id` (string), `auth_type` (string, optional), `response_text` (string, optional), `subagent_name` (string, optional)

- `qwen-code.api_error`: API request failed.
  - **Attributes**: `model` (string), `prompt_id` (string), `duration_ms` (int), `error_message` (string), `response_id` (string, optional), `auth_type` (string, optional), `error_type` (string, optional), `status_code` (int/string, optional), `subagent_name` (string, optional)

  Additionally, OTel-standard aliases (`http.status_code`, `error.message`, `model_name`, `duration`) are emitted for compatibility.

- `qwen-code.api_cancel`: API request cancelled by user.
  - **Attributes**: `model` (string), `prompt_id` (string), `auth_type` (string, optional), `loop_wakeups_cancelled` (int, optional)

- `qwen-code.api_retry`: HTTP-status retry (429/5xx) at an LLM call site. Distinct from `chat.content_retry` which handles `InvalidStreamError` retries on a separate budget.
  - **Attributes**: `model` (string), `prompt_id` (string, optional), `attempt_number` (int), `error_type` (string, optional), `error_message` (string), `status_code` (int/string, optional), `retry_delay_ms` (int), `duration_ms` (int, equals retry_delay_ms — backoff sleep, not HTTP round-trip; for attempt duration see the qwen-code.llm_request span), `subagent_name` (string, optional)

- `qwen-code.malformed_json_response`: `generateJson` response couldn't be parsed.
  - **Attributes**: `model` (string)

- `qwen-code.flash_fallback`: Switched to flash model as fallback.
  - **Attributes**: `auth_type` (string)

- `qwen-code.ripgrep_fallback`: Switched to grep as fallback.
  - **Attributes**: `use_ripgrep` (boolean), `use_builtin_ripgrep` (boolean), `error` (string, optional)

#### Resilience Events

- `qwen-code.chat.content_retry`: Content-error retry (e.g. empty stream).
  - **Attributes**: `attempt_number` (int), `error_type` (string), `retry_delay_ms` (int), `model` (string)

- `qwen-code.chat.content_retry_failure`: All content retries exhausted.
  - **Attributes**: `total_attempts` (int), `final_error_type` (string), `total_duration_ms` (int, optional), `model` (string)

- `qwen-code.chat.invalid_chunk`: Invalid chunk received from stream.
  - **Attributes**: `error.message` (string, optional)

#### Command & Extension Events

- `qwen-code.slash_command`: User executes a slash command.
  - **Attributes**: `command` (string), `subcommand` (string, optional), `status` (string: "success" or "error", optional)

- `qwen-code.slash_command.model`: User switches model via `/model` command.
  - **Attributes**: `model_name` (string)

- `qwen-code.skill_launch`: A skill is launched.
  - **Attributes**: `skill_name` (string), `success` (boolean), `prompt_id` (string)

- `qwen-code.extension_install`: Extension installed.
  - **Attributes**: `extension_name` (string), `extension_version` (string), `extension_source` (string), `status` (string: "success"/"error")

- `qwen-code.extension_uninstall`: Extension uninstalled.
  - **Attributes**: `extension_name` (string), `status` (string)

- `qwen-code.extension_enable`: Extension enabled.
  - **Attributes**: `extension_name` (string), `setting_scope` (string)

- `qwen-code.extension_disable`: Extension disabled.
  - **Attributes**: `extension_name` (string), `setting_scope` (string)

- `qwen-code.extension_update`: Extension updated.
  - **Attributes**: `extension_name` (string), `extension_id` (string), `extension_previous_version` (string), `extension_version` (string), `extension_source` (string), `status` (string: "success"/"error")

- `qwen-code.ide_connection`: IDE connection event.
  - **Attributes**: `connection_type` (string: "start" or "session")

- `qwen-code.auth`: Authentication event.
  - **Attributes**: `auth_type` (string), `action_type` ("auto", "manual", "coding-plan"), `status` ("success", "error", "cancelled"), `error_message` (optional)

#### Subagent Events

- `qwen-code.subagent_execution`: Subagent lifecycle event.
  - **Attributes**: `subagent_name` (string), `status` ("started", "completed", "failed", "cancelled"), `terminate_reason` (optional), `result` (optional), `execution_summary` (optional)

#### Arena Events

- `qwen-code.arena_session_started`: Arena session begins.
  - **Attributes**: `arena_session_id` (string), `model_ids` (JSON string array), `task_length` (int)

- `qwen-code.arena_agent_completed`: An arena agent finishes.
  - **Attributes**: `arena_session_id` (string), `agent_session_id` (string), `agent_model_id` (string), `status` (string: "completed"/"failed"/"cancelled"), `duration_ms` (int), `rounds` (int), `total_tokens` (int), `input_tokens` (int), `output_tokens` (int), `tool_calls` (int), `successful_tool_calls` (int), `failed_tool_calls` (int)

- `qwen-code.arena_session_ended`: Arena session completes.
  - **Attributes**: `arena_session_id` (string), `status` (string: "selected"/"discarded"/"failed"/"cancelled"), `duration_ms` (int), `display_backend` (string, optional), `agent_count` (int), `completed_agents` (int), `failed_agents` (int), `cancelled_agents` (int), `winner_model_id` (string, optional)

#### Workflow Events

- `qwen-code.workflow_keyword`: Workflow keyword trigger fired.

- `qwen-code.workflow_run`: Workflow run reached terminal state.
  - **Attributes**: `status` (string), `agents_dispatched` (int), `agents_completed` (int), `phase_count` (int), `tokens_spent` (int), `duration_ms` (int)

#### Auto-Memory Events

- `qwen-code.memory.extract`: Memory extraction run completed.
  - **Attributes**: `trigger` ("auto"/"manual"), `status` ("completed"/"skipped"/"failed"), `skipped_reason` (optional), `patches_count` (int), `touched_topics` (string), `duration_ms` (int)

- `qwen-code.memory.dream`: Memory consolidation (dream) run completed.
  - **Attributes**: `trigger` ("auto"/"manual"), `status` ("updated"/"noop"/"failed"/"cancelled"), `deduped_entries` (int), `touched_topics_count` (int), `touched_topics` (string), `duration_ms` (int)

- `qwen-code.memory.recall`: Memory recall operation completed.
  - **Attributes**: `query_length` (int), `docs_scanned` (int), `docs_selected` (int), `strategy` ("none"/"heuristic"/"model"), `duration_ms` (int)

#### Prompt Suggestion & Speculation Events

- `qwen-code.prompt_suggestion`: Prompt suggestion outcome.
  - **Attributes**: `outcome` ("accepted"/"ignored"/"suppressed"), `prompt_id` (optional), `accept_method` ("tab"/"enter"/"right", optional), `accept_source` ("live"/"fallback", optional), `time_to_accept_ms` (optional), `time_to_ignore_ms` (optional), `time_to_first_keystroke_ms` (optional), `suggestion_length` (optional), `similarity` (optional), `was_focused_when_shown` (optional), `reason` (optional)

- `qwen-code.speculation`: Speculative execution outcome.
  - **Attributes**: `outcome` ("accepted"/"aborted"/"failed"), `turns_used` (int), `files_written` (int), `tool_use_count` (int), `duration_ms` (int), `boundary_type` (optional), `had_pipelined_suggestion` (boolean)

#### Other Events

- `qwen-code.chat_compression`: Chat context compressed.
  - **Attributes**: `tokens_before` (int), `tokens_after` (int), `compression_input_token_count` (int, optional), `compression_output_token_count` (int, optional)

- `qwen-code.next_speaker_check`: Next speaker determination.
  - **Attributes**: `prompt_id` (string), `finish_reason` (string), `result` (string)

- `loop_detected`: Loop detected during agent execution. _(Note: emitted without `qwen-code.` prefix — pre-existing inconsistency.)_
  - **Attributes**: `loop_type` (string), `prompt_id` (string)

- `kitty_sequence_overflow`: Kitty graphics protocol sequence exceeded buffer size. _(Note: emitted without `qwen-code.` prefix — pre-existing inconsistency.)_
  - **Attributes**: `sequence_length` (int), `truncated_sequence` (string, first 20 chars)

### Metrics

Metrics are numerical measurements of behavior over time. Metric names use the `qwen-code.*` prefix.

#### Core Metrics

- `qwen-code.session.count` (Counter, Int): Incremented once per CLI startup.

- `qwen-code.tool.call.count` (Counter, Int): Counts tool calls.
  - **Attributes**: `function_name`, `success` (boolean), `decision` ("accept"/"reject"/"auto_accept"/"modify", optional), `tool_type` ("mcp"/"native", optional)

- `qwen-code.tool.call.latency` (Histogram, ms): Measures tool call latency.
  - **Attributes**: `function_name` (string)

- `qwen-code.api.request.count` (Counter, Int): Counts all API requests.
  - **Attributes**: `model`, `status_code`, `error_type` (optional)

- `qwen-code.api.request.latency` (Histogram, ms): Measures API request latency.
  - **Attributes**: `model` (string)

- `qwen-code.token.usage` (Counter, Int): Counts tokens used.
  - **Attributes**: `model`, `type` ("input"/"output"/"thought"/"cache")

- `qwen-code.file.operation.count` (Counter, Int): Counts file operations.
  - **Attributes**: `operation` ("create"/"read"/"update"), `lines` (optional), `mimetype` (optional), `extension` (optional), `programming_language` (optional)

- `qwen-code.chat_compression` (Counter, Int): Counts chat compression operations.
  - **Attributes**: `tokens_before` (int), `tokens_after` (int)

- `qwen-code.slash_command.model.call_count` (Counter, Int): Counts model slash command calls.
  - **Attributes**: `slash_command.model.model_name` (string)

- `qwen-code.subagent.execution.count` (Counter, Int): Counts subagent execution events.
  - **Attributes**: `subagent_name`, `status` ("started"/"completed"/"failed"/"cancelled"), `terminate_reason` (optional)

#### Resilience Metrics

- `qwen-code.api.retry.count` (Counter, Int): HTTP-status retries (429/5xx) at LLM call sites.
  - **Attributes**: `model` (string)

- `qwen-code.chat.content_retry.count` (Counter, Int): Retries due to content errors.

- `qwen-code.chat.content_retry_failure.count` (Counter, Int): All content retries exhausted.

- `qwen-code.chat.invalid_chunk.count` (Counter, Int): Invalid chunks from stream.

#### Arena Metrics

- `qwen-code.arena.session.count` (Counter, Int): Arena sessions by status.
  - **Attributes**: `status`, `display_backend` (optional)

- `qwen-code.arena.session.duration` (Histogram, ms): Arena session duration.
  - **Attributes**: `status`

- `qwen-code.arena.agent.count` (Counter, Int): Arena agent completions.
  - **Attributes**: `status`, `model_id`

- `qwen-code.arena.agent.duration` (Histogram, ms): Arena agent execution duration.
  - **Attributes**: `model_id`

- `qwen-code.arena.agent.tokens` (Counter, Int): Token usage by arena agents.
  - **Attributes**: `model_id`, `type` ("input"/"output")

- `qwen-code.arena.result.selected` (Counter, Int): Arena result selections.
  - **Attributes**: `model_id`

#### Auto-Memory Metrics

- `qwen-code.memory.extract.count` (Counter, Int): Auto-memory extraction runs.
  - **Attributes**: `trigger` ("auto"/"manual"), `status`

- `qwen-code.memory.extract.duration` (Histogram, ms): Extraction duration.
  - **Attributes**: `trigger`, `status`

- `qwen-code.memory.dream.count` (Counter, Int): Auto-memory dream runs.
  - **Attributes**: `trigger` ("auto"/"manual"), `status`

- `qwen-code.memory.dream.duration` (Histogram, ms): Dream run duration.
  - **Attributes**: `trigger`, `status`

- `qwen-code.memory.recall.count` (Counter, Int): Auto-memory recall operations.
  - **Attributes**: `strategy` ("none"/"heuristic"/"model")

- `qwen-code.memory.recall.duration` (Histogram, ms): Recall duration.
  - **Attributes**: `strategy`

#### API Request Breakdown

- `qwen-code.api.request.breakdown` (Histogram, ms): API request time breakdown by phase.
  - **Attributes**: `model`, `phase` ("request_preparation"/"network_latency"/"response_processing"/"token_processing")

### Daemon Metrics

The daemon process (long-running HTTP server mode) exposes its own metrics.

> **Note:** The three Observable Gauges (`daemon.session.active`, `daemon.sse.active`, `daemon.process.heap_used`) are callback-based metrics updated at each collection interval; `registerDaemonGaugeCallbacks()` must be invoked during daemon initialization to register the observation callbacks.

#### HTTP

- `qwen-code.daemon.http.request.count` (Counter, Int): Request count by route and status class.
  - **Attributes**: `route`, `status_class` ("2xx"/"4xx"/"5xx")

- `qwen-code.daemon.http.request.duration` (Histogram, ms): Request duration.
  - **Attributes**: `route`
  - **Buckets**: 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000

#### Sessions

- `qwen-code.daemon.session.active` (ObservableGauge, Int): Current active sessions.

- `qwen-code.daemon.session.lifecycle` (Counter, Int): Session lifecycle events.
  - **Attributes**: `action` ("spawn"/"close"/"die")

#### Channels

- `qwen-code.daemon.channel.lifecycle` (Counter, Int): ACP channel lifecycle events.
  - **Attributes**: `action` ("spawn"/"exit"), `expected` (boolean, optional)

#### Prompts

- `qwen-code.daemon.prompt.queue_wait` (Histogram, ms): Prompt FIFO queue wait time.
  - **Buckets**: 1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 30000, 60000

- `qwen-code.daemon.prompt.duration` (Histogram, ms): End-to-end prompt duration.
  - **Buckets**: 100, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000, 600000

#### Errors

- `qwen-code.daemon.bridge.error.count` (Counter, Int): Bridge errors by type.
  - **Attributes**: `error_type` (known class name or "unknown")

- `qwen-code.daemon.cancel.count` (Counter, Int): Cancel request count.

#### Resources

- `qwen-code.daemon.sse.active` (ObservableGauge, Int): Active SSE connections.

- `qwen-code.daemon.process.heap_used` (ObservableGauge, Int, bytes): Heap memory usage.

### Spans

Distributed tracing spans form a tree rooted at `qwen-code.interaction`. Each interaction is a trace root with its own `traceId`; cross-prompt correlation uses the `session.id` attribute.

- `qwen-code.interaction`: Root span for each user prompt turn.
  - **Attributes**: `session.id`, `qwen-code.prompt_id`, `qwen-code.message_type`, `qwen-code.model`, `qwen-code.approval_mode`, `interaction.sequence`, `interaction.duration_ms`, `qwen-code.turn_status` ("ok"/"error"/"cancelled")

- `qwen-code.llm_request`: Wraps a single LLM API call.
  - **Attributes**: `session.id`, `qwen-code.model`, `qwen-code.prompt_id`, `llm_request.context` ("subagent"/"interaction"/"standalone"), `gen_ai.request.model`, `duration_ms`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `ttft_ms`, `request_setup_ms`, `attempt`, `retry_total_delay_ms`, `sampling_ms`, `output_tokens_per_second`, `success`, `error`, `response_id`, `finish_reason`, `thoughts_token_count`, `subagent_name`, `error_type`, `error_status_code`

- `qwen-code.tool`: Wraps the full tool lifecycle (approval wait + execution).
  - **Attributes**: `session.id`, `tool.name`, `duration_ms`, `success`, `error`

- `qwen-code.tool.execution`: Wraps the tool execution phase (after approval).
  - **Attributes**: `session.id`, `duration_ms`, `success`, `error`

- `qwen-code.tool.blocked_on_user`: Time a tool spends waiting on user approval.
  - **Attributes**: `session.id`, `tool.name`, `tool.call_id`, `duration_ms`, `decision` ("proceed_once"/"proceed_always"/"cancel"/"aborted"/"auto_approved"/"error"), `source` ("cli"/"ide"/"hook"/"auto"/"system")

- `qwen-code.hook`: Wraps each pre/post-tool-use hook fire site.
  - **Attributes**: `session.id`, `hook_event` ("PreToolUse"/"PostToolUse"/"PostToolUseFailure"/"PostToolBatch"), `tool.name`, `tool.use_id` (optional), `is_interrupt` (boolean, optional), `duration_ms`, `success`, `should_proceed` (optional), `should_stop` (optional), `block_type` (optional), `error` (optional)

- `qwen-code.subagent`: Wraps a single subagent invocation.
  - **Attributes**: `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.conversation.id`, `qwen-code.subagent.id`, `qwen-code.subagent.name`, `qwen-code.subagent.invocation_kind` ("foreground"/"fork"/"background"), `qwen-code.subagent.is_built_in`, `qwen-code.subagent.depth`, `qwen-code.subagent.status`, `qwen-code.subagent.terminate_reason`, `qwen-code.subagent.duration_ms`

- `qwen-code.daemon.request`: Wraps a daemon HTTP request.
  - **Attributes**: `http.request.method`, `http.route`, `qwen-code.daemon.operation`, `session.id`, `http.response.status_code`

- `qwen-code.daemon.bridge`: Wraps daemon bridge operations.
  - **Attributes**: `qwen-code.daemon.operation`

#### Resource Metrics

- `qwen-code.memory.usage` (Histogram, bytes): Memory usage. Recorded by the memory-pressure monitor when telemetry is enabled.
  - **Attributes**: `memory_type` (string: "heap_used"/"rss")

- `qwen-code.cpu.usage` (Histogram, percent): CPU usage percentage. Recorded by the memory-pressure monitor when telemetry is enabled.
  - **Attributes**: (none)

### Performance Monitoring (Reserved)

The following metrics are defined but **not yet enabled in production**. They will be activated behind a dedicated performance monitoring config flag.

- `qwen-code.startup.duration` (Histogram, ms): CLI startup time by phase.
  - **Attributes**: `phase` (string)

- `qwen-code.tool.queue.depth` (Histogram, count): Tools in execution queue.

- `qwen-code.tool.execution.breakdown` (Histogram, ms): Tool execution time by phase.
  - **Attributes**: `function_name`, `phase` ("validation"/"preparation"/"execution"/"result_processing")

- `qwen-code.token.efficiency` (Histogram, ratio): Token efficiency metrics.
  - **Attributes**: `model`, `metric`, `context` (optional)

- `qwen-code.performance.score` (Histogram, score): Composite performance score (0-100).
  - **Attributes**: `category`, `baseline` (optional)

- `qwen-code.performance.regression` (Counter, Int): Regression detection events.
  - **Attributes**: `metric`, `severity` ("low"/"medium"/"high"), `current_value`, `baseline_value`

- `qwen-code.performance.regression.percentage_change` (Histogram, percent): Percentage change vs baseline.
  - **Attributes**: `metric`, `severity`, `current_value`, `baseline_value`

- `qwen-code.performance.baseline.comparison` (Histogram, percent): Performance vs baseline.
  - **Attributes**: `metric`, `category`, `current_value`, `baseline_value`
