# Daemon ACP HTTP pre-attach bounds

## Scope

Verify that connection/session responses produced before an ACP HTTP SSE or WebSocket owner is ready are bounded by serialized bytes and frame count across every workspace mount. The test does not claim to bound ordinary live transport queues or transient `JSON.stringify` amplification.

## Baseline

Run the harness against the parent of this change. Initialize one ACP HTTP connection without attaching its response stream, then make the fake bridge produce 128 distinct 1 MiB results. Confirm retained heap/RSS grows with every payload and that the connection remains registered. Repeat with primary and dynamic workspace connections to confirm their retained buffers add together without a daemon-global boundary.

## Verification

1. Start `qwen serve` with ACP HTTP enabled, one primary workspace, and one dynamically registered trusted workspace.
2. For each workspace, initialize a logical connection but delay its connection/session stream attachment.
3. Produce distinct large responses until the per-connection 64 MiB boundary is crossed. Expect only the admitting connection to close; a shared WebSocket must receive close code 1013. Confirm the other workspace can still initialize, open a stream, and complete a small request.
4. With several connections below their individual limits, compete for the shared 4,096-frame/256-MiB budget. Expect the connection attempting the global N+1 admission to close without evicting frames from another connection.
5. Attach a deliberately stalled SSE writer after frames are buffered. Confirm status moves the frames from buffered to pending delivery while `usedFrames` and `usedBytes` remain charged. Close the socket, settle the write, and confirm all counters return to the pre-test baseline.
6. Buffer several successful `session/new`, `session/load`, `session/resume`, or `session/fork` results, then close or overflow the connection before delivery. Confirm fresh sessions and persisted forks are removed, newly attached clients are detached, existing ownership remains intact, and none of the provisional sessions accept a prompt before response delivery.
7. Send notification forms of `session/new`, `session/load`, `session/resume`, and `session/fork`. Confirm no session is created, restored, attached, or forked.
8. Read `GET /daemon/status?detail=full`. Verify fixed limits, global current/high-water count and bytes, pending-delivery frames, guard failures, per-mount failure attribution, and per-connection owned count/bytes.
9. Remove the dynamic workspace and close all test connections. Confirm global budget usage returns to the primary baseline.

## Commands

```bash
(cd packages/acp-bridge && npx vitest run src/bridge.test.ts src/spawnChannel.test.ts)
(cd packages/cli && npx vitest run src/serve/acp-http/pre-attach-budget.test.ts src/serve/acp-http/connection-registry.test.ts src/serve/acp-http/sse-stream.test.ts src/serve/acp-http/ws-stream.test.ts src/serve/acp-http/transport.test.ts src/serve/daemon-status.test.ts)
(cd packages/sdk-typescript && npx vitest run test/unit/daemon-public-surface.test.ts)
npm run build && npm run typecheck && npm run lint
git diff --check
```
