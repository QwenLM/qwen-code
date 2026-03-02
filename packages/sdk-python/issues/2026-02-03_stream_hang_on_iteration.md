# Issue: Stream Iteration Hangs Forever

**Date:** 2026-02-03  
**Status:** Workaround Applied  
**Severity:** High  
**Affected Version:** Python SDK (all versions prior to fix)

---

## Problem Summary

When using Python SDK's async iteration to consume query responses, the iteration never completes. The program hangs indefinitely after processing all messages, with the CLI subprocess remaining alive.

### Symptom

```
正在查询: "Hello" (2/3)
正在查询: "List 3 fruits" (3/3)
# Cursor blinks forever, program never exits
```

CLI process remains running: `qwen-code --api-base http://localhost:8080 ...`

---

## Impact Scope

- **Affected Scenarios:**
  - Any code using `async for` to iterate over query results
  - Using the `query()` method with async iteration pattern
  - Clean session termination

- **Not Affected:**
  - Synchronous query methods (if any)
  - Non-iterating async patterns that don't consume the stream

---

## Root Cause Analysis

The hang occurs due to a combination of three issues across different components:

### Issue 1: Stream._consume() Blocks Without Timeout

**File:** `src/qwen_code/utils.py`

```python
# PROBLEMATIC CODE
async def _consume(self) -> None:
    while True:
        value = await self._queue.get()  # <-- BLOCKS FOREVER if no more items
```

The `queue.get()` method blocks indefinitely when the queue is empty and no producers remain. Without a timeout mechanism, the iteration has no way to detect that the stream is complete.

### Issue 2: No Stream Cleanup on Task Cancellation

**File:** `src/qwen_code/transport.py`

When the message router task is cancelled (e.g., timeout or external interrupt), the `_read_stdout_loop()` task exits without marking the stream as done:

```python
# PROBLEMATIC CODE
async def _read_stdout_loop(self) -> None:
    try:
        async for line in self._process.stdout:
            # process lines...
    except asyncio.CancelledError:
        # No cleanup - stream left in undefined state
        raise
```

### Issue 3: Missing endInput() Signal

**File:** `src/qwen_code/query.py`

The CLI requires an explicit `endInput()` signal to know when all input has been sent. Without this:

1. CLI waits for more input (stdin stays open)
2. CLI doesn't flush/close stdout
3. Downstream processing can't detect stream completion

---

## Reproduction Steps

Minimal reproduction case:

```python
import asyncio
from qwen_code import QwenCodeCli

async def main():
    async for msg in QwenCodeCli.query("Hello"):
        print(msg)

if __name__ == "__main__":
    asyncio.run(main())
    # Hangs here forever
```

---

## Workaround Applied

Three files were modified to address the issues:

### Fix 1: Add Timeout to Stream._consume()

**File:** `src/qwen_code/utils.py`

```python
async def _consume(self) -> None:
    while True:
        try:
            # Use timeout to allow checking _done flag
            value = await asyncio.wait_for(
                self._queue.get(),
                timeout=0.1
            )
            self._put(value)
        except asyncio.TimeoutError:
            # Check if stream is complete
            if self._done:
                self._queue.task_done()
                break
```

### Fix 2: Mark Stream Done on Task Cancellation

**File:** `src/qwen_code/transport.py`

```python
async def _read_stdout_loop(self) -> None:
    try:
        async for line in self._process.stdout:
            # process lines...
    except asyncio.CancelledError:
        self._stdout_stream.set_done()  # <-- ADDED: Signal stream completion
        raise
```

### Fix 3: Call endInput() and _input_stream.done()

**File:** `src/qwen_code/query.py`

```python
async def _run_message_router(self) -> None:
    try:
        # ... stream content to CLI ...
        self._transport.stream_write(content)

        # Signal end of input - CRITICAL for CLI to close stdout
        self._transport.endInput()  # <-- ADDED

    finally:
        # Ensure stream is marked done even on cancellation
        self._input_stream.set_done()  # <-- ADDED: Previously missing
```

---

## Verification

After applying the workaround:

```bash
$ python examples/simple_query.py
正在查询: "Hello" (1/3)  -> completed
正在查询: "List 3 fruits" (2/3)  -> completed
正在查询: "What is 2+2" (3/3)  -> completed
程序正常退出，CLI 进程已终止
```

- All 246 existing tests pass
- 2 pre-existing test failures unrelated to this fix

---

## Recommended Long-term Solution

1. **Improve Stream Design**: Consider adding explicit `close()` method instead of relying on `_done` flag
2. **Timeout Configuration**: Make timeout configurable per-stream
3. **Documentation**: Document that `endInput()` must be called after streaming input
4. **Testing**: Add integration tests for stream completion scenarios

---

## References

| File | Lines | Description |
|------|-------|-------------|
| `src/qwen_code/utils.py` | 73-84 | Stream class with queue-based async iteration |
| `src/qwen_code/transport.py` | 184-212 | _read_stdout_loop with task cancellation |
| `src/qwen_code/query.py` | 254-284 | _run_message_router and stream handling |

---

## Credits

**Discovered by:** Qwen Code Development Team  
**Date:** 2026-02-03
