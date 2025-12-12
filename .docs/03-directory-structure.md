# 디렉토리 구조

## 전체 프로젝트 구조

```
/home/user/qwen-code/
├── .github/                    # GitHub 설정 및 워크플로우
├── .vscode/                    # VS Code 워크스페이스 설정
├── docs/                       # 공식 프로젝트 문서
├── packages/                   # 모노레포 패키지들
│   ├── cli/                    # CLI 프론트엔드 패키지
│   ├── core/                   # 코어 백엔드 패키지
│   ├── test-utils/             # 공유 테스트 유틸리티
│   └── vscode-ide-companion/   # VS Code 확장 프로그램
├── scripts/                    # 빌드 및 유틸리티 스크립트
├── integration-tests/          # 통합 테스트
├── esbuild.config.js          # esbuild 빌드 설정
├── eslint.config.js           # ESLint 린팅 규칙
├── tsconfig.json              # TypeScript 설정
├── vitest.config.ts           # Vitest 테스트 설정
├── Dockerfile                 # Docker 컨테이너 이미지
├── Makefile                   # 빌드 자동화
└── package.json               # 루트 패키지 설정
```

## 루트 디렉토리

### 설정 파일

#### `package.json`
- **역할**: 루트 패키지 설정
- **기능**:
  - npm workspaces 정의
  - 공유 스크립트 (build, test, lint)
  - 공통 개발 의존성
- **파일 위치**: `/home/user/qwen-code/package.json`

#### `tsconfig.json`
- **역할**: TypeScript 컴파일러 설정
- **설정**:
  - Strict 모드
  - ES2023 타겟
  - NodeNext 모듈 해상도
  - 복합 프로젝트 구조
- **파일 위치**: `/home/user/qwen-code/tsconfig.json`

#### `vitest.config.ts`
- **역할**: 테스트 프레임워크 설정
- **프로젝트**:
  - cli, core, vscode-ide-companion
  - integration-tests, scripts
- **파일 위치**: `/home/user/qwen-code/vitest.config.ts`

#### `eslint.config.js`
- **역할**: 린팅 규칙
- **형식**: Flat config (ESLint 9+)
- **플러그인**: TypeScript, React, Import
- **파일 위치**: `/home/user/qwen-code/eslint.config.js`

#### `esbuild.config.js`
- **역할**: 프로덕션 빌드 설정
- **출력**: `dist/cli.js` (번들 파일)
- **파일 위치**: `/home/user/qwen-code/esbuild.config.js`

### `.github/`
```
.github/
├── workflows/           # GitHub Actions 워크플로우
│   ├── ci.yml          # CI 파이프라인
│   ├── release.yml     # 릴리스 자동화
│   └── ...
├── ISSUE_TEMPLATE/     # 이슈 템플릿
└── PULL_REQUEST_TEMPLATE.md  # PR 템플릿
```

### `.vscode/`
```
.vscode/
├── launch.json         # 디버그 설정
├── settings.json       # 워크스페이스 설정
└── extensions.json     # 권장 확장 프로그램
```

## `packages/` - 모노레포 패키지

### `packages/cli/` - CLI 패키지 (~508 파일)

```
packages/cli/
├── src/
│   ├── commands/           # 슬래시 커맨드 및 확장
│   │   ├── extensions/     # 커맨드 확장
│   │   └── mcp-servers/    # MCP 서버 예제
│   ├── config/             # CLI 설정
│   │   ├── arguments.ts    # 인자 파싱
│   │   ├── settings.ts     # 설정 관리
│   │   └── auth/           # 인증 처리
│   ├── services/           # CLI 서비스
│   │   ├── commandLoader.ts        # 커맨드 로딩
│   │   ├── promptProcessor.ts      # 프롬프트 처리
│   │   └── fileCommandLoader.ts    # 파일 커맨드
│   ├── ui/                 # React/Ink UI 컴포넌트
│   │   ├── AppContainer.tsx        # 메인 앱 컨테이너
│   │   ├── components/             # 재사용 가능 컴포넌트
│   │   │   ├── MessageRenderer.tsx
│   │   │   ├── ToolConfirmation.tsx
│   │   │   ├── InputBar.tsx
│   │   │   └── ...
│   │   ├── contexts/               # React Contexts
│   │   │   ├── SettingsContext.tsx
│   │   │   ├── SessionContext.tsx
│   │   │   ├── VimModeContext.tsx
│   │   │   └── KeypressContext.tsx
│   │   └── themes/                 # 테마 관리
│   ├── utils/              # CLI 유틸리티
│   ├── gemini.tsx          # 메인 엔트리 포인트
│   └── nonInteractiveCli.ts  # 비대화형 모드
├── index.ts               # 실행 파일 엔트리
├── package.json           # CLI 패키지 설정
└── tsconfig.json          # CLI TypeScript 설정
```

