# 프롬프트 템플릿 시스템

## 개요

Qwen Code는 프롬프트를 동적으로 생성하고 조합하는 강력한 템플릿 시스템을 가지고 있습니다.

## 프롬프트 로딩 메커니즘

### 1. 환경 변수 기반 로딩

**파일**: `/home/user/qwen-code/packages/core/src/core/prompts.ts`

#### 함수: `resolvePathFromEnv(envVar): { isSwitch, value, isDisabled }`

```typescript
// Boolean 스위치 감지
QWEN_SYSTEM_MD="0"     → { isSwitch: true, value: "0", isDisabled: true }
QWEN_SYSTEM_MD="false" → { isSwitch: true, value: "false", isDisabled: true }
QWEN_SYSTEM_MD="1"     → { isSwitch: true, value: "1", isDisabled: false }
QWEN_SYSTEM_MD="true"  → { isSwitch: true, value: "true", isDisabled: false }

// 파일 경로
QWEN_SYSTEM_MD="/path/to/custom.md" → { isSwitch: false, value: "/absolute/path", isDisabled: false }
QWEN_SYSTEM_MD="~/my-prompt.md"     → { isSwitch: false, value: "/home/user/my-prompt.md", isDisabled: false }

// 미설정
QWEN_SYSTEM_MD=""      → { isSwitch: false, value: null, isDisabled: false }
```

#### 틸드 확장
```typescript
"~/" → os.homedir() + "/"
"~"  → os.homedir()
```

### 2. 시스템 프롬프트 로딩 순서

```typescript
function getCoreSystemPrompt(userMemory?, model?) {
  // 1. 환경 변수 확인
  const systemMdPath = resolvePathFromEnv(process.env.QWEN_SYSTEM_MD);

  // 2. 커스텀 프롬프트 또는 기본 프롬프트
  const basePrompt = systemMdPath.value && !systemMdPath.isDisabled
    ? fs.readFileSync(systemMdPath.value, 'utf8')
    : DEFAULT_SYSTEM_PROMPT;

  // 3. 샌드박스 섹션 추가
  basePrompt += getSandboxSection();

  // 4. Git 저장소 섹션 추가
  basePrompt += getGitSection();

  // 5. 도구 호출 예제 추가
  basePrompt += getToolCallExamples(model);

  // 6. 사용자 메모리 추가
  const memorySuffix = userMemory
    ? `\n\n---\n\n${userMemory.trim()}`
    : '';

  return basePrompt + memorySuffix;
}
```

### 3. 사용자 메모리 로딩

**파일**: `/home/user/qwen-code/packages/core/src/config/config.ts`

```typescript
async getUserMemory(): Promise<string> {
  // 1. 파일명 확인
  const filename = this.geminiMdFilename || 'QWEN.md';

  // 2. 파일 위치 검색
  const paths = [
    path.join(process.cwd(), '.qwen', filename),
    path.join(process.cwd(), filename),
    path.join(os.homedir(), '.qwen', filename),
    path.join(os.homedir(), filename)
  ];

  // 3. 첫 번째 존재하는 파일 로드
  for (const p of paths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8');
    }
  }

  return '';
}
```

## 템플릿 변수 치환

### 1. 서브에이전트 템플릿

**파일**: `/home/user/qwen-code/packages/core/src/subagents/subagent.ts`

```typescript
function templateString(template: string, context: ContextState): string {
  // ${variable} 형식의 변수 치환
  return template.replace(/\$\{([^}]+)\}/g, (match, key) => {
    const value = context.get(key);
    return value !== undefined ? String(value) : match;
  });
}
```

**사용 예시**:
```markdown
You are working on the ${project_name} project.
Current directory: ${cwd}
User: ${user_name}

Template Variables:
- project_name: "my-app"
- cwd: "/home/user/my-app"
- user_name: "John"

Result:
You are working on the my-app project.
Current directory: /home/user/my-app
User: John
```

### 2. 단순 문자열 치환

```typescript
// LLM Edit Fixer
const userPrompt = EDIT_USER_PROMPT
  .replace('{instruction}', instruction)
  .replace('{old_string}', old_string)
  .replace('{new_string}', new_string)
  .replace('{error}', error)
  .replace('{current_content}', current_content);

// Summarizer
const prompt = SUMMARIZE_TOOL_OUTPUT_PROMPT
  .replace('{maxOutputTokens}', String(maxOutputTokens))
  .replace('{textToSummarize}', textToSummarize);
```

## 동적 프롬프트 생성

### 1. 모델별 도구 호출 예제

