import { parseArgs } from 'node:util';
import { assertEnv } from '../config/env.js';
import { getPool, closePool } from '../db/pool.js';
import { embedSource } from '../ingest/embedSource.js';
import { embeddingConfigured, embeddingProviderInfo, embeddingSetupHint } from '../ingest/embeddingProvider.js';

const HELP = `
npm run ingest:embeddings -- --book <slug> --edition <label>

  Populates pgvector embeddings for the chunks of ONE source that are still NULL.
  Resumable: already-embedded chunks are never regenerated. Safe to re-run after
  a crash or a provider outage. Never deletes chunks/pages/citations.

  --book, -b     book slug        (required)
  --edition, -e  edition label    (required)
  --help, -h     this message
`;

function fail(msg, code = 1) {
  console.error(`\nERROR: ${msg}`);
  process.exit(code);
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        book: { type: 'string', short: 'b' },
        edition: { type: 'string', short: 'e' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    fail(err.message);
  }
  if (values.help) return console.log(HELP);
  if (!values.book || !values.edition) {
    console.log(HELP);
    return fail('--book and --edition are required');
  }
  assertEnv();
  if (!getPool()) fail('DATABASE_URL is not set — embeddings write to PostgreSQL');
  const info = embeddingProviderInfo();
  console.log(`Embedding provider: ${info.provider}${info.model ? ` (${info.model})` : ''}`);
  if (!embeddingConfigured()) {
    fail(`EMBEDDING_NOT_CONFIGURED: ${embeddingSetupHint()}`);
  }

  try {
    const r = await embedSource({ slug: values.book, edition: values.edition, log: (...a) => console.log(...a) });
    console.log('\n============ EMBEDDING BACKFILL SUMMARY (real DB values) ============');
    console.log(`SOURCE          : ${values.book}/${values.edition}`);
    console.log(`PROVIDER        : ${info.provider}${info.model ? ` (${info.model})` : ''}`);
    console.log(`TOTAL CHUNKS    : ${r.total}`);
    console.log(`EMBEDDED        : ${r.embedded}`);
    console.log(`NULL EMBEDDINGS : ${r.nullEmbeddings}`);
    console.log(`DIMENSION       : ${r.dim}`);
    console.log(`VECTOR-READY    : ${r.ok ? 'YES' : 'NO'}`);
    console.log('=====================================================================');
    await closePool();
    process.exit(r.ok ? 0 : 2);
  } catch (err) {
    await closePool().catch(() => {});
    const code = err?.code || err?.message || 'EMBEDDING_JOB_FAILED';
    // A dimension mismatch carries the exact stop-report (e.g.
    // JINA_EMBEDDING_DIMENSION_MISMATCH expected=384 actual=1024) — print it in
    // full instead of only the JSON detail.
    const report = err?.detail?.report;
    const detail = err?.detail ? ` ${JSON.stringify(err.detail)}` : '';
    fail((report ? `${report}\n\n${code}` : code) + detail);
  }
}

main();
