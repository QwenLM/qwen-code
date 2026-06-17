# Vision Bridge

Vision Bridge lets a **text-only** primary model work with images you paste or reference. When enabled, Qwen Code sends the image to a configured (or auto-selected) **multimodal** model, turns it into a text description, and passes that text to your text-only model — so you keep your preferred text model's reasoning while still being able to share screenshots, error dialogs, and diagrams.

It is **opt-in and disabled by default**. When off (or when your primary model already accepts images), nothing changes.

## When to use it

- Your strongest model for coding is text-only, but you occasionally paste a screenshot or an error image.
- You don't want to switch your primary model to a multimodal one just to read one image.

If your primary model already supports image input, you don't need this — the image is sent to it directly.

## How it works

1. You paste an image or reference one with `@path/to/image.png`.
2. If the bridge is enabled and your primary model is text-only, Qwen Code sends the image(s) and your prompt to the bridge (vision) model.
3. The vision model returns a text description / transcription.
4. That text — wrapped in a clearly marked, untrusted block — is sent to your primary model in place of the image.

What the model receives is the same text you see, so your conversation history stays consistent.

## Enabling it

Add a `visionBridge` block to your `settings.json`:

```json
{
  "visionBridge": {
    "enabled": true
  }
}
```

With just `enabled: true`, the bridge **auto-selects** an image-capable model from your configured providers, preferring one on the same provider as your primary model. To pin a specific model, set `model`:

```json
{
  "visionBridge": {
    "enabled": true,
    "model": "qwen3-vl-plus",
    "maxImages": 4,
    "timeoutMs": 30000,
    "showTranscript": true
  }
}
```

The pinned `model` must be an image-capable model that is resolvable in your configuration (i.e. registered under `modelProviders` so its endpoint and credentials can be resolved).

## Settings

| Setting                       | Type    | Description                                                                                                       | Default |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| `visionBridge.enabled`        | boolean | Convert images to text via a vision model when the primary model is text-only.                                    | `false` |
| `visionBridge.model`          | string  | Vision model id used to transcribe/describe images. Leave empty to auto-select an image-capable registered model. | `""`    |
| `visionBridge.maxImages`      | number  | Maximum number of images converted per turn; extras are reported as omitted. Clamped to 1–16.                     | `4`     |
| `visionBridge.timeoutMs`      | number  | Timeout for the vision model call only (not the whole turn), in milliseconds. Clamped to 1000–120000.             | `30000` |
| `visionBridge.showTranscript` | boolean | Show the generated transcription so you can catch misreads.                                                       | `true`  |

## What you'll see

On success, a notice like:

```
🔎 Converted 1 image(s) to text via qwen3-vl-plus. Your image and prompt were sent to that model.
--- BEGIN image interpretation (UNTRUSTED; 1 image(s)) ---
...the description / transcription...
--- END image interpretation ---
```

The notice always discloses that your image and prompt were sent to the vision model, even if `showTranscript` is off.

## Privacy and safety

- **Data egress**: your image(s) and prompt are sent to the configured vision model, which may be a different provider/endpoint than your primary model. The bridge runs only when you enable it, and the runtime notice tells you each time it happens.
- **Untrusted by design**: the transcription is fenced as untrusted machine-generated text. Text inside an image (e.g. instructions embedded in a screenshot) is treated as data, not commands — it is not executed or obeyed.

## Failure behavior

If the conversion fails — the vision model times out, returns nothing, or no image-capable model is available — Qwen Code shows the failure reason and **stops the turn**. The primary model is not asked to respond, so it never answers as if it had seen the image. Resolve the cause (a reachable vision model, a higher `timeoutMs`) or describe the image in text yourself, then retry.

## Limitations

- **Interactive only**: the bridge runs in the interactive chat path (pasted or `@`-referenced images). Images read by agent tools (`read_file`, `read_many_files`) or in headless / ACP runs are not transcribed — with a text-only model they keep the normal "image input not supported" message. Use a multimodal model for those flows.
- **Tool-result images and transcription caching** are not handled yet.