**주요 진입점**:
- `/home/user/qwen-code/packages/cli/index.ts` - 메인 실행 파일
- `/home/user/qwen-code/packages/cli/src/gemini.tsx` - React 앱 컨테이너

### `packages/core/` - 코어 패키지 (~343 파일)

```
packages/core/
├── src/
│   ├── code_assist/        # OAuth 및 코드 지원
│   │   ├── oauth.ts        # OAuth2 구현
│   │   └── codeAssist.ts   # 코드 지원 기능
│   ├── config/             # 코어 설정
│   │   ├── config.ts       # 설정 로딩
│   │   └── schema.ts       # 설정 스키마
│   ├── core/               # 메인 클라이언트 로직
│   │   ├── client.ts       # GeminiClient 오케스트레이터
│   │   ├── geminiChat.ts   # 채팅 세션 관리
│   │   ├── contentGenerator.ts     # API 상호작용
│   │   ├── coreToolScheduler.ts    # 도구 실행 스케줄링
│   │   ├── prompts.ts              # 시스템 프롬프트
│   │   └── tokenLimits.ts          # 토큰 추적
│   ├── ide/                # IDE 통합
│   │   ├── ideDetection.ts         # IDE 감지
│   │   ├── contextSharing.ts       # 컨텍스트 공유
│   │   └── fileSynchronization.ts  # 파일 동기화
│   ├── mcp/                # Model Context Protocol
│   │   ├── mcpManager.ts           # MCP 관리자
│   │   └── mcpClient.ts            # MCP 클라이언트
│   ├── prompts/            # 시스템 프롬프트
│   │   ├── system/         # 시스템 프롬프트 템플릿
│   │   └── tools/          # 도구 설명 프롬프트
│   ├── qwen/               # Qwen 특화 기능
│   │   ├── qwenOAuth.ts    # Qwen OAuth
│   │   └── qwenParser.ts   # Qwen 응답 파서
│   ├── services/           # 백엔드 서비스
│   │   ├── chatCompressionService.ts   # 대화 압축
│   │   ├── chatRecordingService.ts     # 세션 기록
│   │   ├── shellExecutionService.ts    # Shell 실행
│   │   ├── loopDetectionService.ts     # 무한루프 방지
│   │   └── fileDiscoveryService.ts     # 파일 검색
│   ├── subagents/          # 전문 AI 에이전트
│   │   ├── types.ts                    # 에이전트 타입
│   │   ├── registry.ts                 # 에이전트 레지스트리
│   │   └── built-in/                   # 내장 에이전트
│   │       ├── file-search/
│   │       ├── code-review/
│   │       └── ...
│   ├── telemetry/          # 사용량 추적
│   │   ├── telemetryService.ts
│   │   └── events.ts
│   ├── tools/              # 도구 구현
│   │   ├── read-file.ts            # 파일 읽기
│   │   ├── read-many-files.ts      # 다중 파일 읽기
│   │   ├── write-file.ts           # 파일 쓰기
│   │   ├── edit.ts                 # 파일 편집
│   │   ├── smart-edit.ts           # 스마트 편집
│   │   ├── ls.ts                   # 디렉토리 목록
│   │   ├── grep.ts                 # 내용 검색
│   │   ├── ripGrep.ts              # Ripgrep 통합
│   │   ├── glob.ts                 # 파일 패턴 매칭
│   │   ├── shell.ts                # Shell 명령 실행
│   │   ├── web-fetch.ts            # HTTP 가져오기
│   │   ├── web-search/             # 웹 검색
│   │   ├── memoryTool.ts           # 메모리 지속성
│   │   ├── task.ts                 # 작업 관리
│   │   ├── todoWrite.ts            # TODO 추적
│   │   ├── mcp-client.ts           # MCP 클라이언트
│   │   └── mcp-tool.ts             # MCP 도구
│   └── utils/              # 공유 유틸리티
│       ├── fileUtils.ts
│       ├── pathUtils.ts
│       ├── tokenUtils.ts
│       └── ...
├── package.json            # 코어 패키지 설정
└── tsconfig.json           # 코어 TypeScript 설정
```

