import { createContext, useContext, useMemo } from 'react';
import de from './de.js';
import en from './en.js';

const DICTS = { de, en };
const I18nContext = createContext(null);

// Minimal ICU subset: {name} and {count, plural, one {...} other {...}} with # for the number.
function format(template, vars, locale) {
  const plural = new Intl.PluralRules(locale);
  let out = template.replace(/\{(\w+), plural, ((?:[^{}]|\{[^{}]*\})*)\}/g, (_, key, body) => {
    const n = Number(vars[key] ?? 0);
    const forms = Object.fromEntries([...body.matchAll(/(\w+) \{([^{}]*)\}/g)].map((m) => [m[1], m[2]]));
    const form = forms[`=${n}`] ?? forms[plural.select(n)] ?? forms.other ?? '';
    return form.replace(/#/g, n.toLocaleString(locale));
  });
  out = out.replace(/\{(\w+)\}/g, (m, key) => (vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : m));
  return out;
}

export function resolveLanguage(locale) {
  return (locale ?? '').toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function I18nProvider({ lang, children }) {
  const value = useMemo(() => {
    const dict = DICTS[lang] ?? DICTS.en;
    const locale = lang === 'de' ? 'de-DE' : 'en-GB';
    const t = (key, vars = {}) => format(dict[key] ?? DICTS.en[key] ?? key, vars, locale);
    const dateTime = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const date = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
    const rel = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const relative = (ts) => {
      const diff = (ts - Date.now()) / 1000;
      const abs = Math.abs(diff);
      if (abs < 60) return rel.format(Math.round(diff), 'second');
      if (abs < 3600) return rel.format(Math.round(diff / 60), 'minute');
      if (abs < 86400) return rel.format(Math.round(diff / 3600), 'hour');
      if (abs < 86400 * 30) return rel.format(Math.round(diff / 86400), 'day');
      return date.format(ts);
    };
    return {
      lang,
      locale,
      t,
      fmt: { dateTime: (ts) => dateTime.format(ts), date: (ts) => date.format(ts), time: (ts) => time.format(ts), relative },
    };
  }, [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
