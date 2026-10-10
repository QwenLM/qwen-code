# Remote Web Shell Daemon Implementation Plan

1. Accept a validated remote daemon origin in the standalone Web Shell.
2. Add address and optional token controls to the connection gate and the existing Daemon Status overview.
3. Scope the per-tab bearer token to that daemon origin.
4. Preserve the selected daemon during session navigation and clear session-specific state when switching daemons.
5. Admit the selected HTTP(S) and WebSocket origin in the HTML shell CSP.
6. Reuse the existing workspace, session, file, SSE, and terminal clients for all remote data paths.
7. Add focused unit tests, then verify from local Web Shell against a token-configured daemon on a remote host: connection recovery, workspace and directory discovery, file listing/reference, session transcript loading, and refresh reconnect.

Desktop/Tauri, managed SSH, daemon lifecycle management, and multi-daemon aggregation are out of scope.
