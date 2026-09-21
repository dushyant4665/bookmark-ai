// Minimal landing page for an academic project: what the app is, what it
// actually does, and how to get in. No demo transcript, no marketing sections.

const signin = '#/signin';
const register = '#/register';

const CAPABILITIES = [
  [
    'Answers cite real pages',
    'Page, chapter and passage come from the ingested PDF stored in PostgreSQL — not from the model.',
  ],
  [
    'Sources highlight the exact lines',
    'Each citation carries the PDF’s own text coordinates, so the reader outlines the actual lines at any zoom.',
  ],
  [
    'It stops when the book has nothing',
    'If retrieval finds no passage that can answer the question, you are told that instead of getting an invented answer.',
  ],
];

export function Landing() {
  return (
    <div className="min-h-full bg-surface-sunken">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-5">
          <span className="font-serif text-lg tracking-[0.14em] text-ink">BOOKMARK</span>
          <a href={signin} className="text-sm font-medium text-accent-strong hover:underline">
            Sign in
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-14">
        <h1 className="font-serif text-3xl leading-snug tracking-tight text-ink sm:text-4xl">
          Ask questions of a book, get answers that point to the page.
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-muted">
          BOOKMARK is a grounded research assistant for real PDFs. Pick a book and edition, ask
          something, and every answer comes with the passages it was built from.
        </p>

        <dl className="mt-10 divide-y divide-line rounded-xl border border-line bg-surface">
          {CAPABILITIES.map(([t, d]) => (
            <div key={t} className="px-5 py-4">
              <dt className="text-sm font-medium text-ink">{t}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-ink-muted">{d}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-10 flex flex-wrap gap-3">
          <a
            href={register}
            className="rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-strong"
          >
            Create an account
          </a>
          <a
            href={signin}
            className="rounded-md border border-line bg-surface px-4 py-2.5 text-sm font-medium text-ink hover:border-accent hover:text-accent-strong"
          >
            Sign in
          </a>
        </div>
      </main>
    </div>
  );
}
