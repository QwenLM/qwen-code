# Qwen Code 프로젝트 문서

Qwen Code 프로젝트의 전체 구조와 아키텍처를 설명하는 문서입니다.

## 문서 구조

이 문서는 코드베이스를 체계적으로 이해할 수 있도록 다음과 같이 구성되어 있습니다:

1. **[프로젝트 개요](01-project-overview.md)**
   - 프로젝트 목적 및 주요 기능
   - 핵심 특징 및 차별화 요소

2. **[기술 스택](02-technology-stack.md)**
   - 사용된 프로그래밍 언어
   - 주요 프레임워크 및 라이브러리
   - 개발 도구 및 빌드 시스템

3. **[디렉토리 구조](03-directory-structure.md)**
   - 전체 프로젝트 디렉토리 구조
   - 각 디렉토리의 역할 및 목적

4. **[아키텍처](04-architecture.md)**
   - 시스템 아키텍처 설계
   - 주요 디자인 패턴
   - 컴포넌트 간 관계

5. **[주요 컴포넌트](05-key-components.md)**
   - CLI 패키지 상세
   - Core 패키지 상세
   - VS Code 확장 프로그램

6. **[개발 가이드](06-development-guide.md)**
   - 개발 환경 설정
   - 빌드 및 테스트 방법
   - 개발 워크플로우

## 빠른 시작

```bash
# 의존성 설치
npm install

# 빌드
npm run build

# 실행
npm start

# 테스트
npm run test
```

## 프로젝트 개요

**Qwen Code**는 개발자를 위한 AI 기반 CLI 도구로, 터미널에서 직접 AI 모델과 상호작용하며 코드 작업을 수행할 수 있게 해줍니다.

주요 기능:
- AI 기반 코드 분석 및 리팩토링
- 파일 시스템 작업 자동화
- Shell 명령 실행 지원
- 대규모 코드베이스 이해 및 분석
- OpenAI API 호환성

## 기술 스택 요약

- **언어**: TypeScript (100% 소스 코드)
- **런타임**: Node.js ≥20.0.0
- **UI**: React + Ink (CLI UI)
- **빌드**: esbuild
- **테스트**: Vitest 3.x
- **AI**: Google Gemini API, OpenAI SDK

## 프로젝트 구조 요약

```
qwen-code/
├── packages/
│   ├── cli/              # CLI 프론트엔드
│   ├── core/             # 코어 백엔드
│   ├── vscode-ide-companion/  # VS Code 확장
│   └── test-utils/       # 테스트 유틸리티
├── docs/                 # 공식 문서
├── integration-tests/    # 통합 테스트
├── scripts/             # 빌드 스크립트
└── .github/             # GitHub Actions
```

## 참고 자료

- [공식 문서](/home/user/qwen-code/docs/)
- [GitHub Repository](https://github.com/QwenLM/qwen-code)
- [이슈 트래커](https://github.com/QwenLM/qwen-code/issues)

---

**마지막 업데이트**: 2025-11-09
**버전**: 0.2.0
