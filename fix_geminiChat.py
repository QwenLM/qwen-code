import re

with open('packages/core/src/core/geminiChat.ts') as f:
    content = f.read()

# 1. Add import
content = content.replace(
    "} from './toolCallIdUtils.js';\n",
    "} from './toolCallIdUtils.js';\nimport { createStreamIdleWatchdog, linkAbortSignal, type StreamIdleWatchdog, type InvalidStreamErrorType } from './streamIdleWatchdog.js';\n"
)

# 2. Change InvalidStreamError type
content = content.replace(
    "readonly type: 'NO_FINISH_REASON' | 'NO_RESPONSE_TEXT';",
    "readonly type: InvalidStreamErrorType;"
)
content = content.replace(
    "constructor(message: string, type: 'NO_FINISH_REASON' | 'NO_RESPONSE_TEXT')",
    "constructor(message: string, type: InvalidStreamErrorType)"
)

# 3. Add watchdog in makeApiCallAndProcessStream
content = content.replace(
    "    const apiCall = () =>",
    "    const streamAbortController = new AbortController();\n    const cleanupAbortLink = linkAbortSignal(params.config?.abortSignal, streamAbortController);\n    const streamWatchdog = createStreamIdleWatchdog(model, streamAbortController);\n    const apiCall = () =>"
)

# 4. Add abortSignal to config
content = content.replace(
    "config: { ...this.generationConfig, ...params.config },",
    "config: { ...this.generationConfig, ...params.config, abortSignal: streamAbortController.signal },"
)

# 5. Change return
content = content.replace(
    "    return this.processStreamResponse(model, streamResponse);",
    "    try {\n      return this.processStreamResponse(model, streamResponse, streamWatchdog, cleanupAbortLink);\n    } catch (error) {\n      streamWatchdog?.cleanup();\n      cleanupAbortLink?.();\n      throw error;\n    }"
)

# 6. Change processStreamResponse signature
content = content.replace(
    "  ): AsyncGenerator<GenerateContentResponse> {",
    "    streamWatchdog?: StreamIdleWatchdog,\n    cleanupAbortLink?: () => void,\n  ): AsyncGenerator<GenerateContentResponse> {\n    try {"
)

# 7. Add finally at end of processStreamResponse
content = content.replace(
    "    this.history.push({",
    "    } finally {\n      streamWatchdog?.cleanup();\n      cleanupAbortLink?.();\n    }\n    this.history.push({"
)

with open('packages/core/src/core/geminiChat.ts', 'w') as f:
    f.write(content)
print('ALL EDITS DONE')
