import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Parameter, Stage } from '../data/stages';
import { demoEnglish } from '../data/demo-english';

export type DemoLanguage = 'zh' | 'en';
export type DemoTranslate = (text: string, values?: Record<string, string | number>) => string;
const languageKey = 'tinylens-demo-language-v1';

function readLanguage(key = languageKey): DemoLanguage {
  const query = new URLSearchParams(window.location.search).get('lang');
  if (query === 'en' || query === 'zh') return query;
  try { return localStorage.getItem(key) === 'en' ? 'en' : 'zh'; }
  catch { return 'zh'; }
}

function translate(text: string, language: DemoLanguage, values?: Record<string, string | number>): string {
  const localized = language === 'en' ? demoEnglish[text] ?? text : text;
  return localized.replace(/\{(\w+)\}/g, (match, key: string) => String(values?.[key] ?? match));
}

// Shared controls retain their original Chinese copy in the live AI workspace.
const DemoI18n = createContext({
  language: 'zh' as DemoLanguage,
  t: ((text, values) => translate(text, 'zh', values)) as DemoTranslate,
  setLanguage: (_language: DemoLanguage) => {},
});

export function DemoLanguageProvider({ children, mode = 'demo' }: { children: ReactNode; mode?: 'demo' | 'live' }) {
  const storageKey = mode === 'live' ? 'tinylens-live-language-v1' : languageKey;
  const [language, updateLanguage] = useState<DemoLanguage>(() => readLanguage(storageKey));
  const t = useCallback<DemoTranslate>((text, values) => translate(text, language, values), [language]);
  const setLanguage = useCallback((next: DemoLanguage) => {
    updateLanguage(next);
    const url = new URL(window.location.href);
    url.searchParams.set('lang', next);
    window.history.replaceState(null, '', url);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    document.title = mode === 'live' ? 'TinyLens · Lens workspace' : language === 'en' ? 'TinyLens · Interactive prototype' : 'TinyLens · 交互原型';
    if (mode === 'demo') document.querySelector('meta[name="description"]')?.setAttribute('content', t('TinyLens 交互原型：查看阶段、编辑透镜弧区域并探索合成示例。'));
    try { localStorage.setItem(storageKey, language); } catch { /* Optional preference. */ }
  }, [language, t, mode, storageKey]);
  useEffect(() => {
    const onHistory = () => updateLanguage(readLanguage(storageKey));
    window.addEventListener('popstate', onHistory);
    return () => window.removeEventListener('popstate', onHistory);
  }, [storageKey]);

  return <DemoI18n.Provider value={{ language, t, setLanguage }}>{children}</DemoI18n.Provider>;
}

export const useDemoI18n = () => useContext(DemoI18n);

export function localizeParameter(parameter: Parameter, t: DemoTranslate): Parameter {
  return { ...parameter, name: t(parameter.name), description: t(parameter.description), value: t(parameter.value), unit: t(parameter.unit) };
}

export function localizeStage(stage: Stage, t: DemoTranslate): Stage {
  return {
    ...stage, title: t(stage.title), description: t(stage.description), model: t(stage.model), review: t(stage.review),
    outputs: stage.outputs.map(output => t(output)),
    parameters: stage.parameters.map(parameter => localizeParameter(parameter, t)),
    references: stage.references.map(reference => ({ ...reference, label: t(reference.label) })),
  };
}
