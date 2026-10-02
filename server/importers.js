import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { load as loadHtml } from 'cheerio';
import path from 'node:path';

const MAX_ARCHIVE_EXPANDED_BYTES = 120 * 1024 * 1024;
const compact = value => String(value || '').replace(/\u0000/g, '').replace(/[\t\u00a0 ]+/g, ' ').trim();
const idFrom = value => String(value || '').replace(/^#/, '');

function makeElementsFromText(text) {
  return String(text || '').split(/\n{2,}/).map(compact).filter(Boolean).map((original_text, i) => ({ order: i, kind: 'paragraph', original_text }));
}

function textLines(items) {
  const lines = [];
  let current = [];
  let lastY = null;
  for (const item of items) {
    const value = String(item.str || '');
    if (!value && !item.hasEOL) continue;
    const y = Number(item.transform?.[5]);
    if (current.length && Number.isFinite(y) && Number.isFinite(lastY) && Math.abs(y - lastY) > 2.5) {
      lines.push(current.join(' ').replace(/\s+/g, ' ').trim());
      current = [];
    }
    if (value) current.push(value);
    if (item.hasEOL) {
      lines.push(current.join(' ').replace(/\s+/g, ' ').trim());
      current = [];
      lastY = null;
    } else if (Number.isFinite(y)) lastY = y;
  }
  if (current.length) lines.push(current.join(' ').replace(/\s+/g, ' ').trim());
  return lines.filter(Boolean).join('\n').trim();
}

export async function parsePdf(buffer) {
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false, disableFontFace: true });
  const pdf = await task.promise;
  try {
    const metadata = await pdf.getMetadata().catch(() => ({ info: {} }));
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const textContent = await page.getTextContent();
      const text = textLines(textContent.items.filter(item => typeof item.str === 'string'));
      const operatorList = await page.getOperatorList().catch(() => ({ fnArray: [] }));
      const hasImage = operatorList.fnArray.some(op => op === pdfjs.OPS.paintImageXObject || op === pdfjs.OPS.paintInlineImageXObject || op === pdfjs.OPS.paintImageMaskXObject);
      const content_state = text.length === 0 ? 'ocr_required' : (hasImage ? 'mixed' : 'normal');
      pages.push({ page_number: number, original_text: text, content_state, structure: makeElementsFromText(text) });
      page.cleanup();
    }
    return { title: compact(metadata.info?.Title), author: compact(metadata.info?.Author), pages, mime_type: 'application/pdf', logical_pages: false };
  } finally {
    await pdf.destroy().catch(() => {});
  }
}

async function loadSafeZip(buffer) {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
  let expanded = 0;
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    const original = file.unsafeOriginalName || file.name;
    const normalized = path.posix.normalize(String(original).replaceAll('\\', '/'));
    if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) throw new Error('The document archive contains an unsafe file path.');
    const size = Number(file._data?.uncompressedSize || 0);
    expanded += size;
    if (expanded > MAX_ARCHIVE_EXPANDED_BYTES) throw new Error('The document expands beyond the 120 MB safety limit.');
  }
  return zip;
}

function elementsFromHtml(html) {
  const $ = loadHtml(`<main>${html}</main>`);
  const elements = [];
  $('main').children().each((_index, node) => {
    const kind = (node.tagName || '').toLowerCase();
    if (!['p','h1','h2','h3','h4','h5','h6','li','blockquote','table','figcaption','pre'].includes(kind)) return;
    const text = compact($(node).text());
    if (!text) return;
    elements.push({ order: elements.length, kind: kind === 'li' ? 'list_item' : kind, heading_level: /^h[1-6]$/.test(kind) ? Number(kind[1]) : null, original_text: text });
  });
  if (elements.length) return elements;
  return makeElementsFromText($('main').text());
}

