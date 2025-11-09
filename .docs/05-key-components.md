# 주요 컴포넌트

## CLI 패키지 (`packages/cli/`)

### 1. 메인 엔트리 포인트

#### `/home/user/qwen-code/packages/cli/index.ts`
```typescript
// 실행 파일 엔트리
- 에러 처리 설정
- FatalError 처리
- main() 호출
```

#### `/home/user/qwen-code/packages/cli/src/gemini.tsx`
```typescript
export async function main() {
  // 1. CLI 설정 로딩
  const config = await loadCliConfig();

  // 2. 인자 파싱
  const args = parseArguments();

  // 3. 사용자 설정 로딩
  const settings = await loadSettings();

  // 4. 앱 초기화
  await initializeApp();

  // 5. UI 렌더링
  if (args.interactive) {
    await startInteractiveUI();
  } else {
    await runNonInteractive();
  }
}
```

### 2. UI 컴포넌트

#### `AppContainer.tsx` - 메인 앱 컨테이너
```typescript
// 전체 앱 래퍼
- SessionContext 제공
- SettingsContext 제공
- VimModeContext 제공
- KeypressContext 제공
- 메시지 목록 렌더링
- 입력 바 렌더링
```

**주요 책임**:
- React Context 프로바이더
- 전역 상태 관리
- 키보드 입력 처리
- UI 레이아웃

**파일 위치**: `/home/user/qwen-code/packages/cli/src/ui/AppContainer.tsx`

#### `MessageRenderer.tsx` - 메시지 표시
```typescript
// AI 응답 렌더링
- 텍스트 파트
- 코드 블록 (구문 강조)
- 도구 호출 표시
- 이미지 표시
- 스트리밍 업데이트
```

**기능**:
- Markdown 파싱
- 구문 강조 (highlight.js)
- 인라인 이미지
- 실시간 스트리밍

**파일 위치**: `/home/user/qwen-code/packages/cli/src/ui/components/MessageRenderer.tsx`

#### `ToolConfirmation.tsx` - 도구 확인 UI
```typescript
// 파괴적 작업 확인
- 도구 이름 표시
- 매개변수 표시
- 승인/거부 버튼
- 키보드 단축키 (y/n)
```

**사용 사례**:
- 파일 쓰기 확인
- Shell 명령 확인
- 삭제 작업 확인

**파일 위치**: `/home/user/qwen-code/packages/cli/src/ui/components/ToolConfirmation.tsx`

#### `InputBar.tsx` - 입력 창
```typescript
// 사용자 입력
- 텍스트 입력
- Vim 모드 지원
- 멀티라인 입력
- 히스토리 탐색 (↑↓)
- 자동완성
```

**특징**:
- Vim 키바인딩
- 입력 히스토리
- 붙여넣기 지원
- 이미지 첨부

**파일 위치**: `/home/user/qwen-code/packages/cli/src/ui/components/InputBar.tsx`

### 3. Context (상태 관리)

#### `SessionContext.tsx`
```typescript
interface SessionContextValue {
  currentSession: ChatSession | null;
  messages: Message[];
  isProcessing: boolean;
  sendMessage: (text: string) => Promise<void>;
  clearSession: () => void;
}
```

**역할**: 채팅 세션 전역 상태

**파일 위치**: `/home/user/qwen-code/packages/cli/src/ui/contexts/SessionContext.tsx`

#### `SettingsContext.tsx`
```typescript
interface SettingsContextValue {
  settings: UserSettings;
  updateSettings: (updates: Partial<UserSettings>) => Promise<void>;
  resetSettings: () => Promise<void>;
}
```

**역할**: 사용자 설정 관리

**파일 위치**: `/home/user/qwen-code/packages/cli/src/ui/contexts/SettingsContext.tsx`

#### `VimModeContext.tsx`
```typescript
interface VimModeContextValue {
  mode: 'normal' | 'insert' | 'visual';
  setMode: (mode: VimMode) => void;
  handleKeypress: (key: string, input: string) => void;
}
```

**역할**: Vim 모드 상태 및 키바인딩

**파일 위치**: `/home/user/qwen-code/packages/cli/src/ui/contexts/VimModeContext.tsx`

