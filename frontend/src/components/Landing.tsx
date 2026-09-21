import { useEffect, useState } from 'react';

// Marketing landing page. Shown to anonymous visitors; the workspace itself is
// unchanged. Everything claimed here maps to a real behaviour in the product —
// page numbers come from the PDF, unhighlightable sources say so, and a question
// the book cannot answer is refused rather than filled in.

const signin = '#/signin';
const register = '#/register';

function Logo({ className = '' }: { className?: string }) {
  return (
    <a href="#/" className={`flex items-center gap-2 ${className}`} aria-label="BOOKMARK home">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden className="text-accent">
        <path
          d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.2L5 21V4.5a1 1 0 0 1 1-1Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
      <span className="font-serif text-lg tracking-[0.14em] text-ink">BOOKMARK</span>
    </a>
  );
}

function TopNav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-40 border-b transition-colors ${
        scrolled ? 'border-line bg-surface/90 backdrop-blur' : 'border-transparent bg-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <Logo />
        <nav className="flex items-center gap-1 sm:gap-2" aria-label="Main">
          <a href="#how" className="hidden px-3 py-2 text-sm text-ink-muted hover:text-ink sm:block">
            How it works
          </a>
          <a href="#features" className="hidden px-3 py-2 text-sm text-ink-muted hover:text-ink sm:block">
            What it does
          </a>
          <a href="#faq" className="hidden px-3 py-2 text-sm text-ink-muted hover:text-ink sm:block">
            FAQ
          </a>
          <a href={signin} className="px-3 py-2 text-sm font-medium text-ink hover:text-accent-strong">
            Sign in
          </a>
          <a
            href={register}
            className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-strong"
          >
            Start reading
          </a>
        </nav>
      </div>
    </header>
  );
}

