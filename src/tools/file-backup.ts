import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface BackupEntry {
  backupPath: string;
  originalPath: string;
  /** true = 파일이 새로 생성된 경우 (undo = 삭제) */
  wasNew: boolean;
  timestamp: number;
}

const backupDir = path.join(os.tmpdir(), `codi-backups-${process.pid}`);
const backupHistory: BackupEntry[] = [];
let cleanupRegistered = false;

function ensureBackupDir(): void {
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
}

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on('exit', () => {
    cleanupBackups();
  });
}

/**
 * 파일을 임시 백업 디렉토리에 복사한다.
 * 파일이 존재하지 않으면 "새 파일" 마커로 기록한다.
 * @returns 백업 경로 (새 파일이면 빈 문자열)
 */
export function backupFile(filePath: string): string {
  const resolved = path.resolve(filePath);
  ensureBackupDir();
  registerCleanup();

  const wasNew = !fs.existsSync(resolved);
  const backupName = `${Date.now()}-${Math.random().toString(36).slice(2)}-${path.basename(resolved)}`;
  const backupPath = path.join(backupDir, backupName);

  if (!wasNew) {
    fs.copyFileSync(resolved, backupPath);
  }

  const entry: BackupEntry = {
    backupPath,
    originalPath: resolved,
    wasNew,
    timestamp: Date.now(),
  };
  backupHistory.push(entry);

  return backupPath;
}

/**
 * 백업에서 원본 파일을 복원한다.
 */
export function restoreFile(entry: BackupEntry): void {
  if (entry.wasNew) {
    // 파일이 새로 생성된 것이므로 삭제
    if (fs.existsSync(entry.originalPath)) {
      fs.unlinkSync(entry.originalPath);
    }
  } else {
    // 백업에서 복원
    if (fs.existsSync(entry.backupPath)) {
      fs.copyFileSync(entry.backupPath, entry.originalPath);
    }
  }
}

/**
 * 모든 임시 백업 파일을 삭제한다.
 */
export function cleanupBackups(): void {
  if (fs.existsSync(backupDir)) {
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch {
      // exit 핸들러에서 실패해도 무시
    }
  }
  backupHistory.length = 0;
}

/**
 * 백업 이력을 반환한다.
 */
export function getBackupHistory(): ReadonlyArray<BackupEntry> {
  return backupHistory;
}

/**
 * 가장 최근 백업을 복원하고 이력에서 제거한다.
 * @returns 복원된 BackupEntry 또는 이력이 비어있으면 null
 */
export function undoLast(): BackupEntry | null {
  const entry = backupHistory.pop();
  if (!entry) return null;

  restoreFile(entry);

  // 백업 파일 정리
  if (!entry.wasNew && fs.existsSync(entry.backupPath)) {
    try {
      fs.unlinkSync(entry.backupPath);
    } catch {
      // 무시
    }
  }

  return entry;
}
