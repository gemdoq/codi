import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

export const webSearchTool: Tool = {
  name: 'web_search',
  description: `Search the web for information. Returns search results with titles, URLs, and snippets. Uses DuckDuckGo as the search engine.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
  dangerous: true,
  readOnly: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = String(input['query']);

    try {
      // Use DuckDuckGo HTML search
      const encoded = encodeURIComponent(query);
      const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Codi/0.1)',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return makeToolError(`Search failed: HTTP ${response.status}`);
      }

      const html = await response.text();
      const { load } = await import('cheerio');
      const $ = load(html);

      const results: Array<{ title: string; url: string; snippet: string }> = [];

      $('.result').each((i, el) => {
        if (i >= 10) return false;
        const $el = $(el);
        const title = $el.find('.result__title a').text().trim();
        const href = $el.find('.result__title a').attr('href') || '';
        const snippet = $el.find('.result__snippet').text().trim();

        if (title && href) {
          // Extract actual URL from DuckDuckGo redirect
          let actualUrl = href;
          try {
            const urlObj = new URL(href, 'https://duckduckgo.com');
            actualUrl = urlObj.searchParams.get('uddg') || href;
          } catch {
            actualUrl = href;
          }
          results.push({ title, url: actualUrl, snippet });
        }
      });

      if (results.length === 0) {
        return makeToolResult(`No results found for: ${query}`);
      }

      const formatted = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');

      return makeToolResult(`Search results for: ${query}\n\n${formatted}`);
    } catch (err) {
      return makeToolError(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
