import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import type { Config } from '../config/config.js';

// Full implementation lands in Task 5.3. For now, throw so the dispatch is
// wired but not yet functional — this lets the enum / validation / dispatch
// land first without pulling in the real Copilot generator.
export async function createCopilotContentGenerator(
  _genConfig: ContentGeneratorConfig,
  _config: Config,
): Promise<never> {
  throw new Error('createCopilotContentGenerator not yet implemented');
}
