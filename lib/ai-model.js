/**
 * CI AI translation model labeling. Each archived segment carries its
 * serving model's display name next to the translation
 * (`sectionsZh[key][i].aiModel`, written by scripts/translate-ai.mjs from
 * AI_MODEL_LABEL). Segments translated before the field existed have no
 * model recorded — they were all produced by the model below, so the UI
 * falls back to it instead of showing "unknown".
 */
export const DEFAULT_AI_MODEL = 'GLM 5.3 Flash';

/** Recorded model label, or the historical default when absent. */
export const aiModelOf = (m) => (typeof m === 'string' && m.trim() ? m.trim() : DEFAULT_AI_MODEL);