### 4. 서비스

#### `commandLoader.ts` - 커맨드 로딩
```typescript
// 슬래시 커맨드 로딩
- .gemini/commands/ 스캔
- Markdown 파일 파싱
- 커맨드 등록
```

**파일 위치**: `/home/user/qwen-code/packages/cli/src/services/commandLoader.ts`

#### `promptProcessor.ts` - 프롬프트 처리
```typescript
// 사용자 입력 전처리
- 슬래시 커맨드 감지
- 변수 치환
- 컨텍스트 추가
```

**파일 위치**: `/home/user/qwen-code/packages/cli/src/services/promptProcessor.ts`

#### `fileCommandLoader.ts` - 파일 커맨드
```typescript
// 파일 기반 커맨드
- 프로젝트별 커맨드
- 사용자 정의 커맨드
```

**파일 위치**: `/home/user/qwen-code/packages/cli/src/services/fileCommandLoader.ts`

---

## Core 패키지 (`packages/core/`)

### 1. 클라이언트 계층

#### `client.ts` - GeminiClient (메인 오케스트레이터)
```typescript
class GeminiClient {
  // 채팅 세션 관리
  async sendMessage(message: string): Promise<void>

  // 스트리밍 응답 처리
  private async handleStreamingResponse(generator: AsyncGenerator)

  // 도구 호출 처리
  private async handleToolCall(call: FunctionCall): Promise<FunctionResponse>

  // 세션 관리
  clearHistory(): void
  getHistory(): Message[]
}
```

**주요 책임**:
- AI API 호출 조율
- 메시지 히스토리 관리
- 도구 호출 조율
- 에러 처리

**파일 위치**: `/home/user/qwen-code/packages/core/src/core/client.ts`

#### `geminiChat.ts` - 채팅 세션
```typescript
class GeminiChat {
  // 세션 시작
  async startChat(systemPrompt?: string): Promise<void>

  // 메시지 전송
  async sendMessage(message: Message): Promise<AsyncGenerator<Part>>

  // 히스토리 관리
  getHistory(): Message[]
  updateHistory(message: Message): void
}
```

**역할**: 개별 채팅 세션 관리

**파일 위치**: `/home/user/qwen-code/packages/core/src/core/geminiChat.ts`

#### `contentGenerator.ts` - API 추상화
```typescript
interface ContentGenerator {
  generateContent(request: GenerateRequest): AsyncGenerator<Part>;
  countTokens(content: Content): Promise<number>;
}

class GeminiContentGenerator implements ContentGenerator {
  // Gemini API 구현
}

class OpenAIContentGenerator implements ContentGenerator {
  // OpenAI API 구현
}

class LoggingContentGenerator implements ContentGenerator {
  // 로깅 래퍼
}
```

**목적**: 다양한 AI 모델 제공자 추상화

**파일 위치**: `/home/user/qwen-code/packages/core/src/core/contentGenerator.ts`

#### `coreToolScheduler.ts` - 도구 스케줄러
```typescript
class CoreToolScheduler {
  // 도구 실행
  async executeTool(
    tool: string,
    params: unknown
  ): Promise<ToolResult>

  // 병렬 실행
  async executeTools(
    calls: FunctionCall[]
  ): Promise<FunctionResponse[]>

  // 확인 필요 여부
  requiresConfirmation(
    tool: string,
    params: unknown
  ): boolean
}
```

**기능**:
- 도구 매개변수 검증
- 도구 실행 조율
- 병렬 실행 지원
- 확인 흐름 관리

**파일 위치**: `/home/user/qwen-code/packages/core/src/core/coreToolScheduler.ts`

### 2. 도구 구현

#### 파일 시스템 도구

##### `read-file.ts` - 파일 읽기
```typescript
class ReadFileTool implements ToolInvocation {
  async execute(params: {
    file_path: string;
    offset?: number;
    limit?: number;
  }): Promise<{ content: string; lineCount: number }>
}
```

**기능**:
- 텍스트 파일 읽기
- 이미지 파일 읽기 (base64)
- PDF 파일 읽기
- Jupyter 노트북 읽기
- 라인 오프셋/제한 지원

