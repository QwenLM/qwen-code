Bora! A ideia é: você roda o **LanguageTool** como servidor HTTP local e faz um **CLI “chat”** em Node usando **Ink** (React para terminal). Ao enviar uma mensagem, o app chama `POST /v2/check`, mostra os problemas e oferece o texto corrigido.

---

# UI com Ink (o “chat”)

`App.jsx`

```jsx
import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { checkText, applyFirstSuggestions } from './ltClient.js';

export default function App(props) {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState([]); // {you, corrected, matches}
  const [error, setError] = useState('');

  const {
    server = 'http://localhost:8081',
    lang = 'pt-BR',
    mothertongue,
    rulesOn,
    rulesOff,
  } = props;

  useInput((key, data) => {
    if (data.ctrl && key === 'c') exit();
  });

  async function onSubmit(value) {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError('');

    try {
      const res = await checkText({
        server,
        text: value,
        language: lang,
        motherTongue: mothertongue,
        enabledRules: rulesOn,
        disabledRules: rulesOff,
      });

      const corrected = applyFirstSuggestions(value, res.matches || []);
      setMsgs((prev) => [
        ...prev,
        { you: value, corrected, matches: res.matches || [] },
      ]);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
      setInput('');
    }
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">LT Chat</Text>
        <Text>
          {' '}
          — servidor: {server} — idioma: {lang}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {msgs.length === 0 && (
          <Text dimColor>
            Digite uma frase e pressione Enter. Ctrl+C para sair.
          </Text>
        )}

        {msgs.map((m, i) => {
          const changed = m.you !== m.corrected;
          return (
            <Box key={i} flexDirection="column" marginBottom={1}>
              <Text>
                <Text color="yellow">Você:</Text> {m.you}
              </Text>
              {changed ? (
                <>
                  <Text>
                    <Text color="green">Corrigido:</Text> {m.corrected}
                  </Text>
                  {m.matches.length > 0 && (
                    <Box flexDirection="column" marginLeft={2}>
                      {m.matches.map((match, j) => (
                        <Text key={j} dimColor>
                          • {match.message}{' '}
                          {match.replacements?.length
                            ? `→ ${match.replacements
                                .slice(0, 3)
                                .map((r) => r.value)
                                .join(' | ')}`
                            : ''}
                          {match.rule?.id ? `  [${match.rule.id}]` : ''}
                        </Text>
                      ))}
                    </Box>
                  )}
                </>
              ) : (
                <Text color="green">Sem problemas 👍</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {error && <Text color="red">Erro: {error}</Text>}

      <Box marginTop={1}>
        <Text color={busy ? 'gray' : 'white'}>› </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          placeholder={busy ? 'checando…' : 'Digite aqui e Enter'}
          focus={!busy}
        />
      </Box>
    </Box>
  );
}
```

---

# Entrada do CLI (flags, bootstrap)

`cli.js`

```js
#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import App from './App.jsx';

const cli = meow(
  `
Uso
  $ lt-chat [opções]

