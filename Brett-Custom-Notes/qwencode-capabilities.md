# QwenCode Advanced Capabilities (Already Built-In)

## Multi-Stage Edit Correction (SUPERIOR TO GEMINI CLI!)
- LLM-based snippet correction when exact matches fail
- Intelligent escaping fixes for quotes, newlines, special characters
- External edit detection to prevent conflicts
- Performance caching for repeated operations
- Location: `/packages/core/src/utils/editCorrector.ts`

## Range-Based File Reading
- `offset` and `limit` parameters: `read_file "/path/file.txt" offset=100 limit=50`
- Handles text, images, PDF files
- Smart truncation with continuation guidance

## Smart File Discovery
- Automatic modification time sorting (newest first)
- Glob patterns: `**/*.ts`, `src/**/*.js`
- Large codebase optimization

## Advanced Content Search  
- Regex support with full pattern matching
- Context output with file paths and line numbers
- Git-aware searching with .gitignore respect

## Parallel Tool Execution (NEW!)
- Concurrent tool execution without corruption
- Smart JSON detection for multi-tool scenarios
- Function name reset handling

## What We DON'T Need from Gemini CLI
- Multi-stage edit correction ✓ (we have better)
- Range-based file reading ✓ (already implemented)  
- Glob pattern matching ✓ (already implemented)
- Content search ✓ (already implemented + RAG)