```typescript
function getToolCallExamples(model?: string): string {
  // 환경 변수 우선
  const toolCallStyle = process.env.QWEN_CODE_TOOL_CALL_STYLE;
  if (toolCallStyle) {
    switch (toolCallStyle.toLowerCase()) {
      case 'qwen-coder':
        return qwenCoderToolCallExamples;
      case 'qwen-vl':
        return qwenVlToolCallExamples;
      case 'general':
        return generalToolCallExamples;
    }
  }

  // 모델명 기반 자동 감지
  if (model && model.length < 100) {
    if (/qwen[^-]*-coder/i.test(model)) {
      return qwenCoderToolCallExamples;
    }
    if (/qwen[^-]*-vl/i.test(model)) {
      return qwenVlToolCallExamples;
    }
  }

  return generalToolCallExamples;
}
```

**도구 호출 스타일**:

#### General (JSON-like)
```
<example>
model: [tool_call: Read for path '/path/to/file.ts']
</example>
```

#### Qwen-Coder (XML)
```xml
<example>
model:
<tool_call>
<function=Read>
<parameter=path>
/path/to/file.ts
</parameter>
</function>
</tool_call>
</example>
```

#### Qwen-VL (JSON)
```json
<example>
model:
<tool_call>
{"name": "Read", "arguments": {"path": "/path/to/file.ts"}}
</tool_call>
</example>
```

### 2. 조건부 섹션 추가

```typescript
// 샌드박스 상태에 따라 다른 섹션
const sandboxSection = (function() {
  const isSandboxExec = process.env.SANDBOX === 'sandbox-exec';
  const isGenericSandbox = !!process.env.SANDBOX;

  if (isSandboxExec) {
    return `# macOS Seatbelt
You are running under macos seatbelt with limited access...`;
  } else if (isGenericSandbox) {
    return `# Sandbox
You are running in a sandbox container...`;
  } else {
    return `# Outside of Sandbox
You are running outside of a sandbox...`;
  }
})();

// Git 저장소 여부에 따라
const gitSection = (function() {
  if (isGitRepository(process.cwd())) {
    return `# Git Repository
- The current working directory is being managed by git...
- When asked to commit changes...`;
  }
  return '';
})();
```

### 3. Task 도구 설명 동적 생성

**파일**: `/home/user/qwen-code/packages/core/src/tools/task.ts`

```typescript
// 사용 가능한 서브에이전트 목록 기반으로 설명 생성
function generateTaskToolDescription(subagents: SubagentConfig[]): string {
  const agentDescriptions = subagents.map(agent => `
  - ${agent.name}: ${agent.description}
  `).join('\n');

  return `
Launch a new agent to handle complex, multi-step tasks autonomously.

Available agent types and the tools they have access to:
${agentDescriptions}

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead
...
  `.trim();
}
```

## 프롬프트 조합 및 주입

### 1. 초기 대화 기록 생성

**파일**: `/home/user/qwen-code/packages/core/src/utils/environmentContext.ts`

```typescript
async function getInitialChatHistory(
  config: Config,
  extraHistory?: Content[]
): Promise<Content[]> {
  // 1. 환경 컨텍스트 생성
  const envContext = await getEnvironmentContext(config);

  // 2. 초기 기록 구성
  const history: Content[] = [
    {
      role: 'user',
      parts: envContext // [날짜, OS, 디렉토리 구조]
    },
    {
      role: 'model',
      parts: [{ text: 'Got it. Thanks for the context!' }]
    }
  ];

  // 3. 추가 기록 병합
  if (extraHistory) {
    history.push(...extraHistory);
  }

  return history;
}
```

### 2. 환경 컨텍스트 주입

```typescript
async function getEnvironmentContext(config: Config): Promise<Part[]> {
  const parts: Part[] = [];

  // 날짜
  parts.push({
    text: `Today's date: ${new Date().toISOString().split('T')[0]}`
  });

  // OS 정보
  parts.push({
    text: `Operating System: ${os.platform()}\nOS Version: ${os.release()}`
  });

  // 디렉토리 구조 (선택적)
  if (config.shouldIncludeDirectoryListing()) {
    const dirListing = await getDirectoryListing(process.cwd());
    parts.push({ text: `Directory structure:\n${dirListing}` });
  }

  return parts;
}
```

### 3. 시스템 리마인더 주입

```typescript
// 서브에이전트 리마인더
if (availableSubagents.length > 0) {
  const reminder = getSubagentSystemReminder(
    availableSubagents.map(a => a.name)
  );
  chatHistory.push({
    role: 'user',
    parts: [{ text: reminder }]
  });
  chatHistory.push({
    role: 'model',
    parts: [{ text: 'Understood.' }]
  });
}

