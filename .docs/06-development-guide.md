# 개발 가이드

## 개발 환경 설정

### 사전 요구사항

#### Node.js
```bash
# 개발 권장 버전
node --version  # v20.19.0

# 최소 요구 버전: ≥20.0.0
```

#### 시스템 도구
```bash
# Git
git --version  # ≥2.0.0

# npm
npm --version  # ≥9.0.0

# 선택사항: Docker 또는 Podman (샌드박싱)
docker --version
# 또는
podman --version
```

### 프로젝트 클론 및 설치

```bash
# 1. 저장소 클론
git clone https://github.com/QwenLM/qwen-code.git
cd qwen-code

# 2. 의존성 설치 (모든 워크스페이스)
npm install

# 3. 빌드
npm run build

# 4. 실행 확인
npm start
```

### 디렉토리 구조 확인

```bash
# 설치 후 디렉토리 구조
qwen-code/
├── node_modules/           # 의존성 (설치 후)
├── packages/
│   ├── cli/
│   │   ├── dist/           # 빌드 출력 (빌드 후)
│   │   └── node_modules/   # 패키지별 의존성
│   ├── core/
│   │   └── dist/
│   └── ...
└── dist/                   # 번들 출력 (빌드 후)
    └── cli.js
```

## 빌드 시스템

### 빌드 명령어

#### 전체 빌드
```bash
# 모든 패키지 빌드
npm run build

# packages/cli, packages/core 등 순차 빌드
```

#### 패키지별 빌드
```bash
# CLI만 빌드
npm run build -w packages/cli

# Core만 빌드
npm run build -w packages/core

# VS Code 확장 빌드
npm run build:vscode
```

#### 프로덕션 번들
```bash
# esbuild로 단일 파일 번들
npm run bundle

# 출력: dist/cli.js
```

#### 샌드박스 이미지 빌드
```bash
# Docker 이미지 빌드
npm run build:sandbox:docker

# Podman 이미지 빌드
npm run build:sandbox:podman

# 모두 빌드
npm run build:all
```

### 빌드 과정 상세

#### 1. TypeScript 컴파일
```bash
# 각 패키지의 tsconfig.json 사용
tsc --build

# 출력: packages/*/dist/**/*.js
```

**설정**:
- `tsconfig.json` (루트)
- `packages/cli/tsconfig.json`
- `packages/core/tsconfig.json`

#### 2. esbuild 번들링
```bash
# esbuild.config.js 실행
node esbuild.config.js

# 작업:
# - 모든 TypeScript 파일 번들
# - 네이티브 모듈 외부화
# - __dirname, __filename 심 주입
# - Minification (프로덕션)
```

**설정**: `/home/user/qwen-code/esbuild.config.js`

```javascript
{
  entryPoints: ['packages/cli/index.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: ['@lydell/node-pty', 'node-pty'],
  // ... 기타 설정
}
```

#### 3. 에셋 복사
```bash
# scripts/copy_bundle_assets.js 실행
node scripts/copy_bundle_assets.js

# 복사 대상:
# - 정적 파일
# - 설정 템플릿
# - 네이티브 바이너리
```

### 클린 빌드

```bash
# 모든 빌드 출력 제거
npm run clean

# 제거 대상:
# - dist/
# - packages/*/dist/
# - *.tsbuildinfo
```

## 개발 워크플로우

### 개발 모드 실행

```bash
# 소스에서 직접 실행 (tsx 사용)
npm start

# 또는
npm run dev

# 빌드 후 실행
npm run build-and-start
```

### 디버깅

#### VS Code 디버그 설정

**`.vscode/launch.json`**:
```json
{
  "configurations": [
    {
      "name": "Debug Qwen Code",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["start"],
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Attach to Process",
      "type": "node",
      "request": "attach",
      "port": 9229
    }
  ]
}
```

**사용법**:
1. VS Code에서 F5 누르기
2. 또는 디버그 패널에서 "Debug Qwen Code" 선택

#### 명령줄 디버깅

```bash
# Node.js 인스펙터 활성화
npm run debug

# 또는
node --inspect dist/cli.js

# Chrome DevTools 연결:
# chrome://inspect
```