function splitLongText(text, maxChars) {
  const chunks = [];
  let remaining = String(text || '');
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf(' ', maxChars);
    if (cut < Math.floor(maxChars * 0.55)) cut = maxChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function paginateElements(elements, maxChars = 2600) {
  const pages = [];
  let current = [];
  let size = 0;
  const flush = () => { if (current.length) pages.push(current); current = []; size = 0; };
  for (const source of elements) {
    const base = { ...source };
    for (const text of splitLongText(base.original_text, maxChars)) {
      if (current.length && size + text.length + 2 > maxChars) flush();
      current.push({ ...base, order: current.length, original_text: text });
      size += text.length + 2;
    }
  }
  if (current.length || !pages.length) flush();
  return pages.map((items, index) => ({ page_number: index + 1, original_text: items.map(item => item.original_text).join('\n\n'), content_state: 'normal', structure: items }));
}

export async function parseDocx(buffer) {
  const zip = await loadSafeZip(buffer);
  if (!zip.file('word/document.xml')) throw new Error('This DOCX is missing its main document.');
  const result = await mammoth.convertToHtml({ buffer });
  const elements = elementsFromHtml(result.value);
  return { title: '', author: '', pages: paginateElements(elements), mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', logical_pages: true };
}

function localName(tag) { return String(tag).split(':').pop(); }

export async function parseEpub(buffer) {
  const zip = await loadSafeZip(buffer);
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('This EPUB is missing its container metadata.');
  const containerXml = await containerFile.async('string');
  const rootfileMatch = containerXml.match(/full-path=["']([^"']+)["']/i);
  if (!rootfileMatch) throw new Error('This EPUB has no readable package manifest.');
  const opfPath = path.posix.normalize(rootfileMatch[1].replaceAll('\\', '/'));
  if (opfPath.startsWith('../') || path.posix.isAbsolute(opfPath)) throw new Error('The EPUB package path is invalid.');
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('The EPUB package manifest could not be opened.');
  const opf = await opfFile.async('string');
  const $opf = loadHtml(opf, { xmlMode: true });
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = new Map();
  $opf('*').each((_i, node) => {
    if (localName(node.tagName) !== 'item') return;
    const attrs = node.attribs || {};
    if (attrs.id && attrs.href) manifest.set(attrs.id, attrs.href);
  });
  const spine = [];
  $opf('*').each((_i, node) => {
    if (localName(node.tagName) !== 'itemref') return;
    const idref = node.attribs?.idref;
    if (idref && manifest.has(idref)) spine.push(manifest.get(idref));
  });
  if (!spine.length) throw new Error('The EPUB has no readable chapters.');
  const elements = [];
  for (const href of spine) {
    const decoded = decodeURIComponent(href.split('#')[0]);
    const fullPath = path.posix.normalize(path.posix.join(baseDir, decoded));
    if (fullPath.startsWith('../') || path.posix.isAbsolute(fullPath)) throw new Error('The EPUB chapter path is invalid.');
    const file = zip.file(fullPath);
    if (!file) continue;
    const chapter = await file.async('string');
    const $ = loadHtml(chapter);
    const body = $('body').length ? $('body').html() : $.root().html();
    for (const el of elementsFromHtml(body || '')) elements.push({ ...el, order: elements.length });
  }
  const title = compact($opf('*').filter((_i, node) => localName(node.tagName) === 'title').first().text());
  const author = compact($opf('*').filter((_i, node) => localName(node.tagName) === 'creator').first().text());
  return { title, author, pages: paginateElements(elements), mime_type: 'application/epub+zip', logical_pages: true };
}

export function parseTxt(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.trim()) throw new Error('The text file is empty.');
  const pageTexts = text.split('\f').flatMap(section => {
    const paras = section.split(/\n{2,}/).map(compact).filter(Boolean);
    const pages = [];
    let group = [];
    let length = 0;
    for (const para of paras) {
      for (const piece of splitLongText(para, 2600)) {
        if (group.length && length + piece.length + 2 > 2600) { pages.push(group); group = []; length = 0; }
        group.push(piece); length += piece.length + 2;
      }
    }
    if (group.length) pages.push(group);
    return pages;
  });
  const pages = pageTexts.map((paragraphs, index) => {
    const structure = paragraphs.map((original_text, order) => ({ order, kind: 'paragraph', original_text }));
    return { page_number: index + 1, original_text: paragraphs.join('\n\n'), content_state: 'normal', structure };
  });
  return { title: '', author: '', pages: pages.length ? pages : [{ page_number: 1, original_text: '', content_state: 'ocr_required', structure: [] }], mime_type: 'text/plain', logical_pages: true };
}

export async function parseDocument(buffer, fileName, declaredMime = '') {
  const extension = fileName.toLowerCase().split('.').pop();
  if (extension === 'pdf' && buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return parsePdf(buffer);
  if (extension === 'docx' && buffer.subarray(0, 2).equals(Buffer.from('PK'))) return parseDocx(buffer);
  if (extension === 'epub' && buffer.subarray(0, 2).equals(Buffer.from('PK'))) return parseEpub(buffer);
  if (extension === 'txt' && (!declaredMime || declaredMime.startsWith('text/'))) return Promise.resolve(parseTxt(buffer));
  if (['pdf','docx','epub','txt'].includes(extension)) throw new Error('The file contents do not match its extension or could not be verified.');
  throw new Error('Supported formats are PDF, DOCX, EPUB, and TXT.');
}

export const normalizeElement = element => ({ id: idFrom(element.id), kind: element.kind || 'paragraph', original_text: String(element.original_text || ''), heading_level: element.heading_level || null, formatting: element.formatting || {} });
