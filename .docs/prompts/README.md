# Qwen Code 프롬프트 시스템 문서

Qwen Code에서 사용되는 모든 프롬프트의 상세 분석 및 문서입니다.

## 문서 구조

이 디렉토리는 Qwen Code의 프롬프트 시스템을 체계적으로 설명합니다:

1. **[핵심 시스템 프롬프트](01-core-system-prompts.md)**
   - 메인 에이전트 시스템 프롬프트
   - 대화 압축 프롬프트
   - 프로젝트 요약 프롬프트
   - 시스템 리마인더 프롬프트

2. **[서브에이전트 프롬프트](02-subagent-prompts.md)**
   - 내장 서브에이전트
   - 서브에이전트 생성기 프롬프트
   - 사용자 정의 서브에이전트

3. **[도구 설명 프롬프트](03-tool-prompts.md)**
   - TodoWrite 도구 설명
   - Task 도구 설명
   - Memory 도구 설명
   - 기타 도구 프롬프트

4. **[특수 목적 프롬프트](04-specialized-prompts.md)**
   - LLM 편집 수정 프롬프트
   - 루프 감지 프롬프트
   - 도구 출력 요약 프롬프트
   - Next Speaker 체커 프롬프트

5. **[프롬프트 템플릿 시스템](05-prompt-template-system.md)**
   - 프롬프트 로딩 메커니즘
   - 템플릿 변수 치환
   - 동적 프롬프트 생성
   - 프롬프트 조합 및 주입

## 프롬프트 시스템 개요

### 프롬프트 계층 구조

```
시스템 레벨
├── 핵심 시스템 프롬프트 (getCoreSystemPrompt)
│   ├── 기본 프롬프트
│   ├── 사용자 메모리 추가
│   ├── 환경별 설정 (샌드박스, Git)
│   └── 모델별 도구 호출 예제
│
├── 서브에이전트 프롬프트
│   ├── 내장 에이전트 (general-purpose)
│   └── 사용자 정의 에이전트
│
├── 도구 설명 프롬프트
│   ├── 각 도구의 FunctionDeclaration
│   └── 상세 사용 가이드
│
└── 특수 목적 프롬프트
    ├── 편집 수정 (LLM Edit Fixer)
    ├── 루프 감지 (Loop Detection)
    ├── 요약 (Summarizer)
    └── Next Speaker 체커
```

### 프롬프트 유형

#### 1. 시스템 프롬프트 (System Prompts)
- **목적**: AI 에이전트의 전체 행동을 정의
- **위치**: `/home/user/qwen-code/packages/core/src/core/prompts.ts`
- **특징**:
  - 환경 변수로 커스터마이징 가능 (`QWEN_SYSTEM_MD`)
  - 사용자 메모리 자동 추가
  - 모델별 최적화 (qwen-coder, qwen-vl, general)

#### 2. 서브에이전트 프롬프트 (Subagent Prompts)
- **목적**: 특화된 작업을 수행하는 전문 에이전트
- **위치**:
  - 내장: `/home/user/qwen-code/packages/core/src/subagents/builtin-agents.ts`
  - 사용자 정의: `.qwen/agents/*.md`, `~/.qwen/agents/*.md`
- **특징**:
  - Markdown + YAML frontmatter 형식
  - 도구 제한 가능
  - 모델 설정 가능

#### 3. 도구 설명 프롬프트 (Tool Description Prompts)
- **목적**: AI가 도구를 올바르게 사용하도록 가이드
- **위치**: `/home/user/qwen-code/packages/core/src/tools/*.ts`
- **특징**:
  - FunctionDeclaration 형식
  - JSON Schema 매개변수 정의
  - 상세한 사용 예제 포함

#### 4. 특수 목적 프롬프트 (Specialized Prompts)
- **목적**: 특정 기능을 위한 전문 프롬프트
- **위치**: `/home/user/qwen-code/packages/core/src/utils/*.ts`, `services/*.ts`
- **특징**:
  - 단일 작업에 최적화
  - 구조화된 출력 (JSON Schema)
  - 캐싱 지원

### 프롬프트 파일 위치

#### 핵심 파일
```
packages/core/src/
├── core/
│   └── prompts.ts                  # 메인 프롬프트 (856줄)
├── prompts/
│   ├── mcp-prompts.ts             # MCP 프롬프트
│   └── prompt-registry.ts         # 프롬프트 레지스트리
├── subagents/
│   ├── builtin-agents.ts          # 내장 에이전트
│   ├── subagent-manager.ts        # 에이전트 관리자
│   └── types.ts                   # 에이전트 타입
├── tools/
│   ├── task.ts                    # Task 도구
│   ├── todoWrite.ts               # TodoWrite 도구
│   └── memoryTool.ts              # Memory 도구
├── utils/
│   ├── llm-edit-fixer.ts          # 편집 수정
│   ├── subagentGenerator.ts       # 에이전트 생성기
│   ├── summarizer.ts              # 요약
│   └── nextSpeakerChecker.ts      # Next Speaker
└── services/
    └── loopDetectionService.ts    # 루프 감지
```

#### 사용자 설정 파일
```
프로젝트 레벨:
  .qwen/
  ├── system.md                    # 커스텀 시스템 프롬프트
  ├── QWEN.md                      # 사용자 메모리
  └── agents/
      └── *.md                     # 프로젝트 에이전트

사용자 레벨:
  ~/.qwen/
  ├── system.md                    # 전역 시스템 프롬프트
  ├── QWEN.md                      # 전역 사용자 메모리
  └── agents/
      └── *.md                     # 전역 에이전트
```

