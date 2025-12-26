# Observability with OpenTelemetry

Learn how to enable and setup OpenTelemetry for Qwen Code.

- [Observability with OpenTelemetry](#observability-with-opentelemetry)
  - [Key Benefits](#key-benefits)
  - [OpenTelemetry Integration](#opentelemetry-integration)
  - [Configuration](#configuration)
  - [Aliyun Telemetry](#aliyun-telemetry)
    - [Prerequisites](#prerequisites)
    - [Direct Export (Recommended)](#direct-export-recommended)
  - [Local Telemetry](#local-telemetry)
    - [File-based Output (Recommended)](#file-based-output-recommended)
    - [Collector-Based Export (Advanced)](#collector-based-export-advanced)
  - [Logs and Metrics](#logs-and-metrics)
    - [Logs](#logs)
    - [Metrics](#metrics)

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

## Configuration

> [!note]
>
> **⚠️ Special Note: This feature requires corresponding code changes. This documentation is provided in advance; please refer to future code updates for actual functionality.**

All telemetry behavior is controlled through your `.qwen/settings.json` file.
These settings can be overridden by environment variables or CLI flags.

| Setting        | Environment Variable           | CLI Flag                                                 | Description                                       | Values             | Default                 |
| -------------- | ------------------------------ | -------------------------------------------------------- | ------------------------------------------------- | ------------------ | ----------------------- |
| `enabled`      | `QWEN_TELEMETRY_ENABLED`       | `--telemetry` / `--no-telemetry`                         | Enable or disable telemetry                       | `true`/`false`     | `false`                 |
| `target`       | `QWEN_TELEMETRY_TARGET`        | `--telemetry-target <local\|qwen>`                       | Where to send telemetry data                      | `"qwen"`/`"local"` | `"local"`               |
| `otlpEndpoint` | `QWEN_TELEMETRY_OTLP_ENDPOINT` | `--telemetry-otlp-endpoint <URL>`                        | OTLP collector endpoint                           | URL string         | `http://localhost:4317` |
| `otlpProtocol` | `QWEN_TELEMETRY_OTLP_PROTOCOL` | `--telemetry-otlp-protocol <grpc\|http>`                 | OTLP transport protocol                           | `"grpc"`/`"http"`  | `"grpc"`                |
| `outfile`      | `QWEN_TELEMETRY_OUTFILE`       | `--telemetry-outfile <path>`                             | Save telemetry to file (overrides `otlpEndpoint`) | file path          | -                       |
| `logPrompts`   | `QWEN_TELEMETRY_LOG_PROMPTS`   | `--telemetry-log-prompts` / `--no-telemetry-log-prompts` | Include prompts in telemetry logs                 | `true`/`false`     | `true`                  |
| `useCollector` | `QWEN_TELEMETRY_USE_COLLECTOR` | -                                                        | Use external OTLP collector (advanced)            | `true`/`false`     | `false`                 |

**Note on boolean environment variables:** For the boolean settings (`enabled`,
`logPrompts`, `useCollector`), setting the corresponding environment variable to
`true` or `1` will enable the feature. Any other value will disable it.

For detailed information about all configuration options, see the
[Configuration Guide](./cli/configuration.md).

## Aliyun Telemetry

### Direct Export (Recommended)

Sends telemetry directly to Aliyun services. No collector needed.

1. Enable telemetry in your `.qwen/settings.json`:
   ```json
   {
     "telemetry": {
       "enabled": true,
       "target": "qwen"
     }
   }
   ```
2. Run Qwen Code and send prompts.
3. View logs and metrics in the Aliyun Console.

## Local Telemetry

For local development and debugging, you can capture telemetry data locally:

### File-based Output (Recommended)

1. Enable telemetry in your `.qwen/settings.json`:
   ```json
   {
     "telemetry": {
       "enabled": true,
       "target": "local",
       "otlpEndpoint": "",
       "outfile": ".qwen/telemetry.log"
     }
   }
   ```
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

The following section describes the structure of logs and metrics generated for
Qwen Code.

- A `sessionId` is included as a common attribute on all logs and metrics.

### Logs

Logs are timestamped records of specific events. The following events are logged for Qwen Code:

- `qwen-code.config`: This event occurs once at startup with the CLI's configuration.
  - **Attributes**:
    - `model` (string)
    - `embedding_model` (string)
    - `sandbox_enabled` (boolean)
    - `core_tools_enabled` (string)
    - `approval_mode` (string)
    - `api_key_enabled` (boolean)
    - `vertex_ai_enabled` (boolean)
    - `code_assist_enabled` (boolean)
    - `log_prompts_enabled` (boolean)
    - `file_filtering_respect_git_ignore` (boolean)
    - `debug_mode` (boolean)
    - `mcp_servers` (string)
    - `output_format` (string: "text" or "json")

- `qwen-code.user_prompt`: This event occurs when a user submits a prompt.
  - **Attributes**:
    - `prompt_length` (int)
    - `prompt_id` (string)
    - `prompt` (string, this attribute is excluded if `log_prompts_enabled` is
      configured to be `false`)
    - `auth_type` (string)

- `qwen-code.tool_call`: This event occurs for each function call.
  - **Attributes**:
    - `function_name`
    - `function_args`
    - `duration_ms`
    - `success` (boolean)
    - `decision` (string: "accept", "reject", "auto_accept", or "modify", if
      applicable)
    - `error` (if applicable)
    - `error_type` (if applicable)
    - `content_length` (int, if applicable)
    - `metadata` (if applicable, dictionary of string -> any)

- `qwen-code.file_operation`: This event occurs for each file operation.
  - **Attributes**:
    - `tool_name` (string)
    - `operation` (string: "create", "read", "update")
    - `lines` (int, if applicable)
    - `mimetype` (string, if applicable)
    - `extension` (string, if applicable)
    - `programming_language` (string, if applicable)
    - `diff_stat` (json string, if applicable): A JSON string with the following members:
      - `ai_added_lines` (int)
      - `ai_removed_lines` (int)
      - `user_added_lines` (int)
      - `user_removed_lines` (int)

- `qwen-code.api_request`: This event occurs when making a request to Qwen API.
  - **Attributes**:
    - `model`
    - `request_text` (if applicable)

- `qwen-code.api_error`: This event occurs if the API request fails.
  - **Attributes**:
    - `model`
    - `error`
    - `error_type`
    - `status_code`
    - `duration_ms`
    - `auth_type`

- `qwen-code.api_response`: This event occurs upon receiving a response from Qwen API.
  - **Attributes**:
    - `model`
    - `status_code`
    - `duration_ms`
    - `error` (optional)
    - `input_token_count`
    - `output_token_count`
    - `cached_content_token_count`
    - `thoughts_token_count`
    - `tool_token_count`
    - `response_text` (if applicable)
    - `auth_type`

- `qwen-code.tool_output_truncated`: This event occurs when the output of a tool call is too large and gets truncated.
  - **Attributes**:
    - `tool_name` (string)
    - `original_content_length` (int)
    - `truncated_content_length` (int)
    - `threshold` (int)
    - `lines` (int)
    - `prompt_id` (string)

- `qwen-code.malformed_json_response`: This event occurs when a `generateJson` response from Qwen API cannot be parsed as a json.
  - **Attributes**:
    - `model`

- `qwen-code.flash_fallback`: This event occurs when Qwen Code switches to flash as fallback.
  - **Attributes**:
    - `auth_type`

- `qwen-code.slash_command`: This event occurs when a user executes a slash command.
  - **Attributes**:
    - `command` (string)
    - `subcommand` (string, if applicable)

- `qwen-code.extension_enable`: This event occurs when an extension is enabled
- `qwen-code.extension_install`: This event occurs when an extension is installed
  - **Attributes**:
    - `extension_name` (string)
    - `extension_version` (string)
    - `extension_source` (string)
    - `status` (string)
- `qwen-code.extension_uninstall`: This event occurs when an extension is uninstalled

### Metrics

Metrics are numerical measurements of behavior over time. The following metrics are collected for Qwen Code (metric names remain `qwen-code.*` for compatibility):

- `qwen-code.session.count` (Counter, Int): Incremented once per CLI startup.

- `qwen-code.tool.call.count` (Counter, Int): Counts tool calls.
  - **Attributes**:
    - `function_name`
    - `success` (boolean)
    - `decision` (string: "accept", "reject", or "modify", if applicable)
    - `tool_type` (string: "mcp", or "native", if applicable)

- `qwen-code.tool.call.latency` (Histogram, ms): Measures tool call latency.
  - **Attributes**:
    - `function_name`
    - `decision` (string: "accept", "reject", or "modify", if applicable)

- `qwen-code.api.request.count` (Counter, Int): Counts all API requests.
  - **Attributes**:
    - `model`
    - `status_code`
    - `error_type` (if applicable)

- `qwen-code.api.request.latency` (Histogram, ms): Measures API request latency.
  - **Attributes**:
    - `model`

- `qwen-code.token.usage` (Counter, Int): Counts the number of tokens used.
  - **Attributes**:
    - `model`
    - `type` (string: "input", "output", "thought", "cache", or "tool")

- `qwen-code.file.operation.count` (Counter, Int): Counts file operations.
  - **Attributes**:
    - `operation` (string: "create", "read", "update"): The type of file operation.
    - `lines` (Int, if applicable): Number of lines in the file.
    - `mimetype` (string, if applicable): Mimetype of the file.
    - `extension` (string, if applicable): File extension of the file.
    - `model_added_lines` (Int, if applicable): Number of lines added/changed by the model.
    - `model_removed_lines` (Int, if applicable): Number of lines removed/changed by the model.
    - `user_added_lines` (Int, if applicable): Number of lines added/changed by user in AI proposed changes.
    - `user_removed_lines` (Int, if applicable): Number of lines removed/changed by user in AI proposed changes.
    - `programming_language` (string, if applicable): The programming language of the file.

- `qwen-code.chat_compression` (Counter, Int): Counts chat compression operations
  - **Attributes**:
    - `tokens_before`: (Int): Number of tokens in context prior to compression
    - `tokens_after`: (Int): Number of tokens in context after compression
