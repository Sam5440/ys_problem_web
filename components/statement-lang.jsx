'use client';

import { createContext, useContext, useEffect, useState } from 'react';

const STORAGE_KEY = 'stmt-lang';
const StatementLangContext = createContext({ lang: 'en', setLang: () => {} });

// Statement display language: en (original) / zh (translation) / both (aligned).
// Defaults to the English original on every visit; the choice persists locally.
export function StatementLangProvider({ children }) {
  const [lang, setLang] = useState('en');
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'both') setLang(saved);
  }, []);
  return (
    <StatementLangContext.Provider
      value={{
        lang,
        setLang: (next) => {
          setLang(next);
          window.localStorage.setItem(STORAGE_KEY, next);
        },
      }}
    >
      {children}
    </StatementLangContext.Provider>
  );
}

export const useStatementLang = () => useContext(StatementLangContext);

export function LangSwitch({ className = '' }) {
  const { lang, setLang } = useStatementLang();
  const options = [
    ['en', '英文'],
    ['zh', '中文'],
    ['both', '对照'],
  ];
  return (
    <div
      className={`inline-flex items-center gap-0.5 rounded-md border bg-card p-0.5 ${className}`}
      role="group"
      aria-label="题面语言"
    >
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => setLang(value)}
          className={`rounded px-2 py-1 text-xs transition-colors ${
            lang === value
              ? 'bg-primary font-medium text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
