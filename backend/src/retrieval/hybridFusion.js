import { ragConfig } from '../config/rag.js';

// Hybrid fusion via Reciprocal Rank Fusion (RRF).
//
// Why RRF over a raw weighted score sum: cosine similarity and ts_rank live on
// different, non-comparable scales. RRF fuses by *rank* — it needs no score
// calibration, is fully deterministic, and rewards chunks that surface in both
// the vector and lexical lists. We keep the original scores/ranks on each
// candidate for debugging, and expose weights so the two signals can be tuned.
//
//   rrf(candidate) = vectorWeight/(k + vectorRank) + lexicalWeight/(k + lexicalRank)

export function rrfFusion(vectorResults = [], lexicalResults = [], opts = {}) {
  const {
    k = ragConfig.rrfK,
    vectorWeight = ragConfig.vectorWeight,
    lexicalWeight = ragConfig.lexicalWeight,
    limit = ragConfig.hybridCandidateCount,
  } = opts;

  const byChunk = new Map(); // chunkId -> merged candidate

  const add = (list, kind, weight) => {
    list.forEach((c, idx) => {
      const rank = c.retrieval?.[`${kind}Rank`] ?? idx + 1;
      const id = c.chunkId;
      let entry = byChunk.get(id);
      if (!entry) {
        entry = { ...c, retrieval: { ...(c.retrieval || {}) } };
        byChunk.set(id, entry);
      }
      entry.retrieval[`${kind}Rank`] = rank;
      entry.retrieval[`${kind}Score`] =
        c.retrieval?.[`${kind}Score`] ?? entry.retrieval[`${kind}Score`];
      entry.retrieval[`${kind}Rrf`] = weight / (k + rank);
      entry.hybridScore = (entry.hybridScore || 0) + weight / (k + rank);
    });
  };

  add(vectorResults, 'vector', vectorWeight);
  add(lexicalResults, 'lexical', lexicalWeight);

  const fused = [...byChunk.values()].sort((a, b) => {
    if (b.hybridScore !== a.hybridScore) return b.hybridScore - a.hybridScore;
    // Deterministic tie-break so identical inputs always yield identical order.
    return String(a.chunkUid || a.chunkId).localeCompare(String(b.chunkUid || b.chunkId));
  });

  return fused.slice(0, limit);
}
