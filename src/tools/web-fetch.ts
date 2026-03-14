import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

// In-memory cache with per-entry TTL
const cache: Map<string, { content: string; timestamp: number; ttl: number }> = new Map();
const DEFAULT_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_TEXT_LEN = 50_000;

const USER_AGENT =
  'Mozilla/5.0 (compatible; Codi/0.1; +https://github.com/gemdoq/codi)';

/**
 * Content-Type 헤더에서 charset 추출
 */
function extractCharset(contentType: string): string | null {
  const match = contentType.match(/charset=([^\s;]+)/i);
  return match && match[1] ? match[1].replace(/['"]/g, '') : null;
}

/**
 * Cache-Control 헤더에서 max-age 값을 밀리초로 반환
 */
function parseCacheMaxAge(headers: Headers): number | null {
  const cc = headers.get('cache-control');
  if (!cc) return null;
  const match = cc.match(/max-age=(\d+)/);
  if (!match || !match[1]) return null;
  const seconds = parseInt(match[1], 10);
  if (isNaN(seconds) || seconds <= 0) return null;
  // 최소 60초, 최대 1시간으로 제한
  const clamped = Math.max(60, Math.min(seconds, 3600));
  return clamped * 1000;
}

/**
 * URL이 PDF인지 판별 (확장자 또는 Content-Type 기반)
 */
function isPdf(url: string, contentType: string): boolean {
  return (
    contentType.includes('application/pdf') ||
    /\.pdf(\?|#|$)/i.test(url)
  );
}

/**
 * URL이 JSON API 응답인지 판별
 */
function isJson(contentType: string): boolean {
  return contentType.includes('application/json') || contentType.includes('+json');
}

/**
 * HTML에서 텍스트 추출 (cheerio 사용)
 */
async function extractHtmlText(html: string): Promise<string> {
  const { load } = await import('cheerio');
  const $ = load(html);

  // 불필요한 요소 제거
  $('script, style, nav, header, footer, iframe, noscript, svg, [role="navigation"], [role="banner"], .sidebar, .ad, .ads, .advertisement').remove();

  // 메인 콘텐츠 영역 탐색
  const main = $('main, article, .content, #content, .main, [role="main"]').first();
  let text = (main.length ? main.text() : $('body').text());

  // 공백 정리
  text = text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

/**
 * PDF 바이너리에서 텍스트 추출 (pdf-parse v2)
 */
async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const textResult = await parser.getText();
    const text = textResult.text?.trim() || '';
    const totalPages = textResult.total ?? 'unknown';

    // 메타데이터도 가져오기 시도
    let infoStr = `Pages: ${totalPages}`;
    try {
      const info = await parser.getInfo();
      if (info.info?.Title) infoStr += ` | Title: ${info.info.Title}`;
      if (info.info?.Author) infoStr += ` | Author: ${info.info.Author}`;
    } catch {
      // 메타데이터 추출 실패는 무시
    }

    return `[PDF] ${infoStr}\n\n${text}`;
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/**
 * JSON 응답 포맷팅
 */
function formatJson(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return `[JSON Response]\n${JSON.stringify(parsed, null, 2)}`;
  } catch {
    return `[JSON Response - parse error]\n${raw}`;
  }
}

/**
 * 응답 바디를 문자열로 디코딩 (charset 처리)
 */
async function decodeResponse(response: Response, contentType: string): Promise<string> {
  const charset = extractCharset(contentType);
  if (charset && charset.toLowerCase() !== 'utf-8' && charset.toLowerCase() !== 'utf8') {
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder(charset);
    return decoder.decode(buffer);
  }
  return response.text();
}

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: `Fetch content from a URL and return extracted text. Supports HTML (cheerio), PDF (pdf-parse), and JSON. Includes caching. HTTP URLs are upgraded to HTTPS.`,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      prompt: { type: 'string', description: 'What information to extract from the page' },
      cache_ttl: {
        type: 'number',
        description: 'Cache TTL in seconds (default: 900, i.e. 15 minutes). Set to 0 to bypass cache.',
      },
    },
    required: ['url', 'prompt'],
  },
  dangerous: true,
  readOnly: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    let url = String(input['url']);
    const prompt = String(input['prompt'] || '');
    const cacheTtlInput = input['cache_ttl'];
    const requestTtl =
      typeof cacheTtlInput === 'number' ? cacheTtlInput * 1000 : null;
    const bypassCache = requestTtl === 0;

    // HTTP -> HTTPS 업그레이드
    if (url.startsWith('http://')) {
      url = url.replace('http://', 'https://');
    }

    // 캐시 확인
    if (!bypassCache) {
      const cached = cache.get(url);
      if (cached && Date.now() - cached.timestamp < cached.ttl) {
        return makeToolResult(
          `[Cached] ${prompt ? `Query: ${prompt}\n\n` : ''}${cached.content}`,
        );
      }
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,application/pdf;q=0.7,*/*;q=0.5',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });

      // HTTP 에러 처리 (상세 메시지)
      if (!response.ok) {
        const status = response.status;
        const statusText = response.statusText || 'Unknown';
        let detail = `HTTP ${status} ${statusText}`;
        if (status === 403 || status === 401) {
          detail += ' - 접근이 차단되었습니다. 인증이 필요하거나 봇 차단일 수 있습니다.';
        } else if (status === 404) {
          detail += ' - 페이지를 찾을 수 없습니다.';
        } else if (status === 429) {
          detail += ' - 요청이 너무 많습니다. 잠시 후 다시 시도하세요.';
        } else if (status >= 500) {
          detail += ' - 서버 오류입니다.';
        }
        // 리다이렉트 정보
        if (response.redirected) {
          detail += `\nRedirected to: ${response.url}`;
        }
        return makeToolError(detail);
      }

      // Content-Length 확인 (5MB 제한)
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
        return makeToolError(
          `응답 크기가 너무 큽니다 (${(parseInt(contentLength, 10) / 1024 / 1024).toFixed(1)}MB). 최대 5MB까지 지원합니다.`,
        );
      }

      const contentType = response.headers.get('content-type') || '';
      let text: string;

      // PDF 처리
      if (isPdf(url, contentType)) {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_RESPONSE_SIZE) {
          return makeToolError(
            `PDF 크기가 너무 큽니다 (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB). 최대 5MB까지 지원합니다.`,
          );
        }
        text = await extractPdfText(buffer);
      }
      // JSON 처리
      else if (isJson(contentType)) {
        const raw = await decodeResponse(response, contentType);
        text = formatJson(raw);
      }
      // HTML 처리
      else if (
        contentType.includes('text/html') ||
        contentType.includes('application/xhtml')
      ) {
        const html = await decodeResponse(response, contentType);
        text = await extractHtmlText(html);
      }
      // 기타 텍스트
      else {
        text = await decodeResponse(response, contentType);
      }

      // 텍스트 길이 제한
      if (text.length > MAX_TEXT_LEN) {
        text = text.slice(0, MAX_TEXT_LEN) + '\n\n... (truncated)';
      }

      // 캐시 TTL 결정: 요청 TTL > Cache-Control max-age > 기본값
      const effectiveTtl =
        requestTtl ?? parseCacheMaxAge(response.headers) ?? DEFAULT_CACHE_TTL;

      // 캐시 저장
      if (!bypassCache) {
        cache.set(url, { content: text, timestamp: Date.now(), ttl: effectiveTtl });
      }

      // 리다이렉트 알림
      let prefix = `URL: ${url}`;
      if (response.redirected && response.url !== url) {
        prefix += `\nRedirected to: ${response.url}`;
      }
      if (prompt) {
        prefix += `\nQuery: ${prompt}`;
      }

      return makeToolResult(`${prefix}\n\n${text}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('TimeoutError') || message.includes('aborted')) {
        return makeToolError(`요청 시간 초과 (30초): ${url}`);
      }
      if (message.includes('ENOTFOUND') || message.includes('getaddrinfo')) {
        return makeToolError(`도메인을 찾을 수 없습니다: ${url}`);
      }
      return makeToolError(`URL 가져오기 실패: ${message}`);
    }
  },
};
