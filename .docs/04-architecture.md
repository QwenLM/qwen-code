# 아키텍처

## 시스템 아키텍처 개요

Qwen Code는 **모듈러 모노레포 + 클린 아키텍처** 패턴을 따르는 계층화된 시스템입니다.

## 전체 시스템 계층

```
┌─────────────────────────────────────────────────────┐
│           사용자 인터페이스 계층                      │
│         (CLI Layer - packages/cli)                  │
│                                                      │
│  - React/Ink 기반 터미널 UI                         │
│  - 사용자 입력/출력 처리                             │
│  - 커맨드 라우팅                                     │
│  - 설정 관리                                         │
└────────────────┬────────────────────────────────────┘
                 │
                 │ API Calls
                 ▼
┌─────────────────────────────────────────────────────┐
│           비즈니스 로직 계층                          │
│         (Core Layer - packages/core)                │
│                                                      │
│  - GeminiClient 오케스트레이션                       │
│  - 채팅 세션 관리                                    │
│  - 도구 실행 스케줄링                                │
│  - 시스템 프롬프트 관리                              │
│  - 토큰 관리 및 제한                                 │
└────────────────┬────────────────────────────────────┘
                 │
                 │ Tool Invocations
                 ▼
┌─────────────────────────────────────────────────────┐
│           도구 실행 계층                              │
│              (Tools Layer)                          │
│                                                      │
│  - 파일 시스템 작업 (Read, Write, Edit)             │
│  - Shell 실행 (Bash, Shell)                         │
│  - 검색 (Grep, Glob)                                │
│  - 웹 접근 (WebFetch, WebSearch)                    │
│  - MCP 통합 (외부 도구)                             │
└────────────────┬────────────────────────────────────┘
                 │
                 │ System Calls
                 ▼
┌─────────────────────────────────────────────────────┐
│           시스템 자원 계층                            │
│                                                      │
│  - 파일 시스템 (Node.js fs)                         │
│  - 프로세스 실행 (child_process, PTY)               │
│  - 네트워크 (HTTP/HTTPS)                            │
│  - Git (simple-git)                                 │
└─────────────────────────────────────────────────────┘
```

## 주요 디자인 패턴

### 1. Tool Invocation Pattern (도구 호출 패턴)

**목적**: AI 모델이 요청한 도구를 안전하고 체계적으로 실행

```typescript
// 도구 인터페이스
interface ToolBuilder {
  name: string;
  description: string;
  parameters: JSONSchema;
  validate(params: unknown): ValidationResult;
}

interface ToolInvocation {
  execute(params: ValidatedParams): Promise<ToolResult>;
  requiresConfirmation(params: ValidatedParams): boolean;
}

// 실행 흐름
1. AI 모델이 도구 호출 요청
2. ToolRegistry에서 도구 찾기
3. 매개변수 검증 (Zod 스키마)
4. 확인 필요 시 사용자에게 확인 요청
5. 도구 실행
6. 결과 반환
```

**구현 위치**:
- `/home/user/qwen-code/packages/core/src/tools/` - 도구 구현
- `/home/user/qwen-code/packages/core/src/core/coreToolScheduler.ts` - 스케줄러

### 2. Event-Driven Communication (이벤트 기반 통신)

**목적**: 계층 간 느슨한 결합 및 비동기 통신

```typescript
// CLI 레벨 이벤트
appEvents.emit('toolExecution', { tool, params });
appEvents.on('sessionUpdate', (session) => { /* 처리 */ });

// 서브에이전트 이벤트
subagentEvents.emit('agentComplete', { result });

// IDE 컨텍스트 변경 이벤트
ideEvents.emit('contextChange', { files });
```

**주요 이벤트**:
- `toolExecution`: 도구 실행 시작
- `sessionUpdate`: 세션 상태 변경
- `contextChange`: IDE 컨텍스트 변경
- `errorOccurred`: 에러 발생

### 3. Service Layer Pattern (서비스 계층 패턴)

**목적**: 비즈니스 로직을 캡슐화하고 재사용성 향상

```typescript
// 서비스 예시
class ChatCompressionService {
  constructor(
    private tokenCounter: TokenCounter,
    private config: CompressionConfig
  ) {}

  async compress(messages: Message[]): Promise<Message[]> {
    // 압축 로직
  }
}

// 의존성 주입
const compressionService = new ChatCompressionService(
  tokenCounter,
  config
);
```

**주요 서비스**:
- `ChatCompressionService`: 대화 기록 압축
- `ChatRecordingService`: 세션 기록
- `ShellExecutionService`: Shell 명령 실행
- `LoopDetectionService`: 무한 루프 감지
- `FileDiscoveryService`: 파일 검색

