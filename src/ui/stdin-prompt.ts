/**
 * 공유 stdin 프롬프트 유틸리티.
 *
 * 문제: permission-manager.ts / ask-user.ts에서 새로운 readline.createInterface()를
 * 만들고 rl.close()를 호출하면, Windows에서 메인 REPL의 readline도 함께 닫힌다.
 *
 * 해결: REPL이 자신의 readline을 프롬프트 핸들러로 등록하고,
 * 다른 코드는 이 핸들러를 통해 사용자 입력을 받는다.
 */

type PromptHandler = (prompt: string) => Promise<string>;

let _handler: PromptHandler | null = null;

/**
 * REPL이 시작 시 자신의 readline 기반 프롬프트 핸들러를 등록한다.
 */
export function registerPromptHandler(handler: PromptHandler): void {
  _handler = handler;
}

/**
 * 프롬프트 핸들러 등록 해제 (REPL 종료 시).
 */
export function unregisterPromptHandler(): void {
  _handler = null;
}

/**
 * 사용자에게 프롬프트를 표시하고 응답을 받는다.
 * REPL의 readline을 재사용하므로 Windows에서 stdin이 닫히지 않는다.
 *
 * 핸들러가 등록되지 않은 경우 (단일 프롬프트 모드 등),
 * 폴백으로 별도의 readline을 생성하되 stdin을 닫지 않는다.
 */
export async function sharedPrompt(prompt: string): Promise<string> {
  if (_handler) {
    return _handler(prompt);
  }

  // 폴백: 핸들러 미등록 시 (비-REPL 모드)
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(prompt);
    return answer;
  } finally {
    // Windows에서 stdin이 닫히지 않도록 listeners만 제거
    rl.removeAllListeners();
    // close() 대신 수동 정리
    (rl as any).terminal = false;
    rl.close();
  }
}