**주요 파일**:
- `/home/user/qwen-code/packages/core/src/core/client.ts` - 메인 클라이언트
- `/home/user/qwen-code/packages/core/src/tools/` - 모든 도구 구현

### `packages/vscode-ide-companion/` - VS Code 확장

```
packages/vscode-ide-companion/
├── src/
│   ├── extension.ts        # 확장 엔트리 포인트
│   ├── ide-server.ts       # MCP 서버
│   └── diff-manager.ts     # Diff 처리
├── package.json            # 확장 매니페스트
└── tsconfig.json           # TypeScript 설정
```

**기능**:
- Qwen Code를 위한 직접 워크스페이스 접근
- Diff 편집기 통합
- 파일 변경 관리
- IDE 통신용 MCP 서버

### `packages/test-utils/` - 테스트 유틸리티

```
packages/test-utils/
├── src/
│   ├── mocks/              # Mock 구현
│   ├── helpers/            # 테스트 헬퍼
│   └── fixtures/           # 공유 픽스처
├── package.json
└── tsconfig.json
```

## `docs/` - 공식 문서

```
docs/
├── cli/                    # CLI 관련 문서
├── core/                   # 코어 패키지 문서
├── development/            # 개발 가이드
├── extensions/             # 확장 시스템 문서
├── features/               # 기능 문서
├── ide-integration/        # IDE 통합 가이드
├── tools/                  # 도구 문서
└── examples/               # 예제 설정
```

## `scripts/` - 빌드 스크립트

```
scripts/
├── copy_bundle_assets.js   # 에셋 복사
├── build_sandbox.sh         # 샌드박스 빌드
└── ...
```

## `integration-tests/` - 통합 테스트

```
integration-tests/
├── edit.test.ts                        # 편집 테스트
├── file-system.test.ts                 # 파일 시스템 테스트
├── run_shell_command.test.ts          # Shell 테스트
├── web_search.test.ts                  # 웹 검색 테스트
├── mcp_server_cyclic_schema.test.ts   # MCP 테스트
├── terminal-bench/                     # 터미널 벤치마크
├── test-helper.ts                      # 테스트 헬퍼
└── globalSetup.ts                      # 글로벌 설정
```

## 빌드 출력 디렉토리

### `dist/`
```
dist/
├── cli.js              # 번들된 CLI 실행 파일
├── cli.js.map          # 소스 맵
└── ...                 # 복사된 에셋
```

### `packages/*/dist/`
- 각 패키지의 컴파일된 TypeScript 출력
- ESM 모듈 형식

## 무시되는 디렉토리 (`.gitignore`)

```
node_modules/           # npm 의존성
dist/                   # 빌드 출력
coverage/               # 테스트 커버리지
.env                    # 환경 변수
.qwen/                  # 사용자 설정 (일부 예외)
*.log                   # 로그 파일
```

## 사용자 설정 디렉토리

### `~/.qwen/` (사용자 홈)
```
~/.qwen/
├── settings.json       # 사용자 설정
├── auth/               # 인증 토큰
└── cache/              # 캐시 데이터
```

### `.qwen/` (프로젝트 루트)
```
.qwen/
├── config.yaml         # 프로젝트별 설정
├── commands/           # 커스텀 커맨드
└── hooks/              # 프로젝트 훅
```

## 파일 개수 요약

- **CLI 패키지**: ~508 파일
- **Core 패키지**: ~343 파일
- **VS Code 확장**: ~20 파일
- **문서**: ~100+ 파일
- **테스트**: ~50+ 파일

## 다음 단계

- [아키텍처](04-architecture.md) - 시스템 설계 구조
- [주요 컴포넌트](05-key-components.md) - 컴포넌트 상세 설명
- [개발 가이드](06-development-guide.md) - 개발 환경 설정
