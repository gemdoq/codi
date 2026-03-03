export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  metadata?: {
    filePath?: string;
    linesChanged?: number;
    tokensUsed?: number;
    isImage?: boolean;
    imageData?: string;
    imageMimeType?: string;
  };
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  dangerous: boolean;
  readOnly: boolean;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

export function makeToolResult(output: string, metadata?: ToolResult['metadata']): ToolResult {
  return { success: true, output, metadata };
}

export function makeToolError(error: string, metadata?: ToolResult['metadata']): ToolResult {
  return { success: false, output: error, error, metadata };
}
