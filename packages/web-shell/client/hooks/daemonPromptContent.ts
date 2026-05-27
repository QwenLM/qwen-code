import type { PromptContentBlock } from '@qwen-code/sdk/daemon';
import type { PromptImage } from '../adapters/promptTypes';

export function toPromptContent(
  text: string,
  images?: PromptImage[],
): PromptContentBlock[] {
  const prompt: PromptContentBlock[] = [{ type: 'text', text }];
  for (const image of images ?? []) {
    prompt.push({
      type: 'image',
      mimeType: image.media_type,
      data: image.data,
    });
  }
  return prompt;
}