#### React DevTools (Ink UI)

```bash
# 개발 모드로 실행
DEV=true npm start

# 다른 터미널에서 React DevTools 실행
npx react-devtools@4.28.5

# Ink 버전 4와 호환되는 구버전 사용
```

### 코드 품질 도구

#### Linting (ESLint)

```bash
# 전체 프로젝트 린트
npm run lint

# 자동 수정
npm run lint:fix

# 특정 파일 린트
npx eslint packages/cli/src/gemini.tsx
```

**설정**: `/home/user/qwen-code/eslint.config.js`

**주요 규칙**:
- TypeScript ESLint 권장 규칙
- React Hooks 규칙
- Import 정렬 및 제한
- 상대 경로 패키지 임포트 금지

#### 코드 포맷팅 (Prettier)

```bash
# 전체 프로젝트 포맷팅
npm run format

# 포맷팅 확인만
npm run format:check
```

**설정**: `/home/user/qwen-code/.prettierrc.json`

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "printWidth": 100
}
```

#### 타입 체킹

```bash
# TypeScript 타입 체크
npm run typecheck

# 또는 watch 모드
tsc --watch
```

### Git Hooks

#### Pre-commit Hook

**Husky + lint-staged** 사용

```bash
# .husky/pre-commit
npm run pre-commit
```

**`lint-staged` 설정** (`package.json`):
```json
{
  "lint-staged": {
    "*.{ts,tsx}": [
      "eslint --fix",
      "prettier --write"
    ],
    "*.{json,md}": [
      "prettier --write"
    ]
  }
}
```

**동작**:
1. Staged 파일만 린트
2. 자동으로 포맷팅 적용
3. 수정된 파일 다시 stage

#### Pre-flight 체크

```bash
# 커밋/푸시 전 전체 검증
npm run preflight

# 실행 내용:
# 1. npm run clean
# 2. npm run format
# 3. npm run lint
# 4. npm run build
# 5. npm run typecheck
# 6. npm run test
```

## 테스트

### 테스트 실행

#### 전체 테스트
```bash
# 모든 테스트 실행
npm run test

# Watch 모드
npm run test:watch

# UI 모드 (Vitest)
npm run test:ui
```

#### CI 테스트
```bash
# 커버리지 포함
npm run test:ci

# 출력: coverage/ 디렉토리
```

#### 패키지별 테스트
```bash
# CLI 테스트만
npm run test -w packages/cli

# Core 테스트만
npm run test -w packages/core
```

#### 통합 테스트
```bash
# 모든 통합 테스트
npm run test:integration:all

# 샌드박스 없이
npm run test:integration:sandbox:none

# Docker 샌드박스
npm run test:integration:sandbox:docker

# Podman 샌드박스
npm run test:integration:sandbox:podman
```

#### E2E 테스트
```bash
npm run test:e2e
```

#### 터미널 벤치마크
```bash
# 성능 테스트
npm run test:terminal-bench

# Qwen 전용
npm run test:terminal-bench:qwen
```

### 테스트 작성

#### 단위 테스트 예시

```typescript
// packages/core/src/tools/read-file.test.ts
import { describe, it, expect } from 'vitest';
import { ReadFileTool } from './read-file';

describe('ReadFileTool', () => {
  it('should read text file', async () => {
    const tool = new ReadFileTool();
    const result = await tool.execute({
      file_path: '/path/to/file.txt'
    });

    expect(result.content).toBeDefined();
    expect(result.lineCount).toBeGreaterThan(0);
  });

  it('should respect line offset and limit', async () => {
    const tool = new ReadFileTool();
    const result = await tool.execute({
      file_path: '/path/to/file.txt',
      offset: 10,
      limit: 20
    });

    expect(result.lineCount).toBeLessThanOrEqual(20);
  });
});
```

#### 통합 테스트 예시

```typescript
// integration-tests/file-system.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GeminiClient } from '@qwen-code/qwen-code-core';
import { createTestClient } from './test-helper';

