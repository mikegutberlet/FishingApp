// Text out of a book file for scripts/ingest.mjs: a PDF's text layer (or OCR when there is none), an EPUB in
// spine order, a scan or photo through tesseract, a plain .txt. Pages become paragraphs 80–1500 characters
// long. Each file's extraction is cached by content hash so a second run (or an alias fix) costs nothing.
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const execFile = promisify(execFileCb);
const sh = (cmd, args, opts = {}) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts });

export const BOOK_EXT = ['.pdf', '.epub', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.txt'];
export const MIN_CHARS = 80, MAX_CHARS = 1500;

// ---------- Paragraphs ----------
const clean = s => s.replace(/(\w)-\n\s*(\w)/g, '$1$2').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
function split(text) {
  const out = [];
  while (text.length > MAX_CHARS) {
    const head = text.slice(0, MAX_CHARS), m = head.match(/^[\s\S]*[.!?](?=\s)/);
    const cut = m ? m[0].length : MAX_CHARS;
    out.push(text.slice(0, cut).trim()); text = text.slice(cut).trim();
  }
  if (text) out.push(text);
  return out;
}
export function paragraphs(pages) {
  const out = [];
  for (const { page, text } of pages) for (const raw of String(text ?? '').split(/\n\s*\n/)) {
    const t = clean(raw);
    if (t.length >= MIN_CHARS) for (const piece of split(t)) if (piece.length >= MIN_CHARS) out.push({ page, text: piece });
  }
  return out;
}

export const needsOcr = pages => pages.reduce((n, p) => n + p.replace(/\s/g, '').length, 0) / Math.max(pages.length, 1) < 40;

// ---------- Readers ----------
const missing = e => e.code === 'ENOENT';
async function ocrImages(files) {
  const pages = [];
  for (const f of files) {
    try { pages.push((await sh('tesseract', [f, '-', '-l', 'eng'])).stdout); } catch (e) { if (missing(e)) return null; throw e; }
  }
  return pages;
}
async function pdfInfo(file) {
  const info = {};
  try { for (const line of (await sh('pdfinfo', [file])).stdout.split('\n')) { const m = line.match(/^(Title|Author):\s*(.*)$/); if (m && m[2].trim()) info[m[1].toLowerCase()] = m[2].trim(); } } catch {}
  return info;
}
async function readPdf(file) {
  const { title, author } = await pdfInfo(file);
  let texts = (await sh('pdftotext', ['-layout', file, '-'])).stdout.split('\f');
  if (texts.length > 1 && !texts.at(-1).trim()) texts.pop();
  let ocr = false;
  if (needsOcr(texts)) {
    ocr = true;
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'tb-ocr-'));
    try {
      await sh('pdftoppm', ['-r', '300', '-gray', '-png', file, path.join(tmp, 'p')]);
      const pngs = (await readdir(tmp)).filter(n => n.endsWith('.png')).sort();
      texts = (await ocrImages(pngs.map(n => path.join(tmp, n)))) ?? [];
    } catch (e) { if (!missing(e)) throw e; texts = []; } finally { await rm(tmp, { recursive: true, force: true }); }
  }
  return { title, author, pages: texts.map((text, i) => ({ page: String(i + 1), text })), ocr };
}
const unzip = (file, entry) => sh('unzip', ['-p', file, entry]).then(r => r.stdout);
const strip = s => s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|h[1-6]|li|br|tr|blockquote)>/gi, '\n\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n));
async function readEpub(file) {
  const container = await unzip(file, 'META-INF/container.xml');
  const opfPath = container.match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) throw new Error('EPUB without a package file');
  const opf = await unzip(file, opfPath), base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const title = opf.match(/<dc:title[^>]*>([^<]*)</)?.[1].trim() || undefined, author = opf.match(/<dc:creator[^>]*>([^<]*)</)?.[1].trim() || undefined;
  const hrefs = new Map([...opf.matchAll(/<item\b[^>]*>/g)].map(m => [m[0].match(/\bid="([^"]+)"/)?.[1], m[0].match(/\bhref="([^"]+)"/)?.[1]]));
  const spine = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)].map(m => hrefs.get(m[1])).filter(Boolean);
  const pages = [];
  for (const [i, href] of spine.entries()) {
    const html = await unzip(file, base + decodeURIComponent(href));
    const label = (html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
    pages.push({ page: `ch. ${i + 1}${label ? ` ${label}` : ''}`, text: strip(body) });
  }
  return { title, author, pages, ocr: false };
}
async function readImage(file) {
  const texts = await ocrImages([file]);
  return { pages: texts ? [{ page: '1', text: texts[0] }] : [], ocr: true };
}
async function readTxt(file) {
  const texts = (await readFile(file, 'utf8')).split('\f');
  return { pages: texts.map((text, i) => ({ page: texts.length > 1 ? String(i + 1) : '', text })), ocr: false };
}

// extractFile(file, cacheDir) → { title, author?, pages: [{ page, text }], ocr }
export async function extractFile(file, cacheDir) {
  const data = await readFile(file), sha = createHash('sha256').update(data).digest('hex'), cached = path.join(cacheDir, `${sha}.json`);
  try { return JSON.parse(await readFile(cached, 'utf8')); } catch {}
  const ext = path.extname(file).toLowerCase(), name = path.basename(file, path.extname(file));
  const r = ext === '.pdf' ? await readPdf(file) : ext === '.epub' ? await readEpub(file) : ext === '.txt' ? await readTxt(file) : await readImage(file);
  const out = { title: r.title || name, ...(r.author && { author: r.author }), pages: r.pages, ocr: r.ocr };
  // OCR that produced nothing (tools missing) is not cached, so the next run with the tools present tries again.
  if (!(r.ocr && !r.pages.length)) { await mkdir(cacheDir, { recursive: true }); await writeFile(cached, JSON.stringify(out)); }
  return out;
}
