import { env } from '../config/env.js';

// Phase 3 RAG configuration — one place, never scattered. Every production
// tunable lives here and reads from env so nothing is hardcoded across modules.
export const ragConfig = {
  // Retrieval widths (candidates are fetched wide, then fused/reranked narrow).
  vectorTopK: Number(process.env.VECTOR_TOP_K || 25),
  lexicalTopK: Number(process.env.LEXICAL_TOP_K || 25),

  // Hybrid fusion (Reciprocal Rank Fusion — see hybridFusion.js for the "why").
  rrfK: Number(process.env.RRF_K || 60),
  vectorWeight: Number(process.env.VECTOR_WEIGHT || 1.0),
  lexicalWeight: Number(process.env.LEXICAL_WEIGHT || 1.0),
  hybridCandidateCount: Number(process.env.HYBRID_CANDIDATE_COUNT || 25),

  // Reranker: optional remote cross-encoder; otherwise honest hybrid-order fallback.
  rerankerModel: process.env.RERANKER_MODEL || '',
  rerankerTopN: Number(process.env.RERANKER_TOP_N || 8),

  // Final evidence budget handed to Groq.
  finalEvidenceCount: Number(process.env.FINAL_EVIDENCE_COUNT || 5),

  // Insufficient-evidence heuristic (documented in researchService/generation):
  // require at least this many fused candidates AND that the best fused score
  // clear a floor before we treat the book as able to answer.
  minEvidenceCount: Number(process.env.MIN_EVIDENCE_COUNT || 1),
  minEvidenceScore: Number(process.env.MIN_EVIDENCE_SCORE || 0.0),

  // Conversation context window used for follow-up resolution / prompting.
  contextMessageLimit: Number(process.env.CONTEXT_MESSAGE_LIMIT || 6),
  maxMessageLength: Number(process.env.MAX_MESSAGE_LENGTH || 4000),

  // Embedding dimension the vector column was built for (verified at ingestion).
  embeddingDim: env.embeddingDim,
};
