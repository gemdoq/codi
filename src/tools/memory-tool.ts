import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';
import { memoryManager } from '../agent/memory.js';

function buildFrontmatter(topic: string, description: string): string {
  return `---\nname: ${topic}\ndescription: ${description}\ntype: project\n---\n`;
}

function parseFrontmatter(content: string): { name?: string; description?: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx !== -1) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { name: meta['name'], description: meta['description'], body: match[2]! };
}

function updateIndex(memoryDir: string): void {
  const indexPath = path.join(memoryDir, 'MEMORY.md');
  const files = fs.readdirSync(memoryDir)
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    .sort();

  const lines: string[] = ['# Project Memory', ''];

  if (files.length === 0) {
    lines.push('No topics saved yet.');
  } else {
    lines.push('| Topic | Description |');
    lines.push('|-------|-------------|');
    for (const file of files) {
      const content = fs.readFileSync(path.join(memoryDir, file), 'utf-8');
      const parsed = parseFrontmatter(content);
      const topic = file.replace('.md', '');
      const desc = parsed.description || '';
      lines.push(`| [${topic}](${file}) | ${desc} |`);
    }
  }

  lines.push('');
  fs.writeFileSync(indexPath, lines.join('\n'), 'utf-8');
}

export const updateMemoryTool: Tool = {
  name: 'update_memory',
  description: `Save, delete, or list project memory topics. Use this to persist important information (architecture decisions, user preferences, patterns, etc.) across conversations.
- save: Create or update a memory topic file with content
- delete: Remove a memory topic file
- list: List all existing memory topics with descriptions`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['save', 'delete', 'list'],
        description: 'Action to perform',
      },
      topic: {
        type: 'string',
        description: 'Topic name (used as filename, e.g. "architecture" -> architecture.md). Required for save/delete.',
      },
      content: {
        type: 'string',
        description: 'Content to save. First line is used as description. Required for save.',
      },
    },
    required: ['action', 'topic'],
  },
  dangerous: false,
  readOnly: false,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = String(input['action']);
    const topic = String(input['topic'] || '');
    const content = input['content'] != null ? String(input['content']) : undefined;
    const memoryDir = memoryManager.getMemoryDir();

    switch (action) {
      case 'save': {
        if (!topic) return makeToolError('topic is required for save action');
        if (!content) return makeToolError('content is required for save action');

        memoryManager.ensureDir();

        // Extract first line as description
        const firstLine = content.split('\n')[0]!.trim();
        const description = firstLine.length > 100 ? firstLine.slice(0, 100) + '...' : firstLine;

        const fileContent = buildFrontmatter(topic, description) + content;
        const topicPath = path.join(memoryDir, `${topic}.md`);
        fs.writeFileSync(topicPath, fileContent, 'utf-8');

        updateIndex(memoryDir);

        return makeToolResult(`Memory topic "${topic}" saved to ${topicPath}`);
      }

      case 'delete': {
        if (!topic) return makeToolError('topic is required for delete action');

        const topicPath = path.join(memoryDir, `${topic}.md`);
        if (!fs.existsSync(topicPath)) {
          return makeToolError(`Memory topic "${topic}" not found`);
        }

        fs.unlinkSync(topicPath);
        memoryManager.ensureDir();
        updateIndex(memoryDir);

        return makeToolResult(`Memory topic "${topic}" deleted`);
      }

      case 'list': {
        const topics = memoryManager.listTopics();
        if (topics.length === 0) {
          return makeToolResult('No memory topics saved yet.');
        }

        const lines: string[] = [];
        for (const t of topics) {
          const raw = memoryManager.loadTopic(t);
          if (raw) {
            const parsed = parseFrontmatter(raw);
            lines.push(`- ${t}: ${parsed.description || '(no description)'}`);
          } else {
            lines.push(`- ${t}: (no description)`);
          }
        }

        return makeToolResult(`Memory topics (${topics.length}):\n${lines.join('\n')}\n\nMemory dir: ${memoryDir}`);
      }

      default:
        return makeToolError(`Unknown action: ${action}. Use save, delete, or list.`);
    }
  },
};