describe('File System Integration', () => {
  let client: GeminiClient;

  beforeEach(() => {
    client = createTestClient();
  });

  afterEach(async () => {
    await client.cleanup();
  });

  it('should read, edit, and write files', async () => {
    // 파일 읽기
    await client.sendMessage('Read package.json');

    // 편집
    await client.sendMessage('Update version to 1.0.0');

    // 검증
    const content = await fs.readFile('package.json', 'utf-8');
    expect(content).toContain('"version": "1.0.0"');
  });
});
```

### 테스트 커버리지

```bash
# 커버리지 리포트 생성
npm run test:ci

# HTML 리포트 열기
open coverage/index.html
```

**커버리지 목표**:
- Statements: >80%
- Branches: >75%
- Functions: >80%
- Lines: >80%

## 프로젝트별 작업

### 새 도구 추가

#### 1. 도구 파일 생성
```typescript
// packages/core/src/tools/my-tool.ts
import { ToolInvocation } from '../types';

export class MyTool implements ToolInvocation {
  name = 'MyTool';

  async execute(params: {
    // 매개변수 정의
    input: string;
  }): Promise<{
    // 결과 정의
    output: string;
  }> {
    // 구현
    return { output: params.input.toUpperCase() };
  }

  requiresConfirmation(params: unknown): boolean {
    // 확인 필요 여부
    return false;
  }
}
```

#### 2. 도구 등록
```typescript
// packages/core/src/core/coreToolScheduler.ts
import { MyTool } from '../tools/my-tool';

// ToolRegistry에 추가
toolRegistry.register(new MyTool());
```

#### 3. 테스트 작성
```typescript
// packages/core/src/tools/my-tool.test.ts
import { describe, it, expect } from 'vitest';
import { MyTool } from './my-tool';

describe('MyTool', () => {
  it('should work correctly', async () => {
    const tool = new MyTool();
    const result = await tool.execute({ input: 'hello' });
    expect(result.output).toBe('HELLO');
  });
});
```

#### 4. 문서 작성
```markdown
<!-- docs/tools/my-tool.md -->
# MyTool

## 설명
입력 문자열을 대문자로 변환합니다.

## 매개변수
- `input` (string): 입력 문자열

## 반환값
- `output` (string): 대문자 문자열

## 예시
\`\`\`typescript
const result = await myTool.execute({ input: 'hello' });
// { output: 'HELLO' }
\`\`\`
```

### 새 서브에이전트 추가

#### 1. 설정 파일 생성
```typescript
// packages/core/src/subagents/built-in/my-agent/config.ts
import { SubagentConfig } from '../../types';

export const myAgentConfig: SubagentConfig = {
  name: 'my-agent',
  description: '전문화된 작업 수행',
  systemPrompt: `
당신은 특정 작업의 전문가입니다.
다음 작업을 수행하세요:
1. ...
2. ...
  `,
  tools: ['Read', 'Write', 'Grep'],
  model: 'sonnet'
};
```

#### 2. 레지스트리에 등록
```typescript
// packages/core/src/subagents/registry.ts
import { myAgentConfig } from './built-in/my-agent/config';

subagentRegistry.register(myAgentConfig);
```

### 새 슬래시 커맨드 추가

#### 프로젝트별 커맨드
```bash
# .qwen/commands/ 디렉토리 생성
mkdir -p .qwen/commands

# 커맨드 파일 생성
cat > .qwen/commands/review.md << 'EOF'
---
description: 코드 리뷰 수행
---

다음 파일들을 코드 리뷰해주세요:
- 코드 품질
- 잠재적 버그
- 성능 이슈
- 보안 문제

개선 제안을 구체적으로 제시해주세요.
EOF
```

**사용**:
```bash
$ qwen
> /review src/components/UserForm.tsx
```

#### 전역 커맨드
```bash
# ~/.qwen/commands/ 디렉토리
mkdir -p ~/.qwen/commands

# 전역 커맨드 추가
cat > ~/.qwen/commands/explain.md << 'EOF'
---
description: 코드 설명
---

선택한 코드를 자세히 설명해주세요.
EOF
```

## 의존성 관리

### 의존성 추가

