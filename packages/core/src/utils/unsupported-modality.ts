/**
 * Describe why a model cannot accept a media modality.
 *
 * Both the read_file path and the OpenAI converter build the same refusal, so
 * the wording lives here rather than being duplicated at the two call sites.
 * `sourceKind` is the resolved `modalities` source: a value the user declared
 * and one guessed from the model name need different next steps
 * (QwenLM/qwen-code#16178).
 */
export function unsupportedModalityReason(
  modality: string,
  model: string,
  sourceKind?: string,
): string {
  const opening = `Model '${model}' does not support ${modality} input`;
  if (sourceKind === 'computed') {
    return `${opening}: its input modalities were inferred from the model name. Declare "generationConfig": { "modalities": { "${modality}": true } } on this provider entry to enable it.`;
  }
  if (sourceKind === 'settings') {
    return `${opening}: the "model.generationConfig.modalities" setting is set without ${modality}. Check it and re-select the model with /model.`;
  }
  if (sourceKind === 'modelProviders') {
    return `${opening}: this provider entry's "generationConfig.modalities" is set without ${modality}. Check it and re-select the model with /model.`;
  }
  return `${opening}.`;
}
