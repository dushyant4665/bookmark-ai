import { env } from '../config/env.js';
import { ragConfig } from '../config/rag.js';

// Reranking layer (Phase 3 §14).
//
//   Retriever -> candidate evidence -> Reranker -> best evidence
//
// A remote cross-encoder is OPTIONAL and configured only through env. When no
// reranker provider is configured we do NOT invent relevance scores: we keep
// the deterministic hybrid (RRF) order and label the stage honestly as
// NOT_CONFIGURED. Pretending a reranker ran would violate the project's core
// rule that every number the user sees is real.

class HuggingFaceReranker {
  name = 'huggingface';
  constructor({ apiKey, model }) {
    this.apiKey = apiKey;
    this.model = model;
  }
  modelId() {
    return this.model;
  }
  // Returns an array of scores aligned to `texts` order (higher = more
  // relevant). The HF rerank endpoint returns ranked results, so we map them
  // back to input order here and leave the ordering decision to rerank().
  async rank(query, texts) {
    if (!texts.length) return [];
    const url = `https://api-inference.huggingface.co/rerank/${this.model}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, texts, top_n: texts.length, raw_scores: false }),
    });
    if (!res.ok) throw new Error(`RERANK_ERROR_${res.status}`);
    const json = await res.json().catch(() => null);
    if (!Array.isArray(json)) throw new Error('RERANK_MALFORMED_RESPONSE');
    const scores = new Array(texts.length).fill(null);
    json.forEach((item, i) => {
      const idx = Number.isInteger(item?.index) ? item.index : i;
      if (idx < 0 || idx >= texts.length) return;
      const s = Number(item?.score ?? item?.relevance_score);
      if (Number.isFinite(s)) scores[idx] = s;
    });
    return scores;
  }
}

// Build a reranker only when both a model name and a key are configured.
// Returns null otherwise — callers must handle the honest fallback path.
export function makeReranker() {
  if (!ragConfig.rerankerModel || !env.hfApiKey) return null;
  return new HuggingFaceReranker({ apiKey: env.hfApiKey, model: ragConfig.rerankerModel });
}

// Keep deterministic hybrid order; used both for NOT_CONFIGURED and for a
// configured provider that fails at runtime. Never fabricates scores: the
// rerank score mirrors the existing hybrid score, which is already real.
function hybridFallback(candidates, topN, provider) {
  const ranked = candidates.slice(0, topN).map((c, i) => ({
    ...c,
    rerank: {
      provider,
      rank: i + 1,
      score: c.hybridScore ?? null,
      note: 'deterministic hybrid (RRF) order preserved',
    },
  }));
  return { provider, ranked };
}

// query: the text used for relevance (searchQuery). candidates: fused list.
// reranker: injected provider or null. topN: rerank output budget.
export async function rerank({ query, candidates = [], reranker = null, topN = ragConfig.rerankerTopN }) {
  if (!candidates.length) return { provider: 'NOT_CONFIGURED', ranked: [] };

  if (!reranker) {
    return hybridFallback(candidates, topN, 'NOT_CONFIGURED');
  }

  try {
    const texts = candidates.map((c) => c.text);
    const scores = await reranker.rank(query, texts);
    const scored = candidates.map((c, i) => ({
      ...c,
      _rerankScore: Number.isFinite(scores[i]) ? scores[i] : null,
    }));
    // Items the provider failed to score sink to the bottom; ties break
    // deterministically on a stable identity so identical input -> identical order.
    scored.sort((a, b) => {
      const av = a._rerankScore;
      const bv = b._rerankScore;
      if (av === bv) return String(a.chunkUid || a.chunkId).localeCompare(String(b.chunkUid || b.chunkId));
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
    const ranked = scored.slice(0, topN).map((c, i) => ({
      ...c,
      rerank: {
        provider: reranker.name,
        model: reranker.model,
        rank: i + 1,
        score: c._rerankScore,
      },
    }));
    return { provider: reranker.name, ranked };
  } catch {
    // Configured but unavailable: degrade honestly, never invent an ordering.
    return hybridFallback(candidates, topN, 'HYBRID_FALLBACK_AFTER_ERROR');
  }
}
