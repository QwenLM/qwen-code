# Browser Use

Browser Use lets Qwen Code work with pages in your Chrome browser, using your
existing tabs and signed-in sessions.

## Use

Use macOS or Linux with Chrome 125 or later. **Install the
[Qwen Code extension from the Chrome Web Store](https://chromewebstore.google.com/detail/qwen-code/hdhmmjclhibojdddmancfgbkleahfaph)
in the Chrome profile you want to use.** The extension is required and is not
installed by the Qwen Code package. Chrome keeps it up to date once installed.

If the Chrome Web Store says the extension is not available in your region,
build it from source instead: follow the
[README](https://github.com/QwenLM/qwen-code/tree/main/packages/chrome-extension#readme)
of the `packages/chrome-extension` directory in the Qwen Code repository, then
open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
pick the built `dist/extension` directory.

Describe your browser task directly, for example:

> Read my open dashboard and summarize today's orders.

Qwen selects the Browser Use skill when appropriate. The first browser task
automatically registers a small local connection program in your user directory;
later tasks reuse it. Qwen confirms the connection with the extension before
operating pages. If it cannot connect, open Chrome and check that the extension
is enabled in the intended profile, then retry. If a runtime dependency
needs configuration on first use, Qwen will guide you and may ask you to restart.
No separate Browser Use Qwen extension or `qwen serve` process is needed.

## Disable

Use `/skills` to disable **browser-use**. This hides the skill from the model
but does not disconnect an existing browser session or remove instructions
already loaded in a conversation.
