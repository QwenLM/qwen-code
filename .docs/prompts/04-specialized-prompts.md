# 특수 목적 프롬프트

## 개요

특수 목적 프롬프트는 특정 기능을 수행하기 위해 최적화된 프롬프트입니다.

## 1. LLM 편집 수정 프롬프트 (LLM Edit Fixer)

**파일 위치**: `/home/user/qwen-code/packages/core/src/utils/llm-edit-fixer.ts`

### 목적
실패한 파일 편집 작업을 자동으로 수정합니다.

### 시스템 프롬프트

```
You are an expert code-editing assistant specializing in debugging and correcting
failed search-and-replace operations.

# Primary Goal
Your task is to analyze a failed edit attempt and provide a corrected `search`
string that will match the text in the file precisely. The correction should be
as minimal as possible, staying very close to the original, failed `search` string.

It is important that you do no try to figure out if the instruction is correct.
DO NOT GIVE ADVICE. Your only goal here is to do your best to perform the search
and replace task!

# Input Context
You will be given:
1. The high-level instruction for the original edit
2. The exact `search` and `replace` strings that failed
3. The error message that was produced
4. The full content of the source file

# Rules for Correction
1. **Minimal Correction:** Your new `search` string must be a close variation
   of the original. Focus on fixing issues like whitespace, indentation, line
   endings, or small contextual differences.
2. **Explain the Fix:** Your `explanation` MUST state exactly why the original
   `search` failed and how your new `search` string resolves that specific failure.
3. **Preserve the `replace` String:** Do NOT modify the `replace` string unless
   the instruction explicitly requires it.
4. **No Changes Case:** CRUCIAL: if the change is already present in the file,
   set `noChangesRequired` to True and explain why.
5. **Exactness:** The final `search` field must be the EXACT literal text from
   the file. Do not escape characters.
```

### 사용자 프롬프트 템플릿

```
# Goal of the Original Edit
<instruction>
{instruction}
</instruction>

# Failed Attempt Details
- **Original `search` parameter (failed):**
<search>
{old_string}
</search>
- **Original `replace` parameter:**
<replace>
{new_string}
</replace>
- **Error Encountered:**
<error>
{error}
</error>

# Full File Content
<file_content>
{current_content}
</file_content>

# Your Task
Based on the error and the file content, provide a corrected `search` string
that will succeed.
```

### 응답 스키마

```typescript
{
  type: 'object',
  properties: {
    explanation: { type: 'string' },
    search: { type: 'string' },
    replace: { type: 'string' },
    noChangesRequired: { type: 'boolean' }
  },
  required: ['search', 'replace', 'explanation']
}
```

### 캐싱
- LRU 캐시 사용
- 최대 50개 항목
- SHA-256 해시로 키 생성

---

## 2. 루프 감지 프롬프트 (Loop Detection)

**파일 위치**: `/home/user/qwen-code/packages/core/src/services/loopDetectionService.ts`

### 목적
AI가 무한 루프에 빠졌는지 감지합니다.

### 시스템 프롬프트

```
You are a sophisticated AI diagnostic agent specializing in identifying when a
conversational AI is stuck in an unproductive state. Your task is to analyze the
provided conversation history and determine if the assistant has ceased to make
meaningful progress.

An unproductive state is characterized by one or more of the following patterns
over the last 5 or more assistant turns:

Repetitive Actions: The assistant repeats the same tool calls or conversational
responses a decent number of times. This includes simple loops (e.g., tool_A,
tool_A, tool_A) and alternating patterns (e.g., tool_A, tool_B, tool_A, tool_B, ...).

Cognitive Loop: The assistant seems unable to determine the next logical step.
It might express confusion, repeatedly ask the same questions, or generate responses
that don't logically follow from the previous turns, indicating it's stuck and
not advancing the task.

Crucially, differentiate between a true unproductive state and legitimate,
incremental progress. For example, a series of 'tool_A' or 'tool_B' tool calls
that make small, distinct changes to the same file (like adding docstrings to
functions one by one) is considered forward progress and is NOT a loop.
```

### 사용자 프롬프트

```
Please analyze the conversation history to determine the possibility that the
conversation is stuck in a repetitive, non-productive state. Provide your
response in the requested JSON format.
```

### 응답 스키마

```typescript
{
  type: 'object',
  properties: {
    reasoning: {
      type: 'string',
      description: 'Your reasoning on if the conversation is looping without
                    forward progress.'
    },
    confidence: {
      type: 'number',
      description: 'A number between 0.0 and 1.0 representing your confidence
                    that the conversation is in an unproductive state.'
    }
  },
  required: ['reasoning', 'confidence']
}
```

### 루프 감지 메커니즘

1. **도구 호출 루프**: 동일한 도구 호출 5회 이상 연속
2. **내용 루프**: 동일한 텍스트 청크 10회 이상 반복
3. **LLM 기반 루프**: 30턴 후 LLM이 루프 감지 (90% 이상 신뢰도)

---

## 3. 도구 출력 요약 프롬프트 (Summarizer)

**파일 위치**: `/home/user/qwen-code/packages/core/src/utils/summarizer.ts`

### 목적
긴 도구 출력을 요약하여 토큰 사용을 최소화합니다.

### 프롬프트

