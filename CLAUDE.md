# Codi 프로젝트

AI 코딩 에이전트 CLI 도구. 터미널에서 자연어로 코드 읽기/쓰기/검색/실행을 수행한다.

## 기술 스택

- TypeScript (ESM), Node.js 20+
- 빌드: tsup, 테스트: vitest
- 의존성: Anthropic SDK, OpenAI SDK, Ollama, MCP SDK, chalk, zod 등

## 주요 디렉토리 구조

```
src/
  cli.ts              — 진입점
  repl.ts             — REPL 루프
  config/
    slash-commands.ts  — 슬래시 커맨드 정의 (핵심)
    config.ts          — 설정 관리
    permissions.ts     — 권한 규칙
  agent/
    conversation.ts    — 대화 관리
    session.ts         — 세션 저장/로드
    memory.ts          — 자동 메모리
    mode-manager.ts    — plan/execute 모드
    token-tracker.ts   — 토큰 사용량 추적
    context-compressor.ts — 대화 압축
    checkpoint.ts      — 체크포인트(되감기)
  llm/
    provider.ts        — LLM 프로바이더 인터페이스
  tools/
    task-tools.ts      — 태스크 관리
    executor.ts        — 도구 실행기
    registry.ts        — 도구 레지스트리
  ui/
    renderer.js        — diff 등 UI 렌더링
    status-line.ts     — 상태바
  mcp/
    mcp-manager.ts     — MCP 서버 관리
tests/
  config/
    permissions.test.ts
    slash-commands.test.ts
  agent/
    conversation.test.ts
    mode-manager.test.ts
    token-tracker.test.ts
  tools/
    tool.test.ts
    registry.test.ts
    executor.test.ts
```

## 슬래시 커맨드 패턴

`src/config/slash-commands.ts`의 `createBuiltinCommands()` 배열에 추가한다.

- AI가 처리해야 하는 커맨드: 프롬프트를 대화에 주입하고 `return false`
- 직접 처리하는 커맨드: 결과 출력 후 `return true`

### 현재 커스텀 추가 커맨드 (4개)

| 커맨드 | 유형 | 설명 |
|--------|------|------|
| `/commit` | AI 처리 | git diff → 커밋 메시지 생성 및 커밋 |
| `/review` | AI 처리 | git diff → 코드 리뷰 (보안, 버그, 성능, 스타일) |
| `/search <키워드>` | 직접 출력 | ~/.codi/sessions/*.jsonl 과거 대화 검색 |
| `/fix <명령어>` | 하이브리드 | 명령어 실행, 실패 시 AI가 에러 수정 |

## 개발 명령어

```bash
npm run dev          # tsx로 개발 실행
npm run typecheck    # 타입 검사
npm test -- --run    # 테스트 실행 (현재 104개)
npm run build        # tsup 빌드
```

## 다음 할 일

- (여기에 작업 계획 추가)
