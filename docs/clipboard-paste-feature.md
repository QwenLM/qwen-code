# Clipboard Image Paste Feature

The Qwen Code CLI supports pasting images directly from your clipboard. This feature allows you to share screenshots, diagrams, or UI elements with the AI assistant without having to manually save and reference image files.

## Usage Options

### Option 1: `/paste-image` Command (Recommended)

Type the slash command to paste a clipboard image:

```
/paste-image
```

**Aliases:** `/pi`, `/clipboard-image`

This is the most reliable method and provides detailed feedback about the pasted image.

### Option 2: `Alt+V` Keyboard Shortcut

Press `Alt+V` (or `Meta+V` on some terminals) to quickly paste a clipboard image. This triggers the same `/paste-image` command.

> **Note:** On Windows, terminal keybindings may vary. If the shortcut doesn't work, use the `/paste-image` command instead.

## What Happens When You Paste

1. The image is saved to `.qwen-clipboard/` in your project directory
2. A unique filename is generated with a timestamp (e.g., `clipboard-1768697710562.png`)
3. The image reference is automatically inserted into your prompt as `@path/to/image.png`
4. You'll see detailed feedback:

```
📎 Clipboard image loaded
• Path: .qwen-clipboard/clipboard-1768697710562.png
• Type: image/png
• Size: 60.3 KB
• Hash: 9ca7f144…3dfa
• Auto-delete: 5 minutes

📌 To reference this image, type: @.qwen-clipboard/clipboard-1768697710562.png
```

## Supported Platforms

| Platform            | Clipboard Access Method           |
| ------------------- | --------------------------------- |
| **Windows**         | PowerShell + System.Windows.Forms |
| **macOS**           | AppleScript (osascript)           |
| **Linux (X11)**     | xclip or xsel                     |
| **Linux (Wayland)** | wl-clipboard                      |

## Automatic Cleanup

- Images older than **5 minutes** are automatically deleted
- Cleanup occurs when you paste a new image or when the CLI exits
- The `.qwen-clipboard/` directory is created in your project root

## Privacy & Security

- ✅ Images are saved **locally** in your project directory
- ✅ No external uploads - everything stays on your machine
- ✅ Automatic cleanup prevents accumulation of temporary files
- ✅ The feature respects your project's security settings

## Troubleshooting

| Issue                   | Solution                                                  |
| ----------------------- | --------------------------------------------------------- |
| `Alt+V` doesn't work    | Use `/paste-image` command instead                        |
| "No image in clipboard" | Ensure you've copied an image (not text or a file)        |
| Command is slow         | PowerShell initialization on Windows can take 1-2 seconds |
| Images not appearing    | Check that your terminal supports clipboard access        |

### Linux Users

Ensure one of these packages is installed:

```bash
# For X11
sudo apt install xclip   # or xsel

# For Wayland
sudo apt install wl-clipboard
```

## Example Workflow

1. Take a screenshot of an error message
2. Copy it to your clipboard (`Ctrl+C` or screenshot tool)
3. In Qwen Code, type `/paste-image` or press `Alt+V`
4. Add your question: `What does this error mean?`
5. Submit your prompt

The AI will analyze the image and provide assistance based on what it sees.
