import { execSync } from 'child_process';
import { Conversation } from './conversation.js';

export interface Checkpoint {
  id: number;
  timestamp: number;
  conversation: ReturnType<Conversation['serialize']>;
  gitRef?: string;
  description?: string;
}

export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];
  private nextId = 1;
  private isGitRepo: boolean;

  constructor() {
    try {
      execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });
      this.isGitRepo = true;
    } catch {
      this.isGitRepo = false;
    }
  }

  create(conversation: Conversation, description?: string): number {
    const checkpoint: Checkpoint = {
      id: this.nextId++,
      timestamp: Date.now(),
      conversation: conversation.serialize(),
      description,
    };

    if (this.isGitRepo) {
      try {
        // Save git state
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

        // Immediately restore the stash (we just want the ref)
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

    // Keep only last 20 checkpoints
    if (this.checkpoints.length > 20) {
      this.checkpoints = this.checkpoints.slice(-20);
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
      this.checkpoints = this.checkpoints.slice(0, idx + 1);
    }

    return {
      conversation: Conversation.deserialize(checkpoint.conversation),
      description: checkpoint.description,
    };
  }

  list(): Array<{ id: number; timestamp: number; description?: string }> {
    return this.checkpoints.map((cp) => ({
      id: cp.id,
      timestamp: cp.timestamp,
      description: cp.description,
    }));
  }
}

export const checkpointManager = new CheckpointManager();
