# MCP model-payload filtering

## Goal

Prevent `packages/cua-driver` and `packages/mobile-mcp` from returning known
vendor terms in textual MCP payloads while preserving the real local values
needed to operate apps, windows, devices, and packages.

Filtering is opt-in and disabled by default. Set
`MCP_MODEL_PAYLOAD_FILTER=1` in the MCP server environment for API routes that
reject these terms. Users on other routes retain the original payloads.

The initial case-insensitive ASCII terms are `qwen`, `dashscope`, `alibaba`,
`aliyun`, `aliyuncs`, `alicloud`, `tongyi`, `qianwen`, `antgroup`, `bailian`,
`modelscope`, `damo`, `lingma`, `wanx`, `alipay`, `antfin`, `yuque`,
`dingtalk`, `taobao`, `tmall`, `qoder`, and `maxcompute`. Chinese terms are
matched exactly: `通义`, `千问`, `阿里`, `百炼`, `魔搭`, `达摩`, `灵码`,
`万相`, `支付宝`, `蚂蚁`, `语雀`, `钉钉`, `淘宝`, and `天猫`.
Separator variants are also matched for multi-part names, such as `q-wen`,
`dash_scope`, `ali cloud`, `qian-wen`, and `ant_group`.

## Encoding

Each matched substring is replaced with a stateless token containing its UTF-8
hex bytes. For example, a filtered app name remains readable around the token,
and returning that value to the same MCP server restores the exact original
substring before tool validation and execution. This avoids a session map and
keeps app/package/path round trips working after process restarts.

JSON-RPC ids and methods are never transformed. Object keys and textual values
inside result, error, and notification payloads are transformed recursively.
Image and audio `data` fields are preserved byte-for-byte.

## Component boundaries

In cua-driver, `Response::ok` and `Response::error` are the shared model-facing
boundary for direct stdio, HTTP, and daemon-proxy MCP responses. Tool-call names
and arguments are decoded in `Request::tool_call` before dispatch. Both
directions apply the transform only when `MCP_MODEL_PAYLOAD_FILTER=1`.

In mobile-mcp, a transport wrapper encodes outgoing JSON-RPC payloads and
decodes incoming payloads before the SDK performs schema validation. A small
`McpServer` subclass applies the wrapper to stdio, SSE, in-memory tests, and
future transports when `MCP_MODEL_PAYLOAD_FILTER=1`; otherwise it connects the
original transport unchanged.

## Non-goals

This does not rename installed apps, processes, bundles, npm packages, signing
identities, repositories, or distribution URLs. It does not transform stderr,
telemetry, or build logs. Image bytes are preserved, so OCR-based filtering is
outside this textual-payload guarantee.

Aliases are decoded only when returned to the same MCP component. Passing an
alias to a shell or another server does not recover the local value.

## Verification

- Unit-test every term, mixed case, Chinese text, nested objects and keys,
  invalid tokens, exact round trips, and binary-content preservation.
- Verify that the model-facing boundary is unchanged by default and filtered
  only when `MCP_MODEL_PAYLOAD_FILTER=1` is present.
- Exercise real MCP initialize, tools/list, success, structured success, and
  error responses for both components.
- Re-run the observed cua permission, health, app, and window payloads and the
  deterministic mobile error echo.
