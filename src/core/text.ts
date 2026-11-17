// Text normalization and tokenization shared by indexing, matching and the offline eval.
// Pure functions only: no Forge imports, so the same code runs in Forge and in Node tests.

/** Words that carry no meaning for matching. Kept short on purpose: IDF handles the rest. */
const STOPWORDS = new Set(`
a about above after again against all also am an and any are as at be because been before being below between both but by
can could did do does doing down during each few for from further had has have having he her here hers him his how i if in
into is it its itself just me more most my no nor not now of off on once only or other our ours out over own same she should
so some such than that the their theirs them then there these they this those through to too under until up very was we
were what when where which while who whom why will with would you your yours
us per via vs etc eg ie one two three four five six seven eight nine ten first second third last next new old
get got set use used using make made see seen let still yet really
utc uk us gmt am pm jan feb mar apr may jun jul aug sep oct nov dec monday tuesday wednesday thursday friday saturday sunday
minute minutes hour hours day days week weeks month months year years time today yesterday tomorrow morning evening night
`.split(/\s+/).filter(Boolean));

/** Tokens that look like identifiers of one specific event (ids, hashes, hosts with numbers) carry no reusable meaning. */
export function isVolatile(token: string): boolean {
  if (/^\d+([.,:/-]\d+)*[a-z]{0,3}$/.test(token)) return true; // numbers, versions, dates, 30s, 5xx-like counts
  if (/^[0-9a-f]{6,}$/.test(token) && /\d/.test(token)) return true; // hex ids
  if (/^0x[0-9a-f]+$/.test(token)) return true;
  if (/\d[a-z]+\d|[a-z]\d+[a-z]/.test(token)) return true; // interleaved letters/digits: 3fa2, 8kxq2, x2k1q (ids, pod suffixes)
  if (/\d/.test(token) && token.length >= 8 && token.replace(/[^0-9]/g, '').length >= 3) return true; // long mixed ids
  if (/^[a-z]{1,4}_[a-z0-9]{3,}$/.test(token) && /\d/.test(token)) return true; // prefixed ids like chg_91aa
  return false;
}

/** Remove things that change between occurrences of the same problem: urls, uuids, timestamps, ips, request ids. */
export function stripVolatile(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?)?\b/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(\/\d+)?\b/g, ' ')
    .replace(/\b[A-Z]{2,}-\d+\b/g, ' '); // issue keys are links, not words
}

/** Very small suffix stemmer: enough to merge "connections"/"connection", "timed"/"timeout" stays separate. */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 5) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length > 6) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 5 && !w.endsWith('eed')) return w.slice(0, -2);
  if (w.endsWith('es') && /(ches|shes|xes|ses|zes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

/** Plain words for lexical similarity. Hyphenated and snake names are split here; they are kept whole as technical terms. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of stripVolatile(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || isVolatile(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** Normalized token sequence of one error or log line, for signature shingles. */
export function lineTokens(line: string): string[] {
  return stripVolatile(line)
    .replace(/([a-z])([A-Z])/g, '$1 $2') // KnexTimeoutError -> Knex Timeout Error
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !isVolatile(t) && !STOPWORDS.has(t))
    .map(stem);
}

export function isStopword(w: string): boolean {
  return STOPWORDS.has(w);
}

export function countMap(items: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const i of items) m[i] = (m[i] ?? 0) + 1;
  return m;
}