**파일 위치**: `/home/user/qwen-code/packages/core/src/tools/read-file.ts`

##### `write-file.ts` - 파일 쓰기
```typescript
class WriteFileTool implements ToolInvocation {
  async execute(params: {
    file_path: string;
    content: string;
  }): Promise<{ success: boolean }>
}
```

**기능**:
- 새 파일 생성
- 기존 파일 덮어쓰기
- 디렉토리 자동 생성
- 확인 필요 (파괴적 작업)

**파일 위치**: `/home/user/qwen-code/packages/core/src/tools/write-file.ts`

##### `edit.ts` - 파일 편집
```typescript
class EditTool implements ToolInvocation {
  async execute(params: {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }): Promise<{ success: boolean; changes: number }>
}
```

**기능**:
- 정확한 문자열 치환
- 전체 치환 옵션
- 고유성 검증
- 라인 번호 보존

**파일 위치**: `/home/user/qwen-code/packages/core/src/tools/edit.ts`

#### 검색 도구

##### `grep.ts` - 내용 검색
```typescript
class GrepTool implements ToolInvocation {
  async execute(params: {
    pattern: string;
    path?: string;
    glob?: string;
    type?: string;
    output_mode?: 'content' | 'files_with_matches' | 'count';
    '-i'?: boolean;  // case insensitive
    '-A'?: number;   // after context
    '-B'?: number;   // before context
  }): Promise<SearchResult>
}
```

**기능**:
- Ripgrep 기반 고속 검색
- 정규식 지원
- 파일 타입 필터
- 컨텍스트 라인

**파일 위치**: `/home/user/qwen-code/packages/core/src/tools/grep.ts`

##### `glob.ts` - 파일 패턴 매칭
```typescript
class GlobTool implements ToolInvocation {
  async execute(params: {
    pattern: string;
    path?: string;
  }): Promise<{ files: string[] }>
}
```

**기능**:
- Glob 패턴 매칭
- .gitignore 준수
- 수정 시간순 정렬

**파일 위치**: `/home/user/qwen-code/packages/core/src/tools/glob.ts`

#### Shell 실행 도구

##### `shell.ts` - Shell 명령 실행
```typescript
class ShellTool implements ToolInvocation {
  async execute(params: {
    command: string;
    timeout?: number;
    run_in_background?: boolean;
  }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    shell_id?: string;
  }>
}
```

**기능**:
- 명령 실행
- 타임아웃 지원
- 백그라운드 실행
- 샌드박스 지원

**파일 위치**: `/home/user/qwen-code/packages/core/src/tools/shell.ts`

#### 웹 도구

##### `web-fetch.ts` - 웹 페이지 가져오기
```typescript
class WebFetchTool implements ToolInvocation {
  async execute(params: {
    url: string;
    prompt: string;
  }): Promise<{ content: string }>
}
```

**기능**:
- HTTP(S) 요청
- HTML → Markdown 변환
- AI 기반 요약
- 15분 캐시

**파일 위치**: `/home/user/qwen-code/packages/core/src/tools/web-fetch.ts`

##### `web-search/` - 웹 검색
```typescript
class WebSearchTool implements ToolInvocation {
  async execute(params: {
    query: string;
    allowed_domains?: string[];
    blocked_domains?: string[];
  }): Promise<SearchResult[]>
}
```

**파일 위치**: `/home/user/qwen-code/packages/core/src/tools/web-search/`

#### 협업 도구

##### `task.ts` - 서브에이전트
```typescript
class TaskTool implements ToolInvocation {
  async execute(params: {
    subagent_type: string;
    prompt: string;
    description: string;
    model?: 'sonnet' | 'opus' | 'haiku';
  }): Promise<{ result: string }>
}
```

**기능**:
- 전문 에이전트 실행
- 독립적인 세션
- 결과 수집

**파일 위치**: `/home/user/qwen-code/packages/core/src/tools/task.ts`

##### `todoWrite.ts` - TODO 추적
```typescript
class TodoWriteTool implements ToolInvocation {
  async execute(params: {
    todos: Array<{
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      activeForm: string;
    }>;
  }): Promise<void>
}
```