**위치**: `/home/user/qwen-code/packages/core/src/services/`

### 4. Content Generation Abstraction (콘텐츠 생성 추상화)

**목적**: 다양한 AI 모델 제공자 지원

```typescript
interface ContentGenerator {
  generateContent(request: GenerateRequest): AsyncGenerator<Part>;
  countTokens(content: Content): Promise<number>;
}

// 구현체
class GeminiContentGenerator implements ContentGenerator { }
class OpenAIContentGenerator implements ContentGenerator { }

// 로깅 래퍼
class LoggingContentGenerator implements ContentGenerator {
  constructor(private wrapped: ContentGenerator) {}
  // 모든 호출 로깅
}
```

**위치**: `/home/user/qwen-code/packages/core/src/core/contentGenerator.ts`

### 5. Monorepo Organization (모노레포 구성)

**목적**: 코드 공유 및 의존성 관리 최적화

```json
// package.json
{
  "workspaces": [
    "packages/cli",
    "packages/core",
    "packages/test-utils",
    "packages/vscode-ide-companion"
  ]
}
```

**장점**:
- 공유 타입 정의
- 패키지 간 직접 임포트
- 통합 빌드 및 테스트
- 버전 관리 단순화

## 핵심 컴포넌트 상호작용

### 1. 일반적인 요청 흐름

```
사용자 입력
    ↓
[CLI: InputBar]
    ↓
[CLI: PromptProcessor]
    ↓
[Core: GeminiClient.sendMessage()]
    ↓
[Core: ContentGenerator.generateContent()]
    ↓
[API: Gemini/OpenAI API]
    ↓
[Core: Response Streaming]
    ↓
[Core: Tool Call Detection]
    ↓
[Core: CoreToolScheduler.executeTool()]
    ↓
[Tools: 특정 도구 실행]
    ↓
[Core: 결과를 다시 AI에게 전달]
    ↓
[CLI: MessageRenderer로 출력]
    ↓
사용자에게 표시
```

### 2. 도구 실행 흐름

```
AI 도구 호출 요청
    ↓
[CoreToolScheduler.scheduleTool()]
    ↓
매개변수 검증 (Zod)
    ↓
확인 필요? ─YES→ [CLI: ToolConfirmation UI]
    │                      ↓
    NO                사용자 승인?
    │                      │
    ↓                      ↓
[Tool.execute()]  ←────── YES
    ↓
시스템 작업 수행
    ↓
결과 반환
    ↓
AI에게 피드백
```

### 3. 파일 편집 흐름

```
사용자: "UserService.ts 리팩토링해줘"
    ↓
AI가 파일 분석
    ↓
[ReadFile Tool] - 파일 읽기
    ↓
AI가 변경사항 계획
    ↓
[Edit Tool] - old_string, new_string
    ↓
문자열 매칭 확인
    ↓
파일 수정
    ↓
사용자에게 변경 내용 표시
    ↓
Git diff 생성 (선택사항)
```

### 4. 서브에이전트 흐름

```
복잡한 작업 요청
    ↓
[Task Tool 호출]
    ↓
서브에이전트 타입 선택
    ↓
새 GeminiClient 인스턴스 생성
    ↓
전용 시스템 프롬프트 로딩
    ↓
서브에이전트 실행
    ↓
결과 수집
    ↓
메인 에이전트에게 반환
    ↓
사용자에게 요약 표시
```

## 데이터 흐름

### 1. 메시지 흐름

```typescript
// 메시지 구조
interface Message {
  role: 'user' | 'model';
  parts: Part[];
}

interface Part {
  text?: string;
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
  inlineData?: { mimeType: string; data: string };
}

// 흐름
User Input → Message → ContentGenerator → API
API Response → Streaming Parts → Message Assembly → UI
```

### 2. 상태 관리

**CLI 상태 (React Context)**:
```typescript
// SessionContext
- currentSession: ChatSession
- messages: Message[]
- isProcessing: boolean

// SettingsContext
- settings: UserSettings
- updateSettings()

// VimModeContext
- mode: 'normal' | 'insert' | 'visual'
- handleKeypress()
```

**Core 상태 (GeminiClient)**:
```typescript
class GeminiClient {
  private chatHistory: Message[] = [];
  private toolRegistry: ToolRegistry;
  private config: ClientConfig;

  // 상태 관리 메서드
  async sendMessage(message: string): Promise<void>
  getHistory(): Message[]
  clearHistory(): void
}
```

### 3. 토큰 관리

