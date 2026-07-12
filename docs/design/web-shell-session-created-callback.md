# Web Shell session-created callback

## Goal

Let an embedding host run asynchronous work with a newly created session ID
before Web Shell continues session initialization or submits the first prompt.

## Design

Add an optional `onSessionCreated(sessionId)` prop to `WebShell`. The lazy
session-creation path awaits it immediately after `createSession` succeeds and
before attaching the session. A rejected callback aborts the first prompt and
uses the existing unattached-session cleanup path. The callback times out after
30 seconds so a host cannot permanently block setup or leak the unattached
session.

Existing sessions loaded through the `sessionId` prop or session picker do not
invoke the callback because Web Shell did not create them.
