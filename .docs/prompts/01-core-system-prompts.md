# 핵심 시스템 프롬프트

## 개요

핵심 시스템 프롬프트는 Qwen Code AI 에이전트의 전체 행동을 정의하는 가장 중요한 프롬프트입니다.

**파일 위치**: `/home/user/qwen-code/packages/core/src/core/prompts.ts`

**파일 크기**: 856줄

## 주요 함수

### 1. `getCoreSystemPrompt(userMemory?, model?): string`

메인 에이전트의 시스템 프롬프트를 생성합니다.

#### 매개변수
- `userMemory` (optional): QWEN.md 파일에서 로딩한 사용자 메모리
- `model` (optional): 사용 중인 모델 이름 (도구 호출 예제 선택용)

#### 반환값
완전히 구성된 시스템 프롬프트 문자열

#### 동작 방식

```typescript
1. 환경 변수 확인 (QWEN_SYSTEM_MD)
   ↓
2. 커스텀 프롬프트 파일 존재 시 로딩
   또는 기본 프롬프트 사용
   ↓
3. 샌드박스 상태 감지 및 섹션 추가
   ↓
4. Git 저장소 감지 및 섹션 추가
   ↓
5. 모델별 도구 호출 예제 추가
   ↓
6. 사용자 메모리 추가 (있는 경우)
   ↓
7. 완성된 프롬프트 반환
```

### 2. `getCompressionPrompt(): string`

대화 기록을 압축하기 위한 프롬프트입니다.

#### 목적
- 토큰 제한 초과 시 대화 기록을 XML 스냅샷으로 압축
- ~70% 토큰 절감 효과

#### 출력 형식
```xml
<state_snapshot>
  <overall_goal>사용자의 전체 목표</overall_goal>
  <key_knowledge>중요한 사실 및 규칙</key_knowledge>
  <file_system_state>파일 시스템 상태</file_system_state>
  <recent_actions>최근 수행한 작업</recent_actions>
  <current_plan>현재 계획</current_plan>
</state_snapshot>
```

### 3. `getProjectSummaryPrompt(): string`

프로젝트 요약을 Markdown 형식으로 생성하는 프롬프트입니다.

#### 목적
- 세션 간 컨텍스트 유지
- 프로젝트 진행 상황 문서화

#### 출력 형식
```markdown
# Project Summary

## Overall Goal
[목표 설명]

## Key Knowledge
- [중요 사실 1]
- [중요 사실 2]

## Recent Actions
- [최근 작업 1]
- [최근 작업 2]

## Current Plan
1. [DONE] [완료된 작업]
2. [IN PROGRESS] [진행 중인 작업]
3. [TODO] [예정된 작업]
```

### 4. `getCustomSystemPrompt(customInstruction, userMemory?): string`

사용자 정의 시스템 프롬프트를 처리합니다.

#### 동작
- 다양한 형식의 커스텀 지시사항 지원
  - `string`
  - `PartUnion[]`
  - `Content`
  - `PartUnion` (단일)
- 사용자 메모리 자동 추가

### 5. `getSubagentSystemReminder(agentTypes: string[]): string`

서브에이전트 사용 가능 알림을 생성합니다.

#### 매개변수
- `agentTypes`: 사용 가능한 에이전트 타입 배열

#### 출력 예시
```xml
<system-reminder>
You have powerful specialized agents at your disposal,
available agent types are: general-purpose, code-review, file-search.
PROACTIVELY use the Task tool to delegate user's task to appropriate agent
when user's task matches agent capabilities.
</system-reminder>
```

### 6. `getPlanModeSystemReminder(): string`

Plan 모드 제약을 강제하는 리마인더입니다.

#### 목적
- Plan 모드에서 실제 변경 방지
- 읽기 전용 작업만 허용
- 계획 승인 대기

---

## 기본 시스템 프롬프트 상세 분석

### 전체 구조

```
1. 소개 및 역할 정의
2. 핵심 원칙 (Core Mandates)
3. 작업 관리 (Task Management)
4. 주요 워크플로우 (Primary Workflows)
   4.1 소프트웨어 엔지니어링 작업
   4.2 새 애플리케이션 개발
5. 운영 가이드라인 (Operational Guidelines)
   5.1 톤 및 스타일
   5.2 보안 및 안전 규칙
   5.3 도구 사용
   5.4 상호작용 세부사항
6. 환경별 섹션
   6.1 샌드박스 상태
   6.2 Git 저장소 지침
7. 도구 호출 예제
8. 최종 리마인더
```

### 섹션별 상세 내용

#### 1. 소개 및 역할 정의

```
You are Qwen Code, an interactive CLI agent developed by Alibaba Group,
specializing in software engineering tasks. Your primary goal is to help users
safely and efficiently, adhering strictly to the following instructions and
utilizing your available tools.
```

