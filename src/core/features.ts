// Feature extraction: what we store per document and compare at query time.
//   w: word term frequencies (title counted 3x), for lexical similarity
//   t: technical terms (identifiers, error class names, config keys, resource names)
//   s: error-signature shingles (3-grams of normalized error/log lines)
//   e: canonical entities (services and shared resources)

import type { Content } from './content';
import type { Doc } from './doc';
import { countMap, isStopword, isVolatile, lineTokens, words } from './text';

export interface Features {
  w: Record<string, number>;
  t: string[];
  s: string[];
  e: string[];
  m: string[]; // doc ids this document mentions or links to (indexed so "who cites X" is one lookup)
  l: string[]; // a few readable error lines, used only to explain a signature match
}

const MAX_WORDS = 160;
const MAX_TECH = 90;
const MAX_SHINGLES = 240;

/** Common words that show up in identifier shapes but say nothing (log levels, generic types). */
const TECH_STOP = new Set(['error', 'errors', 'warn', 'info', 'debug', 'true', 'false', 'null', 'undefined', 'string', 'number', 'object', 'the', 'and', 'for', 'utc', 'gmt', 'eur', 'usd', 'gbp', 'json', 'http', 'https', 'www', 'com', 'api', 'firing', 'resolved', 'todo', 'note', 'step', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'status', 'pending', 'prod', 'env', 'pods', 'pod', 'route']);

function normTech(raw: string): string | undefined {
  let t = raw.trim().replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, '').toLowerCase();
  t = t.replace(/[:.\-_]*\*$/, ''); // catalog:guides:* -> catalog:guides
  if (t.length < 3 || t.length > 60) return undefined;
  if (TECH_STOP.has(t) || isStopword(t) || isVolatile(t)) return undefined;
  if (/^\d/.test(t)) return undefined;
  // Drop identifiers that embed an id (pod suffixes, session keys): keep the stable prefix instead.
  const parts = t.split(/[-_:.]/);
  if (parts.some((p) => isVolatile(p))) {
    const stable = parts.filter((p) => !isVolatile(p));
    if (stable.length < 2) return undefined;
    t = stable.join('-');
  }
  return t;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*(?:[.:\-/][A-Za-z0-9_]+)*/g;

/** Identifier-like tokens anywhere in prose: CamelCase, snake_case, kebab-case, dotted.names, ALLCAPS. */
function proseTech(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IDENT)) {
    const tok = m[0];
    const shaped =
      /[a-z][A-Z]/.test(tok) && /^[A-Za-z]+$/.test(tok) && (tok.match(/[A-Z]/g) ?? []).length >= 2 // KnexTimeoutError, PayRail
      || /[a-z0-9]_[a-z0-9]/i.test(tok) // max_connections
      || /^[a-z][a-z0-9]+(-[a-z0-9]+)+$/.test(tok) && tok.length >= 6 // redis-shared, check-then-update
      || /^[a-z]+(\.[a-z]+)+$/.test(tok) && !/\.(com|shop|net|org|io)$/.test(tok) // order.paid, max.poll.interval.ms
      || /^[A-Z]{3,}$/.test(tok); // FLUSHDB, HPA, TTL, OOM
    if (!shaped) continue;
    const n = normTech(tok);
    if (n) out.push(n);
  }
  return out;
}

/** In code, every identifier counts, except plain lowercase English words (those go to the signature). */
function codeTech(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(IDENT)) {
    const tok = m[0];
    if (/^[a-z]+$/.test(tok)) continue;
    const n = normTech(tok);
    if (n) out.push(n);
  }
  return out;
}

/** Lines that describe a failure, an alert or a statement worth matching. Stack frames and hex dumps are noise. */
function signatureLines(c: Content): string[] {
  const lines: string[] = [];
  for (const block of c.codeBlocks) {
    for (const line of block.split('\n')) {
      const l = line.trim();
      if (!l || /^at\s/.test(l) || /^\d+:\s*0x/.test(l) || /^<-+/.test(l) || l.length < 8) continue;
      lines.push(l);
    }
  }
  // Inline code that quotes an error message ("`remaining connection slots are reserved ...`") counts too.
  for (const span of c.codeSpans) if (span.trim().split(/\s+/).length >= 3) lines.push(span);
  return lines;
}

/** An error line with ids, numbers and noise removed, short enough to quote in a reason. */
function readableLine(line: string): string {
  const t = line.replace(/https?:\/\/\S+/g, '').replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, '')
    .replace(/\s(requestId|pod|key|event_id|order|host|route|batch|attempt|pods|env)=\S+/gi, '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? t.slice(0, 139) + '…' : t;
}

export function shingles(lines: string[]): string[] {
  const out = new Set<string>();
  for (const line of lines) {
    const toks = lineTokens(line);
    // Bigrams catch short variants of the same message ("certificate expired"), trigrams are more specific.
    for (let i = 0; i + 2 <= toks.length; i++) out.add(toks.slice(i, i + 2).join(' '));
    for (let i = 0; i + 3 <= toks.length; i++) out.add(toks.slice(i, i + 3).join(' '));
  }
  return [...out];
}

export function extractFeatures(doc: Doc, c: Content): Features {
  const titleWords = words(doc.title);
  const tf = countMap([...titleWords, ...titleWords, ...words(c.text)]); // title already once in text, so 3x total
  const w = Object.fromEntries(Object.entries(tf).sort((a, b) => b[1] - a[1]).slice(0, MAX_WORDS));

  const tech = new Map<string, number>();
  const add = (t: string) => tech.set(t, (tech.get(t) ?? 0) + 1);
  for (const span of c.codeSpans) {
    const single = span.trim();
    if (!/\s/.test(single)) { const n = normTech(single); if (n) add(n); }
    codeTech(span).forEach(add);
  }
  c.codeBlocks.forEach((b) => codeTech(b).forEach(add));
  proseTech(c.text).forEach(add);
  doc.resources.forEach(add); // shared infrastructure names are technical anchors; services are handled as entities
  const t = [...tech.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TECH).map(([k]) => k);

  const s = shingles(signatureLines(c)).slice(0, MAX_SHINGLES);
  const e = [...new Set([...doc.services.map((x) => `svc:${x}`), ...doc.resources.map((x) => `res:${x}`)])];
  const l = [...new Set(signatureLines(c).map(readableLine).filter((x) => x.length >= 12))].slice(0, 8);
  const m = [...new Set([...doc.mentions, ...doc.links.map((x) => x.target)])];
  return { w, t, s, e, l, m };
}

/** All index terms of a document, namespaced, for postings and document-frequency counts. */
export function indexTerms(f: Features): string[] {
  return [...Object.keys(f.w).map((x) => `w:${x}`), ...f.t.map((x) => `t:${x}`), ...f.s.map((x) => `s:${x}`), ...f.e.map((x) => `e:${x}`), ...(f.m ?? []).map((x) => `m:${x}`)];
}
