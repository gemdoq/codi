/**
 * 구조화된 파일 로깅 시스템.
 * JSON-line 형식으로 ~/.codi/logs/codi-<date>.log 에 기록한다.
 * stdout/stderr에는 출력하지 않아 REPL을 방해하지 않는다.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  error?: { message: string; stack?: string };
}

export class Logger {
  private static instance: Logger;

  private level: LogLevel;
  private logDir: string;
  private initialized = false;

  private constructor(logDir?: string) {
    const envLevel = process.env['CODI_LOG_LEVEL']?.toLowerCase();
    this.level = this.isValidLevel(envLevel) ? envLevel : 'info';
    this.logDir = logDir ?? path.join(os.homedir(), '.codi', 'logs');
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /** 테스트용: 커스텀 logDir로 새 인스턴스 생성 */
  static createForTest(logDir: string, level: LogLevel = 'debug'): Logger {
    const instance = new Logger(logDir);
    instance.level = level;
    return instance;
  }

  private isValidLevel(val: string | undefined): val is LogLevel {
    return val !== undefined && val in LOG_LEVEL_PRIORITY;
  }

  private ensureDir(): void {
    if (this.initialized) return;
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      this.initialized = true;
      this.rotateOldLogs();
    } catch {
      // 디렉토리 생성 실패 시 로깅을 조용히 비활성화
    }
  }

  /** 7일 이상 된 로그 파일 삭제 */
  private rotateOldLogs(): void {
    try {
      const files = fs.readdirSync(this.logDir);
      const now = Date.now();
      const maxAge = 7 * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.startsWith('codi-') || !file.endsWith('.log')) continue;
        const filePath = path.join(this.logDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // 개별 파일 처리 실패 무시
        }
      }
    } catch {
      // 로테이션 실패 무시
    }
  }

  private getLogFilePath(): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return path.join(this.logDir, `codi-${date}.log`);
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>, error?: Error): void {
    if (!this.shouldLog(level)) return;

    this.ensureDir();
    if (!this.initialized) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };

    if (context && Object.keys(context).length > 0) {
      entry.context = context;
    }

    if (error) {
      entry.error = {
        message: error.message,
        stack: error.stack,
      };
    }

    try {
      fs.appendFileSync(this.getLogFilePath(), JSON.stringify(entry) + '\n');
    } catch {
      // 쓰기 실패 시 조용히 무시
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>, error?: Error): void {
    this.write('error', message, context, error);
  }
}

export const logger = Logger.getInstance();
