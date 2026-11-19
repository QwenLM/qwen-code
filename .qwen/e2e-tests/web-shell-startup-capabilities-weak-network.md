# Startup capabilities on a weak connection

Use a standalone Web Shell production build against a controlled daemon/proxy.

1. Flush successful `/capabilities` headers, then stall the body. The authentication gate should mount unseeded after about 250 ms and let the workspace fetch normally; it must not display an authentication/network failure or retry the auth probe after 10 seconds.
2. Send a complete valid body promptly. Workspace initialization must reuse it without another serial capabilities request.
3. Repeat with malformed JSON, bootstrap-only capabilities and managed-mode responses. Authenticate but use the ordinary workspace fetch.
4. While the first successful response body is stalled, change target or unmount. Release or reject the old body later. No stale token/capabilities may be accepted, and the replacement request must not be aborted by the old timer.
5. Withhold headers entirely, or return 401/403. Existing timeout/rejection behavior must remain unchanged.

Local verification uses fake-timer unit tests. A real-daemon/global CLI dry run and production browser run have not been performed in this cloud worktree.