```
Summarize the following tool output to be a maximum of {maxOutputTokens} tokens.
The summary should be concise and capture the main points of the tool output.

The summarization should be done based on the content that is provided. Here are
the basic rules to follow:

1. If the text is a directory listing or any output that is structural, use the
   history of the conversation to understand the context. Using this context try
   to understand what information we need from the tool output and return that
   as a response.

2. If the text is text content and there is nothing structural that we need,
   summarize the text.

3. If the text is the output of a shell command, use the history of the
   conversation to understand the context. Using this context try to understand
   what information we need from the tool output and return a summarization along
   with the stack trace of any error within the <error></error> tags. The stack
   trace should be complete and not truncated. If there are warnings, you should
   include them in the summary within <warning></warning> tags.

Text to summarize:
"{textToSummarize}"

Return the summary string which should first contain an overall summarization of
text followed by the full stack trace of errors and warnings in the tool output.
```

### 사용 조건
- 출력이 2000자 이상일 때만 요약
- `DEFAULT_GEMINI_FLASH_LITE_MODEL` 사용 (빠른 처리)

---

## 4. Next Speaker 체커 프롬프트

**파일 위치**: `/home/user/qwen-code/packages/core/src/utils/nextSpeakerChecker.ts`

### 목적
대화에서 누가 다음에 말해야 하는지 결정합니다.

### 프롬프트

```
Analyze *only* the content and structure of your immediately preceding response
(your last turn in the conversation history). Based *strictly* on that response,
determine who should logically speak next: the 'user' or the 'model' (you).

**Decision Rules (apply in order):**

1. **Model Continues:** If your last response explicitly states an immediate next
   action *you* intend to take (e.g., "Next, I will...", "Now I'll process...",
   "Moving on to analyze..."), OR if the response seems clearly incomplete (cut
   off mid-thought without a natural conclusion), then the **'model'** should
   speak next.

2. **Question to User:** If your last response ends with a direct question
   specifically addressed *to the user*, then the **'user'** should speak next.

3. **Waiting for User:** If your last response completed a thought, statement,
   or task *and* does not meet the criteria for Rule 1 (Model Continues) or
   Rule 2 (Question to User), it implies a pause expecting user input or reaction.
   In this case, the **'user'** should speak next.
```

### 응답 스키마

```typescript
{
  type: 'object',
  properties: {
    reasoning: {
      type: 'string',
      description: "Brief explanation justifying the 'next_speaker' choice"
    },
    next_speaker: {
      type: 'string',
      enum: ['user', 'model'],
      description: 'Who should speak next'
    }
  },
  required: ['reasoning', 'next_speaker']
}
```

### 특수 케이스 처리

```typescript
// 마지막 메시지가 function response → model이 계속
if (isFunctionResponse(lastMessage)) {
  return { next_speaker: 'model', reasoning: '...' };
}

// 빈 model 메시지 → model이 계속
if (lastMessage.parts.length === 0) {
  return { next_speaker: 'model', reasoning: '...' };
}
```

---

## 프롬프트 설계 패턴

### 1. 전문가 페르소나
```
You are [expert role] specializing in [domain].
```

### 2. 명확한 목표
```
# Primary Goal
Your task is to [specific objective].
```

### 3. 입력 컨텍스트
```
# Input Context
You will be given:
1. [input 1]
2. [input 2]
```

### 4. 규칙 및 제약
```
# Rules
1. **Rule Name:** Description
2. **Rule Name:** Description
```

### 5. 출력 형식
```
# Output Format
{
  field1: description,
  field2: description
}
```

### 6. 예제 (선택사항)
```
# Example
Input: ...
Output: ...
```

---

## 성능 최적화

### 모델 선택

| 프롬프트 유형 | 모델 | 이유 |
|--------------|------|------|
| LLM Edit Fixer | Flash | 빠른 응답 필요 |
| Loop Detection | 사용자 모델 | 정확도 중요 |
| Summarizer | Flash Lite | 간단한 작업 |
| Next Speaker | 사용자 모델 | 컨텍스트 이해 필요 |

### 캐싱 전략

```typescript
// SHA-256 해시로 캐시 키 생성
const cacheKey = createHash('sha256')
  .update(JSON.stringify(inputs))
  .digest('hex');

// LRU 캐시 사용
const cache = new LruCache<string, Result>(maxSize);
```

### 토큰 최적화

- 긴 출력만 요약 (threshold: 2000자)
- 컨텍스트 크기 제한 (최근 N개 메시지만)
- 구조화된 출력으로 파싱 효율성 향상

---

## 테스트 예시

```typescript
describe('LLM Edit Fixer', () => {
  it('should fix whitespace issues', async () => {
    const result = await FixLLMEditWithInstruction(
      'Add error handling',
      '  if (error) {', // 잘못된 공백
      '  if (error) {\n    throw error;\n  }',
      'String not found in file',
      fileContent,
      client,
      signal
    );

    expect(result.search).toContain('if (error) {');
    expect(result.noChangesRequired).toBe(false);
  });
});

describe('Loop Detection', () => {
  it('should detect tool call loop', () => {
    const service = new LoopDetectionService(config);

    for (let i = 0; i < 6; i++) {
      const detected = service.addAndCheck({
        type: GeminiEventType.ToolCallRequest,
        value: { name: 'Read', args: { path: '/same/file.ts' } }
      });

      if (i < 5) {
        expect(detected).toBe(false);
      } else {
        expect(detected).toBe(true);
      }
    }
  });
});
```

---

## 참고 자료

- [LLM Edit Fixer 코드](../../../packages/core/src/utils/llm-edit-fixer.ts)
- [Loop Detection 코드](../../../packages/core/src/services/loopDetectionService.ts)
- [Summarizer 코드](../../../packages/core/src/utils/summarizer.ts)
- [Next Speaker Checker 코드](../../../packages/core/src/utils/nextSpeakerChecker.ts)
