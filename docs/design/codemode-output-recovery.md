# CodeMode output on failure

The `dragon/code-mode-only-10377` runtime already accumulates `text()` in its host process, but its error frame discards that output. Return the accumulated text and media with script errors, keep failure status, and bound the combined text and error at the exec boundary. This follows Codex's inline result behavior; it does not save a full-output recovery file.

Exec owns its output limit. Exempt its successful and failed results from the scheduler's persistence gates, and declare an empty persisted-file list so aggregate batch truncation also stays inline. Preserve both the beginning and end when truncating text, including a visible truncation marker.

Pass the scheduler's call source through an asynchronous context at the invocation boundary. Nested read_file calls must return file content even if a prior nested read happened, because reading inside JavaScript does not establish that the model saw it. Preserve read-before-edit tracking but mark those bytes absent from model history. Nested shell results omit the submitted command, which is already present in the exec source, while retaining output and exit/error information.

Validate plain and nested failures after text, large success and error output, scheduler and aggregate truncation without output artifacts, nested read cache behavior, and shell command omission. Use deterministic local mocked CLI requests; no real model evaluation is required.
