# Critical Bug Fix Report: MCP OAuth Token Race Condition

## Summary
Fixed a high-severity race condition in the OAuth token refresh logic that could cause authentication state corruption and service disruption for users with OAuth-enabled MCP servers.

## Bug Details

### Impact
- **Data Loss**: Valid OAuth tokens could be deleted from storage
- **Service Disruption**: Users forced to re-authenticate unexpectedly
- **User Impact**: Work interruption, potential loss of in-progress tasks

### Root Cause
The `getValidToken` method in `packages/core/src/mcp/oauth-provider.ts` had a classic TOCTOU (Time-of-check-time-of-use) race condition:

1. Multiple concurrent tool calls could trigger `getValidToken` simultaneously when a token expires
2. All calls would see the same expired token and proceed to refresh independently
3. If one refresh succeeded and saved a valid token, but another failed (rate limit, network issue)
4. The failed call would execute `removeToken(serverName)`, deleting the valid token saved by the successful call
5. Result: Authentication state corrupted, all subsequent calls fail auth

### Concrete Trigger Scenario
```
Time T: Token for "production-api" expires
Time T+1ms: User runs command triggering 5 parallel tool calls to production-api
Time T+2ms: All 5 calls hit getValidToken, all see expired token
Time T+3ms: All 5 attempt refresh simultaneously
Time T+100ms: 4 calls succeed and save tokens, 1 fails due to rate limiting
Time T+101ms: Failed call executes removeToken("production-api")
Time T+102ms: ALL 4 successful tokens are deleted
Result: User's auth state corrupted, must re-authenticate
```

## Fix Implementation

### Changes Made
1. **Added refresh locking**: Per-server promise-based lock to prevent concurrent refresh attempts
2. **Safe deletion logic**: Re-check token state before deletion to avoid removing valid tokens
3. **Added test coverage**: New test case verifying concurrent call handling

### Code Changes
File: `packages/core/src/mcp/oauth-provider.ts`

```typescript
// Module-level lock map
const refreshLocks: Map<string, Promise<string | null>> = new Map();

// Modified getValidToken to:
// 1. Check for existing refresh promise before starting new one
// 2. Wrap refresh logic in async IIFE with proper lock cleanup in finally
// 3. Re-check token validity before calling removeToken on failure
```

### Validation
- Added comprehensive test: `should prevent concurrent refresh attempts and avoid deleting valid tokens`
- Test simulates two concurrent calls with one success/one failure scenario
- Verifies: both calls return valid token, saveToken called once, removeToken NOT called

## Confidence Assessment
- **Confidence Level**: HIGH
- **Reasoning**: 
  - Clear, reproducible trigger scenario
  - Fix is minimal and focused on the specific race condition
  - Test coverage validates the fix under concurrent conditions
  - No changes to external API or behavior, only internal synchronization

## Files Modified
1. `packages/core/src/mcp/oauth-provider.ts` - Fixed race condition in getValidToken
2. `packages/core/src/mcp/oauth-provider.test.ts` - Added regression test

## Additional Findings (Lower Priority)
While investigating, two other potential issues were identified but not addressed as they are lower severity:

1. **Resource leak in OAuth retry path** (`mcp-client.ts`): mcpClient not closed on certain OAuth retry failures. Lower priority because it requires repeated failures to manifest.

2. **Trust flag bypass** (`mcp-tool.ts`): Servers with `trust: true` skip confirmation dialogs. This appears to be intentional design for trusted servers, though config file compromise could be a concern.

## Recommendation
Merge this fix immediately as it addresses a critical correctness bug that affects all users with OAuth-enabled MCP servers. The fix is minimal, well-tested, and has no breaking changes.
