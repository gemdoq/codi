import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Message } from '../llm/types.js';
import { Conversation } from './conversation.js';

export interface SessionInfo {
  id: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  cwd: string;
  model: string;
}

export class SessionManager {
  private sessionsDir: string;

  constructor() {
    const home = process.env['HOME'] || process.env['USERPROFILE'] || '~';
    this.sessionsDir = path.join(home, '.codi', 'sessions');
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  save(conversation: Conversation, name?: string, model?: string): string {
    this.ensureDir();
    const id = name || crypto.randomUUID().slice(0, 8);
    const filePath = path.join(this.sessionsDir, `${id}.jsonl`);

    const data = conversation.serialize();
    const meta: SessionInfo = {
      id,
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: data.messages.length,
      cwd: process.cwd(),
      model: model || 'unknown',
    };

    const lines = [
      JSON.stringify({ type: 'meta', ...meta }),
      JSON.stringify({ type: 'system', content: data.systemPrompt }),
      ...data.messages.map((m) => JSON.stringify({ type: 'message', ...m })),
    ];

    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
    return id;
  }

  load(id: string): { conversation: Conversation; meta: SessionInfo } | null {
    const filePath = path.join(this.sessionsDir, `${id}.jsonl`);
    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    let meta: SessionInfo | null = null;
    let systemPrompt = '';
    const messages: Message[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'meta') {
          meta = obj as SessionInfo;
        } else if (obj.type === 'system') {
          systemPrompt = obj.content;
        } else if (obj.type === 'message') {
          messages.push({ role: obj.role, content: obj.content });
        }
      } catch {
        continue;
      }
    }

    if (!meta) return null;

    const conversation = Conversation.deserialize({ systemPrompt, messages });
    return { conversation, meta };
  }

  list(): SessionInfo[] {
    this.ensureDir();
    const files = fs.readdirSync(this.sessionsDir).filter((f) => f.endsWith('.jsonl'));
    const sessions: SessionInfo[] = [];

    for (const file of files) {
      const filePath = path.join(this.sessionsDir, file);
      try {
        const firstLine = fs.readFileSync(filePath, 'utf-8').split('\n')[0];
        if (firstLine) {
          const meta = JSON.parse(firstLine);
          if (meta.type === 'meta') {
            sessions.push(meta as SessionInfo);
          }
        }
      } catch {
        continue;
      }
    }

    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getLatest(): SessionInfo | null {
    const sessions = this.list();
    return sessions[0] ?? null;
  }

  delete(id: string): boolean {
    const filePath = path.join(this.sessionsDir, `${id}.jsonl`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  cleanup(maxAgeDays: number = 30): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const sessions = this.list();
    let deleted = 0;

    for (const session of sessions) {
      if (session.updatedAt < cutoff) {
        this.delete(session.id);
        deleted++;
      }
    }

    return deleted;
  }
}

export const sessionManager = new SessionManager();
