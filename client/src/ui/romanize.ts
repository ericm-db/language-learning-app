// Re-export of the deterministic Telugu->IAST romanizer, which now lives in
// core/ so store/ and ui/ can both use it without crossing a layer boundary.
// Kept here so existing ui/ imports (TranscriptPanes, ReviewScreen, ...) are
// unchanged.

export { romanize } from '../core/romanize';
