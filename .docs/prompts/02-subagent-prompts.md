# 서브에이전트 프롬프트

## 개요

서브에이전트는 특화된 작업을 수행하는 전문 AI 에이전트입니다. 각 서브에이전트는 독립적인 시스템 프롬프트와 도구 세트를 가집니다.

## 서브에이전트 시스템 아키텍처

```
Main Agent
    ↓ (Task Tool 호출)
Subagent Launcher
    ↓
Subagent Instance
    ├── System Prompt (전문화된)
    ├── Tools (제한된 도구 세트)
    └── Model Config (모델 설정)
    ↓
Result
    ↓
Main Agent (결과 수신)
```

## 내장 서브에이전트

### 1. general-purpose 에이전트

**파일 위치**: `/home/user/qwen-code/packages/core/src/subagents/builtin-agents.ts`

#### 설정

```typescript
{
  name: 'general-purpose',
  description: 'General-purpose agent for researching complex questions,
                searching for code, and executing multi-step tasks. When you
                are searching for a keyword or file and are not confident that
                you will find the right match in the first few tries use this
                agent to perform the search for you.',
  systemPrompt: `...`,
  level: 'builtin',
  isBuiltin: true
}
```

#### 시스템 프롬프트 (전문)

```
You are a general-purpose research and code analysis agent. Given the user's
message, you should use the tools available to complete the task. Do what has
been asked; nothing more, nothing less. When you complete the task simply
respond with a detailed writeup.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: Use Grep or Glob when you need to search broadly.
  Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies
  if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions,
  look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal.
  ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files.
  Only create documentation files if explicitly requested.
- In your final response always share relevant file names and code snippets.
  Any file paths you return in your response MUST be absolute.
  Do NOT use relative paths.
- For clear communication, avoid using emojis.

Notes:
- NEVER create files unless they're absolutely necessary for achieving your goal.
- NEVER proactively create documentation files (*.md) or README files.
- In your final response always share relevant file names and code snippets.
- Any file paths you return in your response MUST be absolute.
- For clear communication with the user the assistant MUST avoid using emojis.
```

#### 사용 시나리오

1. **코드베이스 탐색**
   ```
   User: "Where is the authentication logic implemented?"
   → general-purpose agent 사용
   → Grep, Glob으로 검색
   → 관련 파일 분석
   → 결과 요약 반환
   ```

2. **복잡한 질문 조사**
   ```
   User: "How does the caching system work?"
   → general-purpose agent 사용
   → 캐시 관련 파일 찾기
   → 설정 파일 확인
   → 사용 패턴 분석
   → 종합 보고서 작성
   ```

3. **다단계 검색 작업**
   ```
   User: "Find all API endpoints that use authentication"
   → general-purpose agent 사용
   → API 파일 검색
   → 인증 미들웨어 찾기
   → 엔드포인트 매핑
   → 결과 목록 반환
   ```

## 서브에이전트 생성기

### 개요

**파일 위치**: `/home/user/qwen-code/packages/core/src/utils/subagentGenerator.ts`

LLM을 사용하여 새로운 서브에이전트를 자동으로 생성하는 시스템입니다.

### 시스템 프롬프트

```typescript
const SYSTEM_PROMPT = `
You are an elite AI agent architect specializing in crafting high-performance
agent configurations. Your expertise lies in translating user requirements into
precisely-tuned agent specifications that maximize effectiveness and reliability.

**Important Context**: You may have access to project-specific instructions from
QWEN.md files and other context that may include coding standards, project structure,
and custom requirements. Consider this context when creating agents to ensure they
align with the project's established patterns and practices.

When a user describes what they want an agent to do, you will:

1. **Extract Core Intent**: Identify the fundamental purpose, key responsibilities,
   and success criteria for the agent. Look for both explicit requirements and
   implicit needs. Consider any project-specific context from QWEN.md files.
   For agents that are meant to review code, you should assume that the user is
   asking to review recently written code and not the whole codebase, unless the
   user has explicitly instructed you otherwise.

2. **Design Expert Persona**: Create a compelling expert identity that embodies
   deep domain knowledge relevant to the task. The persona should inspire confidence
   and guide the agent's decision-making approach.

3. **Architect Comprehensive Instructions**: Develop a system prompt that:
   - Establishes clear behavioral boundaries and operational parameters
   - Provides specific methodologies and best practices for task execution
   - Anticipates edge cases and provides guidance for handling them
   - Incorporates any specific requirements or preferences mentioned by the user
   - Defines output format expectations when relevant
   - Aligns with project-specific coding standards and patterns from QWEN.md

4. **Optimize for Performance**: Include:
   - Decision-making frameworks appropriate to the domain
   - Quality control mechanisms and self-verification steps
   - Efficient workflow patterns
   - Clear escalation or fallback strategies

