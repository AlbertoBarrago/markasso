import { readStorage, writeStorage } from '../io/safe_storage';
import { detectLocale, type Locale } from './detect';
import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import it from './locales/it.json';
import ja from './locales/ja.json';
import pt from './locales/pt.json';
import zh from './locales/zh.json';

const STORAGE_KEY = 'markasso-locale';

export type { Locale };

export const LOCALES: Record<Locale, string> = {
  it: 'Italiano',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  zh: '中文',
  ja: '日本語',
};

const dicts: Record<Locale, Record<string, string>> = {
  it,
  en,
  es,
  fr,
  de,
  pt,
  zh,
  ja,
};

const current: Locale = detectLocale(
  readStorage(STORAGE_KEY),
  navigator.languages.length > 0 ? navigator.languages : [navigator.language],
);
document.documentElement.lang = current;

export function t(key: string): string {
  return dicts[current][key] ?? dicts.en[key] ?? key;
}

/**
 * Saves the language and reloads to apply it. Returns false, without
 * reloading, when the browser refuses to store it: a reload would apply
 * nothing and could lose a drawing that storage could not keep either.
 */
export function setLocale(locale: Locale): boolean {
  if (!writeStorage(STORAGE_KEY, locale)) return false;
  location.reload();
  return true;
}

export function getLocale(): Locale {
  return current;
}