### 프롬프트 로딩 순서

```
1. 환경 변수 확인 (QWEN_SYSTEM_MD)
   ↓
2. 시스템 프롬프트 로딩
   - 커스텀 (.qwen/system.md) 또는
   - 기본 (내장 프롬프트)
   ↓
3. 사용자 메모리 추가 (QWEN.md)
   ↓
4. 환경 컨텍스트 주입
   - 날짜, OS, 디렉토리 구조
   ↓
5. 서브에이전트 리마인더 추가 (해당 시)
   ↓
6. Plan 모드 리마인더 추가 (해당 시)
   ↓
7. 도구 선언 추가
   ↓
8. API 호출
```

### 프롬프트 커스터마이징

#### 환경 변수

```bash
# 커스텀 시스템 프롬프트 사용
export QWEN_SYSTEM_MD=".qwen/system.md"
# 또는 절대 경로
export QWEN_SYSTEM_MD="/path/to/custom/system.md"

# 시스템 프롬프트 비활성화
export QWEN_SYSTEM_MD="0"
# 또는
export QWEN_SYSTEM_MD="false"

# 도구 호출 스타일 지정
export QWEN_CODE_TOOL_CALL_STYLE="qwen-coder"
# 옵션: qwen-coder, qwen-vl, general

# 시스템 프롬프트 파일로 저장
export QWEN_WRITE_SYSTEM_MD="1"
```

#### 프로그래매틱 커스터마이징

```typescript
// 커스텀 시스템 프롬프트
const customPrompt = getCustomSystemPrompt(
  myCustomInstruction,
  userMemory
);

// 서브에이전트 프롬프트 생성
const agentPrompt = await subagentGenerator(
  "Create an agent that reviews Python code",
  config,
  abortSignal
);
```

## 프롬프트 작성 가이드라인

### 효과적인 프롬프트 작성 원칙

1. **구체성 (Specificity)**
   - 모호한 지시 대신 구체적인 행동 정의
   - 예제 포함하여 명확성 확보

2. **구조화 (Structure)**
   - 섹션 헤딩으로 논리적 분류
   - 번호 매긴 리스트로 순서 명확화

3. **제약 조건 (Constraints)**
   - 해야 할 일과 하지 말아야 할 일 명시
   - 엣지 케이스 처리 방법 정의

4. **예제 (Examples)**
   - 실제 사용 사례 제공
   - 좋은 예제와 나쁜 예제 대비

5. **검증 메커니즘 (Verification)**
   - 자가 검증 단계 포함
   - 품질 체크 기준 명시

### 프롬프트 템플릿 예시

```markdown
# 역할 정의
You are [expert role] specializing in [domain].

# 핵심 책임
Your primary responsibilities:
1. [responsibility 1]
2. [responsibility 2]
3. [responsibility 3]

# 운영 지침
## 해야 할 일
- [guideline 1]
- [guideline 2]

## 하지 말아야 할 일
- [constraint 1]
- [constraint 2]

# 워크플로우
1. [step 1]
2. [step 2]
3. [step 3]

# 예제
<example>
user: [user input]
assistant: [expected response]
<reasoning>
[why this response is correct]
</reasoning>
</example>

# 품질 기준
- [quality criterion 1]
- [quality criterion 2]
```

## 성능 최적화

### 프롬프트 캐싱

```typescript
// LLM Edit Fixer - LRU 캐시 (최대 50개)
const editCorrectionCache = new LruCache<string, SearchReplaceEdit>(50);

// Web Fetch - 15분 자동 정리 캐시
// 도구 설명 - 도구 레지스트리에 캐싱
```

### 토큰 최적화

- **압축 프롬프트**: 대화 기록을 XML 스냅샷으로 압축 (~70% 토큰 절감)
- **요약 프롬프트**: 긴 도구 출력을 요약하여 토큰 사용 최소화
- **조건부 주입**: 필요할 때만 리마인더 및 컨텍스트 추가

### 모델별 최적화

```typescript
// 모델에 따라 다른 도구 호출 예제 사용
if (model.includes('qwen-coder')) {
  // XML 스타일 도구 호출
  return qwenCoderToolCallExamples;
} else if (model.includes('qwen-vl')) {
  // JSON 스타일 도구 호출
  return qwenVlToolCallExamples;
} else {
  // 일반 도구 호출
  return generalToolCallExamples;
}
```

## 테스트 및 검증

### 프롬프트 테스트

```bash
# 단위 테스트
npm run test packages/core/src/core/prompts.test.ts

# 통합 테스트
npm run test:integration

# E2E 테스트
npm run test:e2e
```

### 프롬프트 품질 체크리스트

- [ ] 명확한 역할 정의
- [ ] 구체적인 지시사항
- [ ] 예제 포함
- [ ] 제약 조건 명시
- [ ] 에러 처리 가이드
- [ ] 검증 메커니즘
- [ ] 토큰 효율성
- [ ] 모델 호환성

## 참고 자료

- [프롬프트 엔지니어링 가이드](https://www.promptingguide.ai/)
- [Anthropic Prompt Engineering](https://docs.anthropic.com/claude/docs/prompt-engineering)
- [OpenAI Best Practices](https://platform.openai.com/docs/guides/prompt-engineering)

---

**다음 단계**: 각 문서를 참조하여 상세한 프롬프트 내용 및 사용법을 확인하세요.
