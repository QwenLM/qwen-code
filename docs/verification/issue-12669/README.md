# Current standalone session deletion: browser evidence

These screenshots were captured with two Chrome contexts attached to the same
standalone session on an isolated local daemon. No model request was sent.

1. [Confirmation](issue-12669-two-tab-confirm.png): the dialog opened by
   selecting Delete on the current, idle session before leaving.
2. [Busy result](issue-12669-two-tab-busy.png): the first tab has left, but the
   other tab remains attached. The daemon returns `session_busy`, and the row
   and error remain visible.
3. [Successful retry](issue-12669-two-tab-after.png): after the second tab
   leaves, retrying the first tab's existing confirmation removes the row. The
   old busy toast is still visible because this image was captured immediately
   after the successful delete.

The request sequence and test boundaries are recorded in the PR's E2E report.
