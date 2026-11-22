# Session overview

Use Session Overview in Web Shell to browse sessions, return to a conversation,
and manage session titles and archives.

## Find and open sessions

Open **More → Session Overview**. Search by session title, session ID, Git branch,
or linked pull request number, such as `#123`. Use the status filters to narrow
the list. When multiple workspaces are available, the workspace filter lets you
choose which ones to include. Choose **Refresh** to reload the catalog.

Click a session row to open that conversation. Use the row checkboxes to select
sessions for the footer actions; the pagination controls change the visible page
and number of rows.

## Rename a session

Choose the row's pencil action when it is available, then edit the title. Press
**Enter** to save or **Escape** to cancel. If the editor loses focus, the
unfinished rename is canceled rather than saved.

## Archive sessions

Select sessions with their row checkboxes, then choose **Archive** in the footer.
The action is enabled only when every selected session is idle and supports
archiving. Confirm in the dialog to archive, or choose **Cancel** to leave the
sessions active.

If a rename editor still has focus when you click **Archive**, its unfinished
draft is canceled and the archive confirmation opens. Entering or canceling a
rename keeps the footer controls in place, so clicks near a button's edge still
reach that button.
