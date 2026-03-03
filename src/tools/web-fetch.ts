import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

// Simple in-memory cache
const cache: Map<string, { content: string; timestamp: number }> = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: `Fetch content from a URL, convert HTML to text, and return the content. Includes a 15-minute cache. HTTP URLs are upgraded to HTTPS.`,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      prompt: { type: 'string', description: 'What information to extract from the page' },
    },
    required: ['url', 'prompt'],
  },
  dangerous: true,
  readOnly: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    let url = String(input['url']);
    const prompt = String(input['prompt'] || '');

    // Upgrade HTTP to HTTPS
    if (url.startsWith('http://')) {
      url = url.replace('http://', 'https://');
    }

    // Check cache
    const cached = cache.get(url);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return makeToolResult(`[Cached] ${prompt ? `Query: ${prompt}\n\n` : ''}${cached.content}`);
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Codi/0.1 (AI Code Agent)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        return makeToolError(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      let text: string;

      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        const html = await response.text();
        const { load } = await import('cheerio');
        const $ = load(html);

        // Remove script, style, nav, header, footer
        $('script, style, nav, header, footer, iframe, noscript').remove();

        // Extract text from main content
        const main = $('main, article, .content, #content, .main').first();
        text = (main.length ? main.text() : $('body').text())
          .replace(/\s+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      } else {
        text = await response.text();
      }

      // Truncate if too long
      const MAX_LEN = 50_000;
      if (text.length > MAX_LEN) {
        text = text.slice(0, MAX_LEN) + '\n\n... (truncated)';
      }

      // Cache the result
      cache.set(url, { content: text, timestamp: Date.now() });

      return makeToolResult(prompt ? `URL: ${url}\nQuery: ${prompt}\n\n${text}` : text);
    } catch (err) {
      return makeToolError(`Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
