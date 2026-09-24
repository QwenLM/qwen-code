# Default file drop action

Expose `fileDropAction?: 'upload' | 'attach'` on WebShell and its shared
customization context so main and split composers behave identically. Omission
preserves the choice dialog when both destinations are available. A configured
available destination runs immediately; if only one destination is available,
use it regardless of the preference. Neither available means no ingestion.

Workspace upload still requires the existing capability, selected workspace and
trust checks. Attachment availability remains governed by `attachmentsEnabled`.
`fileUploadEnabled=false` disables workspace upload without disabling attachments.
Keep the add menu's attachment availability consistent with drag-and-drop.
Cancel a pending choice if availability, default action, session or workspace
changes; do not apply an old drop to a newly selected destination.

Use existing upload and attachment ingestion callbacks. Preserve batch filtering,
drop cancellation, disabled behavior, image paste, and upload directory handling.
Validate the routing matrix with component tests and public prop/context tests;
use mocked browser drag events for direct-action and dialog flows.
