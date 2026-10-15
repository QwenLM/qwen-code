# Web Shell command explanation

Shell approval cards expose an **Explain** action when the connected session
supports session generation. Opening it sends the displayed command to the
existing session-generation endpoint and renders the streamed explanation in
the same popover pattern used for thinking translations.

The action is limited to executable permission requests with an extracted
command. Other approvals and sessions without generation support remain
unchanged.
