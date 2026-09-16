# Browser Use

Browser Use lets Qwen Code work with pages in your Chrome browser, using your
existing tabs and signed-in sessions.

## Use

Use macOS or Linux with Chrome 125 or later. **Install and enable the Qwen
Chrome extension in the Chrome profile you want to use.** The extension is
required and is not installed by the Qwen Code package. There is no Chrome Web
Store listing yet. Build it from the `packages/chrome-extension` directory of
the Qwen Code repository by following its
[README](https://github.com/QwenLM/qwen-code/tree/main/packages/chrome-extension#readme),
then open `chrome://extensions`, enable Developer mode, choose **Load
unpacked**, and pick the built `dist/extension` directory.

Describe your browser task directly, for example:

> Read my open dashboard and summarize today's orders.

Qwen selects the Browser Use skill when appropriate. If a runtime dependency
needs configuration on first use, Qwen will guide you and may ask you to restart.
No separate Browser Use Qwen extension or `qwen serve` process is needed.

## Disable

Use `/skills` to disable **browser-use**. This hides the skill from the model
but does not disconnect an existing browser session or remove instructions
already loaded in a conversation.
