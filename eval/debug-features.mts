// Developer tool: print the features of seeded items, and optionally the pair score of the first against the rest.
//   node --import ./eval/ts-resolve.mjs eval/debug-features.mts <seed-id> [<seed-id> ...] [--pair]
import fs from 'node:fs';
import path from 'node:path';
import { mapJiraIssue, mapConfluencePage } from '../src/core/doc';
import { extractFeatures } from '../src/core/features';
import { MemoryIndex } from '../src/core/index-mem';
import { scorePair } from '../src/core/match';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const data = read('eval/.cache.json'), state = read('seed/.state.json'), settings = read('seed/settings.json');
const cfg = { entities: settings.entities, occurredField: data.occurredField, resolvedField: data.resolvedField, peopleNames: data.peopleNames };
const index = new MemoryIndex();
for (const i of data.issues) { const m = mapJiraIssue(i, '', cfg); index.upsert(m.doc, extractFeatures(m.doc, m.content)); }
for (const p of data.pages) { const m = mapConfluencePage(p, '', cfg); index.upsert(m.doc, extractFeatures(m.doc, m.content)); }
const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const docOf = (seed: string) => { const s = state.items[seed]; const id = s.key ? `jira:${s.key}` : `conf:${s.pageId}`; return index.all().find((x) => x.doc.id === id)!; };
const stats = await index.stats();
for (const id of ids) {
  const { doc, f } = docOf(id);
  console.log(`${id} ${doc.id} ${doc.kind}/${doc.subkind} ${doc.occurredAt.slice(0, 10)} svc=${doc.services} res=${doc.resources}`);
  console.log(`  t: ${f.t.slice(0, 30).join(' ')}`);
  console.log(`  w: ${Object.entries(f.w).slice(0, 25).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  console.log(`  s: ${f.s.length} shingles, m: ${f.m.join(' ')}`);
}
if (process.argv.includes('--pair')) {
  const q = docOf(ids[0]);
  const { indexTerms } = await import('../src/core/features');
  for (const other of ids.slice(1)) {
    const d = docOf(other);
    const dfs = await index.df([...indexTerms(q.f), ...indexTerms(d.f)]);
    const r = scorePair(q, d, { n: stats.n, avg: stats.avg, dfs });
    console.log(`${ids[0]} vs ${other}: ${r.score.toFixed(3)} ${JSON.stringify(r.signals)} | ${r.reasons.map((x) => x.text).join(' · ')}`);
  }
}
