/**
 * 커맨드 샌드박싱: bash 도구 실행 전 위험한 명령어 패턴을 감지하여 차단/경고한다.
 * --yolo 모드에서는 검증을 건너뛴다.
 */

import { logger } from '../utils/logger.js';

export type ValidationLevel = 'blocked' | 'warned' | 'allowed';

export interface ValidationResult {
  allowed: boolean;
  level: ValidationLevel;
  reason?: string;
}

interface CommandPattern {
  pattern: RegExp;
  reason: string;
}

// 항상 차단하는 패턴 (Unix + PowerShell 변형 포함)
const BLOCKED_PATTERNS: CommandPattern[] = [
  // 광범위 삭제
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|(-[a-zA-Z]*f[a-zA-Z]*r))\s+[/~*]/, reason: '광범위 삭제 명령어(rm -rf /, ~, *)가 감지되었습니다.' },
  { pattern: /\brm\s+-rf\s*$/, reason: '대상 없는 rm -rf가 감지되었습니다.' },
  { pattern: /\bRemove-Item\s+.*-Recurse.*[/\\]\s*$/, reason: 'PowerShell 광범위 삭제가 감지되었습니다.' },
  { pattern: /\bRemove-Item\s+.*-Recurse.*(\*|~|[A-Z]:\\)/, reason: 'PowerShell 광범위 삭제가 감지되었습니다.' },

  // 디스크 연산
  { pattern: /\bmkfs\b/, reason: '파일시스템 포맷(mkfs) 명령어가 감지되었습니다.' },
  { pattern: /\bformat\s+[A-Z]:/i, reason: '디스크 포맷(format) 명령어가 감지되었습니다.' },
  { pattern: /\bdd\s+if=/, reason: 'dd 디스크 쓰기 명령어가 감지되었습니다.' },

  // 광범위 권한 변경
  { pattern: /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?777\b/, reason: '광범위 권한 변경(chmod 777)이 감지되었습니다.' },
  { pattern: /\bchown\s+-[a-zA-Z]*R/, reason: '재귀적 소유자 변경(chown -R)이 감지되었습니다.' },

  // 포크 폭탄
  { pattern: /:\(\)\s*\{.*\|.*&\s*\}\s*;?\s*:/, reason: '포크 폭탄이 감지되었습니다.' },
  { pattern: /\bwhile\s+true\s*;\s*do\s+fork/, reason: '포크 폭탄 패턴이 감지되었습니다.' },

  // 디바이스 리디렉션
  { pattern: />\s*\/dev\/sd[a-z]/, reason: '디바이스 직접 쓰기가 감지되었습니다.' },
  { pattern: />\s*\/dev\/nvme/, reason: '디바이스 직접 쓰기가 감지되었습니다.' },
  { pattern: />\s*\\\\\.\\PhysicalDrive/, reason: 'Windows 디바이스 직접 쓰기가 감지되었습니다.' },

  // 인터넷에서 받아서 바로 실행
  { pattern: /\bcurl\b.*\|\s*(sh|bash|zsh|powershell|pwsh)\b/, reason: '원격 스크립트 파이프 실행(curl | sh)이 감지되었습니다.' },
  { pattern: /\bwget\b.*\|\s*(sh|bash|zsh|powershell|pwsh)\b/, reason: '원격 스크립트 파이프 실행(wget | sh)이 감지되었습니다.' },
  { pattern: /\bInvoke-WebRequest\b.*\|\s*Invoke-Expression\b/, reason: 'PowerShell 원격 스크립트 실행이 감지되었습니다.' },
  { pattern: /\biwr\b.*\|\s*iex\b/, reason: 'PowerShell 원격 스크립트 실행(iwr | iex)이 감지되었습니다.' },
  { pattern: /\bIEX\s*\(\s*(New-Object|Invoke-WebRequest|iwr)\b/, reason: 'PowerShell 원격 스크립트 실행이 감지되었습니다.' },

  // 시스템 종료/재부팅
  { pattern: /\bshutdown\b/, reason: '시스템 종료(shutdown) 명령어가 감지되었습니다.' },
  { pattern: /\breboot\b/, reason: '시스템 재부팅(reboot) 명령어가 감지되었습니다.' },
  { pattern: /\bhalt\b/, reason: '시스템 중지(halt) 명령어가 감지되었습니다.' },
  { pattern: /\bStop-Computer\b/, reason: 'PowerShell 시스템 종료가 감지되었습니다.' },
  { pattern: /\bRestart-Computer\b/, reason: 'PowerShell 시스템 재부팅이 감지되었습니다.' },

  // 프로세스 종료
  { pattern: /\bkill\s+-9\s+1\b/, reason: 'init 프로세스 종료(kill -9 1)가 감지되었습니다.' },
  { pattern: /\bkillall\b/, reason: '전체 프로세스 종료(killall)가 감지되었습니다.' },
  { pattern: /\bStop-Process\s+.*-Id\s+1\b/, reason: 'PowerShell init 프로세스 종료가 감지되었습니다.' },
];

// 경고하지만 허용하는 패턴
const WARNED_PATTERNS: CommandPattern[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|(-[a-zA-Z]*f[a-zA-Z]*r))\s+/, reason: 'rm -rf 명령어가 감지되었습니다. 경로를 확인하세요.' },
  { pattern: /\bRemove-Item\s+.*-Recurse/, reason: 'PowerShell 재귀 삭제가 감지되었습니다. 경로를 확인하세요.' },
  { pattern: /\bsudo\b/, reason: 'sudo 명령어가 감지되었습니다.' },
  { pattern: /\bRunAs\b/i, reason: 'Windows 관리자 권한 실행이 감지되었습니다.' },
  { pattern: /\bnpm\s+publish\b/, reason: 'npm 패키지 배포(npm publish)가 감지되었습니다.' },
  { pattern: /\bdocker\s+push\b/, reason: 'Docker 이미지 푸시(docker push)가 감지되었습니다.' },
  { pattern: /\bgit\s+push\b/, reason: 'git push가 감지되었습니다.' },
];

/**
 * 명령어를 검증하여 차단/경고/허용 여부를 반환한다.
 * --yolo 모드에서는 이 함수를 호출하지 않고 바로 허용해야 한다.
 */
export function validateCommand(command: string): ValidationResult {
  const trimmed = command.trim();

  if (!trimmed) {
    return { allowed: true, level: 'allowed' };
  }

  // 차단 패턴 우선 검사
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      logger.warn('명령어 차단됨', { command: trimmed, reason });
      return { allowed: false, level: 'blocked', reason };
    }
  }

  // 경고 패턴 검사
  for (const { pattern, reason } of WARNED_PATTERNS) {
    if (pattern.test(trimmed)) {
      logger.info('명령어 경고', { command: trimmed, reason });
      return { allowed: true, level: 'warned', reason };
    }
  }

  return { allowed: true, level: 'allowed' };
}
