// Generate a REAL text-layer PDF from the Project Gutenberg plain text of
// The Brothers Karamazov (Constance Garnett, public domain). pdfkit lays out
// selectable text with positioned runs, so pdfjs can later read per-item x/y
// transforms -> genuine highlight coordinates. This is the single authoritative
// source the ingestion runs against, so pages/text/coordinates stay consistent.
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const SRC = 'tmp/karamazov.txt';
const OUT = 'storage/karamazov.pdf';

const lines = fs.readFileSync(SRC, 'utf8').replace(/\r\n?/g, '\n').split('\n');
// Drop the Gutenberg legal header (before START marker) and footer (END marker).
const start = lines.findIndex((l) => l.includes('START OF THE PROJECT GUTENBERG'));
const end = lines.findIndex((l) => l.includes('END OF THE PROJECT GUTENBERG'));
let body = lines.slice(start + 1, end).join('\n');

// Tidy: normalise the reference line, collapse >2 blank lines, drop pagebreaks.
body = body
  .replace(/^[ \t]*Produced by[^\n]*\n/gim, '')
  .replace(/\f/g, '\n')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const paragraphs = body.split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);

fs.mkdirSync(path.dirname(OUT), { recursive: true });

const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 64, bottom: 64, left: 72, right: 72 },
  bufferPages: true,
  autoFirstPage: true,
  info: { Title: 'The Brothers Karamazov', Author: 'Fyodor Dostoevsky', Creator: 'BOOKMARK ingest' },
});

const stream = fs.createWriteStream(OUT);
doc.pipe(stream);
doc.font('Helvetica').fontSize(11).lineGap(3.5);

const HEADING_PART = /^(PART|BOOK)\s+[IVXLCDM0-9]/i;
const HEADING_TITLE = /^[A-Z][A-Za-z .]{2,59}$/;

for (const p of paragraphs) {
  const isHeading =
    HEADING_PART.test(p) || (HEADING_TITLE.test(p) && !/[.!?]$/.test(p));
  if (isHeading) {
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(14).text(p);
    doc.font('Helvetica').fontSize(11).lineGap(3.5).moveDown(0.8);
    continue;
  }
  doc.text(p, { align: 'left' });
  doc.moveDown(0.7);
}

doc.end();
stream.on('finish', () => {
  const { first, last } = doc.bufferedPageRange();
  const bytes = fs.statSync(OUT).size;
  console.log(JSON.stringify({ out: OUT, pages: last - first + 1, paragraphs: paragraphs.length, bytes }));
});
