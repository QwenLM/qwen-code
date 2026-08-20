# Web Shell mid-turn file attachments

## Problem

Web Shell turns an `@` file selection into prompt text plus a file input annotation. Annotated prompts currently wait for the next turn, while images can be uploaded and inserted into a running turn. File insertion must use the same durable attachment and rendering path as an ordinary prompt with an attached file.

## Design

When the daemon advertises `session_attachments`, Web Shell uploads both composer file attachments and files resolved from annotations to the current session attachment store. Annotated files are read through the selected trusted workspace with the existing bounded workspace-file reader. The returned attachment references travel with the existing mid-turn `content` payload alongside image references. Prompts containing non-file annotations, unavailable workspace ownership, unreadable files, or oversized files continue through the ordinary pending queue or restore to the editor before daemon admission.

The inserted display text omits annotated `@` tokens because the referenced files are rendered as attachment rows. Pending file attachments appear beside image previews and open in the existing attachment preview panel. Reconciliation and injection echoes recover file rows from the same `resource` attachment references used by an ordinary prompt with files.

Deleting a queued mid-turn message removes its referenced file attachments after the daemon confirms the message was removed. Failed removals leave the attachments intact because the queued or running message may still need them.

No new daemon protocol or attachment type is introduced.

## Compatibility

Older daemons without `session_attachments` keep annotated prompts on the ordinary queue. Existing image-only mid-turn messages and text insertion are unchanged.
