/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import {
  CommandKind,
  SlashCommand,
  SubmitPromptActionReturn,
} from './types.js';

export const projectInitCommand: SlashCommand = {
  name: 'startup',
  altNames: ['project-init', 'init-project', 'session-init'],
  description: 'Initialize project session with parallel indexing and RAG searches',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SubmitPromptActionReturn> => {
    const config = context.services.config;
    if (!config) {
      throw new Error('Configuration not available');
    }

    const projectRoot = config.getProjectRoot();
    const projectName = path.basename(projectRoot);
    
    // Parse optional search terms from args, default to common project terms
    const searchTerms = args.trim() 
      ? args.split(',').map(term => term.trim())
      : ['setup', 'config', 'install', 'dependencies', 'architecture'];

    // This command will trigger a submit_prompt that causes parallel execution

    // Return a submit_prompt action that will trigger the parallel execution
    return {
      type: 'submit_prompt',
      content: `Initialize ${projectName} project session:

PHASE 1: Parallel Discovery & Indexing
Execute in parallel:
tts-speak --voice "Bella" "Starting ${projectName} initialization..." + 
rag-index create ${projectRoot} --confirm + 
python3 /MASTERFOLDER/Claude/tools/intelligent_codebase_discovery.py ${projectRoot} --lightweight + 
${searchTerms.map(term => `rag knowledge-base "${term}" --keyword --topk 3`).join(' + ')} + 
glob "**/package.json" + glob "**/requirements.txt" + glob "**/Cargo.toml" + glob "**/.*rc" + glob "**/README*"

PHASE 2: Adaptive Project Analysis
After indexing completes, analyze Phase 1 results and perform 5-6 intelligent searches based on what was discovered:
- Use codebase analysis insights to identify key components
- Use keyword search results to understand project context  
- Use file structure findings to target specific areas
- Execute targeted RAG searches on the indexed project content
- Focus on the most relevant architectural patterns found

Then announce completion:
tts-speak --voice "Isabella" "${projectName} analysis complete - ready for development!"

This creates an adaptive workflow where Phase 2 searches are dynamically determined by Phase 1 discoveries.`
    };
  },
};