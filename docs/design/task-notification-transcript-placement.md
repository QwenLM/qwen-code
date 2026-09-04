# Task notification transcript placement

Background task completions are model inputs, not user-authored prompts. The
live daemon path already identifies them with
`_meta.source = "background_notification"`, but history replay previously
projected persisted notification records as unmarked user messages.

History replay will preserve the persisted model-input role while adding the
same source marker used by live notifications. The Web Shell transcript adapter
will map that source, from either a user or assistant chunk, to an informational
system message. New records also persist the existing structured task status so
live and replayed messages use the same completed, failed, or cancelled label;
older records fall back to a generic notification label. The notification
content is rendered unchanged beside a semantic status icon. This keeps both
live and replayed notifications visible on the left without changing shared
replay semantics for other consumers.
