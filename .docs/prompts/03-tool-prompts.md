# 도구 설명 프롬프트

## 개요

도구 설명 프롬프트는 AI가 각 도구를 올바르게 이해하고 사용할 수 있도록 가이드하는 프롬프트입니다. Function Calling (도구 호출) 시스템의 핵심입니다.

## 도구 프롬프트 구조

```typescript
interface FunctionDeclaration {
  name: string;                    // 도구 이름
  description: string;              // 도구 설명 (짧은 요약)
  parametersJsonSchema: JSONSchema; // 매개변수 스키마
}

// 추가로 상세 설명을 주석이나 문서에 포함
const detailedDescription = `
  긴 설명, 사용 시나리오, 예제, 주의사항 등
`;
```

## 주요 도구 프롬프트

### 1. TodoWrite 도구

**파일 위치**: `/home/user/qwen-code/packages/core/src/tools/todoWrite.ts`

#### 짧은 설명

```typescript
description: 'Creates and manages a structured task list for your current coding
              session. This helps track progress, organize complex tasks, and
              demonstrate thoroughness.'
```

#### 매개변수 스키마

```typescript
parametersJsonSchema: {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 1 },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed']
          },
          id: { type: 'string' }
        },
        required: ['content', 'status', 'id']
      }
    }
  },
  required: ['todos']
}
```

#### 상세 설명 프롬프트

```
Use this tool to create and manage a structured task list for your current
coding session. This helps you track progress, organize complex tasks, and
demonstrate thoroughness to the user.

## When to Use This Tool

Use this tool proactively in these scenarios:

1. Complex multi-step tasks - When a task requires 3 or more distinct steps
2. Non-trivial and complex tasks - Tasks that require careful planning
3. User explicitly requests todo list
4. User provides multiple tasks - When users provide a list of things to be done
5. After receiving new instructions - Immediately capture user requirements
6. When you start working on a task - Mark it as in_progress BEFORE beginning work
7. After completing a task - Mark it as completed and add follow-up tasks

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

## Examples

<example>
User: I want to add a dark mode toggle to the application settings. Make sure
      you run the tests and build when you're done!