```bash
# 루트 의존성 추가
npm install -D <package> -w root

# CLI 패키지 의존성
npm install <package> -w packages/cli

# Core 패키지 의존성
npm install <package> -w packages/core
```

### 의존성 업데이트

```bash
# 모든 의존성 확인
npm outdated

# 특정 패키지 업데이트
npm update <package>

# 메이저 버전 업그레이드
npm install <package>@latest
```

### 의존성 정리

```bash
# 사용하지 않는 의존성 제거
npm prune

# package-lock.json 재생성
rm package-lock.json
npm install
```

## 배포

### 릴리스 준비

```bash
# 1. 버전 업데이트
npm version patch  # 0.2.0 → 0.2.1
# 또는
npm version minor  # 0.2.0 → 0.3.0
# 또는
npm version major  # 0.2.0 → 1.0.0

# 2. Pre-flight 체크
npm run preflight

# 3. Git 태그 생성
git tag v0.2.1
git push origin v0.2.1

# 4. GitHub Release 생성
gh release create v0.2.1 --generate-notes
```

### npm 패키지 배포

```bash
# 1. 로그인
npm login

# 2. 빌드
npm run bundle

# 3. 배포
npm publish

# 또는 특정 태그로
npm publish --tag beta
```

### Docker 이미지 배포

```bash
# 1. 이미지 빌드
npm run build:sandbox:docker

# 2. 태그
docker tag qwen-code:latest ghcr.io/qwenlm/qwen-code:0.2.0

# 3. 푸시
docker push ghcr.io/qwenlm/qwen-code:0.2.0
```

## 문제 해결

### 빌드 실패

```bash
# 1. 클린 후 재빌드
npm run clean
npm install
npm run build

# 2. 캐시 삭제
rm -rf node_modules package-lock.json
npm install
```

### 테스트 실패

```bash
# 1. 의존성 확인
npm install

# 2. 빌드 확인
npm run build

# 3. 격리된 테스트 실행
npm run test -- --reporter=verbose
```

### TypeScript 에러

```bash
# 1. 타입 정의 재생성
npm run build

# 2. IDE 재시작
# VS Code: Cmd+Shift+P → "Reload Window"

# 3. TypeScript 서버 재시작
# VS Code: Cmd+Shift+P → "TypeScript: Restart TS Server"
```

## 개발 팁

### VS Code 확장 프로그램

**권장 확장**:
- ESLint
- Prettier
- TypeScript and JavaScript Language Features
- Vitest

**`.vscode/extensions.json`**:
```json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "vitest.explorer"
  ]
}
```

### 빠른 반복 개발

```bash
# Watch 모드로 빌드 + 테스트
npm run build -- --watch &
npm run test:watch
```

### 코드 탐색

```bash
# 특정 심볼 검색
npm run grep "GeminiClient"

# 파일 패턴 검색
npm run glob "**/*.test.ts"
```

## 기여 가이드

### Pull Request 생성

1. **브랜치 생성**
   ```bash
   git checkout -b feature/my-feature
   ```

2. **변경 사항 커밋**
   ```bash
   git add .
   git commit -m "feat: add new feature"
   ```

3. **Pre-flight 체크**
   ```bash
   npm run preflight
   ```

4. **푸시**
   ```bash
   git push origin feature/my-feature
   ```

5. **PR 생성**
   ```bash
   gh pr create --title "Add new feature" --body "Description"
   ```

### 커밋 메시지 규칙

**Conventional Commits** 사용:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**타입**:
- `feat`: 새 기능
- `fix`: 버그 수정
- `docs`: 문서 변경
- `style`: 코드 포맷팅
- `refactor`: 리팩토링
- `test`: 테스트 추가
- `chore`: 빌드/도구 변경

**예시**:
```
feat(tools): add MyTool for string manipulation

- Implement execute method
- Add parameter validation
- Write unit tests

Closes #123
```

## 다음 단계

- [프로젝트 개요](01-project-overview.md) - 프로젝트 이해
- [아키텍처](04-architecture.md) - 시스템 설계 파악
- [주요 컴포넌트](05-key-components.md) - 컴포넌트 상세 학습
