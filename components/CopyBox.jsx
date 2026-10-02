'use client';

import { useState } from 'react';

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
    <div className="sample-box">
      <div className="sample-box-head">
        <span className={`sample-label ${label === 'Input' ? 'in' : 'out'}`}>{label}</span>
        <button type="button" className="copy-btn" onClick={copy} aria-label={`复制${label}`}>
          {copied ? '已复制 ✓' : '复制'}
        </button>
      </div>
      <pre className="sample-pre">
        <code>{text}</code>
      </pre>
    </div>
  );
}
