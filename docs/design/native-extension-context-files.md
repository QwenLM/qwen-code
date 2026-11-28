# Native extension context files

[English](native-extension-context-files.md) | [简体中文](native-extension-context-files.zh-CN.md)

An enabled native Qwen extension currently contributes root `QWEN.md` by default. An extension that already ships its instructions in `AGENTS.md` has to repeat that filename in its manifest.

Native extensions will discover both root files in a fixed order, `QWEN.md` followed by `AGENTS.md`, under the same rule that applies to `QWEN.md` today: a file present at the extension root is included. A non-empty `contextFileName` string or list remains the complete selection in its configured order. Omitted and empty values use the defaults.

Discovery and file watching will share the same candidate list. Adding, editing, or removing either default file will use the existing extension refresh behavior. Converted plugins keep their existing fallback, and Managed extension packages keep their own resource selection.

Verify that native extensions with one or both files contribute the expected instructions, that a manifest selection excludes both defaults when it names other files, and that creating `AGENTS.md` after startup marks the extension stale. Existing enabled extensions can begin contributing a previously unused `AGENTS.md` on their next load.
