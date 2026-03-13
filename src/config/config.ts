import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProviderName } from '../llm/provider.js';

export interface CodiConfig {
  provider: ProviderName;
  model: string;
  maxTokens: number;
  temperature?: number;
  apiKeys: {
    anthropic?: string;
    openai?: string;
  };
  baseUrls: {
    anthropic?: string;
    openai?: string;
    ollama?: string;
  };
  permissions: {
    allow: string[];
    deny: string[];
    ask: string[];
  };
  hooks: Record<string, HookConfig[]>;
  mcpServers: Record<string, McpServerConfig>;
  customCommands: string[];
  sandbox: boolean;
  autoCompactThreshold: number; // 0-1, fraction of context window
  memoryEnabled: boolean;
}

export interface HookConfig {
  matcher: string;
  hooks: Array<{
    type: 'command' | 'prompt';
    command?: string;
    prompt?: string;
    timeout?: number;
  }>;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

const DEFAULT_CONFIG: CodiConfig = {
  provider: 'openai',
  model: 'gemini-2.5-flash',
  maxTokens: 8192,
  apiKeys: {},
  baseUrls: {
    openai: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  permissions: {
    allow: ['read_file', 'glob', 'grep', 'list_dir', 'ask_user'],
    deny: [],
    ask: ['write_file', 'edit_file', 'multi_edit', 'bash', 'git', 'web_fetch', 'web_search', 'notebook_edit'],
  },
  hooks: {},
  mcpServers: {},
  customCommands: [],
  sandbox: false,
  autoCompactThreshold: 0.7,
  memoryEnabled: true,
};

export class ConfigManager {
  private config: CodiConfig;
  private configPaths: string[] = [];

  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.loadAll();
  }

  private loadAll(): void {
    const home = process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();

    // User global config
    this.loadFile(path.join(home, '.codi', 'settings.json'));

    // Project config
    this.loadFile(path.join(process.cwd(), '.codi', 'settings.json'));

    // Project local config (gitignored)
    this.loadFile(path.join(process.cwd(), '.codi', 'settings.local.json'));

    // Environment variables override
    if (process.env['GEMINI_API_KEY']) {
      this.config.apiKeys.openai = process.env['GEMINI_API_KEY'];
    }
    if (process.env['ANTHROPIC_API_KEY']) {
      this.config.apiKeys.anthropic = process.env['ANTHROPIC_API_KEY'];
    }
    if (process.env['OPENAI_API_KEY']) {
      this.config.apiKeys.openai = process.env['OPENAI_API_KEY'];
    }
    if (process.env['CODI_MODEL']) {
      this.config.model = process.env['CODI_MODEL'];
    }
    if (process.env['CODI_PROVIDER']) {
      this.config.provider = process.env['CODI_PROVIDER'] as ProviderName;
    }
  }

  private loadFile(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      this.configPaths.push(filePath);
      this.mergeConfig(parsed);
    } catch {
      // Skip invalid config files
    }
  }

  private mergeConfig(partial: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(partial)) {
      if (key === 'permissions' && typeof value === 'object' && value !== null) {
        const perms = value as Record<string, unknown>;
        if (Array.isArray(perms['allow'])) {
          this.config.permissions.allow = [
            ...new Set([...this.config.permissions.allow, ...perms['allow']]),
          ];
        }
        if (Array.isArray(perms['deny'])) {
          this.config.permissions.deny = [
            ...new Set([...this.config.permissions.deny, ...perms['deny']]),
          ];
        }
        if (Array.isArray(perms['ask'])) {
          this.config.permissions.ask = [
            ...new Set([...this.config.permissions.ask, ...perms['ask']]),
          ];
        }
      } else if (key === 'hooks' && typeof value === 'object' && value !== null) {
        Object.assign(this.config.hooks, value);
      } else if (key === 'mcpServers' && typeof value === 'object' && value !== null) {
        Object.assign(this.config.mcpServers, value);
      } else if (key === 'apiKeys' && typeof value === 'object' && value !== null) {
        Object.assign(this.config.apiKeys, value);
      } else if (key === 'baseUrls' && typeof value === 'object' && value !== null) {
        Object.assign(this.config.baseUrls, value);
      } else if (key in this.config) {
        (this.config as any)[key] = value;
      }
    }
  }

  get(): CodiConfig {
    return this.config;
  }

  reload(): void {
    this.config = { ...DEFAULT_CONFIG };
    this.configPaths = [];
    this.loadAll();
  }

  set(key: string, value: unknown): void {
    (this.config as any)[key] = value;
  }

  getConfigPaths(): string[] {
    return this.configPaths;
  }

  save(scope: 'user' | 'project' | 'local'): void {
    const home = process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();
    let filePath: string;

    switch (scope) {
      case 'user':
        filePath = path.join(home, '.codi', 'settings.json');
        break;
      case 'project':
        filePath = path.join(process.cwd(), '.codi', 'settings.json');
        break;
      case 'local':
        filePath = path.join(process.cwd(), '.codi', 'settings.local.json');
        break;
    }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(this.config, null, 2), 'utf-8');
  }
}

export const configManager = new ConfigManager();
