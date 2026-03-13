import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool, ToolResult } from '../tools/tool.js';
import { makeToolResult, makeToolError } from '../tools/tool.js';
import type { ToolRegistry } from '../tools/registry.js';
import { configManager } from '../config/config.js';
import chalk from 'chalk';

interface McpServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: string[];
}

export class McpManager {
  private servers: Map<string, McpServer> = new Map();

  async initialize(registry: ToolRegistry): Promise<void> {
    const config = configManager.get();

    // Also check for mcp.json files
    const mcpConfigs = this.loadMcpConfigs();
    const allServers = { ...mcpConfigs, ...config.mcpServers };

    for (const [name, serverConfig] of Object.entries(allServers)) {
      try {
        await this.connectServer(name, serverConfig, registry);
      } catch (err) {
        console.error(chalk.yellow(`  ⚠ Failed to connect MCP server '${name}': ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  private loadMcpConfigs(): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
    const configs: Record<string, any> = {};
    const home = process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();

    const paths = [
      path.join(home, '.codi', 'mcp.json'),
      path.join(process.cwd(), '.codi', 'mcp.json'),
    ];

    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          const content = JSON.parse(fs.readFileSync(p, 'utf-8'));
          if (content.mcpServers) {
            Object.assign(configs, content.mcpServers);
          }
        }
      } catch {
        // Skip invalid configs
      }
    }

    return configs;
  }

  private async connectServer(
    name: string,
    config: { command: string; args?: string[]; env?: Record<string, string> },
    registry: ToolRegistry
  ): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
    });

    const client = new Client({
      name: 'codi',
      version: '0.1.0',
    });

    await client.connect(transport);

    // Discover tools
    const toolsResult = await client.listTools();
    const toolNames: string[] = [];

    for (const mcpTool of toolsResult.tools) {
      const toolName = `mcp__${name}__${mcpTool.name}`;
      toolNames.push(toolName);

      const tool: Tool = {
        name: toolName,
        description: `[MCP:${name}] ${mcpTool.description || mcpTool.name}`,
        inputSchema: (mcpTool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
        dangerous: true,
        readOnly: false,

        async execute(input: Record<string, unknown>): Promise<ToolResult> {
          try {
            const result = await client.callTool({
              name: mcpTool.name,
              arguments: input,
            });

            const contentArr = Array.isArray(result.content) ? result.content : [];
            const text = contentArr
              .map((c: any) => {
                if (c.type === 'text') return c.text;
                return JSON.stringify(c);
              })
              .join('\n') || '';

            return makeToolResult(text);
          } catch (err) {
            return makeToolError(`MCP tool error: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      };

      registry.register(tool);
    }

    this.servers.set(name, { name, client, transport, tools: toolNames });
    console.log(chalk.dim(`  ✓ MCP server '${name}' connected (${toolNames.length} tools)`));
  }

  async disconnect(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;

    try {
      await server.transport.close();
    } catch {
      // Ignore disconnect errors
    }
    this.servers.delete(name);
  }

  async disconnectAll(): Promise<void> {
    for (const [name] of this.servers) {
      await this.disconnect(name);
    }
  }

  listServers(): Array<{ name: string; tools: string[] }> {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      tools: s.tools,
    }));
  }

  getServerCount(): number {
    return this.servers.size;
  }
}

export const mcpManager = new McpManager();
