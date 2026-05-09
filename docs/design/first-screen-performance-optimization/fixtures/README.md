# Benchmark fixtures

Each subdirectory is a self-contained `QWEN_HOME` for use with `scripts/benchmark-startup.mjs`. The benchmark sets `QWEN_HOME` and `HOME` to the fixture dir so qwen-code reads its settings from there.

| Fixture            | Purpose                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `no-mcp/`          | No MCP servers; pure baseline.                                   |
| `one-fast-mcp/`    | 1 local stdio MCP server that responds in < 50 ms.               |
| `three-mixed-mcp/` | 2 fast servers + 1 deliberately slow (sleep 5 s) server.         |
| `flaky-mcp/`       | 1 server that never responds (validates timeout / non-blocking). |

Fixture MCP server implementations live next to the fixture (`mcp-servers/*.mjs`). They speak only the minimum subset of the MCP stdio protocol needed for `client.connect()` and `client.discover()` to complete.
