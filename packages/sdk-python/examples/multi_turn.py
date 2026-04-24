"""Multi-turn conversation example for qwen-code Python SDK.

Demonstrates streaming messages to the query.
"""

import asyncio
from qwen_code import query, SDKUserMessage, is_sdk_assistant_message, is_sdk_result_message


async def main():
    """Run a multi-turn conversation."""
    print("=== Multi-turn Conversation Demo ===\n")

    # Multi-turn query (synchronous call, like TS-SDK)
    messages = [
        SDKUserMessage(
            session_id="my-session",
            message={"role": "user", "content": "List 3 popular Python web frameworks"},
            parent_tool_use_id=None,
        ),
        SDKUserMessage(
            session_id="my-session",
            message={"role": "user", "content": "Now list their key features"},
            parent_tool_use_id=None,
        ),
    ]

    q = query(messages)

    print("Streaming responses:\n")

    async for message in q:
        if is_sdk_assistant_message(message):
            content = message.get("message", {}).get("content", "")
            if content:
                print(f"Assistant: {content}\n")
        elif is_sdk_result_message(message):
            result_text = message.get("result", "")
            if result_text:
                print(f"Result: {result_text}\n")

    print("Conversation completed!")


if __name__ == "__main__":
    asyncio.run(main())
