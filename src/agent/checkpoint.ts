import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { Conversation } from './conversation.js';

export interface Checkpoint {
  id: number;
  timestamp: number;
  conversation: ReturnType<Conversation['serialize']>;
  gitRef?: string;
  description?: string;
  messageCount: number;
}

const MAX_CHECKPOINTS = 20;

export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];
  private nextId = 1;
  private isGitRepo: boolean;
  private sessionId: string;
  private checkpointDir: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId || crypto.randomUUID().slice(0, 8);
    const home = process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();
    this.checkpointDir = path.join(home, '.codi', 'checkpoints', this.sessionId);

    try {
      execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });
      this.isGitRepo = true;
    } catch {
      this.isGitRepo = false;
    }

    this.loadFromDisk();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.checkpointDir)) {
      fs.mkdirSync(this.checkpointDir, { recursive: true });
    }
  }

  private checkpointPath(id: number): string {
    return path.join(this.checkpointDir, `checkpoint-${id}.json`);
  }

  private saveToDisk(checkpoint: Checkpoint): void {
    this.ensureDir();
    const filePath = this.checkpointPath(checkpoint.id);
    fs.writeFileSync(filePath, JSON.stringify(checkpoint), 'utf-8');
  }

  private deleteFromDisk(id: number): void {
    const filePath = this.checkpointPath(id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.checkpointDir)) return;

    const files = fs.readdirSync(this.checkpointDir)
      .filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'))
      .sort((a, b) => {
        const idA = parseInt(a.replace('checkpoint-', '').replace('.json', ''), 10);
        const idB = parseInt(b.replace('checkpoint-', '').replace('.json', ''), 10);
        return idA - idB;
      });

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.checkpointDir, file), 'utf-8');
        const checkpoint = JSON.parse(content) as Checkpoint;
        this.checkpoints.push(checkpoint);
        if (checkpoint.id >= this.nextId) {
          this.nextId = checkpoint.id + 1;
        }
      } catch {
        // 손상된 파일은 무시
        continue;
      }
    }
  }

  create(conversation: Conversation, description?: string): number {
    const checkpoint: Checkpoint = {
      id: this.nextId++,
      timestamp: Date.now(),
      conversation: conversation.serialize(),
      description,
      messageCount: conversation.getMessageCount(),
    };

    if (this.isGitRepo) {
      try {
        execSync('git stash push -m "codi-checkpoint" --include-untracked', {
          stdio: 'pipe',
          encoding: 'utf-8',
        });
        const ref = execSync('git stash list --format=%H', {
          encoding: 'utf-8',
        }).split('\n')[0]?.trim();

        if (ref) {
          checkpoint.gitRef = ref;
        }

        try {
          execSync('git stash pop', { stdio: 'pipe' });
        } catch {
          // If pop fails, there's nothing to pop
        }
      } catch {
        // Git operations may fail, that's OK
      }
    }

    this.checkpoints.push(checkpoint);
    this.saveToDisk(checkpoint);

    // Keep only last 20 checkpoints
    if (this.checkpoints.length > MAX_CHECKPOINTS) {
      const removed = this.checkpoints.splice(0, this.checkpoints.length - MAX_CHECKPOINTS);
      for (const cp of removed) {
        this.deleteFromDisk(cp.id);
      }
    }

    return checkpoint.id;
  }

  rewind(id?: number): { conversation: Conversation; description?: string } | null {
    let checkpoint: Checkpoint | undefined;

    if (id !== undefined) {
      checkpoint = this.checkpoints.find((cp) => cp.id === id);
    } else {
      // Rewind to previous checkpoint
      checkpoint = this.checkpoints[this.checkpoints.length - 2];
    }

    if (!checkpoint) return null;

    // Restore git state if available
    if (checkpoint.gitRef && this.isGitRepo) {
      try {
        execSync(`git checkout ${checkpoint.gitRef} -- .`, { stdio: 'pipe' });
      } catch {
        // Git restore may fail
      }
    }

    // Remove all checkpoints after this one
    const idx = this.checkpoints.indexOf(checkpoint);
    if (idx >= 0) {
      const removed = this.checkpoints.splice(idx + 1);
      for (const cp of removed) {
        this.deleteFromDisk(cp.id);
      }
    }

    return {
      conversation: Conversation.deserialize(checkpoint.conversation),
      description: checkpoint.description,
    };
  }

  list(): Array<{ id: number; timestamp: number; description?: string; messageCount: number }> {
    return this.checkpoints.map((cp) => ({
      id: cp.id,
      timestamp: cp.timestamp,
      description: cp.description,
      messageCount: cp.messageCount,
    }));
  }

  /**
   * 세션 종료 시 체크포인트 파일 정리
   */
  cleanup(): void {
    if (fs.existsSync(this.checkpointDir)) {
      fs.rmSync(this.checkpointDir, { recursive: true, force: true });
    }
    this.checkpoints = [];
  }
}

export const checkpointManager = new CheckpointManager();