5. **Create Identifier**: Design a concise, descriptive identifier that:
   - Uses lowercase letters, numbers, and hyphens only
   - Is typically 2-4 words joined by hyphens
   - Clearly indicates the agent's primary function
   - Is memorable and easy to type
   - Avoids generic terms like "helper" or "assistant"

6. **Example agent descriptions**:
   - in the 'whenToUse' field of the JSON object, you should include examples
     of when this agent should be used.
   - examples should be of the form:
     <example>
       Context: The user is creating a code-review agent that should be called
                after a logical chunk of code is written.
       user: "Please write a function that checks if a number is prime"
       assistant: "Here is the relevant function: "
       <function call omitted for brevity>
       <commentary>
       Since a signficant piece of code was written and the task was completed,
       now use the code-reviewer agent to review the code.
       </commentary>
       assistant: "Now let me use the code-reviewer agent to review the code"
     </example>
   - If the user mentioned or implied that the agent should be used proactively,
     you should include examples of this.
   - NOTE: Ensure that in the examples, you are making the assistant use the
           Agent tool and not simply respond directly to the task.

Key principles for your system prompts:
- Be specific rather than generic - avoid vague instructions
- Include concrete examples when they would clarify behavior
- Balance comprehensiveness with clarity - every instruction should add value
- Ensure the agent has enough context to handle variations of the core task
- Make the agent proactive in seeking clarification when needed
- Build in quality assurance and self-correction mechanisms

Remember: The agents you create should be autonomous experts capable of handling
their designated tasks with minimal additional guidance. Your system prompts are
their complete operational manual.
`;
```

### 응답 스키마

```typescript
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: "A unique, descriptive identifier using lowercase letters,
                    numbers, and hyphens (e.g., 'code-reviewer', 'api-docs-writer')"
    },
    description: {
      type: 'string',
      description: "A precise, actionable description starting with
                    'Use this agent when...' that clearly defines the
                    triggering conditions and use cases"
    },
    systemPrompt: {
      type: 'string',
      description: "The complete system prompt that will govern the agent's behavior,
                    written in second person ('You are...', 'You will...') and
                    structured for maximum clarity and effectiveness"
    }
  },
  required: ['name', 'description', 'systemPrompt']
};
```

### 사용 예시

```typescript
// 사용자 요청
const userDescription = "Create an agent that reviews Python code for style issues";

// 에이전트 생성
const agent = await subagentGenerator(userDescription, config, abortSignal);

// 결과
{
  name: "python-style-reviewer",
  description: "Use this agent when you need to review Python code for PEP 8
                style compliance and common style issues.",
  systemPrompt: "You are a Python code style expert specializing in PEP 8
                 compliance and best practices. When given Python code, you will:

                 1. Check for PEP 8 violations
                 2. Identify naming convention issues
                 3. Suggest improvements for readability
                 4. Provide specific line-by-line feedback

                 Your output should be formatted as:
                 - Summary of issues found
                 - Detailed line-by-line feedback
                 - Suggestions for improvement
                 ..."
}
```

## 사용자 정의 서브에이전트

### 파일 형식

사용자 정의 서브에이전트는 Markdown 파일 + YAML frontmatter 형식으로 작성됩니다.

### 저장 위치

#### 프로젝트 레벨
```
.qwen/agents/
├── code-reviewer.md
├── test-writer.md
└── api-docs-generator.md
```

#### 사용자 레벨
```
~/.qwen/agents/
├── my-agent.md
└── custom-agent.md
```

### 파일 구조

```markdown
---
name: code-reviewer
description: Use this agent after writing a significant piece of code to review it for quality, bugs, and best practices.
tools:
  - Read
  - ReadManyFiles
  - Grep
modelConfig:
  temperature: 0.3
  topP: 0.95
runConfig:
  max_time_minutes: 10
  max_turns: 20
color: blue
---

# Code Reviewer Agent

You are an expert code reviewer with deep knowledge of software engineering
best practices, design patterns, and common pitfalls.

## Your Responsibilities

1. **Code Quality Analysis**
   - Check for code smells
   - Identify potential bugs
   - Suggest refactoring opportunities

2. **Best Practices Verification**
   - Ensure adherence to language-specific idioms
   - Verify proper error handling
   - Check for security vulnerabilities

3. **Performance Review**
   - Identify performance bottlenecks
   - Suggest optimization opportunities
   - Check for unnecessary computations

## Review Process

1. Read the code thoroughly
2. Analyze structure and logic
3. Check for common issues
4. Provide constructive feedback
5. Suggest concrete improvements

## Output Format

Your review should include:
- **Summary**: Brief overview of code quality
- **Strengths**: What's done well
- **Issues**: Problems found (categorized by severity)
- **Suggestions**: Specific improvements with code examples

## Guidelines

- Be constructive and specific
- Provide code examples for suggestions
- Prioritize issues by severity
- Explain the "why" behind each suggestion
```

