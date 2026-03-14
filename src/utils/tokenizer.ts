import { getEncoding, encodingForModel } from 'js-tiktoken';
import type { Tiktoken, TiktokenModel } from 'js-tiktoken';
import type { ContentBlock } from '../llm/types.js';

// 인코더 인스턴스 캐시 (모델/인코딩별로 재사용)
const encoderCache = new Map<string, Tiktoken>();

/**
 * 지정된 모델에 맞는 인코더를 가져온다.
 * 알 수 없는 모델이면 cl100k_base 폴백.
 */
function getEncoder(model?: string): Tiktoken {
  const cacheKey = model ?? 'cl100k_base';

  const cached = encoderCache.get(cacheKey);
  if (cached) return cached;

  try {
    const encoder = model
      ? encodingForModel(model as TiktokenModel)
      : getEncoding('cl100k_base');
    encoderCache.set(cacheKey, encoder);
    return encoder;
  } catch {
    // 모델을 인식 못 하면 cl100k_base 사용
    const fallback = encoderCache.get('cl100k_base');
    if (fallback) return fallback;

    const encoder = getEncoding('cl100k_base');
    encoderCache.set('cl100k_base', encoder);
    return encoder;
  }
}

/**
 * 텍스트의 토큰 수를 정확하게 계산한다.
 * tiktoken 실패 시 chars/4 폴백.
 */
export function countTokens(text: string, model?: string): number {
  if (!text) return 0;

  try {
    const encoder = getEncoder(model);
    return encoder.encode(text).length;
  } catch {
    // 폴백: 대략 4글자당 1토큰
    return Math.ceil(text.length / 4);
  }
}

/**
 * ContentBlock 배열의 토큰 수를 계산한다.
 * 텍스트가 아닌 블록은 JSON 문자열로 변환하여 카운트.
 */
export function countContentBlockTokens(blocks: ContentBlock[], model?: string): number {
  let total = 0;

  for (const block of blocks) {
    if (block.type === 'text') {
      total += countTokens(block.text, model);
    } else if (block.type === 'tool_use') {
      total += countTokens(block.name, model);
      total += countTokens(JSON.stringify(block.input), model);
    } else if (block.type === 'tool_result') {
      if (typeof block.content === 'string') {
        total += countTokens(block.content, model);
      } else {
        total += countTokens(JSON.stringify(block.content), model);
      }
    } else {
      // image 등 기타 블록
      total += countTokens(JSON.stringify(block), model);
    }
  }

  return total;
}

/**
 * Message content(string 또는 ContentBlock[])의 토큰 수를 계산한다.
 */
export function countMessageTokens(content: string | ContentBlock[], model?: string): number {
  if (typeof content === 'string') {
    return countTokens(content, model);
  }
  return countContentBlockTokens(content, model);
}
