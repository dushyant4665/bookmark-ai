import { parseArgs } from 'node:util';
import { assertEnv } from '../config/env.js';
import { ingestBook } from '../ingest/ingestBook.js';
import { getPool } from '../db/pool.js';

const HELP = `
npm run ingest:book -- --book <slug> --edition <label> --file <path-to-pdf> [options]

  --book, -b       book slug (created if missing)            required
  --edition, -e    edition label (e.g. "default")             required
  --file, -f       path to a real source PDF                  required
  --title          display title (used when creating the book)
  --author         author (used when creating the book)
  --language       edition language
  --force          rebuild even if the same source hash was already ingested
  --no-embed       structural dry run: parse+chunk+store, NULL embeddings
  --help, -h       this message
`;

function fail(msg) {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        book: { type: 'string', short: 'b' },
        edition: { type: 'string', short: 'e' },
        file: { type: 'string', short: 'f' },
        title: { type: 'string' },
        author: { type: 'string' },
        language: { type: 'string' },
        force: { type: 'boolean', default: false },
        'no-embed': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail(err.message);
  }
  const { values } = parsed;
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!values.book || !values.edition || !values.file) {
    console.log(HELP);
    fail('--book, --edition and --file are all required');
  }
  assertEnv();
  if (!getPool()) fail('DATABASE_URL is not set — ingestion writes to PostgreSQL');

  const log = (...a) => console.log(...a);
  let result;
  try {
    result = await ingestBook({
      slug: values.book,
      edition: values.edition,
      file: values.file,
      title: values.title,
      author: values.author,
      language: values.language,
      force: values.force,
      skipEmbeddings: values['no-embed'],
      log,
    });
  } catch (err) {
    fail(err.message);
  }

  if (result.skipped) {
    console.log(`\nSKIPPED — source already COMPLETED (hash ${result.sha256.slice(0, 12)}…, ${result.pageCount} pages).`);
    return;
  }

  const s = result.summary;
  console.log('\n================ INGESTION SUMMARY (real DB values) ================');
  console.log(`BOOK / EDITION   : ${values.book} / ${values.edition}`);
  console.log(`SOURCE HASH      : ${result.sha256}`);
  console.log(`PDF PAGES        : ${s.pdfPages}`);
  console.log(`DATABASE PAGES   : ${s.dbPages}`);
  console.log(`CHUNKS           : ${s.dbChunks} (expected ${s.chunksExpected})`);
  console.log(`EMBEDDED CHUNKS  : ${s.embeddedChunks}`);
  console.log(`EMBEDDING DIM    : ${s.embeddingDim ?? 'n/a (dry run)'}`);
  console.log(`COORDINATE PAGES : ${s.coordinatePages}`);
  console.log(`STATUS           : COMPLETED`);
  console.log('===================================================================');

  if (s.dbPages !== s.pdfPages) fail(`page count mismatch: PDF ${s.pdfPages} vs DB ${s.dbPages}`);
  if (s.dbChunks !== s.chunksExpected) fail(`chunk count mismatch: expected ${s.chunksExpected} vs DB ${s.dbChunks}`);
  if (!values['no-embed'] && s.embeddedChunks !== s.dbChunks) fail(`not all chunks embedded: ${s.embeddedChunks}/${s.dbChunks}`);

  await getPool()?.end();
  process.exit(0);
}

main();
