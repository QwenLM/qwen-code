# 기술 스택

## 프로그래밍 언어

### TypeScript (주요 언어)
- **버전**: 5.3.3+
- **사용률**: 소스 코드의 100%
- **설정**: Strict 모드 활성화
- **타겟**: ES2023
- **모듈 시스템**: NodeNext (ESM)

### JavaScript
- 빌드 스크립트 및 설정 파일
- esbuild 설정
- 유틸리티 스크립트

### Bash
- Shell 스크립트
- 빌드 자동화
- 시스템 유틸리티

## 런타임 및 빌드 도구

### Node.js
- **개발 버전**: ~20.19.0 (의존성 요구사항)
- **프로덕션 버전**: ≥20.0.0
- **패키지 관리**: npm workspaces (모노레포)

### esbuild
- **버전**: ^0.25.0
- **역할**: 프로덕션 빌드용 고속 번들러
- **설정**: `/home/user/qwen-code/esbuild.config.js`
- **특징**:
  - 단일 파일로 번들링
  - 네이티브 모듈 외부화
  - __dirname, __filename 심 주입

### TypeScript 컴파일러
- **용도**: 타입 체킹 및 컴파일
- **설정**: 복합 프로젝트 구조
- **출력**: 각 패키지의 `dist/` 디렉토리

## 테스트 프레임워크

### Vitest
- **버전**: 3.x
- **특징**:
  - Vite 기반 고속 테스트 러너
  - Jest 호환 API
  - TypeScript 네이티브 지원
  - 멀티 프로젝트 설정

### 테스트 라이브러리
- **@testing-library/react**: React 컴포넌트 테스트
- **Ink Testing Library**: CLI UI 테스트
- **MSW (Mock Service Worker)**: API 모킹
- **@vitest/coverage-v8**: 코드 커버리지

## 프론트엔드/UI

### React
- **버전**: 19.x
- **용도**: UI 프레임워크
- **특징**: 최신 Hooks 및 Concurrent 기능

### Ink
- **버전**: 6.x
- **역할**: React for CLIs
- **기능**: 터미널 UI 렌더링
- **컴포넌트**:
  - ink-spinner: 로딩 스피너
  - ink-gradient: 그라디언트 텍스트
  - ink-link: 클릭 가능한 링크

## AI/ML 통합

### Google Gemini API
- **패키지**: @google/genai
- **버전**: 1.16.0
- **역할**: Gemini API 클라이언트
- **기능**:
  - 채팅 완료
  - 스트리밍 응답
  - 함수 호출 (Function Calling)

### OpenAI SDK
- **버전**: 5.11.0
- **용도**: OpenAI API 호환성
- **지원**: GPT 모델 및 호환 엔드포인트

### Tiktoken
- **버전**: ^1.0.21
- **기능**: 토큰 카운팅
- **용도**: 토큰 제한 관리

### Model Context Protocol (MCP)
- **패키지**: @modelcontextprotocol/sdk
- **버전**: ^1.11.0
- **역할**: MCP 표준 구현
- **기능**: 외부 도구 통합

## 핵심 라이브러리

### CLI 도구

#### yargs
- **버전**: ^17.7.2
- **용도**: CLI 인자 파싱
- **특징**: 명령어, 옵션, 플래그 처리

#### dotenv
- **버전**: ^17.1.0
- **기능**: 환경 변수 로딩
- **파일**: `.env` 파일 지원

#### update-notifier
- **버전**: ^7.3.1
- **역할**: 업데이트 알림
- **기능**: 새 버전 자동 감지

### 파일 시스템

#### glob
- **버전**: ^10.4.5
- **용도**: 파일 패턴 매칭
- **예시**: `**/*.ts`, `src/**/*.tsx`

#### picomatch
- **역할**: 고속 glob 매칭
- **용도**: 패턴 필터링

#### ignore
- **버전**: ^7.0.0
- **기능**: `.gitignore` 파싱
- **용도**: 파일 제외 패턴

#### mime
- **버전**: 4.0.7
- **기능**: MIME 타입 감지
- **용도**: 파일 타입 판별

### Git 연동

#### simple-git
- **버전**: ^3.28.0
- **기능**: Git 작업 수행
- **명령**: status, diff, commit, push 등

