# Computer Use platform guidance and text operations

[English](computer-use-text-operations.md) | [简体中文](computer-use-text-operations.zh-CN.md)

The Computer Use SDK exposes app-oriented observation and input on macOS. Windows and Linux retain the exact-window workflow. A single bundled Skill entrypoint selects one of two platform documents using the connected driver's tools inventory. This is target metadata, not the Node host's operating system. Both CLI and SDK distributions must ship the same entrypoint and resources.

## Public API

`computer.getPlatform()` returns `macos`, `windows`, or `linux` from the existing owner `listToolsJson()` channel. Missing or invalid metadata fails explicitly. No desktop observation is needed.

On macOS, `app.paste(text, { format: 'text' | 'md' | 'html' })` pastes into the app's current window; format defaults to `text`. `app.selectText(element, text, { prefix, suffix, selection })` selects a unique match within an observed element; selection defaults to `text`, with `cursor_before` and `cursor_after` alternatives. App handles retain their existing serialization, current-window resolution, short-ID validation, and managed delivery. Exact-window SDK methods and typed driver/session methods carry the same operations. Native tool contracts advertise only macOS support; Windows/Linux guidance does not expose these methods.

## Native behavior

The reference is the installed official SkyComputerUseService, SHA-256 `25e9141499b94c396f39afbdb7b19ed8f49e45dc8c61be61028ceab8f3807ce6`. Disassembly identifies `ComputerUseAppController.selectText` at `0x100077cf4`, `sourceTextRange` at `0x10072e0a0`, and the overlapping, context-constrained unique-match search at `0x10072e338`. Detailed local evidence is retained under `.qwen/e2e-tests/paste-select/`.

Selection first checks whether the exact retained AX element supports a settable `AXSelectedTextRange`. It resolves visible formatted text to source offsets, falling back to the element's plain text. Matching is case-sensitive, counts overlapping occurrences, uses immediately adjacent optional prefix/suffix, and accepts exactly one result. AX ranges use UTF-16 offsets. Cursor placement changes the selected range to zero length at the corresponding boundary. The field is focused when necessary before setting the range; failed AX writes propagate instead of replaying a selection with keys. Read-back determines whether the action effect can be confirmed.

Paste is a process-serialized clipboard transaction and one targeted Command-V dispatch. The transaction snapshots all readable pasteboard items and types, supplies text lazily, waits for consumption and bounded AX effect evidence, and restores the snapshot only while it still owns the pasteboard change count. External clipboard changes must survive. HTML and Markdown supply HTML, RTF, and plain text using in-process AppKit conversion with external resource loading blocked. Markdown conversion uses pulldown-cmark; it does not introduce an executable or service. Clipboard and rich conversion run on the AppKit main thread, while the input worker retains the queue and mutation ownership through cleanup. Cancellation/error paths must release clipboard ownership safely; dispatch success alone does not prove the application inserted the content.

Both actions use existing exact-window gates and app focus/input infrastructure. Their tool registration uses the existing desktop-input authorization adapter, process-target protection, capture scope and origin-manifest restrictions. There is no background-failure replay in the foreground, no new permissions owner, and no additional runtime process.

Plain Node does not run AppKit's main loop. The existing Node addon supplies a private synchronous main-loop pump; the Node SDK runs it only while a native paste promise is pending, through both typed paste and generic tool calls. The pump runs on the Node main thread, rejects Worker-thread use before dispatch, and is removed after native cleanup. An already-aborted signal stops before the native call; cancellation after the native call begins waits for its completion and clipboard cleanup. Native hosts outside the Node package must provide their own AppKit main loop, as an AppKit application or the driver service does.

## Verification

Test unique/ambiguous/missing matches, adjacent context, overlapping matches, UTF-16 ranges, formatted text mapping, and all selection modes. Test clipboard format conversion, item/type preservation, external change protection, serialization, and failure cleanup. Exercise generated typed exports, facade/App dispatch, platform metadata routing, document packaging, and installed resource paths. Finally use owned local TextEdit/LibreOffice fixtures to select, replace by paste, verify actual text/format and clipboard restoration, without operating the benchmark machine. Build/typecheck and focused tests precede review of the existing PR update.
