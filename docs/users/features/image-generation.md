# Image Generation

Qwen Code ships with a built-in `image_gen` tool that turns a text prompt into
a PNG image using a configured image model. Ask for an image in a conversation
— "draw a poster for our release party" — and the agent calls the tool, saves
the result into the workspace, and shows it to you. In the Web Shell, generated
images appear as artifacts in the Artifacts panel.

The tool requires a selected image model; it is also unavailable in `--bare`
or `--safe-mode` sessions and when `tools.executionSandbox` is configured.

## Setup

### 1. Configure an image-capable route

Image generation uses a [`modelProviders`](../configuration/model-providers.md)
route marked with `supportsImageGeneration: true` (or the legacy
`imageOnly: true`). The route must declare an explicit HTTPS `baseUrl` and a
non-empty `envKey`; the API key is read from that environment variable.
DashScope-compatible image endpoints and MiniMax
(`api.minimax.io` / `api.minimaxi.com`) are supported.

The tool appends the generation path itself, so enter the API root as the
`baseUrl`: for DashScope use `https://dashscope.aliyuncs.com/api/v1` — the
`compatible-mode/v1` chat endpoint is **not** an image base URL and fails with
HTTP 404. For MiniMax use `https://api.minimax.io/v1` (or
`https://api.minimaxi.com/v1`).

The easiest path in the Web Shell is **Settings → Models → + Add Model** with
**Model purpose** set to **Image generation**: enter the endpoint and API key,
then the model id. Adding an image model keeps your current conversation
model.

### 2. Select the image model

Any of these paths sets [`imageModel`](../configuration/settings.md#imagemodel):

- The **Image Model** row in Settings opens a picker of image-capable routes
  (including a **Disabled** option).
- `/model --image <model-id>` in the terminal.
- `imageModel` in `settings.json`.

The Web Shell composer does not implement `/model --image`; use the Settings
picker there.

A route can play both roles: with `supportsImageGeneration: true` and no
`imageOnly`, it remains selectable as a conversation model and as the image
model. `imageOnly: true` reserves the route for image generation and hides it
from ordinary model selectors. See
[Image generation routes](../configuration/model-providers.md#image-generation-routes)
for the full configuration shape.

## Generate an image

Ask in natural language; the agent writes the prompt and calls `image_gen`.
The tool asks for permission by default, like other execution tools.

You can request a specific aspect ratio — the tool accepts an optional size in
`width*height` form, for example `1536*864`. The total pixel count must be
between `512*512` and `2048*2048`.

Each generated image is:

- saved to `.qwen/generated-images/<session>/<uuid>.png` inside the workspace;
- registered as a workspace artifact ("Generated image"), visible in the Web
  Shell's Artifacts panel;
- fed back to the conversation model when that model accepts image input, so
  the agent can inspect its own output and iterate on request.

## Troubleshooting

- **"Image generation is not configured with a valid endpoint"** — the
  `imageModel` selector is empty or unparsable, matches zero or several
  image-capable routes, or the matched route lacks an `envKey`, lacks a
  `baseUrl`, or declares a non-HTTPS `baseUrl`. A missing `envKey` produces
  this message too, not the environment-variable message below.
- **"Image generation requires the … environment variable"** — the route's
  `envKey` is not set in the daemon's environment (or the `env` block of
  `settings.json`).
- **"Image generation failed with HTTP 404"** — the route's `baseUrl` is not
  the API root the tool expects. For DashScope use
  `https://dashscope.aliyuncs.com/api/v1`, not the `compatible-mode/v1` chat
  endpoint.
- **The model is missing from the picker** — the route needs
  `supportsImageGeneration: true` (or `imageOnly: true`); image input support
  (`capabilities.vision`) alone does not qualify a route.

## Related

- [Model Providers — Image generation routes](../configuration/model-providers.md#image-generation-routes)
- [Settings reference — imageModel](../configuration/settings.md#imagemodel)
- [Commands — /model](./commands.md)
