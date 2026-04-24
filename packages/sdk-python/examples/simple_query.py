"""Simple query example for qwen-code Python SDK.

Demonstrates basic single-turn query functionality.
"""

import asyncio
from qwen_code import query, is_sdk_assistant_message, is_sdk_result_message


async def main():
    """Run a simple query."""
    print("=== Simple Query Demo ===\n")

    # Single-turn query (synchronous call, like TS-SDK)
    q = query("List 3 popular Python web frameworks")

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

    print("Query completed!")


if __name__ == "__main__":
    asyncio.run(main())
