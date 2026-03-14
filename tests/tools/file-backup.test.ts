import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// file-backup 모듈은 모듈 레벨 상태를 갖기 때문에 동적 import로 격리
// 대신 직접 함수를 테스트한다
import {
  backupFile,
  restoreFile,
  undoLast,
  getBackupHistory,
  cleanupBackups,
} from '../../src/tools/file-backup.js';

describe('file-backup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codi-backup-test-'));
    // 이전 테스트의 히스토리 정리
    cleanupBackups();
  });

  afterEach(() => {
    cleanupBackups();
    // 테스트 임시 디렉토리 정리
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('backupFile', () => {
    it('기존 파일의 백업을 생성한다', () => {
      const filePath = path.join(tempDir, 'test.txt');
      fs.writeFileSync(filePath, 'original content', 'utf-8');

      const backupPath = backupFile(filePath);

      expect(backupPath).toBeTruthy();
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.readFileSync(backupPath, 'utf-8')).toBe('original content');
    });

    it('존재하지 않는 파일도 백업 엔트리를 생성한다 (wasNew)', () => {
      const filePath = path.join(tempDir, 'nonexistent.txt');

      const backupPath = backupFile(filePath);

      expect(backupPath).toBeTruthy();
      const history = getBackupHistory();
      expect(history.length).toBe(1);
      expect(history[0]!.wasNew).toBe(true);
    });

    it('백업 히스토리에 엔트리를 추가한다', () => {
      const filePath = path.join(tempDir, 'test.txt');
      fs.writeFileSync(filePath, 'content', 'utf-8');

      expect(getBackupHistory().length).toBe(0);
      backupFile(filePath);
      expect(getBackupHistory().length).toBe(1);
    });

    it('여러 파일을 백업할 수 있다', () => {
      const file1 = path.join(tempDir, 'file1.txt');
      const file2 = path.join(tempDir, 'file2.txt');
      fs.writeFileSync(file1, 'content1', 'utf-8');
      fs.writeFileSync(file2, 'content2', 'utf-8');

      backupFile(file1);
      backupFile(file2);

      expect(getBackupHistory().length).toBe(2);
    });
  });

  describe('undoLast', () => {
    it('가장 최근 백업을 복원한다', () => {
      const filePath = path.join(tempDir, 'test.txt');
      fs.writeFileSync(filePath, 'original', 'utf-8');

      backupFile(filePath);
      fs.writeFileSync(filePath, 'modified', 'utf-8');

      const entry = undoLast();

      expect(entry).not.toBeNull();
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('original');
    });

    it('새 파일(wasNew=true) 복원 시 파일을 삭제한다', () => {
      const filePath = path.join(tempDir, 'new-file.txt');

      backupFile(filePath);
      // 새 파일이 생성된 상황 시뮬레이션
      fs.writeFileSync(filePath, 'new content', 'utf-8');

      const entry = undoLast();

      expect(entry).not.toBeNull();
      expect(entry!.wasNew).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('히스토리가 비어있으면 null을 반환한다', () => {
      const result = undoLast();
      expect(result).toBeNull();
    });

    it('복원 후 히스토리에서 엔트리를 제거한다', () => {
      const filePath = path.join(tempDir, 'test.txt');
      fs.writeFileSync(filePath, 'content', 'utf-8');

      backupFile(filePath);
      expect(getBackupHistory().length).toBe(1);

      undoLast();
      expect(getBackupHistory().length).toBe(0);
    });
  });

  describe('getBackupHistory', () => {
    it('초기 상태에서 빈 배열을 반환한다', () => {
      expect(getBackupHistory()).toEqual([]);
    });

    it('백업 엔트리의 올바른 속성을 포함한다', () => {
      const filePath = path.join(tempDir, 'test.txt');
      fs.writeFileSync(filePath, 'content', 'utf-8');

      backupFile(filePath);
      const history = getBackupHistory();

      expect(history.length).toBe(1);
      expect(history[0]).toHaveProperty('backupPath');
      expect(history[0]).toHaveProperty('originalPath');
      expect(history[0]).toHaveProperty('wasNew');
      expect(history[0]).toHaveProperty('timestamp');
      expect(history[0]!.originalPath).toBe(path.resolve(filePath));
      expect(history[0]!.wasNew).toBe(false);
      expect(history[0]!.timestamp).toBeGreaterThan(0);
    });
  });

  describe('cleanupBackups', () => {
    it('모든 백업을 정리하고 히스토리를 비운다', () => {
      const filePath = path.join(tempDir, 'test.txt');
      fs.writeFileSync(filePath, 'content', 'utf-8');

      backupFile(filePath);
      backupFile(filePath);
      expect(getBackupHistory().length).toBe(2);

      cleanupBackups();
      expect(getBackupHistory().length).toBe(0);
    });
  });

  describe('restoreFile', () => {
    it('백업에서 파일을 복원한다', () => {
      const filePath = path.join(tempDir, 'test.txt');
      fs.writeFileSync(filePath, 'original', 'utf-8');

      backupFile(filePath);
      fs.writeFileSync(filePath, 'changed', 'utf-8');

      const history = getBackupHistory();
      restoreFile(history[0]!);

      expect(fs.readFileSync(filePath, 'utf-8')).toBe('original');
    });
  });
});
