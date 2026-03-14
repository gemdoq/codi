import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export class MemoryManager {
  private memoryDir: string;

  constructor() {
    const home = process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();
    const projectHash = crypto.createHash('md5').update(process.cwd()).digest('hex').slice(0, 8);
    const projectName = path.basename(process.cwd());
    this.memoryDir = path.join(home, '.codi', 'projects', `${projectName}-${projectHash}`, 'memory');
  }

  ensureDir(): void {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  getMemoryDir(): string {
    return this.memoryDir;
  }

  loadIndex(): string {
    const indexPath = path.join(this.memoryDir, 'MEMORY.md');
    if (!fs.existsSync(indexPath)) return '';

    const content = fs.readFileSync(indexPath, 'utf-8');
    // Only load first 200 lines
    const lines = content.split('\n');
    return lines.slice(0, 200).join('\n');
  }

  saveIndex(content: string): void {
    this.ensureDir();
    const indexPath = path.join(this.memoryDir, 'MEMORY.md');
    fs.writeFileSync(indexPath, content, 'utf-8');
  }

  loadTopic(name: string): string | null {
    const topicPath = path.join(this.memoryDir, `${name}.md`);
    if (!fs.existsSync(topicPath)) return null;
    return fs.readFileSync(topicPath, 'utf-8');
  }

  saveTopic(name: string, content: string): void {
    this.ensureDir();
    const topicPath = path.join(this.memoryDir, `${name}.md`);
    fs.writeFileSync(topicPath, content, 'utf-8');
  }

  listTopics(): string[] {
    if (!fs.existsSync(this.memoryDir)) return [];
    return fs
      .readdirSync(this.memoryDir)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
      .map((f) => f.replace('.md', ''));
  }

  buildMemoryPrompt(): string {
    const index = this.loadIndex();
    if (!index) return '';

    const lines = [
      `You have a persistent memory directory at ${this.memoryDir}.`,
      'Use the update_memory tool to save, delete, or list memory topics as you learn patterns.',
      '',
      'Current MEMORY.md:',
      index,
    ];

    return lines.join('\n');
  }
}

export const memoryManager = new MemoryManager();