// Plan 모드 리마인더
if (config.isPlanMode()) {
  const reminder = getPlanModeSystemReminder();
  chatHistory.push({
    role: 'user',
    parts: [{ text: reminder }]
  });
  chatHistory.push({
    role: 'model',
    parts: [{ text: 'Understood. I will only perform read operations.' }]
  });
}
```

## 프롬프트 저장

### 시스템 프롬프트 파일로 저장

```typescript
// QWEN_WRITE_SYSTEM_MD 환경 변수 설정 시
const writeSystemMdResolution = resolvePathFromEnv(
  process.env.QWEN_WRITE_SYSTEM_MD
);

if (writeSystemMdResolution.value && !writeSystemMdResolution.isDisabled) {
  const writePath = writeSystemMdResolution.isSwitch
    ? systemMdPath
    : writeSystemMdResolution.value;

  fs.mkdirSync(path.dirname(writePath), { recursive: true });
  fs.writeFileSync(writePath, basePrompt);
}
```

## MCP 프롬프트 시스템

### 1. MCP 프롬프트 레지스트리

**파일**: `/home/user/qwen-code/packages/core/src/prompts/prompt-registry.ts`

```typescript
class PromptRegistry {
  private prompts = new Map<string, DiscoveredMCPPrompt>();

  registerPrompt(prompt: DiscoveredMCPPrompt): void {
    this.prompts.set(prompt.name, prompt);
  }

  getAllPrompts(): DiscoveredMCPPrompt[] {
    return Array.from(this.prompts.values());
  }

  getPrompt(name: string): DiscoveredMCPPrompt | undefined {
    return this.prompts.get(name);
  }

  getPromptsByServer(serverName: string): DiscoveredMCPPrompt[] {
    return Array.from(this.prompts.values())
      .filter(p => p.serverName === serverName);
  }
}
```

### 2. MCP 프롬프트 로딩

```typescript
// MCP 서버로부터 프롬프트 발견
async function discoverMCPPrompts(serverName: string): Promise<void> {
  const prompts = await mcpClient.listPrompts(serverName);

  for (const prompt of prompts) {
    promptRegistry.registerPrompt({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
      serverName: serverName
    });
  }
}
```

## 프롬프트 최적화 전략

### 1. 지연 로딩
```typescript
// 필요할 때만 프롬프트 로드
let cachedSystemPrompt: string | null = null;

function getSystemPrompt(): string {
  if (!cachedSystemPrompt) {
    cachedSystemPrompt = generateSystemPrompt();
  }
  return cachedSystemPrompt;
}
```

### 2. 조건부 포함
```typescript
// 필요한 섹션만 포함
const sections = [];
sections.push(coreSection);
if (config.hasGitRepo()) sections.push(gitSection);
if (config.isSandboxed()) sections.push(sandboxSection);
return sections.join('\n\n');
```

### 3. 토큰 절약
```typescript
// 짧은 메모리만 포함 (토큰 제한)
function getTruncatedMemory(memory: string, maxTokens: number): string {
  const tokens = encode(memory);
  if (tokens.length <= maxTokens) {
    return memory;
  }
  return decode(tokens.slice(0, maxTokens)) + '\n... [truncated]';
}
```

## 테스트

```typescript
describe('Prompt Template System', () => {
  it('should resolve environment path', () => {
    process.env.QWEN_SYSTEM_MD = '~/my-prompt.md';
    const resolved = resolvePathFromEnv(process.env.QWEN_SYSTEM_MD);
    expect(resolved.value).toBe(path.join(os.homedir(), 'my-prompt.md'));
  });

  it('should substitute template variables', () => {
    const template = 'Hello ${name}, you are ${age} years old';
    const context = new Map([['name', 'Alice'], ['age', '30']]);
    const result = templateString(template, context);
    expect(result).toBe('Hello Alice, you are 30 years old');
  });

  it('should load user memory from correct location', async () => {
    const memory = await config.getUserMemory();
    expect(memory).toContain('User preferences:');
  });
});
```

## 참고 자료

- [프롬프트 메인 파일](../../../packages/core/src/core/prompts.ts)
- [환경 컨텍스트](../../../packages/core/src/utils/environmentContext.ts)
- [서브에이전트 템플릿](../../../packages/core/src/subagents/subagent.ts)
- [MCP 프롬프트 레지스트리](../../../packages/core/src/prompts/prompt-registry.ts)
