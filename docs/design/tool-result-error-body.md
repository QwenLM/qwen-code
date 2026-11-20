# Preserve the body of a tool failure

[English](tool-result-error-body.md) | [简体中文](tool-result-error-body.zh-CN.md)

## Problem

An MCP tool can finish and return `isError: true` with a business error code and recovery instructions. Wrapping that text with the call arguments and a serialized response makes the next model request harder to interpret. The MCP SDK also wraps failed responses from its callable tool adapter, so both MCP entry points need to read the enclosed content.

## Result handling

- Add optional `ToolResult.isError` for producers that return a failure body in `llmContent`. MCP uses its normal text, structured content, and media processing for these results. Calls from an MCP App continue to deliver the raw response to the app and a short summary to the session.
- Core and ACP use the existing failure status, failure hook, and function response error field. They carry the tool's body through that field and supply a short message when there is no text. Existing execution exceptions still use `ToolResult.error`.
- Shell uses its existing exit code rules. Text printed by a process that exits successfully, including a confirmation prompt, is treated as command output.

## Validation

Compare the next model request, tool status, and failure hook on CLI and ACP with the same MCP result. Check ACP session reload and cover empty results, images, and shell exit semantics.
