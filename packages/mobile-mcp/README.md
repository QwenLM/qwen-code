# Mobile Next - MCP server for Mobile Development and Automation | iOS, Android, Simulator, Emulator, and Real Devices

This is a [Model Context Protocol (MCP) server](https://github.com/modelcontextprotocol) that enables scalable mobile automation, development through a platform-agnostic interface, eliminating the need for distinct iOS or Android knowledge. You can run it on emulators, simulators, and real devices (iOS and Android).
This server allows Agents and LLMs to interact with native iOS/Android applications and devices through structured accessibility snapshots or coordinate-based taps based on screenshots.

<h4 align="center">
  <a href="https://github.com/mobile-next/mobile-mcp">
    <img src="https://img.shields.io/github/stars/mobile-next/mobile-mcp" alt="Mobile Next Stars" />
  </a>
  <a href="https://www.npmjs.com/package/@mobilenext/mobile-mcp">
    <img src="https://img.shields.io/npm/dm/@mobilenext/mobile-mcp?logo=npm&style=flat&color=red" alt="npm" />
  </a>
  <a href="https://github.com/mobile-next/mobile-mcp/releases">
    <img src="https://img.shields.io/github/release/mobile-next/mobile-mcp" />
  </a>
  <a href="https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%7B%22name%22%3A%22mobile-mcp%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mobilenext%2Fmobile-mcp%40latest%22%5D%7D">
    <img src="https://img.shields.io/badge/VS_Code-VS_Code?style=flat-square&label=Install%20Server&color=0098FF" alt="Install in VS Code" />
  </a>
  <a href="https://github.com/mobile-next/mobile-mcp/wiki">
    <img src="https://img.shields.io/badge/documentation-wiki-blue" alt="wiki" />
  </a>
  <a href="https://mobilenexthq.com/join-slack">
    <img src="https://img.shields.io/badge/join-Slack-blueviolet?logo=slack&style=flat" alt="join on Slack" />
  </a>
</h4>


https://github.com/user-attachments/assets/bb084777-beb3-4930-ae6f-8d3fe694ddde


<p align="center">
    <a href="https://github.com/mobile-next/">
        <img alt="mobile-mcp" src="https://raw.githubusercontent.com/mobile-next/mobile-next-assets/refs/heads/main/mobile-mcp-banner.png" width="600" />
    </a>
</p>

### 🚀 Mobile MCP Roadmap: Building the Future of Mobile

Join us on our journey as we continuously enhance Mobile MCP!
Check out our detailed roadmap to see upcoming features, improvements, and milestones. Your feedback is invaluable in shaping the future of mobile automation.

👉 [Explore the Roadmap](https://github.com/orgs/mobile-next/projects/3)


### Main use cases

How we help to scale mobile automation:

- 📲 Native app automation (iOS and Android) for testing or data-entry scenarios.
- 📝 Scripted flows and form interactions without manually controlling simulators/emulators or real devices (iPhone, Samsung, Google Pixel etc)
- 🧭 Automating multi-step user journeys driven by an LLM
- 👆 General-purpose mobile application interaction for agent-based frameworks
- 🤖 Enables agent-to-agent communication for mobile automation usecases, data extraction

## Main Features

- 🚀 **Fast and lightweight**: Uses native accessibility trees for most interactions, or screenshot based coordinates where a11y labels are not available.
- 🤖 **LLM-friendly**: No computer vision model required in Accessibility (Snapshot).
- 🧿 **Visual Sense**: Evaluates and analyses what's actually rendered on screen to decide the next action. If accessibility data or view-hierarchy coordinates are unavailable, it falls back to screenshot-based analysis.
- 📊 **Deterministic tool application**: Reduces ambiguity found in purely screenshot-based approaches by relying on structured data whenever possible.
- 📺 **Extract structured data**: Enables you to extract structred data from anything visible on screen.

### 🎯 Platform Support

| Platform | Supported |
|----------|:---------:|
| iOS Real Device | ✅ |
| iOS Simulator | ✅ |
| Android Real Device | ✅ |
| Android Emulator | ✅ |

## 🔧 Available MCP Tools

<details>
<summary>📱 <strong>Click to expand tool list</strong> - List of Mobile MCP tools for automation and development</summary>

> For detailed implementation and parameter specifications, see [`src/server.ts`](src/server.ts)

### Device Management
- **`mobile_list_available_devices`** - List all available devices (simulators, emulators, and real devices)
- **`mobile_get_screen_size`** - Get the screen size of the mobile device in pixels
- **`mobile_get_orientation`** - Get the current screen orientation of the device
- **`mobile_set_orientation`** - Change the screen orientation (portrait/landscape)

### App Management
- **`mobile_list_apps`** - List all installed apps on the device
- **`mobile_launch_app`** - Launch an app using its package name
- **`mobile_terminate_app`** - Stop and terminate a running app
- **`mobile_install_app`** - Install an app from file (.apk, .ipa, .app, .zip)
- **`mobile_uninstall_app`** - Uninstall an app using bundle ID or package name

### Screen Interaction
- **`mobile_take_screenshot`** - Take a screenshot to understand what's on screen
- **`mobile_save_screenshot`** - Save a screenshot to a file
- **`mobile_list_elements_on_screen`** - List UI elements with their coordinates and properties
- **`mobile_click_on_screen_at_coordinates`** - Click at specific x,y coordinates
- **`mobile_double_tap_on_screen`** - Double-tap at specific coordinates
- **`mobile_long_press_on_screen_at_coordinates`** - Long press at specific coordinates
- **`mobile_swipe_on_screen`** - Swipe in any direction (up, down, left, right)

### Input & Navigation
- **`mobile_type_keys`** - Type text into focused elements with optional submit
- **`mobile_press_button`** - Press device buttons (HOME, BACK, VOLUME_UP/DOWN, ENTER, etc.)
- **`mobile_open_url`** - Open URLs in the device browser

### Platform Support
- **iOS**: Simulators and real devices via native accessibility and WebDriverAgent
- **Android**: Emulators and real devices via ADB and UI Automator
- **Cross-platform**: Unified API works across both iOS and Android

</details>

## 🏗️ Mobile MCP Architecture

<p align="center">
    <a href="https://raw.githubusercontent.com/mobile-next/mobile-next-assets/refs/heads/main/mobile-mcp-arch-1.png">
        <img alt="mobile-mcp" src="https://raw.githubusercontent.com/mobile-next/mobile-next-assets/refs/heads/main/mobile-mcp-arch-1.png" width="600">
    </a>
</p>


## 📚 Wiki page

More details in our [wiki page](https://github.com/mobile-next/mobile-mcp/wiki) for setup, configuration and debugging related questions.


## Installation and configuration

**Standard config** works in most of the tools:

```json
{
  "mcpServers": {
    "mobile-mcp": {
      "command": "npx",
      "args": ["-y", "@mobilenext/mobile-mcp@latest"]
    }
  }
}
```

<details>
<summary>Amp</summary>

Add via the Amp VS Code extension settings screen or by updating your `settings.json` file:

```json
"amp.mcpServers": {
  "mobile-mcp": {
    "command": "npx",
    "args": [
      "@mobilenext/mobile-mcp@latest"
    ]
  }
}
```

**Amp CLI:**

Run the following command in your terminal:

```bash
amp mcp add mobile-mcp -- npx @mobilenext/mobile-mcp@latest
```

</details>

<details>
<summary>Cline</summary>

To setup Cline, just add the json above to your MCP settings file.

[More in our wiki](https://github.com/mobile-next/mobile-mcp/wiki/Cline)

</details>

<details>
<summary>Claude Code</summary>

Use the Claude Code CLI to add the Mobile MCP server:

```bash
claude mcp add mobile-mcp -- npx -y @mobilenext/mobile-mcp@latest
```
</details>

<details>
<summary>Claude Desktop</summary>

Follow the [MCP install guide](https://modelcontextprotocol.io/quickstart/user), use json configuration above.

</details>

<details>
<summary>Codex</summary>

Use the Codex CLI to add the Mobile MCP server:

```bash
codex mcp add mobile-mcp npx "@mobilenext/mobile-mcp@latest"
```

Alternatively, create or edit the configuration file `~/.codex/config.toml` and add:

```toml
[mcp_servers.mobile-mcp]
command = "npx"
args = ["@mobilenext/mobile-mcp@latest"]
```

For more information, see the Codex MCP documentation.

</details>

<details>
<summary>Copilot</summary>

Use the Copilot CLI to interactively add the Mobile MCP server:

```text
/mcp add
```

You can edit the configuration file `~/.copilot/mcp-config.json` and add:

```json
{
  "mcpServers": {
    "mobile-mcp": {
      "type": "local",
      "command": "npx",
      "tools": [
        "*"
      ],
      "args": [
        "@mobilenext/mobile-mcp@latest"
      ]
    }
  }
}
```

For more information, see the Copilot CLI documentation.

</details>

<details>
<summary>Cursor</summary>

#### Click the button to install:

[<img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Install in Cursor">](https://cursor.com/en/install-mcp?name=Mobile%20MCP&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtb2JpbGVuZXh0L21vYmlsZS1tY3BAbGF0ZXN0Il19)

#### Or install manually:

Go to `Cursor Settings` -> `MCP` -> `Add new MCP Server`. Name to your liking, use `command` type with the command `npx -y @mobilenext/mobile-mcp@latest`. You can also verify config or add command like arguments via clicking `Edit`.

</details>

<details>
<summary>Gemini CLI</summary>

Use the Gemini CLI to add the Mobile MCP server:

```bash
gemini mcp add mobile-mcp npx -y @mobilenext/mobile-mcp@latest
```

</details>

<details>
<summary>Goose</summary>

#### Click the button to install:

[![Install in Goose](https://block.github.io/goose/img/extension-install-dark.svg)](https://block.github.io/goose/extension?cmd=npx&arg=-y&arg=%40mobilenext%2Fmobile-mcp%40latest&id=mobile-mcp&name=Mobile%20MCP&description=Mobile%20automation%20and%20development%20for%20iOS%2C%20Android%2C%20simulators%2C%20emulators%2C%20and%20real%20devices)

#### Or install manually:

Go to `Advanced settings` -> `Extensions` -> `Add custom extension`. Name to your liking, use type `STDIO`, and set the `command` to `npx -y @mobilenext/mobile-mcp@latest`. Click "Add Extension".

</details>

<details>
<summary>Kiro</summary>

Follow the MCP Servers [documentation](https://kiro.dev/docs/mcp/). For example in `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "mobile-mcp": {
      "command": "npx",
      "args": [
        "@mobilenext/mobile-mcp@latest"
      ]
    }
  }
}
```

</details>

<details>
<summary>opencode</summary>

Follow the MCP Servers documentation. For example in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mobile-mcp": {
      "type": "local",
      "command": [
        "npx",
        "@mobilenext/mobile-mcp@latest"
      ],
      "enabled": true
    }
  }
}
```

</details>

<details>
<summary>Qodo Gen</summary>

Open [Qodo Gen](https://docs.qodo.ai/qodo-documentation/qodo-gen) chat panel in VSCode or IntelliJ → Connect more tools → + Add new MCP → Paste the standard config above.

Click <code>Save</code>.

</details>


<details>
<summary>Windsurf</summary>

Open Windsurf settings, navigate to MCP servers, and add a new server using the `command` type with:

```bash
npx @mobilenext/mobile-mcp@latest
```

Or add the standard config under `mcpServers` in your settings as shown above.

</details>


[Read more in our wiki](https://github.com/mobile-next/mobile-mcp/wiki)! 🚀

### SSE Server Mode

By default, Mobile MCP runs over stdio. To start an SSE server instead, use the `--listen` flag:

```bash
npx @mobilenext/mobile-mcp@latest --listen 3000
```

This binds to `localhost:3000`. To bind to a specific interface:

```bash
npx @mobilenext/mobile-mcp@latest --listen 0.0.0.0:3000
```

Then configure your MCP client to connect to `http://<host>:3000/mcp`.

#### Authorization

To require Bearer token authorization on the SSE server, set the `MOBILEMCP_AUTH` environment variable:

```bash
MOBILEMCP_AUTH=my-secret-token npx @mobilenext/mobile-mcp@latest --listen 3000
```

When set, all requests must include the header `Authorization: Bearer my-secret-token`.

### 🛠️ How to Use 📝

After adding the MCP server to your IDE/Client, you can instruct your AI assistant to use the available tools.
For example, in Cursor's agent mode, you could use the prompts below to quickly validate, test and iterate on UI intereactions, read information from screen, go through complex workflows.
Be descriptive, straight to the point.

### ✨ Example Prompts

#### Workflows

You can specifiy detailed workflows in a single prompt, verify business logic, setup automations. You can go crazy:

**Search for a video, comment, like and share it.**
```
Find the video called " Beginner Recipe for Tonkotsu Ramen" by Way of
Ramen, click on like video, after liking write a comment " this was
delicious, will make it next Friday", share the video with the first
contact in your whatsapp list.
```

**Download a successful step counter app, register, setup workout and 5-star the app**
```
Find and Download a free "Pomodoro" app that has more than 1k stars.
Launch the app, register with my email, after registration find how to
start a pomodoro timer. When the pomodoro timer started, go back to the
app store and rate the app 5 stars, and leave a comment how useful the
app is.
```

**Search in Substack, read, highlight, comment and save an article**
```
Open Substack website, search for "Latest trends in AI automation 2025",
open the first article, highlight the section titled "Emerging AI trends",
and save article to reading list for later review, comment a random
paragraph summary.
```

**Reserve a workout class, set timer**
```
Open ClassPass, search for yoga classes tomorrow morning within 2 miles,
book the highest-rated class at 7 AM, confirm reservation,
setup a timer for the booked slot in the phone
```

**Find a local event, setup calendar event**
```
Open Eventbrite, search for AI startup meetup events happening this
weekend in "Austin, TX", select the most popular one, register and RSVP
yes to the event, setup a calendar event as a reminder.
```

**Check weather forecast and send a Whatsapp/Telegram/Slack message**
```
Open Weather app, check tomorrow's weather forecast for "Berlin", and
send the summary via Whatsapp/Telegram/Slack to contact "Lauren Trown",
thumbs up their response.
```

- **Schedule a meeting in Zoom and share invite via email**
```
Open Zoom app, schedule a meeting titled "AI Hackathon" for tomorrow at
10AM with a duration of 1 hour, copy the invitation link, and send it via
Gmail to contacts "team@example.com".
```
[More prompt examples can be found here.](https://github.com/mobile-next/mobile-mcp/wiki/Prompt-Example-repo-list)

## Prerequisites

What you will need to connect MCP with your agent and mobile devices:

- [Xcode command line tools](https://developer.apple.com/xcode/resources/)
- [Android Platform Tools](https://developer.android.com/tools/releases/platform-tools)
- [node.js](https://nodejs.org/en/download/) v22+
- [MCP](https://modelcontextprotocol.io/introduction) supported foundational models or agents, like [Claude MCP](https://modelcontextprotocol.io/quickstart/server), [OpenAI Agent SDK](https://openai.github.io/openai-agents-python/mcp/), [Copilot Studio](https://www.microsoft.com/en-us/microsoft-copilot/blog/copilot-studio/introducing-model-context-protocol-mcp-in-copilot-studio-simplified-integration-with-ai-apps-and-agents/)

### Simulators, Emulators, and Real Devices

When launched, Mobile MCP can connect to:
- iOS Simulators on macOS/Linux
- Android Emulators on Linux/Windows/macOS
- iOS or Android real devices (requires proper platform tools and drivers)

Make sure you have your mobile platform SDKs (Xcode, Android SDK) installed and configured properly before running Mobile Next Mobile MCP.

### Telemetry

Mobile MCP collects anonymous usage telemetry via PostHog. To disable it, set the `MOBILEMCP_DISABLE_TELEMETRY` environment variable:

```bash
MOBILEMCP_DISABLE_TELEMETRY=1 npx @mobilenext/mobile-mcp@latest
```

For json configurations:

```json
{
  "mcpServers": {
    "mobile-mcp": {
      "command": "npx",
      "args": ["-y", "@mobilenext/mobile-mcp@latest"],
      "env": {
        "MOBILEMCP_DISABLE_TELEMETRY": "1"
      }
    }
  }
}
```

### Running in "headless" mode on Simulators/Emulators

When you do not have a real device connected to your machine, you can run Mobile MCP with an emulator or simulator in the background.

For example, on Android:
1. Start an emulator (avdmanager / emulator command).
2. Run Mobile MCP with the desired flags

On iOS, you'll need Xcode and to run the Simulator before using Mobile MCP with that simulator instance.
- `xcrun simctl list`
- `xcrun simctl boot "iPhone 16"`

# Thanks to all contributors ❤️

### We appreciate everyone who has helped improve this project.

  <a href = "https://github.com/mobile-next/mobile-mcp/graphs/contributors">
   <img src = "https://contrib.rocks/image?repo=mobile-next/mobile-mcp"/>
 </a>
