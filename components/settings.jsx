'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { AI_MODELS, aiTranslate } from './ai-translate';

/* ---------------- constants ---------------- */

export const CHANNELS = [
  { id: 'deepl', label: 'DeepL' },
  { id: 'youdao', label: '有道' },
  { id: 'caiyun', label: '彩云' },
  { id: 'iflyrec', label: '讯飞' },
  { id: 'ai', label: 'AI' },
];

export const channelLabel = (id) => CHANNELS.find((c) => c.id === id)?.label || id;

const DEFAULT_SETTINGS = {
  defaultChannel: 'deepl',
  sidebarChannels: ['deepl', 'youdao', 'caiyun', 'iflyrec', 'ai'],
  ai: { baseUrl: '', apiKey: '', model: AI_MODELS[0] },
};

const LANG_KEY = 'stmt-lang-v2';
const SETTINGS_KEY = 'stmt-settings-v1';

function loadLang(defaultChannel) {
  try {
    const raw = window.localStorage.getItem(LANG_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && ['en', 'zh', 'both'].includes(v.mode) && typeof v.channel === 'string') return v;
    }
    // migrate v1 ("en" | "zh" | "both")
    const legacy = window.localStorage.getItem('stmt-lang');
    if (legacy === 'zh') return { mode: 'zh', channel: defaultChannel };
    if (legacy === 'both') return { mode: 'both', channel: defaultChannel };
  } catch {}
  return { mode: 'en', channel: defaultChannel }; // default: English original
}

function loadSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...v,
        ai: { ...DEFAULT_SETTINGS.ai, ...(v.ai || {}) },
      };
    }
  } catch {}
  return DEFAULT_SETTINGS;
}

/* ---------------- context ---------------- */

const SettingsContext = createContext(null);

export function useSettings() {
  return useContext(SettingsContext);
}

export function SettingsProvider({ children }) {
  const [settings, setSettingsState] = useState(DEFAULT_SETTINGS);
  const [lang, setLangState] = useState({ mode: 'en', channel: DEFAULT_SETTINGS.defaultChannel });
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    setSettingsState(loadSettings());
    setLangState(loadLang(loadSettings().defaultChannel));
  }, []);

  const setSettings = (next) => {
    setSettingsState((prev) => {
      const merged = typeof next === 'function' ? next(prev) : { ...prev, ...next };
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
      } catch {}
      return merged;
    });
  };

  const setLang = (next) => {
    setLangState((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      try {
        window.localStorage.setItem(LANG_KEY, JSON.stringify(v));
      } catch {}
      return v;
    });
  };

  const value = {
    lang,
    setLang,
    settings,
    setSettings,
    openSettings: () => setDialogOpen(true),
    aiReady: !!(settings.ai.baseUrl && settings.ai.apiKey),
  };

  return (
    <SettingsContext.Provider value={value}>
      {children}
      {dialogOpen && <SettingsDialog onClose={() => setDialogOpen(false)} />}
    </SettingsContext.Provider>
  );
}

/* ---------------- gear button (top-right, in SiteHeader) ---------------- */

function GearIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

export function SettingsGearButton() {
  const { openSettings } = useSettings();
  return (
    <button
      type="button"
      onClick={openSettings}
      title="翻译设置"
      aria-label="翻译设置"
      className="inline-flex size-8 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors hover:text-foreground"
    >
      <GearIcon className="size-4" />
    </button>
  );
}

/* ---------------- settings dialog ---------------- */

const inputCls =
  'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-primary/60';

function Field({ label, hint, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] leading-relaxed text-muted-foreground/70">{hint}</span>}
    </label>
  );
}

function SettingsDialog({ onClose }) {
  const { settings, setSettings, setLang, aiReady } = useSettings();
  const [ai, setAi] = useState(settings.ai);
  const [test, setTest] = useState(null); // {state: 'loading'|'ok'|'fail', msg}

  const patchAi = (p) => setAi((prev) => ({ ...prev, ...p }));

  const saveAi = () => {
    setSettings((prev) => ({ ...prev, ai }));
  };

  const runTest = async () => {
    setTest({ state: 'loading' });
    try {
      const out = await aiTranslate('Print the maximum total tastiness.', ai);
      setTest({ state: 'ok', msg: out });
    } catch (e) {
      setTest({ state: 'fail', msg: e.message });
    }
  };

  const toggleChannel = (id) => {
    const has = settings.sidebarChannels.includes(id);
    const next = has
      ? settings.sidebarChannels.filter((c) => c !== id)
      : [...CHANNELS.map((c) => c.id).filter((c) => settings.sidebarChannels.includes(c) || c === id)];
    setSettings({ sidebarChannels: next });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[8vh]" onClick={onClose}>
      <div
        className="w-full max-w-md space-y-5 rounded-xl border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">翻译设置</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">默认中文渠道（侧栏首次选择中文时使用）</p>
          <div className="flex flex-wrap gap-1.5">
            {CHANNELS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setSettings({ defaultChannel: c.id });
                  setLang((prev) => ({ ...prev, channel: c.id }));
                }}
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  settings.defaultChannel === c.id
                    ? 'border-primary/60 bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">侧栏显示的翻译渠道</p>
          <div className="flex flex-wrap gap-1.5">
            {CHANNELS.map((c) => {
              const on = settings.sidebarChannels.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleChannel(c.id)}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
                    on ? 'border-primary/60 bg-primary/10 text-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <span className={`inline-block size-2 rounded-full ${on ? 'bg-primary' : 'bg-border'}`} />
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <p className="text-xs font-medium text-muted-foreground">
            自定义 AI 翻译（OpenAI 兼容接口，浏览器直连，Key 仅保存在本机）
          </p>
          <Field label="Base URL" hint="HTTPS 部署的站点需填写 HTTPS 地址，否则浏览器会拦截混合内容">
            <input
              className={inputCls}
              placeholder="http://localhost:3000"
              value={ai.baseUrl}
              onChange={(e) => patchAi({ baseUrl: e.target.value.trim() })}
            />
          </Field>
          <Field label="API Key">
            <input
              className={inputCls}
              type="password"
              placeholder="sk-..."
              value={ai.apiKey}
              onChange={(e) => patchAi({ apiKey: e.target.value.trim() })}
            />
          </Field>
          <Field label="模型">
            <select className={inputCls} value={ai.model} onChange={(e) => patchAi({ model: e.target.value })}>
              {AI_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runTest}
              disabled={!ai.baseUrl || !ai.apiKey || test?.state === 'loading'}
              className="rounded-md border bg-background px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              {test?.state === 'loading' ? '测试中…' : '测试连接'}
            </button>
            <button
              type="button"
              onClick={saveAi}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
            >
              保存
            </button>
            {aiReady && settings.ai.apiKey === ai.apiKey && settings.ai.baseUrl === ai.baseUrl && (
              <span className="text-[11px] text-emerald-500">已配置</span>
            )}
          </div>
          {test && (
            <p className={`text-[11px] leading-relaxed ${test.state === 'ok' ? 'text-emerald-500' : 'text-red-400'}`}>
              {test.state === 'ok' ? `✓ ${test.msg}` : `✗ ${test.msg}`}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-md border py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          完成
        </button>
      </div>
    </div>
  );
}
