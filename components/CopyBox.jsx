'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function CopyBox({ label, text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5">
        <span
          className={`text-xs font-semibold uppercase tracking-wider ${
            label === 'Input' ? 'text-blue-500 dark:text-blue-400' : 'text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {label}
        </span>
        <Button variant="ghost" size="icon" className="size-6" onClick={copy} aria-label={`复制${label}`}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-6 text-foreground/90">
        <code>{text}</code>
      </pre>
    </div>
  );
}
