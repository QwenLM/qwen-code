# Terminal Images

Qwen Code can display image parts from assistant responses and completed tool
results directly in the interactive terminal UI. This display path is separate
from Markdown rendering and behaves the same in Markdown `render` and `raw`
modes.

## Where Images Appear

In assistant responses, text and images keep their original order. Tool rows
show the result text followed by images for successful, failed, and cancelled
results.

Other output surfaces, including headless, ACP, daemon/Web Shell, and IDE
integrations, do not render image parts. The WeChat (weixin), WeCom, and
DingTalk channels can still deliver agent-generated image files through their
`[IMAGE: ...]` marker flow; other IM channels do not currently deliver outbound
images.

## Terminal Support

| Environment                                                        | Image display                                                                           |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Direct Kitty or Ghostty TTY, without tmux or SSH                   | Native terminal image placement                                                         |
| Other terminals with `chafa` installed                             | 256-color ANSI preview, including in iTerm2, Warp, tmux, and SSH sessions               |
| No compatible renderer, or screen-reader mode (inline image parts) | Deterministic text such as `[image: 1024x768 png]` instead of a terminal image sequence |

## Limits and Fallbacks

Inline pixel previews currently require valid PNG data within the display
limits: 64 megapixels total and at most 1,000,000 pixels per side. Other image
formats, invalid PNGs, and inline PNGs exceeding those limits remain visible as
text placeholders.

Inline image payloads larger than 8 MiB are not pixel-rendered. Most oversized
payloads are dropped before entering TUI history, while payloads marginally over
the limit may remain as text placeholders because admission is based on encoded
size. Each assistant response or tool row displays at most four images and
reports the remainder with a marker such as `[+2 more images]`.

## Session History and Memory

Tool image parts are saved with their results and can be reconstructed after
session resume. Assistant images render live but are not currently persisted,
so `--continue` and `--resume` restore the assistant text without those images.

To bound memory in long or image-heavy sessions, the TUI may replace older
displayed images with markers such as `[Old assistant image content cleared]`
or `[Old tool result content cleared]`. This affects only the live view. Tool
image parts remain in the session record and reappear after resume.
