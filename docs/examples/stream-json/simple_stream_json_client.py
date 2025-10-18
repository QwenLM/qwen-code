#!/usr/bin/env python3
"""Demonstration script using the lightweight stream-json pseudo SDK."""

import asyncio
import sys

sys.path.append("docs/examples/stream-json")

from sdk import StreamJsonClient, StreamJsonClientOptions


async def main() -> None:
    client = StreamJsonClient(StreamJsonClientOptions())
    await client.run()


if __name__ == "__main__":
    asyncio.run(main())