// Illustrative transcript of a real question against the live library. The page
// number and wording mirror what the product actually returns.
function Preview() {
  return (
    <div className="relative mt-4 rounded-2xl border border-line bg-surface p-4 shadow-[0_24px_60px_-30px_rgba(26,26,26,0.35)] sm:p-5">
      <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
          The Brothers Karamazov · Garnett
        </div>
        <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-faint">
          Reader + Chat
        </span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-[1.05fr_1fr]">
        <div className="rounded-xl bg-surface-sunken p-4">
          <div className="relative mx-auto w-full max-w-[220px] rounded-sm border border-line bg-white p-3 shadow-sm">
            <p className="font-serif text-[9px] leading-[1.5] text-ink-muted">
              “Gentlemen, I am not a {''}
              <mark className="rounded-[2px] bg-accent-soft px-[1px] text-ink">
                Karamazov
              </mark>
              {''}… I have been a Karamazov my whole life.”
            </p>
            <p className="mt-2 text-center font-serif text-[8px] text-ink-faint">page 309</p>
            <span
              className="pointer-events-none absolute inset-x-6 top-[34px] h-[26px] rounded-sm ring-2 ring-accent/60"
              aria-hidden
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="ml-auto w-fit max-w-[92%] rounded-lg rounded-tr-sm bg-accent-soft px-3 py-2 text-xs text-ink">
            What does Dmitri say about being a Karamazov?
          </div>
          <div className="w-fit max-w-[96%] rounded-lg rounded-tl-sm border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-ink">
            He calls himself a Karamazov by blood and admits the passion is part of him — arguing
            he is not worse for it.
          </div>
          <div className="rounded-lg border border-line bg-surface p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Source · e1
            </div>
            <div className="mt-1 font-serif text-[11px] italic leading-relaxed text-ink-muted">
              “Gentlemen, I am not a Karamazov… I have been a Karamazov my whole life…”
            </div>
            <div className="mt-2 text-[11px] font-medium text-accent-strong">Open on page 309 →</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_70%_-10%,#f3ede6_0%,transparent_60%)]"
        aria-hidden
      />
      <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-5 pb-16 pt-14 lg:grid-cols-[1.05fr_1fr] lg:pb-24 lg:pt-20">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            Grounded reading for real books
          </p>
          <h1 className="mt-5 font-serif text-4xl leading-[1.12] tracking-tight text-ink sm:text-5xl">
            Every answer points back to the page it came from.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-muted">
            BOOKMARK reads your book the way a careful research assistant would. Ask a question and
            get an answer built only from passages that exist in the PDF — with the page number
            attached, and the exact lines highlighted when you click.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href={register}
              className="rounded-md bg-accent px-5 py-3 text-sm font-medium text-white shadow-sm hover:bg-accent-strong"
            >
              Start researching a book
            </a>
            <a
              href={signin}
              className="rounded-md border border-line bg-surface px-5 py-3 text-sm font-medium text-ink hover:border-accent hover:text-accent-strong"
            >
              I already have an account
            </a>
          </div>
          <p className="mt-4 text-xs text-ink-faint">
            No summaries of summaries. If the book never says it, BOOKMARK says so.
          </p>
        </div>
        <Preview />
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: '01',
      t: 'Open a book from your library',
      d: 'Pick the title and the edition you are actually reading. Each edition keeps its own pages, so a citation can never leak across printings.',
    },
    {
      n: '02',
      t: 'Ask anything of the text',
      d: 'Characters, arguments, themes, a line you half remember. Follow-ups work: “and why does he believe that?” is resolved against the conversation you are having.',
    },
    {
      n: '03',
      t: 'Click a source, land on the passage',
      d: 'The reader jumps to the page and outlines the exact text runs the answer was built from — real coordinates from the PDF, aligned at any zoom.',
    },
  ];
  return (
    <section id="how" className="border-y border-line bg-surface">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="font-serif text-3xl tracking-tight text-ink">How a reading session works</h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-muted">
          Three steps, and the book stays in front of you the whole time.
        </p>
        <ol className="mt-10 grid gap-6 md:grid-cols-3">
          {steps.map((s) => (
            <li key={s.n} className="rounded-xl border border-line bg-surface-sunken p-5">
              <span className="font-serif text-sm text-accent">{s.n}</span>
              <h3 className="mt-2 font-serif text-lg text-ink">{s.t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{s.d}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Features() {
  const items = [
    {
      t: 'Citations, not vibes',
      d: 'Page, chapter and passage for every claim come from the database row behind the text. The model is never trusted to name a page number.',
      icon: 'M4 5h16M4 12h16M4 19h10',
    },
    {
      t: 'It highlights the real lines',
      d: 'Sources carry the PDF’s own text coordinates. One rectangle per text run, so a multi-line passage lights up as it truly sits on the page.',
      icon: 'M4 4h16v16H4z M8 9h8 M8 13h8 M8 17h5',
    },
    {
      t: 'Editions kept honest',
      d: 'Two translations of the same work are two separate corpora. Retrieval is scoped to the edition on screen, page numbers stay meaningful.',
      icon: 'M6 3h9l4 4v14H6z M14 3v5h5',
    },
    {
      t: 'It says when it has nothing',
      d: 'When no passage matches your question you get a plain, specific note about what was searched — never a confident paragraph about nothing.',
      icon: 'M12 3l9 17H3z M12 9v5 M12 17h.01',
    },
    {
      t: 'Your conversation survives a refresh',
      d: 'Questions, answers and their sources are stored with the session. Close the tab, come back tomorrow, the thread and its citations are intact.',
      icon: 'M4 12a8 8 0 1 0 3-6.2 M4 4v4h4',
    },
    {
      t: 'Only the evidence leaves',
      d: 'The passages needed to answer go to the language model — not your whole book, and never your credentials or library metadata.',
      icon: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z M9.5 12l2 2 4-4',
    },
  ];
  return (
    <section id="features" className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
      <h2 className="font-serif text-3xl tracking-tight text-ink">
        Built for people who check the page
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-muted">
        The hard part of book AI is not writing prose. It is refusing to write anything that is not
        there. These are the parts that make that possible.
      </p>
      <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((f) => (
          <article
            key={f.t}
            className="group rounded-xl border border-line bg-surface p-5 transition-shadow hover:shadow-[0_18px_40px_-28px_rgba(26,26,26,0.4)]"
          >
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent-strong">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                <path d={f.icon} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <h3 className="mt-4 font-serif text-base text-ink">{f.t}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">{f.d}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function Honesty() {
  return (
    <section className="border-y border-line bg-ink">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-16 lg:grid-cols-2 lg:py-20">
        <div>
          <h2 className="font-serif text-3xl leading-snug tracking-tight text-white">
            “The book does not say that” is a real answer.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-white/70">
            Most book assistants treat an empty result set as an invitation to improvise. BOOKMARK
            treats it as a stop sign. The retrieval layer decides whether the evidence can carry
            your question; if it cannot, the answer stream never starts, and you are told what was
            searched in plain words instead of a canned apology.
          </p>
        </div>
        <div className="space-y-3">
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs text-white/50">You asked</p>
            <p className="mt-1 text-sm text-white/90">
              What does the author say about cryptocurrency in chapter 4?
            </p>
            <p className="mt-3 text-xs text-white/50">BOOKMARK</p>
            <p className="mt-1 font-serif text-sm italic leading-relaxed text-white/80">
              I searched the indexed text of this edition and found no passage touching on
              cryptocurrency — the term does not appear in the passages ranked closest to your
              question, so there is nothing here for me to summarise.
            </p>
          </div>
          <p className="text-xs text-white/40">
            Confidence is reported as <code className="text-white/70">insufficient</code> and no
            sources are attached, so an unsupported answer can never look supported.
          </p>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const qs = [
    [
      'Do I upload my own PDF?',
      'Books are added to your library by whoever runs this instance — the catalog is read from the database, so the selector always shows what is actually available to you.',
    ],
    [
      'Can it quote a page that does not exist?',
      'No. Citations are resolved from stored chunk rows: page numbers, chapter labels and text come from the ingested PDF itself. The language model only references evidence it was handed.',
    ],
    [
      'What about translations and editions?',
      'Each edition is ingested separately with its own pages and coordinates. Switching edition switches the corpus retrieval runs against, which keeps page references honest.',
    ],
    [
      'Is my reading private?',
      'Your account scopes every conversation. The model receives the question plus the candidate passages needed to answer it — not your library, your credentials, or your other chats.',
    ],
    [
      'Does it work offline or with scan-only PDFs?',
      'A PDF without a usable text layer has no coordinates to highlight, so BOOKMARK tells you exact highlighting is unavailable instead of drawing a box it invented.',
    ],
  ];
  return (
    <section id="faq" className="mx-auto max-w-3xl px-5 py-16 lg:py-20">
      <h2 className="text-center font-serif text-3xl tracking-tight text-ink">Questions worth asking first</h2>
      <div className="mt-8 divide-y divide-line rounded-xl border border-line bg-surface">
        {qs.map(([q, a]) => (
          <details key={q} className="group px-5 py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium text-ink">
              {q}
              <span className="text-ink-faint transition-transform group-open:rotate-45" aria-hidden>
                +
              </span>
            </summary>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="mx-auto max-w-6xl px-5 pb-20">
      <div className="rounded-2xl border border-line bg-accent-soft px-6 py-12 text-center">
        <h2 className="mx-auto max-w-xl font-serif text-3xl leading-snug tracking-tight text-ink">
          Read with an assistant that shows its work.
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-ink-muted">
          Sign in, choose a book, and ask the question you have been carrying around.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <a
            href={register}
            className="rounded-md bg-accent px-5 py-3 text-sm font-medium text-white hover:bg-accent-strong"
          >
            Create an account
          </a>
          <a
            href={signin}
            className="rounded-md border border-accent/30 bg-surface px-5 py-3 text-sm font-medium text-accent-strong hover:border-accent"
          >
            Sign in
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-8 text-xs text-ink-faint sm:flex-row sm:items-center sm:justify-between">
        <Logo />
        <p>Answers are grounded in the selected book. Page references come from its PDF.</p>
      </div>
    </footer>
  );
}

export function Landing() {
  return (
    <div className="min-h-full bg-surface-sunken">
      <TopNav />
      <main>
        <Hero />
        <HowItWorks />
        <Features />
        <Honesty />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
