# Markdown Rendering

Qwen Code renders common Markdown structures directly in the TUI so model
answers are easier to scan without leaving the terminal. The renderer is
designed to keep the original source reachable, especially for visual blocks
such as Mermaid diagrams and LaTeX math.

## Render and Raw Modes

By default, Markdown is shown in `render` mode. Supported blocks render as
visual previews where possible:

- Mermaid fenced code blocks
- Markdown tables
- task lists
- blockquotes
- inline and block LaTeX math
- fenced code blocks with syntax highlighting

Press `Alt/Option+M` to toggle the current session between:

- `render`: show rich terminal previews for supported Markdown.
- `raw`: show source-oriented Markdown for visual blocks such as Mermaid,
  tables, and LaTeX.

To start Qwen Code in raw mode by default, set `ui.renderMode`:

```json
{
  "ui": {
    "renderMode": "raw"
  }
}
```

Accepted values are `"render"` and `"raw"`. The shortcut only changes the
current session view; it does not rewrite your settings file.

## Mermaid

Fenced `mermaid` code blocks render visually in `render` mode. The TUI uses a
layered strategy:

1. If enabled and supported, Qwen Code asks Mermaid CLI (`mmdc`) to render the
   diagram to a PNG and sends it to the terminal image protocol.
2. If terminal images are unavailable but `chafa` is installed, the same PNG can
   be converted to ANSI block graphics.
3. Otherwise, Qwen Code falls back to a terminal wireframe or compact text
   preview.
4. If a Mermaid diagram type cannot be previewed, Qwen Code shows the original
   fenced source instead of hiding it behind a placeholder.

Mermaid image rendering is disabled by default because it requires external
renderers and terminal image support. Enable it with:

```bash
QWEN_CODE_MERMAID_IMAGE_RENDERING=1 qwen
```

Optional environment variables:

| Variable                                    | Description                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `QWEN_CODE_MERMAID_IMAGE_RENDERING=1`       | Enables external Mermaid image rendering.                                           |
| `QWEN_CODE_DISABLE_MERMAID_IMAGES=1`        | Disables Mermaid image rendering even when enabled elsewhere.                       |
| `QWEN_CODE_MERMAID_IMAGE_PROTOCOL=kitty`    | Forces Kitty protocol output. Useful for terminals such as Kitty and Ghostty.       |
| `QWEN_CODE_MERMAID_IMAGE_PROTOCOL=iterm2`   | Forces iTerm2 inline image output.                                                  |
| `QWEN_CODE_MERMAID_IMAGE_PROTOCOL=off`      | Disables terminal image protocols and allows text or `chafa` fallback.              |
| `QWEN_CODE_MERMAID_MMD_CLI=/path/to/mmdc`   | Uses a specific Mermaid CLI executable.                                             |
| `QWEN_CODE_MERMAID_ALLOW_NPX=1`             | Allows Qwen Code to run `npx @mermaid-js/mermaid-cli` when `mmdc` is not installed. |
| `QWEN_CODE_MERMAID_ALLOW_LOCAL_RENDERERS=1` | Allows project-local renderer binaries under `node_modules/.bin`.                   |
| `QWEN_CODE_MERMAID_RENDER_WIDTH=1200`       | Overrides the PNG render width.                                                     |
| `QWEN_CODE_MERMAID_RENDER_TIMEOUT_MS=10000` | Overrides the external render timeout.                                              |

The first image render can be slow, especially when `npx` needs to resolve or
download Mermaid CLI. During streaming, Qwen Code shows a bounded text preview
and attempts image rendering only after the model response is complete.

### Mermaid Source Copy

Every rendered Mermaid block includes a source hint such as:

```text
Mermaid flowchart (TD) · source: /copy mermaid 1
```

Use these commands to copy Mermaid source from the last AI response:

| Command                | Behavior                                      |
| ---------------------- | --------------------------------------------- |
| `/copy mermaid`        | Copies the last Mermaid block.                |
| `/copy mermaid 1`      | Copies the first Mermaid block.               |
| `/copy code mermaid`   | Copies the last fenced `mermaid` code block.  |
| `/copy code mermaid 1` | Copies the first fenced `mermaid` code block. |

`/copy code 1` counts all fenced code blocks, not only Mermaid blocks. Use
`/copy mermaid N` when you want the Mermaid-specific sequence shown in the
rendered title.

## LaTeX Math

Qwen Code supports basic inline and block LaTeX rendering in the terminal:

```markdown
Inline math: $x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$

$$
\sum_{n=1}^{\infty} 1/n^2 = \pi^2/6
$$
```

The renderer focuses on common symbols and readable terminal output. It is not
a full TeX engine; complex layouts such as matrices, aligned equations, and
large nested expressions may be simplified.

### LaTeX Source Copy

Use these commands to copy LaTeX source from the last AI response:

| Command                | Behavior                                |
| ---------------------- | --------------------------------------- |
| `/copy latex`          | Copies the last block LaTeX expression. |
| `/copy latex 2`        | Copies the second block expression.     |
| `/copy latex inline`   | Copies the last inline expression.      |
| `/copy latex inline 2` | Copies the second inline expression.    |
| `/copy inline-latex 2` | Alias for `/copy latex inline 2`.       |

Inline LaTeX does not show a per-expression copy hint in rendered text to avoid
making prose noisy. Switch to raw mode with `Alt/Option+M` when you want to
inspect inline source in place.

## General Code Copy

The `/copy code` command reads fenced code blocks from the last AI Markdown
response:

| Command                 | Behavior                                 |
| ----------------------- | ---------------------------------------- |
| `/copy code`            | Copies the last fenced code block.       |
| `/copy code 2`          | Copies the second fenced code block.     |
| `/copy code typescript` | Copies the last `typescript` code block. |
| `/copy code mermaid 1`  | Copies the first `mermaid` code block.   |

## Current Limits

- Mermaid image rendering depends on Mermaid CLI plus terminal image support.
- Wireframe Mermaid rendering is a readable terminal preview, not a full
  Mermaid layout engine.
- Raw mode is global for rendered Markdown blocks; it is not a per-block toggle.
- LaTeX rendering covers common symbols and expressions, not full TeX layout.
- Source copy commands operate on the last AI response.
