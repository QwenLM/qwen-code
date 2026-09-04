/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transcript-only entrypoint for `@qwen-code/web-shell`.
 *
 * Exposes the read-only transcript renderer without the interactive shell:
 * no `App`, no daemon providers, no editor/terminal chrome. Bundlers that
 * only render transcripts (for example the self-contained `/export html`
 * document renderer in `@qwen-code/web-templates`) must import this
 * subpath instead of the package root, so the interactive runtime is not
 * inlined into their output.
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
