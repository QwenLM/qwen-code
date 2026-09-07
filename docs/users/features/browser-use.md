# Browser Use

Browser Use lets Qwen Code work with pages in your Chrome browser using a
bundled skill. It is disabled by default.

## Enable or disable

Run `/skills` and enable **browser-use**. You can disable it in the same
picker, just like Computer Use and other skills.

Alternatively, explicitly enable it in your Qwen Code settings:

```json
{
  "skills": {
    "enabled": ["browser-use"]
  }
}
```

To disable it, add `browser-use` to `skills.disabled`. A disabled entry takes
precedence over an enabled entry, including disables set at a higher settings
scope. Merge these entries with your existing skill lists.

Disabling hides the skill from the model's available skills and removes its
slash command. It does not erase instructions already loaded in a conversation
or disconnect an existing browser session; it is not a browser permission
revocation mechanism.

## Prerequisites

Configure the Node REPL MCP server and install the Qwen Chrome extension.
The SDK is bundled with Qwen Code; no separate Browser Use Qwen extension is
required. Native Host setup currently supports macOS and Linux and runs on
first use, not when Qwen Code starts.