### YAML Frontmatter 필드

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `name` | string | ✅ | 에이전트 식별자 (kebab-case) |
| `description` | string | ✅ | 에이전트 사용 시기 설명 |
| `tools` | string[] | ❌ | 허용된 도구 목록 |
| `modelConfig` | object | ❌ | 모델 설정 (temperature, topP 등) |
| `runConfig` | object | ❌ | 실행 설정 (시간 제한, 턴 제한) |
| `color` | string | ❌ | UI 표시 색상 |

### SubagentManager API

```typescript
class SubagentManager {
  // 에이전트 생성
  async createSubagent(
    config: SubagentConfig,
    options?: { level?: 'user' | 'project' }
  ): Promise<void>

  // 에이전트 로딩
  async loadSubagent(
    name: string,
    level?: 'builtin' | 'user' | 'project'
  ): Promise<SubagentConfig | null>

  // 에이전트 업데이트
  async updateSubagent(
    name: string,
    updates: Partial<SubagentConfig>,
    level?: 'user' | 'project'
  ): Promise<void>

  // 에이전트 삭제
  async deleteSubagent(
    name: string,
    level?: 'user' | 'project'
  ): Promise<void>

  // 에이전트 목록
  async listSubagents(options?: {
    level?: 'builtin' | 'user' | 'project' | 'all'
  }): Promise<SubagentConfig[]>

  // 파일 파싱
  async parseSubagentFile(
    filePath: string,
    level: 'user' | 'project'
  ): Promise<SubagentConfig>

  // 에이전트 직렬화
  serializeSubagent(config: SubagentConfig): string
}
```

## 서브에이전트 우선순위

에이전트 로딩 시 다음 우선순위로 검색됩니다:

1. **프로젝트 레벨** (`.qwen/agents/`)
2. **사용자 레벨** (`~/.qwen/agents/`)
3. **내장** (코드에 하드코딩)

같은 이름의 에이전트가 여러 레벨에 존재하면 우선순위가 높은 것이 사용됩니다.

## 서브에이전트 실행 흐름

```typescript
// 1. Task 도구 호출
await taskTool.execute({
  subagent_type: 'code-reviewer',
  prompt: 'Review the UserService.ts file',
  description: 'Code review'
});

// 2. 서브에이전트 로딩
const agent = await subagentManager.loadSubagent('code-reviewer');

// 3. 새 GeminiClient 인스턴스 생성
const subagentClient = new GeminiClient({
  systemPrompt: agent.systemPrompt,
  tools: filterTools(agent.tools),
  modelConfig: agent.modelConfig
});

// 4. 에이전트 실행
const result = await subagentClient.sendMessage(prompt);

// 5. 결과 반환
return { result: result.text };
```

## 서브에이전트 작성 모범 사례

### 1. 명확한 역할 정의

```markdown
You are a [specific expert role] specializing in [domain].
```

### 2. 구체적인 책임 명시

```markdown
## Your Responsibilities
1. [책임 1]: [상세 설명]
2. [책임 2]: [상세 설명]
```

### 3. 워크플로우 제공

```markdown
## Process
1. [단계 1]
2. [단계 2]
3. [단계 3]
```

### 4. 출력 형식 정의

```markdown
## Output Format
- **Section 1**: [내용]
- **Section 2**: [내용]
```

### 5. 예제 포함

```markdown
## Example
Input: [예제 입력]
Output: [예제 출력]
```

### 6. 제약 조건 명시

```markdown
## Constraints
- DO: [해야 할 일]
- DON'T: [하지 말아야 할 일]
```

## 서브에이전트 디버깅

### 로깅

```typescript
// 에이전트 실행 로그
console.log('Subagent:', agent.name);
console.log('Prompt:', prompt);
console.log('Tools:', agent.tools);

// 결과 로그
console.log('Result:', result);
```

### 테스트

```typescript
// 단위 테스트
describe('SubagentManager', () => {
  it('should load builtin agent', async () => {
    const agent = await manager.loadSubagent('general-purpose');
    expect(agent).toBeDefined();
    expect(agent.name).toBe('general-purpose');
  });

  it('should create custom agent', async () => {
    await manager.createSubagent(customAgent, { level: 'project' });
    const loaded = await manager.loadSubagent(customAgent.name, 'project');
    expect(loaded).toEqual(customAgent);
  });
});
```

## 참고 자료

- 서브에이전트 타입: `/home/user/qwen-code/packages/core/src/subagents/types.ts`
- 서브에이전트 관리자: `/home/user/qwen-code/packages/core/src/subagents/subagent-manager.ts`
- 내장 에이전트: `/home/user/qwen-code/packages/core/src/subagents/builtin-agents.ts`
- 에이전트 생성기: `/home/user/qwen-code/packages/core/src/utils/subagentGenerator.ts`
