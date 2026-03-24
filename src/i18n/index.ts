import { en } from './en.js';
import { ko } from './ko.js';

export type Locale = 'en' | 'ko';

const translations: Record<Locale, Record<string, string>> = { en, ko };

let currentLocale: Locale = 'en';

/**
 * Set the current locale.
 */
export function setLocale(locale: Locale): void {
  if (locale in translations) {
    currentLocale = locale;
  }
}

/**
 * Get the current locale.
 */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Get all supported locale codes.
 */
export function getSupportedLocales(): Locale[] {
  return Object.keys(translations) as Locale[];
}

/**
 * Translate a key with optional interpolation.
 * Placeholders: {0}, {1}, {2}, ...
 */
export function t(key: string, ...args: (string | number)[]): string {
  const map = translations[currentLocale] || translations['en']!;
  let text = map[key] ?? translations['en']![key] ?? key;

  for (let i = 0; i < args.length; i++) {
    text = text.replace(new RegExp(`\\{${i}\\}`, 'g'), String(args[i]));
  }

  return text;
}

/**
 * Detect locale from OS settings.
 * Uses Intl API which works on both macOS and Windows.
 */
export function detectOsLocale(): Locale {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    const lang = resolved.split('-')[0]!.toLowerCase();
    if (lang in translations) {
      return lang as Locale;
    }
  } catch {
    // Intl not available
  }

  // Fallback: check LANG / LC_ALL env vars (Unix)
  const envLang = process.env['LANG'] || process.env['LC_ALL'] || '';
  const envCode = envLang.split(/[_.]/)[0]!.toLowerCase();
  if (envCode in translations) {
    return envCode as Locale;
  }

  return 'en';
}

/**
 * Detect language from user input text using Unicode ranges.
 */
export function detectPromptLanguage(text: string): Locale | null {
  // Count characters in different Unicode ranges
  let hangul = 0;
  let latin = 0;
  let total = 0;

  for (const char of text) {
    const code = char.codePointAt(0)!;
    // Skip whitespace and punctuation
    if (code <= 0x7e && !/[a-zA-Z]/.test(char)) continue;

    total++;

    // Hangul Syllables (AC00-D7AF) + Hangul Jamo (1100-11FF) + Hangul Compatibility Jamo (3130-318F)
    if (
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f)
    ) {
      hangul++;
    }
    // Basic Latin letters
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latin++;
    }
  }

  if (total === 0) return null;

  const hangulRatio = hangul / total;
  if (hangulRatio > 0.3) return 'ko';
  if (latin / total > 0.5) return 'en';

  return null;
}

/**
 * Get the display name for a locale (in that locale's own language).
 */
export function getLocaleDisplayName(locale: Locale): string {
  switch (locale) {
    case 'en': return 'English';
    case 'ko': return '한국어';
    default: return locale;
  }
}
