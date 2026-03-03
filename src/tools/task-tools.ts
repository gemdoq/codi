import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

export interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private nextId = 1;

  create(subject: string, description: string, activeForm?: string): Task {
    const id = String(this.nextId++);
    const task: Task = {
      id,
      subject,
      description,
      activeForm,
      status: 'pending',
      blocks: [],
      blockedBy: [],
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(id, task);
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  update(id: string, updates: Partial<Task> & {
    addBlocks?: string[];
    addBlockedBy?: string[];
  }): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    if (updates.status) task.status = updates.status;
    if (updates.subject) task.subject = updates.subject;
    if (updates.description) task.description = updates.description;
    if (updates.activeForm) task.activeForm = updates.activeForm;
    if (updates.owner) task.owner = updates.owner;
    if (updates.metadata) Object.assign(task.metadata, updates.metadata);

    if (updates.addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...updates.addBlocks])];
    }
    if (updates.addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...updates.addBlockedBy])];
    }

    if (updates.status === 'deleted') {
      this.tasks.delete(id);
    }

    task.updatedAt = Date.now();
    return task;
  }

  list(): Task[] {
    return [...this.tasks.values()].filter((t) => t.status !== 'deleted');
  }
}

export const taskManager = new TaskManager();

function formatTask(task: Task): string {
  const lines = [
    `#${task.id} [${task.status}] ${task.subject}`,
  ];
  if (task.description) lines.push(`  ${task.description}`);
  if (task.owner) lines.push(`  Owner: ${task.owner}`);
  if (task.blocks.length) lines.push(`  Blocks: ${task.blocks.join(', ')}`);
  if (task.blockedBy.length) lines.push(`  Blocked by: ${task.blockedBy.join(', ')}`);
  return lines.join('\n');
}

export const taskCreateTool: Tool = {
  name: 'task_create',
  description: `Create a new task to track work.`,
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Brief task title' },
      description: { type: 'string', description: 'Detailed description' },
      activeForm: { type: 'string', description: 'Present continuous form (e.g., "Running tests")' },
    },
    required: ['subject', 'description'],
  },
  dangerous: false,
  readOnly: false,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const task = taskManager.create(
      String(input['subject']),
      String(input['description']),
      input['activeForm'] ? String(input['activeForm']) : undefined
    );
    return makeToolResult(`Task #${task.id} created: ${task.subject}`);
  },
};

export const taskUpdateTool: Tool = {
  name: 'task_update',
  description: `Update a task's status, description, or dependencies.`,
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
      subject: { type: 'string' },
      description: { type: 'string' },
      activeForm: { type: 'string' },
      owner: { type: 'string' },
      addBlocks: { type: 'array', items: { type: 'string' } },
      addBlockedBy: { type: 'array', items: { type: 'string' } },
    },
    required: ['taskId'],
  },
  dangerous: false,
  readOnly: false,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const task = taskManager.update(String(input['taskId']), input as any);
    if (!task) return makeToolError(`Task not found: ${input['taskId']}`);
    return makeToolResult(`Task #${task.id} updated: ${formatTask(task)}`);
  },
};

export const taskListTool: Tool = {
  name: 'task_list',
  description: `List all tasks with their status.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  dangerous: false,
  readOnly: true,

  async execute(): Promise<ToolResult> {
    const tasks = taskManager.list();
    if (tasks.length === 0) {
      return makeToolResult('No tasks.');
    }
    return makeToolResult(tasks.map(formatTask).join('\n\n'));
  },
};

export const taskGetTool: Tool = {
  name: 'task_get',
  description: `Get full details of a specific task.`,
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
    },
    required: ['taskId'],
  },
  dangerous: false,
  readOnly: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const task = taskManager.get(String(input['taskId']));
    if (!task) return makeToolError(`Task not found: ${input['taskId']}`);
    return makeToolResult(formatTask(task));
  },
};