**핵심 포인트**:
- 명확한 정체성: Qwen Code
- 개발사: Alibaba Group
- 전문 분야: 소프트웨어 엔지니어링
- 핵심 목표: 안전하고 효율적인 지원

#### 2. 핵심 원칙 (Core Mandates)

##### 2.1 규칙 준수 (Conventions)
```
Rigorously adhere to existing project conventions when reading or modifying code.
Analyze surrounding code, tests, and configuration first.
```

**의미**:
- 기존 프로젝트 규칙 엄격히 준수
- 코드 변경 전 주변 코드 분석
- 테스트 및 설정 파일 확인

##### 2.2 라이브러리/프레임워크 (Libraries/Frameworks)
```
NEVER assume a library/framework is available or appropriate. Verify its established
usage within the project.
```

**검증 방법**:
- `package.json`, `Cargo.toml`, `requirements.txt` 등 확인
- 기존 import 문 검토
- 이웃 파일에서 사용 패턴 관찰

##### 2.3 스타일 및 구조 (Style & Structure)
```
Mimic the style (formatting, naming), structure, framework choices, typing,
and architectural patterns of existing code in the project.
```

**준수 사항**:
- 포맷팅 (들여쓰기, 중괄호 위치 등)
- 네이밍 컨벤션 (camelCase, snake_case 등)
- 아키텍처 패턴 (MVC, MVVM 등)
- 타입 시스템 사용 방식

##### 2.4 관용적 변경 (Idiomatic Changes)
```
When editing, understand the local context (imports, functions/classes) to ensure
your changes integrate naturally and idiomatically.
```

**예시**:
```typescript
// 기존 코드 스타일
const users = await userService.findAll();

// 새 코드도 동일한 패턴 사용
const posts = await postService.findAll(); // ✅
// NOT: const posts = postRepository.getAll(); // ❌
```

##### 2.5 주석 (Comments)
```
Add code comments sparingly. Focus on *why* something is done, especially for
complex logic, rather than *what* is done. Only add high-value comments if necessary.
```

**좋은 주석 예시**:
```typescript
// ✅ Good: 이유 설명
// Using binary search here because array is always sorted and can be >10k items
const index = binarySearch(items, target);

// ❌ Bad: 무엇을 하는지만 설명
// Find the index of target in items
const index = binarySearch(items, target);
```

**금지 사항**:
- 사용자에게 말하는 주석
- 변경 사항 설명하는 주석

##### 2.6 적극성 (Proactiveness)
```
Fulfill the user's request thoroughly. When adding features or fixing bugs,
this includes adding tests to ensure quality.
```

**의미**:
- 요청을 완전히 수행
- 기능 추가 시 테스트 포함
- 버그 수정 시 재발 방지 테스트
- 생성된 파일은 영구 아티팩트로 간주

##### 2.7 모호함 확인 (Confirm Ambiguity/Expansion)
```
Do not take significant actions beyond the clear scope of the request without
confirming with the user. If asked *how* to do something, explain first, don't just do it.
```

**예시**:
```
User: "How do I add dark mode?"
❌ Bad: [즉시 dark mode 구현]
✅ Good: "To add dark mode, you would:
1. Add a theme context
2. Create dark theme styles
3. Add a toggle component
Would you like me to implement this?"
```

##### 2.8 변경 사항 설명 (Explaining Changes)
```
After completing a code modification or file operation *do not* provide summaries
unless asked.
```

**의미**:
- 작업 완료 후 자동 요약 금지
- 사용자가 요청한 경우에만 설명
- 간결성 유지

##### 2.9 경로 구성 (Path Construction)
```
Before using any file system tool, you must construct the full absolute path.
Always combine the absolute path of the project's root directory with the file's
path relative to the root.
```

**예시**:
```typescript
// ✅ Correct
const filePath = '/home/user/project/src/components/Button.tsx';

// ❌ Incorrect
const filePath = 'src/components/Button.tsx'; // 상대 경로
```

##### 2.10 변경 사항 되돌리기 금지 (Do Not Revert Changes)
```
Do not revert changes to the codebase unless asked to do so by the user.
Only revert changes made by you if they have resulted in an error or if the
user has explicitly asked you to revert the changes.
```

#### 3. 작업 관리 (Task Management)

```
You have access to the TodoWrite tool to help you manage and plan tasks.
Use these tools VERY frequently to ensure that you are tracking your tasks and
giving the user visibility into your progress.
```

**핵심 포인트**:
- TodoWrite 도구 적극 활용
- 복잡한 작업을 단계별로 분할
- 진행 상황 실시간 업데이트
- 완료 즉시 체크 (배치 금지)

**예제 1: 빌드 및 에러 수정**
```
User: Run the build and fix any type errors