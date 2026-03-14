import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// 검색 결과 캐시
const searchCache: Map<string, { results: string; timestamp: number }> = new Map();
const SEARCH_CACHE_TTL = 10 * 60 * 1000; // 10분

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * DuckDuckGo 리다이렉트 URL에서 실제 URL 추출
 */
function extractRealUrl(href: string): string {
  try {
    const urlObj = new URL(href, 'https://duckduckgo.com');
    return urlObj.searchParams.get('uddg') || href;
  } catch {
    return href;
  }
}

/**
 * URL 정규화 (중복 제거용)
 */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // 트래킹 파라미터 제거
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'fbclid', 'gclid'];
    for (const param of trackingParams) {
      u.searchParams.delete(param);
    }
    // 끝 슬래시 정규화
    let path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.hostname}${path}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * 검색 결과 중복 제거 및 정렬
 */
function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];

  for (const result of results) {
    const normalized = normalizeUrl(result.url);
    if (!seen.has(normalized) && result.title.length > 0) {
      seen.add(normalized);
      deduped.push(result);
    }
  }

  return deduped;
}

/**
 * DuckDuckGo HTML 검색
 */
async function searchDuckDuckGo(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo HTTP ${response.status} ${response.statusText}`);
  }

  const html = await response.text();

  // 차단 감지
  if (html.includes('If this error persists') || html.includes('blocked')) {
    throw new Error('DuckDuckGo에서 요청이 차단되었습니다');
  }

  const { load } = await import('cheerio');
  const $ = load(html);

  const results: SearchResult[] = [];

  // DuckDuckGo HTML 결과 파싱
  $('.result').each((_i, el) => {
    const $el = $(el);

    // 광고 결과 제외
    if ($el.hasClass('result--ad') || $el.find('.badge--ad').length > 0) {
      return;
    }

    const titleEl = $el.find('.result__title a, .result__a');
    const title = titleEl.text().trim();
    const href = titleEl.attr('href') || '';
    const snippet = $el.find('.result__snippet').text().trim();

    if (title && href) {
      const actualUrl = extractRealUrl(href);
      // 유효한 URL인지 검증
      if (actualUrl.startsWith('http://') || actualUrl.startsWith('https://')) {
        results.push({ title, url: actualUrl, snippet });
      }
    }
  });

  return deduplicateResults(results).slice(0, maxResults);
}

/**
 * DuckDuckGo Lite 검색 (폴백)
 */
async function searchDuckDuckGoLite(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://lite.duckduckgo.com/lite/?q=${encoded}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo Lite HTTP ${response.status}`);
  }

  const html = await response.text();
  const { load } = await import('cheerio');
  const $ = load(html);

  const results: SearchResult[] = [];

  // Lite 버전은 테이블 기반 레이아웃
  // 결과 링크는 class="result-link"
  $('a.result-link').each((_i, el) => {
    const $a = $(el);
    const title = $a.text().trim();
    const href = $a.attr('href') || '';

    if (title && href) {
      const actualUrl = extractRealUrl(href);
      // snippet은 다음 행에서 추출 시도
      const $row = $a.closest('tr');
      const snippet = $row.next('tr').find('.result-snippet').text().trim()
        || $row.next('tr').find('td').last().text().trim();

      if (actualUrl.startsWith('http://') || actualUrl.startsWith('https://')) {
        results.push({ title, url: actualUrl, snippet });
      }
    }
  });

  return deduplicateResults(results).slice(0, maxResults);
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description: `Search the web for information. Returns search results with titles, URLs, and snippets. Uses DuckDuckGo. Falls back to DuckDuckGo Lite if the main search fails.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: {
        type: 'number',
        description: 'Maximum number of results (default: 10, max: 20)',
      },
    },
    required: ['query'],
  },
  dangerous: true,
  readOnly: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = String(input['query']).trim();
    if (!query) {
      return makeToolError('검색어가 비어있습니다.');
    }

    const rawMax = typeof input['max_results'] === 'number' ? input['max_results'] : 10;
    const maxResults = Math.max(1, Math.min(20, Math.round(rawMax)));

    // 캐시 키 생성
    const cacheKey = `${query}|${maxResults}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SEARCH_CACHE_TTL) {
      return makeToolResult(`[Cached] ${cached.results}`);
    }

    let results: SearchResult[] = [];
    let fallbackUsed = false;

    // DuckDuckGo HTML 검색 시도
    try {
      results = await searchDuckDuckGo(query, maxResults);
    } catch (primaryErr) {
      // 폴백: DuckDuckGo Lite 검색
      try {
        results = await searchDuckDuckGoLite(query, maxResults);
        fallbackUsed = true;
      } catch (fallbackErr) {
        const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        return makeToolError(
          `검색 실패:\n  Primary: ${primaryMsg}\n  Fallback: ${fallbackMsg}`,
        );
      }
    }

    if (results.length === 0) {
      return makeToolResult(`"${query}"에 대한 검색 결과가 없습니다.`);
    }

    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`,
      )
      .join('\n\n');

    const header = fallbackUsed
      ? `Search results for: ${query} (fallback engine used)`
      : `Search results for: ${query}`;

    const output = `${header}\n\n${formatted}`;

    // 캐시 저장
    searchCache.set(cacheKey, { results: output, timestamp: Date.now() });

    return makeToolResult(output);
  },
};
