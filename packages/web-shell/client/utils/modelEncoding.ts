/**
 * Encodes a model ID from ACP format (modelId(authType)) to storage format
 * (authType:modelId). Core's resolveVisionModelSelection() expects this format.
 * If the input is not in ACP format, returns it unchanged.
 */
export function encodeVisionModelForSetting(modelId: string): string {
  const match = modelId.match(/^(.+)\(([^()]+)\)$/);
  return match ? `${match[2]}:${match[1]}` : modelId;
}

export function extractBareModelId(modelId: string): string {
  const match = modelId.match(/^(.+)\(([^()]+)\)$/);
  return match ? match[1] : modelId;
}

/**
 * Decodes a stored model ID from authType:modelId format back to ACP format
 * (modelId(authType)). Used for picker comparison where model IDs are in ACP
 * format. Splits on the first colon — safe for colon-bearing model IDs
 * (e.g., 'openai:gpt-4o:online' → 'gpt-4o:online(openai)').
 * If the input has no colon, returns it unchanged.
 */
export function decodeVisionModelForPicker(storedValue: string): string {
  // CLI stores custom-endpoint vision models as authType:modelId\0baseUrl.
  // Strip the \0 suffix before decoding to ACP format.
  const nullIdx = storedValue.indexOf('\0');
  const selector = nullIdx >= 0 ? storedValue.slice(0, nullIdx) : storedValue;
  const colonIdx = selector.indexOf(':');
  if (colonIdx > 0) {
    return `${selector.slice(colonIdx + 1)}(${selector.slice(0, colonIdx)})`;
  }
  return selector;
}
