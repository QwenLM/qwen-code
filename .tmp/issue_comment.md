## Root Cause Analysis & Fix Available

I encountered the same errors and tracked down the root cause. The issue is in the message format conversion process in `packages/core/src/core/openaiContentGenerator.ts`.

### Technical Root Cause
Tool results are being serialized with `role: "user"` instead of `role: "tool"` during Gemini-to-OpenAI format conversion. This violates the OpenAI API specification that requires tool responses to have `role: "tool"` with a `tool_call_id`.

### Evidence
I added debug instrumentation that dumps message payloads to `.debug/` files. Here's what shows the bug:

**Current (incorrect) serialization:**
```json
{
  "role": "user",               // ❌ Wrong - causes the 400 error you're seeing
  "parts": [
    {
      "functionResponse": {
        "id": "call_ikfws9zl", 
        "name": "read_many_files",
        "response": {...}
      }
    }
  ]
}
```

**Expected (correct) serialization:**
```json
{
  "role": "tool",               // ✅ Correct
  "tool_call_id": "call_ikfws9zl",
  "content": "{...stringified response...}"
}
```

### Why This Causes Your 400 Error
The OpenAI API validates that every assistant message with `tool_calls` is followed by corresponding tool messages (with `role: "tool"` and matching `tool_call_id`). When tool responses get labeled as `role: "user"`, the API can't match them up and throws:

```
InternalError.Algo.InvalidParameter: An assistant message with "tool_calls" must be followed by tool messages responding to each "tool_call_id"
```

### Location of Bug
**File:** `packages/core/src/core/openaiContentGenerator.ts`  
**Lines:** ~821-858 (fallback role assignment logic)

The issue is in the else-fallback that defaults non-model content to `role: "user"` instead of properly handling `functionResponse` parts.

### Fix Status
I'm preparing a PR with:
1. ✅ Corrected role assignment for tool results
2. ✅ Regression test to prevent recurrence  
3. ✅ Debug instrumentation to help diagnose similar issues

The fix ensures only genuine human input gets `role: "user"` while tool results properly get `role: "tool"`.

**Branch:** `fix/tool-role-serialization` (will reference this issue in PR)