**파일 위치**: `/home/user/qwen-code/packages/core/src/tools/todoWrite.ts`

##### `memoryTool.ts` - 메모리 지속성
```typescript
class MemoryTool implements ToolInvocation {
  async execute(params: {
    action: 'read' | 'write' | 'delete';
    key: string;
    value?: string;
  }): Promise<MemoryResult>
}
```

**파일 위치**: `/home/user/qwen-code/packages/core/src/tools/memoryTool.ts`

### 3. 서비스 계층

#### `chatCompressionService.ts` - 대화 압축
```typescript
class ChatCompressionService {
  async compress(
    messages: Message[],
    targetTokens: number
  ): Promise<Message[]> {
    // 1. 오래된 메시지 요약
    // 2. 중요도 낮은 메시지 제거
    // 3. 토큰 제한 준수
  }
}
```

**목적**: 토큰 제한 내에서 컨텍스트 유지

**파일 위치**: `/home/user/qwen-code/packages/core/src/services/chatCompressionService.ts`

#### `chatRecordingService.ts` - 세션 기록
```typescript
class ChatRecordingService {
  startRecording(sessionId: string): void
  stopRecording(): void
  saveMessage(message: Message): void
  getRecording(sessionId: string): Message[]
}
```

**기능**: 디버깅 및 분석을 위한 세션 기록

**파일 위치**: `/home/user/qwen-code/packages/core/src/services/chatRecordingService.ts`

#### `shellExecutionService.ts` - Shell 실행
```typescript
class ShellExecutionService {
  async execute(
    command: string,
    options: ExecutionOptions
  ): Promise<ExecutionResult>

  // 백그라운드 Shell
  createBackgroundShell(id: string): BackgroundShell
  getShellOutput(id: string): string
  killShell(id: string): void
}
```

**기능**:
- 동기 실행
- 비동기/백그라운드 실행
- PTY (pseudo-terminal) 지원
- 샌드박스 격리

**파일 위치**: `/home/user/qwen-code/packages/core/src/services/shellExecutionService.ts`

#### `loopDetectionService.ts` - 무한루프 감지
```typescript
class LoopDetectionService {
  detectLoop(
    toolCalls: FunctionCall[]
  ): { isLoop: boolean; pattern?: string }

  reset(): void
}
```

**목적**: AI가 반복적으로 같은 도구 호출 시 감지

**파일 위치**: `/home/user/qwen-code/packages/core/src/services/loopDetectionService.ts`

### 4. 서브에이전트 시스템

#### 서브에이전트 레지스트리
```typescript
interface SubagentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: ModelName;
}

class SubagentRegistry {
  register(config: SubagentConfig): void
  get(name: string): SubagentConfig
  list(): SubagentConfig[]
}
```

**내장 서브에이전트**:
- `Explore`: 코드베이스 탐색
- `Plan`: 작업 계획 수립
- `file-search`: 파일 검색
- `code-review`: 코드 리뷰

**파일 위치**: `/home/user/qwen-code/packages/core/src/subagents/`

---

## VS Code 확장 (`packages/vscode-ide-companion/`)

### `extension.ts` - 확장 엔트리
```typescript
export function activate(context: vscode.ExtensionContext) {
  // 1. MCP 서버 시작
  startMcpServer();

  // 2. 명령 등록
  registerCommands();

  // 3. 워크스페이스 감시
  watchWorkspace();
}
```

**기능**:
- Qwen Code와 VS Code 연동
- 워크스페이스 파일 접근
- Diff 편집기 통합

**파일 위치**: `/home/user/qwen-code/packages/vscode-ide-companion/src/extension.ts`

### `ide-server.ts` - MCP 서버
```typescript
class IdeServer {
  // 워크스페이스 파일 제공
  async listFiles(): Promise<string[]>

  // 파일 읽기
  async readFile(path: string): Promise<string>

  // Diff 적용
  async applyDiff(diff: Diff): Promise<void>
}
```

**파일 위치**: `/home/user/qwen-code/packages/vscode-ide-companion/src/ide-server.ts`

---

## 다음 단계

- [개발 가이드](06-development-guide.md) - 개발 환경 설정 및 워크플로우
