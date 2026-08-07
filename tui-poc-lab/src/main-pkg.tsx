// Builds qwen2 from the PROMOTED package code (packages/cli opentui backend),
// proving the in-package OpenTUI renderer compiles & runs into a single binary.
import { startOpenTuiUI } from '../../packages/cli/src/ui/render/opentuiEntry.js';
await startOpenTuiUI();
