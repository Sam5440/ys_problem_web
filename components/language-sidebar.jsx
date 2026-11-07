'use client';

import { useEffect, useState } from 'react';
import { useSettings, channelLabel } from './settings';

/**
 * 左下角语言切换浮标：英文 / 中文(每渠道) / 对照，per user's enabled
 * channels。全宽宽统一的 floating pill，向上展开；原先的右缘中部侧栏与
 * 右下角浮标合并于此——编译器面板占据右侧后两者不再冲突，打开面板时
 * 语言栏仍可用。
 */
export default function LanguageSidebar() {
  const { lang, setLang, settings, openSettings, aiReady } = useSettings();
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const channels = (settings.sidebarChannels || []).filter((id) =>
    ['deepl', 'youdao', 'caiyun', 'iflyrec', 'ai', 'ai_custom'].includes(id),
  );

  const pickChannel = (id) => {
    if (id === 'ai_custom' && !aiReady) {
      openSettings(); // configure the AI endpoint first
      return;
    }
    setLang({ mode: 'zh', channel: id });
  };

  const items = [
    {
      key: 'en',
      label: '英文',
      active: lang.mode === 'en',
      on: () => setLang((prev) => ({ mode: 'en', channel: prev.channel })),
    },
    ...channels.map((id) => ({
      key: `zh:${id}`,
      // the two AI entries carry their full label; the MT ones read 中文(渠道)
      label: id === 'ai' || id === 'ai_custom' ? channelLabel(id) : `中文(${channelLabel(id)})`,
      active: lang.mode === 'zh' && lang.channel === id,
      dim: id === 'ai_custom' && !aiReady,
      on: () => pickChannel(id),
    })),
    {
      key: 'both',
      label: '对照',
      active: lang.mode === 'both',
      on: () => setLang((prev) => ({ mode: 'both', channel: prev.channel })),
    },
  ];

  const list = (className) => (
    <div className={`w-40 space-y-0.5 rounded-xl border bg-card p-1.5 shadow-lg ${className || ''}`} role="radiogroup" aria-label="题面语言">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="radio"
          aria-checked={it.active}
          onClick={it.on}
          className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
            it.active
              ? 'bg-primary/15 font-medium text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          } ${it.dim && !it.active ? 'opacity-60' : ''}`}
        >
          <span className="truncate">{it.label}</span>
          {it.dim && (
            <span className="ml-1 shrink-0 rounded border border-amber-500/40 px-1 text-[9px] text-amber-500">
              未配置
            </span>
          )}
        </button>
      ))}
    </div>
  );

  return (
    <div className="fixed bottom-5 left-4 z-40">
      {expanded && list('mb-2')}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex size-10 items-center justify-center rounded-full border bg-card text-sm font-medium shadow-lg transition-colors hover:text-foreground"
        aria-label="题面语言"
        aria-expanded={expanded}
      >
        译
      </button>
    </div>
  );
}
