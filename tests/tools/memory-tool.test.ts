import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tempDir: string;

// memoryManager를 모킹하여 실제 홈 디렉토리에 쓰지 않는다
vi.mock('../../src/agent/memory.js', () => {
  return {
    memoryManager: {
      getMemoryDir: () => tempDir,
      ensureDir: () => {
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
      },
      listTopics: () => {
        if (!fs.existsSync(tempDir)) return [];
        return fs
          .readdirSync(tempDir)
          .filter((f: string) => f.endsWith('.md') && f !== 'MEMORY.md')
          .map((f: string) => f.replace('.md', ''));
      },
      loadTopic: (name: string) => {
        const topicPath = path.join(tempDir, `${name}.md`);
        if (!fs.existsSync(topicPath)) return null;
        return fs.readFileSync(topicPath, 'utf-8');
      },
    },
  };
});

import { updateMemoryTool } from '../../src/tools/memory-tool.js';

describe('memory-tool', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codi-memory-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('save', () => {
    it('frontmatter가 포함된 파일을 생성한다', async () => {
      const result = await updateMemoryTool.execute({
        action: 'save',
        topic: 'architecture',
        content: 'Clean architecture pattern\nDetails here',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('architecture');

      const filePath = path.join(tempDir, 'architecture.md');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('---');
      expect(content).toContain('name: architecture');
      expect(content).toContain('description: Clean architecture pattern');
      expect(content).toContain('Clean architecture pattern');
    });

    it('MEMORY.md 인덱스를 업데이트한다', async () => {
      await updateMemoryTool.execute({
        action: 'save',
        topic: 'patterns',
        content: 'Singleton pattern usage',
      });

      const indexPath = path.join(tempDir, 'MEMORY.md');
      expect(fs.existsSync(indexPath)).toBe(true);

      const indexContent = fs.readFileSync(indexPath, 'utf-8');
      expect(indexContent).toContain('patterns');
    });

    it('topic이 없으면 에러를 반환한다', async () => {
      const result = await updateMemoryTool.execute({
        action: 'save',
        topic: '',
        content: 'some content',
      });

      expect(result.success).toBe(false);
    });

    it('content가 없으면 에러를 반환한다', async () => {
      const result = await updateMemoryTool.execute({
        action: 'save',
        topic: 'test',
      });

      expect(result.success).toBe(false);
    });

    it('긴 첫 줄은 100자로 잘라서 description으로 사용한다', async () => {
      const longLine = 'A'.repeat(150);
      await updateMemoryTool.execute({
        action: 'save',
        topic: 'longdesc',
        content: longLine,
      });

      const content = fs.readFileSync(path.join(tempDir, 'longdesc.md'), 'utf-8');
      expect(content).toContain('description: ' + 'A'.repeat(100) + '...');
    });
  });

  describe('delete', () => {
    it('존재하는 토픽 파일을 삭제한다', async () => {
      // 먼저 파일 생성
      await updateMemoryTool.execute({
        action: 'save',
        topic: 'to-delete',
        content: 'This will be deleted',
      });

      const filePath = path.join(tempDir, 'to-delete.md');
      expect(fs.existsSync(filePath)).toBe(true);

      const result = await updateMemoryTool.execute({
        action: 'delete',
        topic: 'to-delete',
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('존재하지 않는 토픽 삭제 시 에러를 반환한다', async () => {
      const result = await updateMemoryTool.execute({
        action: 'delete',
        topic: 'nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('not found');
    });
  });

  describe('list', () => {
    it('토픽 목록을 반환한다', async () => {
      await updateMemoryTool.execute({
        action: 'save',
        topic: 'topic-a',
        content: 'Description A',
      });
      await updateMemoryTool.execute({
        action: 'save',
        topic: 'topic-b',
        content: 'Description B',
      });

      const result = await updateMemoryTool.execute({
        action: 'list',
        topic: '',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('topic-a');
      expect(result.output).toContain('topic-b');
      expect(result.output).toContain('2');
    });

    it('토픽이 없으면 안내 메시지를 반환한다', async () => {
      const result = await updateMemoryTool.execute({
        action: 'list',
        topic: '',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('No memory topics');
    });
  });

  describe('unknown action', () => {
    it('알 수 없는 액션에 에러를 반환한다', async () => {
      const result = await updateMemoryTool.execute({
        action: 'unknown',
        topic: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Unknown action');
    });
  });
});
