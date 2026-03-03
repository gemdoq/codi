import type { Tool } from './tool.js';
import type { ToolDefinition } from '../llm/types.js';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  listNames(): string[] {
    return [...this.tools.keys()];
  }

  getToolDefinitions(options?: { readOnly?: boolean; names?: string[] }): ToolDefinition[] {
    let tools = [...this.tools.values()];

    if (options?.readOnly) {
      tools = tools.filter((t) => t.readOnly);
    }

    if (options?.names) {
      const nameSet = new Set(options.names);
      tools = tools.filter((t) => nameSet.has(t.name));
    }

    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  clone(): ToolRegistry {
    const newRegistry = new ToolRegistry();
    for (const [, tool] of this.tools) {
      newRegistry.register(tool);
    }
    return newRegistry;
  }

  subset(names: string[]): ToolRegistry {
    const newRegistry = new ToolRegistry();
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) newRegistry.register(tool);
    }
    return newRegistry;
  }
}
