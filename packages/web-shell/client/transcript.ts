/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transcript-only entrypoint for `@qwen-code/web-shell`.
 *
 * Exposes the read-only transcript renderer without the interactive shell:
 * no `App`, no composer, no editor/terminal chrome. Bundlers that only render
 * transcripts (for example the `/export html` document renderer in
 * `@qwen-code/web-templates`) must import this subpath instead of the package
 * root, so the interactive runtime is not pulled into their output.
 *
 * Known residual: this is not free of the daemon React runtime. `MessageList`
 * renders `McpStatusMessage`, `TasksStatusMessage` and the artifact turn
 * outputs, and those call the strict `useDaemonActions` / `useDaemonWorkspace`
 * hooks, so their provider guards are in `dist/transcript.js`. Decoupling them
 * is #11100. `client/build-artifact.test.ts` therefore bounds this entry's size
 * rather than asserting a symbol is absent.
 *
 * Do not rely on importing the package root or incidental tree shaking to
 * keep this payload small; see
 * `docs/design/2026-07-14-chat-record-daemon-transcript-block-projection.md`.
 *
 * @example
 * ```tsx
 * import { WebShellTranscript } from '@qwen-code/web-shell/transcript';
 * ```
 */

export { WebShellTranscript } from './components/WebShellTranscript';
export type { WebShellTranscriptProps } from './components/WebShellTranscript';
