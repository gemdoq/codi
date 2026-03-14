import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from '../../src/utils/logger.js';

describe('logger', () => {
  describe('로그 레벨 우선순위', () => {
    const LOG_LEVEL_PRIORITY: Record<string, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };

    function shouldLog(current: string, threshold: string): boolean {
      return LOG_LEVEL_PRIORITY[current]! >= LOG_LEVEL_PRIORITY[threshold]!;
    }

    it('debug 레벨은 debug 임계값에서 로그된다', () => {
      expect(shouldLog('debug', 'debug')).toBe(true);
    });

    it('debug 레벨은 info 임계값에서 로그되지 않는다', () => {
      expect(shouldLog('debug', 'info')).toBe(false);
    });

    it('info 레벨은 info 임계값에서 로그된다', () => {
      expect(shouldLog('info', 'info')).toBe(true);
    });

    it('warn 레벨은 info 임계값에서 로그된다', () => {
      expect(shouldLog('warn', 'info')).toBe(true);
    });

    it('error 레벨은 모든 임계값에서 로그된다', () => {
      expect(shouldLog('error', 'debug')).toBe(true);
      expect(shouldLog('error', 'info')).toBe(true);
      expect(shouldLog('error', 'warn')).toBe(true);
      expect(shouldLog('error', 'error')).toBe(true);
    });

    it('info 레벨은 warn 임계값에서 로그되지 않는다', () => {
      expect(shouldLog('info', 'warn')).toBe(false);
    });

    it('info 레벨은 error 임계값에서 로그되지 않는다', () => {
      expect(shouldLog('info', 'error')).toBe(false);
    });
  });

  describe('실제 로그 쓰기', () => {
    let tempLogDir: string;

    beforeEach(() => {
      tempLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codi-logger-test-'));
    });

    afterEach(() => {
      if (fs.existsSync(tempLogDir)) {
        fs.rmSync(tempLogDir, { recursive: true, force: true });
      }
    });

    it('파일에 JSON-line을 기록한다', () => {
      const log = Logger.createForTest(tempLogDir, 'debug');
      log.info('test message', { key: 'value' });

      const files = fs.readdirSync(tempLogDir).filter((f) => f.endsWith('.log'));
      expect(files.length).toBe(1);

      const content = fs.readFileSync(path.join(tempLogDir, files[0]!), 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed).toHaveProperty('level', 'info');
      expect(parsed).toHaveProperty('message', 'test message');
      expect(parsed.context).toEqual({ key: 'value' });
    });

    it('올바른 JSON-line 형식을 생성한다', () => {
      const log = Logger.createForTest(tempLogDir, 'debug');
      log.info('formatted entry');

      const files = fs.readdirSync(tempLogDir).filter((f) => f.endsWith('.log'));
      const content = fs.readFileSync(path.join(tempLogDir, files[0]!), 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('level');
      expect(parsed).toHaveProperty('message');
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });

    it('context가 비어있으면 포함하지 않는다', () => {
      const log = Logger.createForTest(tempLogDir, 'debug');
      log.info('no context');

      const files = fs.readdirSync(tempLogDir).filter((f) => f.endsWith('.log'));
      const content = fs.readFileSync(path.join(tempLogDir, files[0]!), 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed).not.toHaveProperty('context');
    });

    it('레벨 필터링이 작동한다', () => {
      const log = Logger.createForTest(tempLogDir, 'warn');
      log.debug('should skip');
      log.info('should skip too');
      log.warn('should appear');
      log.error('should also appear');

      const files = fs.readdirSync(tempLogDir).filter((f) => f.endsWith('.log'));
      const content = fs.readFileSync(path.join(tempLogDir, files[0]!), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]!).level).toBe('warn');
      expect(JSON.parse(lines[1]!).level).toBe('error');
    });

    it('Error 객체를 포함하면 error 필드를 기록한다', () => {
      const log = Logger.createForTest(tempLogDir, 'debug');
      log.error('something failed', {}, new Error('test error'));

      const files = fs.readdirSync(tempLogDir).filter((f) => f.endsWith('.log'));
      const content = fs.readFileSync(path.join(tempLogDir, files[0]!), 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.error).toBeDefined();
      expect(parsed.error.message).toBe('test error');
      expect(parsed.error.stack).toBeDefined();
    });
  });

  describe('싱글톤', () => {
    it('logger 싱글톤이 존재하고 메서드를 가진다', async () => {
      const { logger } = await import('../../src/utils/logger.js');
      expect(logger).toBeDefined();
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('logger 메서드 호출 시 예외를 던지지 않는다', async () => {
      const { logger } = await import('../../src/utils/logger.js');
      expect(() => logger.debug('test debug')).not.toThrow();
      expect(() => logger.info('test info')).not.toThrow();
      expect(() => logger.warn('test warn')).not.toThrow();
      expect(() => logger.error('test error')).not.toThrow();
    });
  });
});