Opções
  --server, -s       URL do servidor LanguageTool (default: http://localhost:8081)
  --lang, -l         Código do idioma (ex: pt-BR, en-US)
  --mothertongue     Idioma nativo (ex: pt-BR)
  --rules-on         enabledRules separados por vírgula
  --rules-off        disabledRules separados por vírgula

Exemplos
  $ lt-chat -l pt-BR
  $ lt-chat --server http://127.0.0.1:8081 --rules-off=UPPERCASE_SENTENCE_START
`,
  {
    importMeta: import.meta,
    flags: {
      server: {
        type: 'string',
        shortFlag: 's',
        default: 'http://localhost:8081',
      },
      lang: { type: 'string', shortFlag: 'l', default: 'pt-BR' },
      mothertongue: { type: 'string' },
      rulesOn: { type: 'string' },
      rulesOff: { type: 'string' },
    },
  },
);

render(<App {...cli.flags} />);
```

Dê permissão de execução:

```bash
chmod +x cli.js
npm link   # (opcional) para usar como comando global
```

Rodar:

```bash
lt-chat -l pt-BR
# ou
node cli.js --lang pt-BR
```

---

Acima está um exemplo de como usar languagetoo.
languagetoo já está rodando na porta 8081.

como usar languagetool para corrigir os inputs dos usuários no qwen-code?

Based on my analysis of the Qwen-Code system, here's how it processes and validates user input, and how LanguageTool could be integrated:

## Current Input Processing and Validation System

The Qwen-Code system implements a multi-layered input processing and validation architecture:

### 1. Text Buffer Layer (Character-Level Processing)

The lowest level handles raw keyboard input and character filtering. [1](#1-0) The system strips unsafe characters including ANSI escape codes and control characters that could break terminal rendering, while preserving line breaks.

### 2. Input Prompt Layer (Command Processing)

The input prompt component processes user commands and handles special operations. [2](#1-1) This layer manages various input types including regular text, slash commands, shell commands, and special key combinations like Ctrl+C for clearing input.

### 3. Slash Command Validation

The slash command processor validates and routes commands starting with "/" or "?". [3](#1-2) It performs command path resolution, validates command existence, and handles hierarchical command structures with subcommands and aliases.

### 4. Tool Parameter Validation

Each tool implements parameter validation through a standardized interface. [4](#1-3) Tools must validate their parameters in both confirmation and execution phases, returning error messages for invalid inputs.

The tool registry also sanitizes parameters for AI model compatibility. [5](#1-4) This includes handling enum values, removing unsupported format specifications, and ensuring schema compatibility with the Gemini API.

Specific tools like the Edit tool demonstrate comprehensive validation including path validation and security checks. [6](#1-5) This ensures file paths are absolute, within the allowed root directory, and conform to the expected schema.

## LanguageTool Integration Opportunities

LanguageTool could be integrated at several levels of this existing validation system:

### 1. Text Buffer Level Integration

Real-time grammar and style checking could be implemented at the text buffer level, similar to how unsafe character filtering currently works. This would provide immediate feedback as users type.

### 2. Input Prompt Enhancement

The input prompt layer could incorporate LanguageTool validation before command submission, correcting grammar issues in user queries before they're processed by the AI model.

### 3. New Tool Implementation

A dedicated LanguageTool could be created following the existing tool architecture, implementing the `validateToolParams` method and providing grammar checking as an explicit user command.

### 4. Preprocessing Pipeline

LanguageTool could be integrated as a preprocessing step in the command processing pipeline, automatically correcting user input before it reaches the AI model, similar to how the slash command processor currently validates and transforms input.

The existing validation infrastructure provides a solid foundation for LanguageTool integration, with established patterns for parameter validation, error handling, and user feedback that could be extended to support grammar and style correction.

## Notes

The Qwen-Code system currently has no existing LanguageTool integration. The input validation system is primarily focused on security, command syntax, and AI model compatibility rather than linguistic correctness. The modular architecture and established validation patterns would facilitate LanguageTool integration at multiple levels, allowing for both real-time correction and explicit grammar checking capabilities.

/\*\*

- @license
- Copyright 2025 Google LLC
- SPDX-License-Identifier: Apache-2.0
  \*/

import {
Content,
GenerateContentConfig,
SchemaUnion,
Type,
} from '@google/genai';
import { GeminiClient } from '../core/client.js';
import { EditToolParams, EditTool } from '../tools/edit.js';
import { WriteFileTool } from '../tools/write-file.js';
import { ReadFileTool } from '../tools/read-file.js';
import { ReadManyFilesTool } from '../tools/read-many-files.js';
import { GrepTool } from '../tools/grep.js';
import { LruCache } from './LruCache.js';
import { DEFAULT_GEMINI_FLASH_MODEL } from '../config/models.js';
import {
isFunctionResponse,
isFunctionCall,
} from '../utils/messageInspectors.js';
import \* as fs from 'fs';

const EditModel = DEFAULT_GEMINI_FLASH_MODEL;
const EditConfig: GenerateContentConfig = {
thinkingConfig: {
thinkingBudget: 0,
},
};

const MAX_CACHE_SIZE = 50;

// Cache for ensureCorrectEdit results
const editCorrectionCache = new LruCache<string, CorrectedEditResult>(
MAX_CACHE_SIZE,
);

// Cache for ensureCorrectFileContent results
const fileContentCorrectionCache = new LruCache<string, string>(MAX_CACHE_SIZE);

/\*\*

- Defines the structure of the parameters within CorrectedEditResult
  \*/
  interface CorrectedEditParams {
  file_path: string;
  old_string: string;
  new_string: string;
  }

/\*\*

- Defines the result structure for ensureCorrectEdit.
  \*/
  export interface CorrectedEditResult {
  params: CorrectedEditParams;
  occurrences: number;
  }

/\*\*

- Extracts the timestamp from the .id value, which is in format
- <tool.name>-<timestamp>-<uuid>
- @param fcnId the ID value of a functionCall or functionResponse object
- @returns -1 if the timestamp could not be extracted, else the timestamp (as a number)
  \*/
  function getTimestampFromFunctionId(fcnId: string): number {
  const idParts = fcnId.split('-');
  if (idParts.length > 2) {
  const timestamp = parseInt(idParts[1], 10);
  if (!isNaN(timestamp)) {
  return timestamp;
  }
  }
  return -1;
  }

/\*\*

- Will look through the gemini client history and determine when the most recent
- edit to a target file occurred. If no edit happened, it will return -1
- @param filePath the path to the file
- @param client the geminiClient, so that we can get the history
- @returns a DateTime (as a number) of when the last edit occurred, or -1 if no edit was found.
  \*/
  async function findLastEditTimestamp(
  filePath: string,
  client: GeminiClient,
  ): Promise<number> {
  const history = (await client.getHistory()) ?? [];

// Tools that may reference the file path in their FunctionResponse `output`.
const toolsInResp = new Set([
WriteFileTool.Name,
EditTool.Name,
ReadManyFilesTool.Name,
GrepTool.Name,
]);
// Tools that may reference the file path in their FunctionCall `args`.
const toolsInCall = new Set([...toolsInResp, ReadFileTool.Name]);

// Iterate backwards to find the most recent relevant action.
for (const entry of history.slice().reverse()) {
if (!entry.parts) continue;

    for (const part of entry.parts) {
      let id: string | undefined;
      let content: unknown;

      // Check for a relevant FunctionCall with the file path in its arguments.
      if (
        isFunctionCall(entry) &&
        part.functionCall?.name &&
        toolsInCall.has(part.functionCall.name)
      ) {
        id = part.functionCall.id;
        content = part.functionCall.args;
      }
      // Check for a relevant FunctionResponse with the file path in its output.
      else if (
        isFunctionResponse(entry) &&
        part.functionResponse?.name &&
        toolsInResp.has(part.functionResponse.name)
      ) {
        const { response } = part.functionResponse;
        if (response && !('error' in response) && 'output' in response) {
          id = part.functionResponse.id;
          content = response.output;
        }
      }

      if (!id || content === undefined) continue;

      // Use the "blunt hammer" approach to find the file path in the content.
      // Note that the tool response data is inconsistent in their formatting
      // with successes and errors - so, we just check for the existence
      // as the best guess to if error/failed occurred with the response.
      const stringified = JSON.stringify(content);
      if (
        !stringified.includes('Error') && // only applicable for functionResponse
        !stringified.includes('Failed') && // only applicable for functionResponse
        stringified.includes(filePath)
      ) {
        return getTimestampFromFunctionId(id);
      }
    }

}

return -1;
}

/\*\*

- Attempts to correct edit parameters if the original old_string is not found.
- It tries unescaping, and then LLM-based correction.
- Results are cached to avoid redundant processing.
-
- @param currentContent The current content of the file.
- @param originalParams The original EditToolParams
- @param client The GeminiClient for LLM calls.
- @returns A promise resolving to an object containing the (potentially corrected)
-          EditToolParams (as CorrectedEditParams) and the final occurrences count.
  \*/
  export async function ensureCorrectEdit(
  filePath: string,
  currentContent: string,
  originalParams: EditToolParams, // This is the EditToolParams from edit.ts, without \'corrected\'
  client: GeminiClient,
  abortSignal: AbortSignal,
  ): Promise<CorrectedEditResult> {
  const cacheKey = `${currentContent}---${originalParams.old_string}---${originalParams.new_string}`;
  const cachedResult = editCorrectionCache.get(cacheKey);
  if (cachedResult) {
  return cachedResult;
  }

let finalNewString = originalParams.new_string;
const newStringPotentiallyEscaped =
unescapeStringForGeminiBug(originalParams.new_string) !==
originalParams.new_string;

const expectedReplacements = originalParams.expected_replacements ?? 1;

let finalOldString = originalParams.old_string;
let occurrences = countOccurrences(currentContent, finalOldString);

if (occurrences === expectedReplacements) {
if (newStringPotentiallyEscaped) {
finalNewString = await correctNewStringEscaping(
client,
finalOldString,
originalParams.new_string,
abortSignal,
);
}
} else if (occurrences > expectedReplacements) {
const expectedReplacements = originalParams.expected_replacements ?? 1;

    // If user expects multiple replacements, return as-is
    if (occurrences === expectedReplacements) {
      const result: CorrectedEditResult = {
        params: { ...originalParams },
        occurrences,
      };
      editCorrectionCache.set(cacheKey, result);
      return result;
    }

    // If user expects 1 but found multiple, try to correct (existing behavior)
    if (expectedReplacements === 1) {
      const result: CorrectedEditResult = {
        params: { ...originalParams },
        occurrences,
      };
      editCorrectionCache.set(cacheKey, result);
      return result;
    }

    // If occurrences don't match expected, return as-is (will fail validation later)
    const result: CorrectedEditResult = {
      params: { ...originalParams },
      occurrences,
    };
    editCorrectionCache.set(cacheKey, result);
    return result;

} else {
// occurrences is 0 or some other unexpected state initially
const unescapedOldStringAttempt = unescapeStringForGeminiBug(
originalParams.old_string,
);
occurrences = countOccurrences(currentContent, unescapedOldStringAttempt);

    if (occurrences === expectedReplacements) {
      finalOldString = unescapedOldStringAttempt;
      if (newStringPotentiallyEscaped) {
        finalNewString = await correctNewString(
          client,
          originalParams.old_string, // original old
          unescapedOldStringAttempt, // corrected old
          originalParams.new_string, // original new (which is potentially escaped)
          abortSignal,
        );
      }
    } else if (occurrences === 0) {
      if (filePath) {
        // In order to keep from clobbering edits made outside our system,
        // let's check if there was a more recent edit to the file than what
        // our system has done
        const lastEditedByUsTime = await findLastEditTimestamp(
          filePath,
          client,
        );

        // Add a 1-second buffer to account for timing inaccuracies. If the file
        // was modified more than a second after the last edit tool was run, we
        // can assume it was modified by something else.
        if (lastEditedByUsTime > 0) {
          const stats = fs.statSync(filePath);
          const diff = stats.mtimeMs - lastEditedByUsTime;
          if (diff > 2000) {
            // Hard coded for 2 seconds
            // This file was edited sooner
            const result: CorrectedEditResult = {
              params: { ...originalParams },
              occurrences: 0, // Explicitly 0 as LLM failed
            };
            editCorrectionCache.set(cacheKey, result);
            return result;
          }
        }
      }

      const llmCorrectedOldString = await correctOldStringMismatch(
        client,
        currentContent,
        unescapedOldStringAttempt,
        abortSignal,
      );
      const llmOldOccurrences = countOccurrences(
        currentContent,
        llmCorrectedOldString,
      );

      if (llmOldOccurrences === expectedReplacements) {
        finalOldString = llmCorrectedOldString;
        occurrences = llmOldOccurrences;

        if (newStringPotentiallyEscaped) {
          const baseNewStringForLLMCorrection = unescapeStringForGeminiBug(
            originalParams.new_string,
          );
          finalNewString = await correctNewString(
            client,
            originalParams.old_string, // original old
            llmCorrectedOldString, // corrected old
            baseNewStringForLLMCorrection, // base new for correction
            abortSignal,
          );
        }
      } else {
        // LLM correction also failed for old_string
        const result: CorrectedEditResult = {
          params: { ...originalParams },
          occurrences: 0, // Explicitly 0 as LLM failed
        };
        editCorrectionCache.set(cacheKey, result);
        return result;
      }
    } else {
      // Unescaping old_string resulted in > 1 occurrence
      const result: CorrectedEditResult = {
        params: { ...originalParams },
        occurrences, // This will be > 1
      };
      editCorrectionCache.set(cacheKey, result);
      return result;
    }

}

const { targetString, pair } = trimPairIfPossible(
finalOldString,
finalNewString,
currentContent,
expectedReplacements,
);
finalOldString = targetString;
finalNewString = pair;

// Final result construction
const result: CorrectedEditResult = {
params: {
file_path: originalParams.file_path,
old_string: finalOldString,
new_string: finalNewString,
},
occurrences: countOccurrences(currentContent, finalOldString), // Recalculate occurrences with the final old_string
};
editCorrectionCache.set(cacheKey, result);
return result;
}

export async function ensureCorrectFileContent(
content: string,
client: GeminiClient,
abortSignal: AbortSignal,
): Promise<string> {
const cachedResult = fileContentCorrectionCache.get(content);
if (cachedResult) {
return cachedResult;
}

const contentPotentiallyEscaped =
unescapeStringForGeminiBug(content) !== content;
if (!contentPotentiallyEscaped) {
fileContentCorrectionCache.set(content, content);
return content;
}

const correctedContent = await correctStringEscaping(
content,
client,
abortSignal,
);
fileContentCorrectionCache.set(content, correctedContent);
return correctedContent;
}

// Define the expected JSON schema for the LLM response for old_string correction
const OLD_STRING_CORRECTION_SCHEMA: SchemaUnion = {
type: Type.OBJECT,
properties: {
corrected_target_snippet: {
type: Type.STRING,
description:
'The corrected version of the target snippet that exactly and uniquely matches a segment within the provided file content.',
},
},
required: ['corrected_target_snippet'],
};

export async function correctOldStringMismatch(
geminiClient: GeminiClient,
fileContent: string,
problematicSnippet: string,
abortSignal: AbortSignal,
): Promise<string> {
const prompt = `
Context: A process needs to find an exact literal, unique match for a specific text snippet within a file's content. The provided snippet failed to match exactly. This is most likely because it has been overly escaped.

Task: Analyze the provided file content and the problematic target snippet. Identify the segment in the file content that the snippet was _most likely_ intended to match. Output the _exact_, literal text of that segment from the file content. Focus _only_ on removing extra escape characters and correcting formatting, whitespace, or minor differences to achieve a PERFECT literal match. The output must be the exact literal text as it appears in the file.

Problematic target snippet:
\`\`\`
${problematicSnippet}
\`\`\`

File Content:
\`\`\`
${fileContent}
\`\`\`

For example, if the problematic target snippet was "\\\\\\nconst greeting = \`Hello \\\\\`\${name}\\\\\`\`;" and the file content had content that looked like "\nconst greeting = \`Hello ${'\\`'}\${name}${'\\`'}\`;", then corrected_target_snippet should likely be "\nconst greeting = \`Hello ${'\\`'}\${name}${'\\`'}\`;" to fix the incorrect escaping to match the original file content.
If the differences are only in whitespace or formatting, apply similar whitespace/formatting changes to the corrected_target_snippet.

Return ONLY the corrected target snippet in the specified JSON format with the key 'corrected_target_snippet'. If no clear, unique match can be found, return an empty string for 'corrected_target_snippet'.
`.trim();

const contents: Content[] = [{ role: 'user', parts: [{ text: prompt }] }];

try {
const result = await geminiClient.generateJson(
contents,
OLD_STRING_CORRECTION_SCHEMA,
abortSignal,
EditModel,
EditConfig,
);

    if (
      result &&
      typeof result.corrected_target_snippet === 'string' &&
      result.corrected_target_snippet.length > 0
    ) {
      return result.corrected_target_snippet;
    } else {
      return problematicSnippet;
    }

} catch (error) {
if (abortSignal.aborted) {
throw error;
}

    console.error(
      'Error during LLM call for old string snippet correction:',
      error,
    );

    return problematicSnippet;

}
}

// Define the expected JSON schema for the new_string correction LLM response
const NEW_STRING_CORRECTION_SCHEMA: SchemaUnion = {
type: Type.OBJECT,
properties: {
corrected_new_string: {
type: Type.STRING,
description:
'The original_new_string adjusted to be a suitable replacement for the corrected_old_string, while maintaining the original intent of the change.',
},
},
required: ['corrected_new_string'],
};

/\*\*

- Adjusts the new_string to align with a corrected old_string, maintaining the original intent.
  \*/
  export async function correctNewString(
  geminiClient: GeminiClient,
  originalOldString: string,
  correctedOldString: string,
  originalNewString: string,
  abortSignal: AbortSignal,
  ): Promise<string> {
  if (originalOldString === correctedOldString) {
  return originalNewString;
  }

const prompt = `
Context: A text replacement operation was planned. The original text to be replaced (original_old_string) was slightly different from the actual text in the file (corrected_old_string). The original_old_string has now been corrected to match the file content.
We now need to adjust the replacement text (original_new_string) so that it makes sense as a replacement for the corrected_old_string, while preserving the original intent of the change.

original_old_string (what was initially intended to be found):
\`\`\`
${originalOldString}
\`\`\`

corrected_old_string (what was actually found in the file and will be replaced):
\`\`\`
${correctedOldString}
\`\`\`

original_new_string (what was intended to replace original_old_string):
\`\`\`
${originalNewString}
\`\`\`

Task: Based on the differences between original_old_string and corrected_old_string, and the content of original_new_string, generate a corrected_new_string. This corrected_new_string should be what original_new_string would have been if it was designed to replace corrected_old_string directly, while maintaining the spirit of the original transformation.

For example, if original_old_string was "\\\\\\nconst greeting = \`Hello \\\\\`\${name}\\\\\`\`;" and corrected_old_string is "\nconst greeting = \`Hello ${'\\`'}\${name}${'\\`'}\`;", and original_new_string was "\\\\\\nconst greeting = \`Hello \\\\\`\${name} \${lastName}\\\\\`\`;", then corrected_new_string should likely be "\nconst greeting = \`Hello ${'\\`'}\${name} \${lastName}${'\\`'}\`;" to fix the incorrect escaping.
If the differences are only in whitespace or formatting, apply similar whitespace/formatting changes to the corrected_new_string.

Return ONLY the corrected string in the specified JSON format with the key 'corrected_new_string'. If no adjustment is deemed necessary or possible, return the original_new_string.
`.trim();

const contents: Content[] = [{ role: 'user', parts: [{ text: prompt }] }];

try {
const result = await geminiClient.generateJson(
contents,
NEW_STRING_CORRECTION_SCHEMA,
abortSignal,
EditModel,
EditConfig,
);

    if (
      result &&
      typeof result.corrected_new_string === 'string' &&
      result.corrected_new_string.length > 0
    ) {
      return result.corrected_new_string;
    } else {
      return originalNewString;
    }

} catch (error) {
if (abortSignal.aborted) {
throw error;
}

    console.error('Error during LLM call for new_string correction:', error);
    return originalNewString;

}
}

const CORRECT_NEW_STRING_ESCAPING_SCHEMA: SchemaUnion = {
type: Type.OBJECT,
properties: {
corrected_new_string_escaping: {
type: Type.STRING,
description:
'The new_string with corrected escaping, ensuring it is a proper replacement for the old_string, especially considering potential over-escaping issues from previous LLM generations.',
},
},
required: ['corrected_new_string_escaping'],
};

export async function correctNewStringEscaping(
geminiClient: GeminiClient,
oldString: string,
potentiallyProblematicNewString: string,
abortSignal: AbortSignal,
): Promise<string> {
const prompt = `
Context: A text replacement operation is planned. The text to be replaced (old_string) has been correctly identified in the file. However, the replacement text (new_string) might have been improperly escaped by a previous LLM generation (e.g. too many backslashes for newlines like \\n instead of \n, or unnecessarily quotes like \\"Hello\\" instead of "Hello").

old_string (this is the exact text that will be replaced):
\`\`\`
${oldString}
\`\`\`

potentially_problematic_new_string (this is the text that should replace old_string, but MIGHT have bad escaping, or might be entirely correct):
\`\`\`
${potentiallyProblematicNewString}
\`\`\`

Task: Analyze the potentially_problematic_new_string. If it's syntactically invalid due to incorrect escaping (e.g., "\n", "\t", "\\", "\\'", "\\""), correct the invalid syntax. The goal is to ensure the new_string, when inserted into the code, will be a valid and correctly interpreted.

For example, if old_string is "foo" and potentially_problematic_new_string is "bar\\nbaz", the corrected_new_string_escaping should be "bar\nbaz".
If potentially_problematic_new_string is console.log(\\"Hello World\\"), it should be console.log("Hello World").

Return ONLY the corrected string in the specified JSON format with the key 'corrected_new_string_escaping'. If no escaping correction is needed, return the original potentially_problematic_new_string.
`.trim();

const contents: Content[] = [{ role: 'user', parts: [{ text: prompt }] }];

try {
const result = await geminiClient.generateJson(
contents,
CORRECT_NEW_STRING_ESCAPING_SCHEMA,
abortSignal,
EditModel,
EditConfig,
);

    if (
      result &&
      typeof result.corrected_new_string_escaping === 'string' &&
      result.corrected_new_string_escaping.length > 0
    ) {
      return result.corrected_new_string_escaping;
    } else {
      return potentiallyProblematicNewString;
    }

} catch (error) {
if (abortSignal.aborted) {
throw error;
}

    console.error(
      'Error during LLM call for new_string escaping correction:',
      error,
    );
    return potentiallyProblematicNewString;

}
}

const CORRECT_STRING_ESCAPING_SCHEMA: SchemaUnion = {
type: Type.OBJECT,
properties: {
corrected_string_escaping: {
type: Type.STRING,
description:
'The string with corrected escaping, ensuring it is valid, specially considering potential over-escaping issues from previous LLM generations.',
},
},
required: ['corrected_string_escaping'],
};

export async function correctStringEscaping(
potentiallyProblematicString: string,
client: GeminiClient,
abortSignal: AbortSignal,
): Promise<string> {
const prompt = `
Context: An LLM has just generated potentially_problematic_string and the text might have been improperly escaped (e.g. too many backslashes for newlines like \\n instead of \n, or unnecessarily quotes like \\"Hello\\" instead of "Hello").

potentially_problematic_string (this text MIGHT have bad escaping, or might be entirely correct):
\`\`\`
${potentiallyProblematicString}
\`\`\`

Task: Analyze the potentially_problematic_string. If it's syntactically invalid due to incorrect escaping (e.g., "\n", "\t", "\\", "\\'", "\\""), correct the invalid syntax. The goal is to ensure the text will be a valid and correctly interpreted.

For example, if potentially_problematic_string is "bar\\nbaz", the corrected_new_string_escaping should be "bar\nbaz".
If potentially_problematic_string is console.log(\\"Hello World\\"), it should be console.log("Hello World").

Return ONLY the corrected string in the specified JSON format with the key 'corrected_string_escaping'. If no escaping correction is needed, return the original potentially_problematic_string.
`.trim();

const contents: Content[] = [{ role: 'user', parts: [{ text: prompt }] }];

try {
const result = await client.generateJson(
contents,
CORRECT_STRING_ESCAPING_SCHEMA,
abortSignal,
EditModel,
EditConfig,
);

    if (
      result &&
      typeof result.corrected_string_escaping === 'string' &&
      result.corrected_string_escaping.length > 0
    ) {
      return result.corrected_string_escaping;
    } else {
      return potentiallyProblematicString;
    }

} catch (error) {
if (abortSignal.aborted) {
throw error;
}

    console.error(
      'Error during LLM call for string escaping correction:',
      error,
    );
    return potentiallyProblematicString;

}
}

function trimPairIfPossible(
target: string,
trimIfTargetTrims: string,
currentContent: string,
expectedReplacements: number,
) {
const trimmedTargetString = target.trim();
if (target.length !== trimmedTargetString.length) {
const trimmedTargetOccurrences = countOccurrences(
currentContent,
trimmedTargetString,
);

    if (trimmedTargetOccurrences === expectedReplacements) {
      const trimmedReactiveString = trimIfTargetTrims.trim();
      return {
        targetString: trimmedTargetString,
        pair: trimmedReactiveString,
      };
    }

}

return {
targetString: target,
pair: trimIfTargetTrims,
};
}

/\*\*

- Unescapes a string that might have been overly escaped by an LLM.
  \*/
  export function unescapeStringForGeminiBug(inputString: string): string {
  // Regex explanation:
  // \\ : Matches exactly one literal backslash character.
  // (n|t|r|'|"|`|\\|\n) : This is a capturing group. It matches one of the following:
  //   n, t, r, ', ", ` : These match the literal characters 'n', 't', 'r', single quote, double quote, or backtick.
  // This handles cases like "\\n", "\\`", etc.
  // \\ : This matches a literal backslash. This handles cases like "\\\\" (escaped backslash).
  // \n : This matches an actual newline character. This handles cases where the input
  // string might have something like "\\\n" (a literal backslash followed by a newline).
  // g : Global flag, to replace all occurrences.

return inputString.replace(
/\\+(n|t|r|'|"|`|\\|\n)/g,
    (match, capturedChar) => {
      // 'match' is the entire erroneous sequence, e.g., if the input (in memory) was "\\\\`", match is "\\\\`".
      // 'capturedChar' is the character that determines the true meaning, e.g., '`'.

      switch (capturedChar) {
        case 'n':
          return '\n'; // Correctly escaped: \n (newline character)
        case 't':
          return '\t'; // Correctly escaped: \t (tab character)
        case 'r':
          return '\r'; // Correctly escaped: \r (carriage return character)
        case "'":
          return "'"; // Correctly escaped: ' (apostrophe character)
        case '"':
          return '"'; // Correctly escaped: " (quotation mark character)
        case '`':
          return '`'; // Correctly escaped: ` (backtick character)
        case '\\': // This handles when 'capturedChar' is a literal backslash
          return '\\'; // Replace escaped backslash (e.g., "\\\\") with single backslash
        case '\n': // This handles when 'capturedChar' is an actual newline
          return '\n'; // Replace the whole erroneous sequence (e.g., "\\\n" in memory) with a clean newline
        default:
          // This fallback should ideally not be reached if the regex captures correctly.
          // It would return the original matched sequence if an unexpected character was captured.
          return match;
      }
    },

);
}

/\*\*

- Counts occurrences of a substring in a string
  \*/
  export function countOccurrences(str: string, substr: string): number {
  if (substr === '') {
  return 0;
  }
  let count = 0;
  let pos = str.indexOf(substr);
  while (pos !== -1) {
  count++;
  pos = str.indexOf(substr, pos + substr.length); // Start search after the current match
  }
  return count;
  }

export function resetEditCorrectorCaches_TEST_ONLY() {
editCorrectionCache.clear();
fileContentCorrectionCache.clear();
}

---

Boa! Como o seu **LanguageTool já está rodando em `http://localhost:8081`**, dá pra plugar no **Qwen-Code** em dois jeitos (podem coexistir):

1. **Pré-processador automático** dos inputs do usuário (corrige antes de mandar pro modelo).
2. **Tool/Slash-command** explícito (o usuário digita `/lt …` ou o próprio LLM chama a ferramenta).

Abaixo vai **código completo**, pronto pra colar. Use Node ≥ 20 (tem `fetch` nativo).

---

# 1) Cliente do LanguageTool (reuso no app todo)

`src/integrations/languagetool/ltClient.ts`

```ts
// Node >= 20 (fetch nativo)
export type LTMatch = {
  message: string;
  shortMessage?: string;
  offset: number;
  length: number;
  replacements?: { value: string }[];
  rule?: { id?: string; description?: string; issueType?: string };
  context?: { text: string; offset: number; length: number };
};

export type LTCheckParams = {
  server?: string; // default: http://localhost:8081
  text: string;
  language?: string; // ex: 'pt-BR', 'en-US'
  motherTongue?: string; // ex: 'pt-BR'
  enabledRules?: string[]; // ids
  disabledRules?: string[]; // ids
  level?: 'default' | 'picky';
};

export type LTCheckResponse = {
  matches: LTMatch[];
  language?: { name?: string; code?: string; detected?: boolean };
};

const toCsv = (xs?: string[]) => (xs && xs.length ? xs.join(',') : undefined);

export async function checkText({
  server = 'http://localhost:8081',
  text,
  language = 'pt-BR',
  motherTongue,
  enabledRules,
  disabledRules,
  level = 'default',
}: LTCheckParams): Promise<LTCheckResponse> {
  const body = new URLSearchParams();
  body.set('text', text);
  body.set('language', language);
  if (motherTongue) body.set('motherTongue', motherTongue);
  if (enabledRules?.length) body.set('enabledRules', toCsv(enabledRules)!);
  if (disabledRules?.length) body.set('disabledRules', toCsv(disabledRules)!);
  if (level) body.set('level', level);

  const res = await fetch(`${server.replace(/\/+$/, '')}/v2/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`LanguageTool HTTP ${res.status}: ${msg}`);
  }

  return (await res.json()) as LTCheckResponse;
}

/** Aplica substituições sem quebrar offsets (varre da esquerda p/ direita). */
export function applySuggestions(
  original: string,
  matches: LTMatch[],
  strategy: 'first' | 'best' = 'first',
): { text: string; changes: number } {
  // ordenar por offset crescente
  const sorted = [...matches].sort((a, b) => a.offset - b.offset);

  let out = '';
  let cursor = 0;
  let changes = 0;

  for (const m of sorted) {
    const { offset, length, replacements = [] } = m;
    // pular inconsistências
    if (offset < cursor || offset > original.length) continue;

    const before = original.slice(cursor, offset);
    const current = original.slice(offset, offset + length);

    let repl = '';
    if (replacements.length) {
      if (strategy === 'best') {
        // LanguageTool não manda "confidence" padrão; pega 1ª mesmo.
        repl = replacements[0].value;
      } else {
        repl = replacements[0].value;
      }
    } else {
      // Sem sugestão -> mantém texto original
      repl = current;
    }

    out += before + repl;
    cursor = offset + length;
    if (repl !== current) changes++;
  }

  out += original.slice(cursor);
  return { text: out, changes };
}
```

---

# 2) Pré-processador do input (auto/confirm/manual)

`src/integrations/languagetool/preprocess.ts`

```ts
import { checkText, applySuggestions, LTMatch } from './ltClient.js';

export type LTPolicy = 'off' | 'confirm' | 'auto-first' | 'auto-best';

export type LTOptions = {
  enabled: boolean;
  policy: LTPolicy;
  server: string;
  language: string;
  motherTongue?: string;
  rulesOn?: string[];
  rulesOff?: string[];
  level?: 'default' | 'picky';
};

export type LTResult = {
  original: string;
  corrected: string;
  changes: number;
  matches: LTMatch[];
  applied: boolean;
  policy: LTPolicy;
};

export async function preprocessUserInput(
  raw: string,
  opts: LTOptions,
  // se quiser perguntar ao usuário: passe um callback (opcional)
  confirmFn?: (
    orig: string,
    corrected: string,
    matches: LTMatch[],
  ) => Promise<boolean>,
): Promise<LTResult> {
  const safeOpts: LTOptions = {
    enabled: opts.enabled ?? false,
    policy: opts.policy ?? 'off',
    server: opts.server ?? 'http://localhost:8081',
    language: opts.language ?? 'pt-BR',
    motherTongue: opts.motherTongue,
    rulesOn: opts.rulesOn,
    rulesOff: opts.rulesOff,
    level: opts.level ?? 'default',
  };

  if (!safeOpts.enabled || safeOpts.policy === 'off' || !raw.trim()) {
    return {
      original: raw,
      corrected: raw,
      changes: 0,
      matches: [],
      applied: false,
      policy: safeOpts.policy,
    };
  }

  const res = await checkText({
    server: safeOpts.server,
    text: raw,
    language: safeOpts.language,
    motherTongue: safeOpts.motherTongue,
    enabledRules: safeOpts.rulesOn,
    disabledRules: safeOpts.rulesOff,
    level: safeOpts.level,
  });

  const strategy = safeOpts.policy === 'auto-best' ? 'best' : 'first';
  const { text: corrected, changes } = applySuggestions(
    raw,
    res.matches ?? [],
    strategy,
  );

  // Sem mudanças -> nada a fazer
  if (!changes) {
    return {
      original: raw,
      corrected: raw,
      changes: 0,
      matches: res.matches ?? [],
      applied: false,
      policy: safeOpts.policy,
    };
  }

  // confirmar?
  if (safeOpts.policy === 'confirm' && confirmFn) {
    const ok = await confirmFn(raw, corrected, res.matches ?? []);
    return {
      original: raw,
      corrected: ok ? corrected : raw,
      changes: ok ? changes : 0,
      matches: res.matches ?? [],
      applied: !!ok,
      policy: safeOpts.policy,
    };
  }

  // auto
  return {
    original: raw,
    corrected,
    changes,
    matches: res.matches ?? [],
    applied: true,
    policy: safeOpts.policy,
  };
}
```

---

# 3) Fio no pipeline do Qwen-Code (antes do `generate`)

Supondo que você tenha algo como `handleUserInput(raw)` que transforma o texto em `Content[]` e chama o modelo, insira o pré-processador:

`src/core/handleUserInput.ts`

```ts
import {
  preprocessUserInput,
  LTOptions,
} from '../integrations/languagetool/preprocess.js';
import { promptConfirmOnTty } from '../ui/promptConfirm.js'; // exemplo (abaixo)

// Carregue de env/config
const LT_CFG: LTOptions = {
  enabled: process.env.LT_ENABLED === '1',
  policy: (process.env.LT_POLICY as any) || 'confirm', // 'off' | 'confirm' | 'auto-first' | 'auto-best'
  server: process.env.LT_SERVER || 'http://localhost:8081',
  language: process.env.LT_LANG || 'pt-BR',
  motherTongue: process.env.LT_MOTHER || 'pt-BR',
  rulesOn: process.env.LT_RULES_ON?.split(',').filter(Boolean),
  rulesOff: process.env.LT_RULES_OFF?.split(',').filter(Boolean),
  level: (process.env.LT_LEVEL as any) || 'default',
};

export async function handleUserInput(raw: string) {
  // 1) Corrigir com LT (se habilitado)
  const lt = await preprocessUserInput(
    raw,
    LT_CFG,
    async (orig, corrected, matches) => {
      // Mostra dif rápido (poderia renderizar bonito em sua UI)
      console.log('\n— LanguageTool sugeriu correções —');
      console.log('Original :', orig);
      console.log('Corrigido:', corrected);
      return await promptConfirmOnTty('Aplicar correções? (y/N) ');
    },
  );

  const finalText = lt.applied ? lt.corrected : lt.original;

  // 2) (Opcional) anexe metadados no contexto/histórico
  // ex.: history.push({ role:'system', parts:[{text:`LT: ${lt.changes} mudanças`}]} )

  // 3) Siga o fluxo normal: montar mensagem p/ modelo
  return generateWithModel(finalText);
}

// placeholder – substitua pelo seu fluxo real
async function generateWithModel(text: string) {
  // ... montar Content[], chamar client.generateContent etc.
  return text;
}
```

Prompt de confirmação simples:

`src/ui/promptConfirm.ts`

```ts
export async function promptConfirmOnTty(question: string): Promise<boolean> {
  return await new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => {
      const s = String(d || '')
        .trim()
        .toLowerCase();
      resolve(s === 'y' || s === 'yes' || s === 's' || s === 'sim');
    });
  });
}
```

### Como habilitar por env

```bash
# .env ou no shell
export LT_ENABLED=1
export LT_POLICY=confirm        # off | confirm | auto-first | auto-best
export LT_SERVER=http://localhost:8081
export LT_LANG=pt-BR
export LT_MOTHER=pt-BR
export LT_LEVEL=default         # ou picky
export LT_RULES_OFF=UPPERCASE_SENTENCE_START,MORFOLOGIK_RULE_PT_PT
```

---

# 4) Slash-command `/lt` (manual, quando o usuário quiser)

Se seu parser já tem comandos “/…”, acrescente um handler:

`src/commands/lt.ts`

```ts
import {
  checkText,
  applySuggestions,
} from '../integrations/languagetool/ltClient.js';

export async function cmdLt(
  args: string[],
  textFromBuffer: string,
  cfg: {
    server: string;
    language: string;
    motherTongue?: string;
    rulesOn?: string[];
    rulesOff?: string[];
    level?: 'default' | 'picky';
  },
) {
  const text = args.join(' ').trim() || textFromBuffer;
  if (!text) {
    console.log('Uso: /lt <texto>  (ou selecione texto atual e rode /lt)');
    return;
  }
  const res = await checkText({
    server: cfg.server,
    text,
    language: cfg.language,
    motherTongue: cfg.motherTongue,
    enabledRules: cfg.rulesOn,
    disabledRules: cfg.rulesOff,
    level: cfg.level,
  });
  const applied = applySuggestions(text, res.matches || [], 'first');
  console.log('— Correções —');
  console.log(applied.text);
  if (applied.changes === 0) console.log('(sem mudanças)');
}
```

Registre no seu roteador de slash-commands, por exemplo:

```ts
router.add('/lt', (args) => cmdLt(args, inputBuffer.get(), LT_CFG));
```

---

# 5) (Opcional) Tool para o LLM chamar (function-calling)

Se você usa o padrão de “tools” com **schema** (como os seus `EditTool`, etc.), crie:

`src/tools/languagetool.ts`

```ts
import { SchemaUnion, Type } from '@google/genai';
import {
  checkText,
  applySuggestions,
} from '../integrations/languagetool/ltClient.js';

export const LanguageToolTool = {
  Name: 'language_tool_check',
  Parameters: {
    type: Type.OBJECT,
    properties: {
      text: {
        type: Type.STRING,
        description: 'Texto a ser checado/corrigido.',
      },
      language: { type: Type.STRING, description: 'ex: pt-BR, en-US' },
      policy: {
        type: Type.STRING,
        description: 'first|best|none',
        enum: ['first', 'best', 'none'],
      },
      rulesOn: { type: Type.ARRAY, items: { type: Type.STRING } },
      rulesOff: { type: Type.ARRAY, items: { type: Type.STRING } },
      level: { type: Type.STRING, enum: ['default', 'picky'] },
    },
    required: ['text'],
  } as SchemaUnion,

  async validateToolParams(args: any) {
    if (typeof args?.text !== 'string' || !args.text.trim()) {
      return { ok: false, error: 'text obrigatório' };
    }
    return { ok: true };
  },

  async execute(args: any, ctx: { env: Record<string, string | undefined> }) {
    const server = (ctx.env.LT_SERVER as string) || 'http://localhost:8081';
    const language = args.language || (ctx.env.LT_LANG as string) || 'pt-BR';
    const level = (args.level || ctx.env.LT_LEVEL || 'default') as
      | 'default'
      | 'picky';

    const res = await checkText({
      server,
      text: args.text,
      language,
      enabledRules: Array.isArray(args.rulesOn) ? args.rulesOn : undefined,
      disabledRules: Array.isArray(args.rulesOff) ? args.rulesOff : undefined,
      level,
    });

    let corrected = args.text;
    let changes = 0;
    const policy = args.policy || 'first';
    if (policy !== 'none') {
      const strat = policy === 'best' ? 'best' : 'first';
      const ap = applySuggestions(args.text, res.matches ?? [], strat);
      corrected = ap.text;
      changes = ap.changes;
    }

    return {
      ok: true,
      output: {
        original: args.text,
        corrected,
        changes,
        matches: res.matches ?? [],
        language,
        policy,
      },
    };
  },
};
```

Registre no seu “tool registry” (onde já adiciona `EditTool`, etc.) e exponha para o modelo. Assim, o próprio LLM pode pedir “verifique gramática do usuário” antes de responder.

---

## Dicas práticas

- **Política recomendada**: `confirm` (mostra o texto corrigido e pergunta). Em bots 100% automáticos, use `auto-first`.
- **Regras**: desative regras que não combinam com seu caso (ex.: _UPPERCASE_SENTENCE_START_ se o prompt começa minúsculo porque é estilo do app).
- **Falhas de rede**: se o LT cair, **continue** com o texto original (fail-open) para não travar o chat.
- **Privacidade**: como o servidor é local, não há vazamento externo; se um dia usar o público, trate DLP e anonimização.

Se quiser, eu adapto esses trechos exatamente para os pontos do seu repositório (nomes de arquivos/módulos). Quer que eu gere um diff/patch (`git apply`)?
