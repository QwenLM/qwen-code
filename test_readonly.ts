import { isShellCommandReadOnlyAST } from '@qwen-code/qwen-code-core/out/utils/shellAstParser.js';
console.log(await isShellCommandReadOnlyAST('git branch --show-current'));
