// Secret attribute values that must never be stored in the export (handoff rule: the LLM key stays on the
// server's config asset only; stored auth tokens are credentials). Values are replaced, keys are kept.
export const SECRET_KEYS = /^(dbb_llm_api_key|authToken|.*(api_?key|token|secret|password).*)$/i;
export const redactAttrs = (list) => (list || []).map((a) => (SECRET_KEYS.test(a.key) ? { ...a, value: '<redacted>' } : a));