### 텍스트 처리

#### marked
- **버전**: ^15.0.12
- **용도**: Markdown 파싱
- **기능**: Markdown → HTML 변환

#### diff
- **역할**: 텍스트 차이 비교
- **용도**: 파일 변경 사항 표시

### 구문 강조

#### highlight.js
- **버전**: ^11.11.1
- **기능**: 코드 구문 강조
- **언어**: 다중 프로그래밍 언어 지원

#### lowlight
- **역할**: highlight.js용 Virtual 구문 트리
- **용도**: 터미널 코드 하이라이팅

### 유틸리티

#### fzf
- **버전**: ^0.5.2
- **기능**: Fuzzy 찾기
- **용도**: 대화형 선택

#### zod
- **버전**: ^3.23.8
- **역할**: 스키마 검증
- **용도**: 런타임 타입 체킹

#### qrcode-terminal
- **버전**: ^0.12.0
- **기능**: QR 코드 생성
- **용도**: OAuth 로그인 표시

## 개발 도구

### 린터 및 포맷터

#### ESLint
- **버전**: 9.x
- **설정**: Flat config 형식
- **플러그인**:
  - @typescript-eslint
  - eslint-plugin-react
  - eslint-plugin-import

#### Prettier
- **버전**: 3.5+
- **역할**: 코드 포맷팅
- **설정**: `.prettierrc.json`

### Git Hooks

#### Husky
- **버전**: ^9.1.7
- **용도**: Git hooks 관리
- **훅**: pre-commit, pre-push

#### lint-staged
- **버전**: ^16.1.6
- **기능**: Staged 파일 린팅
- **통합**: Husky와 함께 사용

## 플랫폼별 의존성

### 터미널 에뮬레이션

#### @lydell/node-pty
- **버전**: 1.1.0
- **역할**: Pseudo-터미널 (PTY)
- **플랫폼**: Linux, macOS, Windows
- **선택**: Optional dependency

#### node-pty
- **버전**: ^1.0.0
- **역할**: 터미널 에뮬레이션
- **대체**: @lydell/node-pty

#### @xterm/headless
- **버전**: 5.5.0
- **용도**: 헤드리스 터미널
- **기능**: 터미널 출력 처리

## 인증 및 보안

### google-auth-library
- **버전**: ^9.11.0
- **기능**: Google OAuth 2.0
- **용도**: Qwen OAuth 구현

## 컨테이너 및 샌드박싱

### Docker/Podman
- **Dockerfile**: 멀티 스테이지 빌드
- **베이스 이미지**: Node 20
- **도구**: ripgrep, gh, git 포함

## 프로덕션 의존성 요약

```json
{
  "@google/genai": "1.16.0",
  "openai": "5.11.0",
  "tiktoken": "^1.0.21",
  "@modelcontextprotocol/sdk": "^1.11.0",
  "google-auth-library": "^9.11.0",
  "ink": "^6.2.3",
  "react": "^19.1.0",
  "yargs": "^17.7.2",
  "marked": "^15.0.12",
  "simple-git": "^3.28.0",
  "glob": "^10.4.5",
  "zod": "^3.23.8"
}
```

## 개발 의존성 요약

```json
{
  "typescript": "^5.3.3",
  "esbuild": "^0.25.0",
  "eslint": "^9.24.0",
  "vitest": "^3.2.4",
  "prettier": "^3.5.3",
  "husky": "^9.1.7",
  "@types/node": "^20.11.24"
}
```

## 기술 선택 이유

### TypeScript
- 강력한 타입 안정성
- 우수한 IDE 지원
- 리팩토링 용이성

### React + Ink
- 선언적 UI 구축
- 컴포넌트 재사용성
- 풍부한 생태계

### Vitest
- 빠른 테스트 실행
- TypeScript 네이티브
- Jest 호환성

### esbuild
- 매우 빠른 빌드 속도
- 단순한 설정
- 네이티브 성능

## 다음 단계

- [디렉토리 구조](03-directory-structure.md) - 프로젝트 파일 구조
- [아키텍처](04-architecture.md) - 시스템 설계
- [개발 가이드](06-development-guide.md) - 개발 환경 설정
