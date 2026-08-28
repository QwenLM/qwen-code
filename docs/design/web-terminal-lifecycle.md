# Web terminal lifecycle

The browser terminal is a manually opened Web Shell surface. The host must add
the terminal right-panel action and the daemon must advertise the
`web_terminal` capability before the UI exposes the entry. WebSocket requests
use the daemon's shared Host, Origin, authentication and workspace trust gates.

Each terminal is owned by one active, trusted workspace runtime. The daemon
resolves the client workspace selector against the live registry and supplies
that runtime's cwd and effective environment to the PTY. A terminal id cannot
be reclaimed through another workspace.

Closing a terminal tab sends an explicit release control frame and kills the
PTY. Hiding the panel, switching tabs or losing the WebSocket only detaches the
client, so reconnect can replay the same session. A detached session is killed
after the idle timeout even if its command is still running. Exited sessions
replay both scrollback and exit state. Binary WebSocket frames contain UTF-8
terminal input and output; NUL-prefixed text frames contain control messages.
Reloading the page loses the in-memory terminal id, so the detached session is
reclaimed after the idle timeout rather than restored into the new page.
