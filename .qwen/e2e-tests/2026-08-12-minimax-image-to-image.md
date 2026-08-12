# MiniMax image-to-image generation

## Scenario

Configure the MiniMax preset with `image-01` as the image model. Ask Qwen Code
to generate a new portrait that preserves the character from a public HTTPS
reference image while changing the setting.

## Checks

- The `image_gen` approval shows the requested prompt and reference-image mode.
- The request uses the configured regional image-generation endpoint and sends
  the reference as a character `subject_reference`.
- The generated PNG is saved under `.qwen/generated-images/<session>/` and is
  returned as a workspace artifact.
- Repeat with a PNG data URL reference and confirm the generated PNG is saved.
- A private-network reference URL fails before a billable request is sent.

## Baseline

The released global CLI cannot perform this flow because its `image_gen` tool
schema does not accept a reference image. A live baseline request was not sent
because image generation is billable. The focused service and tool tests cover
the request payload, both regional endpoints, URL and data URL references, URL
and base64 responses, and pre-request rejection of private URLs.
