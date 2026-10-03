/**
 * Placeholder protection for machine translation — shared by the Node
 * pipeline (scripts/lib/translate.mjs) and the browser-side AI translation
 * (components/ai-translate.js). Pure JS, no node builtins.
 *
 * Math ($$$…$$$, $$…$$, $…$), inline code, image markdown and bare URLs are
 * masked out before MT and spliced back afterwards. Zero-padded ids: a bare
 * "[M0]" gets interpreted by some engines (iflyrec translates it as the
 * money-supply term 流通中现金); "[M07]" survives every engine tested.
 */

export function protectMath(text) {
  const stash = [];
  const masked = String(text).replace(
    /\$\$\$[\s\S]+?\$\$\$|\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|`[^`\n]+`|!\[[^\]]*\]\([^)]+\)|https?:\/\/\S+/g,
    (m) => `[M${String(stash.push(m) - 1).padStart(2, '0')}]`,
  );
  return { masked, stash };
}

export function restoreMath(translated, stash) {
  if (!stash.length) return translated;
  // Engines may answer with fullwidth brackets/letters/digits — fold them
  // back before matching, and count slots: any lost/mangled placeholder
  // fails the round.
  const normalized = String(translated)
    .replace(/[Ａ-Ｚａ-ｚ０-９【】［］]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（/g, '(')
    .replace(/）/g, ')');
  const found = normalized.match(/\[\s*M\s*\d+\s*\]/gi);
  if (!found || found.length !== stash.length) return null;
  return normalized.replace(/\[\s*M\s*(\d+)\s*\]/gi, (_, n) => {
    const i = Number(n);
    return i < stash.length ? stash[i] : '';
  });
}