```
입력 메시지
    ↓
[TokenCounter.count()] - tiktoken 사용
    ↓
현재 토큰 수 + 새 토큰 수
    ↓
제한 초과? ─YES→ [ChatCompressionService]
    │                      ↓
    NO                 압축된 기록
    │                      │
    ↓                      ↓
API 요청           ←───────┘
```

## 보안 아키텍처

### 1. 샌드박싱

```
사용자 명령
    ↓
샌드박스 모드? ─YES→ Docker/Podman 컨테이너
    │                      ↓
    NO                 격리된 환경
    │                      │
    ↓                      ↓
로컬 실행        컨테이너 내 실행
```

**샌드박스 레벨**:
- `none`: 샌드박스 없음
- `docker`: Docker 컨테이너
- `podman`: Podman 컨테이너

### 2. 확인 흐름

```typescript
// 파괴적 작업 확인
const destructiveTools = [
  'Write',
  'Edit',
  'Bash',
  'Delete'
];

if (tool.requiresConfirmation(params)) {
  const confirmed = await ui.confirmTool(tool, params);
  if (!confirmed) {
    return { canceled: true };
  }
}
```

### 3. 파일 접근 제어

```typescript
// .gitignore 및 .geminiignore 준수
const ignore = createIgnoreFilter([
  '.gitignore',
  '.geminiignore'
]);

if (ignore(filePath)) {
  throw new Error('File is ignored');
}
```

## 확장성 설계

### 1. 도구 등록 시스템

```typescript
// 새 도구 추가
class MyCustomTool implements ToolInvocation {
  name = 'myCustomTool';

  async execute(params: Params): Promise<Result> {
    // 구현
  }
}

// 등록
toolRegistry.register(new MyCustomTool());
```

### 2. MCP (Model Context Protocol)

```
Qwen Code
    ↓
[MCP Client]
    ↓
MCP 서버 (외부)
    ↓
추가 도구 및 컨텍스트
```

**예시 MCP 서버**:
- 데이터베이스 접근
- 클라우드 서비스
- 커스텀 API

### 3. 서브에이전트 확장

```typescript
// 새 서브에이전트 정의
const customAgent: SubagentConfig = {
  name: 'custom-agent',
  description: '특화된 작업 수행',
  systemPrompt: '...',
  tools: ['Read', 'Write', 'Bash'],
  model: 'sonnet'
};

// 등록
subagentRegistry.register(customAgent);
```

## 성능 최적화

### 1. 스트리밍 응답

```typescript
// 청크 단위로 UI 업데이트
for await (const part of contentGenerator.generateContent(request)) {
  ui.appendToPart(part);
  // 사용자가 즉시 응답 확인 가능
}
```

### 2. 병렬 도구 실행

```typescript
// 독립적인 도구 병렬 실행
const results = await Promise.all([
  toolScheduler.execute('Read', { file: 'a.ts' }),
  toolScheduler.execute('Read', { file: 'b.ts' }),
  toolScheduler.execute('Grep', { pattern: 'foo' })
]);
```

### 3. 캐싱

- **파일 디스커버리 캐시**: 프로젝트 파일 목록
- **웹 페치 캐시**: 15분 자동 정리
- **토큰 카운트 캐시**: 반복 계산 방지

## 에러 처리

### 계층별 에러 처리

```
[Tools Layer]
    ↓ ToolExecutionError
[Core Layer]
    ↓ ClientError, APIError
[CLI Layer]
    ↓ FatalError, UserFacingError
[UI]
    ↓ 사용자에게 표시
```

### 에러 복구 전략

1. **재시도**: 네트워크 에러 시 자동 재시도
2. **롤백**: 파일 작업 실패 시 원복
3. **Fallback**: 메인 모델 실패 시 대체 모델
4. **Graceful Degradation**: 일부 기능 실패 시 계속 진행

## 테스트 가능성

### 의존성 주입

```typescript
// 테스트 가능한 설계
class GeminiClient {
  constructor(
    private contentGenerator: ContentGenerator,
    private toolRegistry: ToolRegistry,
    private config: ClientConfig
  ) {}
}

// 테스트에서 Mock 주입
const mockGenerator = createMockContentGenerator();
const client = new GeminiClient(mockGenerator, ...);
```

### 계층별 격리 테스트

- **Unit Tests**: 각 도구, 서비스 독립 테스트
- **Integration Tests**: 도구 + 파일 시스템
- **E2E Tests**: 전체 CLI 흐름

## 다음 단계

- [주요 컴포넌트](05-key-components.md) - 각 컴포넌트 상세 설명
- [개발 가이드](06-development-guide.md) - 개발 환경 설정
