import { Router } from 'express';
import * as bookService from '../services/bookService.js';
import * as storageService from '../services/storageService.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    res.json({ books: await bookService.listBooks() });
  } catch (err) {
    next(err);
  }
});

// The library folder in storage is what the selector shows, joined against real
// ingestion state. Declared before /:bookId so "library" is never read as an id.
router.get('/library', async (req, res, next) => {
  try {
    res.json(await bookService.listLibrary());
  } catch (err) {
    next(err);
  }
});

router.get('/:bookId', async (req, res, next) => {
  try {
    const book = await bookService.getBook(req.params.bookId);
    if (!book) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ book });
  } catch (err) {
    next(err);
  }
});

router.get('/:bookId/editions', async (req, res, next) => {
  try {
    res.json({ editions: await bookService.listEditions(req.params.bookId) });
  } catch (err) {
    next(err);
  }
});

// Serves the exact PDF for the selected edition. The client only sends ids;
// the backend resolves the storage record. No arbitrary paths accepted.
// Supports byte-range requests so PDF.js streams pages without downloading the
// whole file (works for both local and Supabase storage backends).
router.get('/:bookId/editions/:editionId/pdf', async (req, res, next) => {
  try {
    const pdf = await storageService.getBookPdf(req.params.bookId, req.params.editionId, {
      rangeHeader: req.headers.range,
    });
    if (!pdf) return res.status(404).json({ error: 'NOT_FOUND' });

    res.setHeader('Content-Type', pdf.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="${(pdf.originalFilename || 'book.pdf').replace(/"/g, '')}"`);
    if (pdf.status === 206 && pdf.contentRange) {
      res.status(206);
      res.setHeader('Content-Range', pdf.contentRange);
      if (pdf.contentLength != null) res.setHeader('Content-Length', String(pdf.contentLength));
    } else if (pdf.fileSize != null) {
      res.setHeader('Content-Length', String(pdf.fileSize));
    }
    pdf.stream.on('error', next);
    pdf.stream.pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT' || err.message === 'STORAGE_OBJECT_NOT_FOUND') {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }
    next(err);
  }
});

export default router;
