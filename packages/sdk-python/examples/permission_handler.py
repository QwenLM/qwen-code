"""Custom permission handler example for qwen-code Python SDK.

Demonstrates how to implement a custom permission callback for tool execution.
"""

import asyncio
from qwen_code import query, PermissionResult, is_sdk_assistant_message, is_sdk_result_message


async def can_use_tool(tool_name: str, input_data: dict, context: dict) -> PermissionResult:
    """Custom permission handler.

    Args:
        tool_name: Name of the tool being requested
        input_data: Tool input parameters
        context: Additional context (e.g., permission suggestions)

    Returns:
        PermissionResult indicating allow/deny decision
    """
    # Allow all read operations
    if tool_name.startswith("read_"):
        print(f"[Permission] Auto-allowing read tool: {tool_name}")
        return PermissionResult(behavior="allow", updated_input=input_data)

    # For write operations, use strict mode (deny by default)
    print(f"[Permission] Denying write tool: {tool_name}")
    return PermissionResult(
        behavior="deny",
        message=f"Permission denied for: {tool_name}"
    )


async def main():
    """Run a query with custom permission handler."""
    print("=== Custom Permission Handler Demo ===\n")
    print("Note: Write tools will be denied, read tools will be allowed.\n")

    # Query with permission callback (synchronous call)
    q = query(
        "Read the current directory and list files, then try to create a new file",
        can_use_tool=can_use_tool,
    )

    print("\nStreaming responses:\n")

    async for message in q:
        if is_sdk_assistant_message(message):
            content = message.get("message", {}).get("content", "")
            if content:
                print(f"Assistant: {content}\n")
        elif is_sdk_result_message(message):
            result_text = message.get("result", "")
            if result_text:
                print(f"Result: {result_text}\n")

    print("Query completed!")


if __name__ == "__main__":
    asyncio.run(main())
