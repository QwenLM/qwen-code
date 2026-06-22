# Vision Bridge

Vision Bridge lets a text-only primary model handle images you paste or reference with `@path/to/image.png`.

When your primary model is known to be text-only and an image-capable model is available in your configured providers, Qwen Code automatically sends the image and surrounding prompt/context to that multimodal model, turns the result into text, and sends that text to your primary model.

If your primary model already supports image input, the bridge is skipped and the image is sent directly to that model. For unknown or custom primary models, Qwen Code assumes text-only and attempts the bridge when an image-capable model is available. If no image-capable model can be found, it keeps the normal unsupported-image behavior.

## What you'll see

On success, Qwen Code shows a notice like:

```text
Converted 1 image(s) to text via qwen3-vl-plus. Your image and prompt/context were sent to that model.
--- BEGIN image interpretation (UNTRUSTED; 1 image(s)) ---
...the description / transcription...
--- END image interpretation ---
```

The transcription is fenced as untrusted machine-generated text. Text inside an image is treated as data, not commands.

## Privacy and safety

- Your image and prompt/context are sent to the auto-selected vision model, which may use a different provider or endpoint than your primary model.
- The runtime notice discloses the model and endpoint host when the bridge sends image data.
- If conversion fails, Qwen Code removes the image data, keeps surrounding text, and tells the primary model that the image content is unavailable.

## Limitations

- The bridge runs in the interactive chat path for pasted or `@`-referenced images.
- Images read by agent tools or headless / ACP runs keep the normal unsupported-image behavior when the active model cannot read images.
- Tool-result images and transcription caching are not handled.
