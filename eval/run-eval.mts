// Offline evaluation of the Déjà Vu matcher against the seeded site and seed/ground-truth.json.
//
//   node --import ./eval/ts-resolve.mjs eval/run-eval.mts [--refresh] [--verbose] [--only c1-inc-5]
//
// It fetches the site's issues and pages over REST (cached in eval/.cache.json; --refresh refetches),
// maps them with the SAME src/core code the Forge app uses, indexes them in memory, and replays every
// ground-truth query "as of" the query item's own date. Env: ATL_SITE, ATL_EMAIL, ATL_TOKEN.

import fs from 'node:fs';
import path from 'node:path';
import { mapConfluencePage, mapJiraIssue, JIRA_FIELDS, CONFLUENCE_EXPAND } from '../src/core/doc';
import type { MatchConfig } from '../src/core/doc';
import { extractFeatures } from '../src/core/features';
import { MemoryIndex } from '../src/core/index-mem';
import { findRelated } from '../src/core/match';
import type { RelatedResult } from '../src/core/match';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const CACHE = path.join(ROOT, 'eval', '.cache.json');

const SITE = (process.env.ATL_SITE ?? '').replace(/\/$/, '');
const AUTH = 'Basic ' + Buffer.from(`${process.env.ATL_EMAIL}:${process.env.ATL_TOKEN}`).toString('base64');
async function get(p: string, body?: unknown): Promise<any> {
  const res = await fetch(SITE + p, { method: body ? 'POST' : 'GET', headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', 'settings.json'), 'utf8'));
const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', 'ground-truth.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', '.state.json'), 'utf8'));

async function fetchSite() {
  if (fs.existsSync(CACHE) && !args.includes('--refresh')) return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const fields = await get('/rest/api/3/field');
  const fid = (name: string) => fields.find((f: any) => f.name === name)?.id;
  const occurredField = fid(settings.occurredFieldName); const resolvedField = fid(settings.resolvedFieldName);
  const issues: any[] = []; let token: string | undefined;
  do {
    const r = await get('/rest/api/3/search/jql', { jql: `project in (${settings.jiraProjects.join(',')}) ORDER BY created ASC`, fields: [...JIRA_FIELDS, occurredField, resolvedField].filter(Boolean), maxResults: 100, nextPageToken: token });
    issues.push(...r.issues); token = r.nextPageToken;
  } while (token);
  const pages: any[] = [];
  for (const space of settings.confluenceSpaces) {
    for (let start = 0; ; start += 50) {
      const r = await get(`/wiki/rest/api/content?spaceKey=${space}&type=page&limit=50&start=${start}&expand=${CONFLUENCE_EXPAND}`);
      pages.push(...r.results); if (r.size < 50) break;
    }
  }
  const users: any[] = [];
  for (let start = 0; ; start += 100) { const r = await get(`/rest/api/3/users/search?maxResults=100&startAt=${start}`); users.push(...r); if (r.length < 100) break; }
  const peopleNames = users.filter((u) => u.accountType === 'atlassian' && u.active).map((u) => u.displayName);
  const data = { occurredField, resolvedField, issues, pages, peopleNames };
  fs.writeFileSync(CACHE, JSON.stringify(data));
  return data;
}

// seed id -> site doc ids (a postmortem counts as found if either its page or its review issue is returned)
function siteIds(seedId: string): string[] {
  const out: string[] = [];
  const s = state.items[seedId];
  if (s?.key) out.push(`jira:${s.key}`);
  if (s?.pageId) out.push(`conf:${s.pageId}`);
  const pir = state.items[`${seedId}#pir`];
  if (pir?.key) out.push(`jira:${pir.key}`);
  return out;
}

async function main() {
  const data = await fetchSite();
  const cfg: MatchConfig = { entities: settings.entities, occurredField: data.occurredField, resolvedField: data.resolvedField, peopleNames: data.peopleNames };
  const index = new MemoryIndex();
  for (const i of data.issues) { const m = mapJiraIssue(i, SITE, cfg); index.upsert(m.doc, extractFeatures(m.doc, m.content)); }
  for (const p of data.pages) { const m = mapConfluencePage(p, SITE, cfg); index.upsert(m.doc, extractFeatures(m.doc, m.content)); }
  const all = index.all();
  console.log(`indexed ${all.length} docs (${data.issues.length} issues, ${data.pages.length} pages)`);

  const seedOf = new Map<string, string>();
  for (const k of Object.keys(state.items)) for (const id of siteIds(k.replace('#pir', ''))) if (!k.includes('#') || !seedOf.has(id)) seedOf.set(id, k.replace('#pir', '') + (k.includes('#pir') ? '#pir' : ''));
  const label = (id: string) => seedOf.get(id) ?? id;

  // Planted clusters: incident seed id -> cluster
  const clusterOf = new Map<string, string>();
  for (const [c, items] of Object.entries<any[]>(truth.clusters)) for (const it of items) clusterOf.set(it.id, c);
  const dateOf = (seedId: string) => all.find((s) => siteIds(seedId).includes(s.doc.id))?.doc.occurredAt ?? '';

  // Queries: every incident (for repeat detection) plus every item with labelled recall/decoys.
  const queryIds = new Set<string>([...truth.queries.map((q: any) => q.id), ...[...clusterOf.keys()], ...truth.oneOffIncidents.map((o: any) => o.id)]);
  const qMeta = new Map(truth.queries.map((q: any) => [q.id, q]));

  let tp = 0, fp = 0, fn = 0, recallHit = 0, recallTotal = 0, decoyRec = 0, decoyTop = 0, decoyTotal = 0;
  const rows: any[] = [];
  for (const qid of queryIds) {
    if (ONLY && qid !== ONLY) continue;
    const qdocId = siteIds(qid)[0];
    const q = all.find((s) => s.doc.id === qdocId);
    if (!q) { console.warn(`missing ${qid}`); continue; }
    const res: RelatedResult = await findRelated(q, index, { asOf: q.doc.occurredAt, now: q.doc.occurredAt });

    // Repeats vs. planted clusters
    const cluster = clusterOf.get(qid);
    const expectedRec = new Set(cluster && q.doc.kind === 'incident'
      ? truth.clusters[cluster].map((x: any) => x.id).filter((x: string) => x !== qid && dateOf(x) && dateOf(x) < q.doc.occurredAt).flatMap(siteIds) : []);
    const gotRec = new Set(res.recurrence.items.map((h) => h.id));
    const qtp = [...gotRec].filter((x) => expectedRec.has(x)).length;
    tp += qtp; fp += gotRec.size - qtp; fn += [...expectedRec].filter((x) => !gotRec.has(x)).length;

    // Recall of labelled older items anywhere in the answer; decoys must not be repeats or near the top.
    const shownIds = [...res.recurrence.items, ...res.debt, ...res.postmortems, ...res.background, ...res.related].map((h) => h.id);
    const meta: any = qMeta.get(qid);
    const missed: string[] = []; const decoysShown: string[] = [];
    for (const r of meta?.recall ?? []) { recallTotal++; if (siteIds(r.id).some((x) => shownIds.includes(x))) recallHit++; else missed.push(r.id); }
    const top5 = res.related.slice(0, 5).map((h) => h.id);
    for (const d of meta?.decoys ?? []) {
      decoyTotal++;
      const ids = siteIds(d.id);
      if (ids.some((x) => gotRec.has(x))) { decoyRec++; decoysShown.push(`${d.id}(REPEAT)`); }
      else if (ids.some((x) => top5.includes(x))) { decoyTop++; decoysShown.push(`${d.id}(top5)`); }
    }
    rows.push({ qid, rec: `${qtp}/${expectedRec.size}${gotRec.size - qtp ? ` +${gotRec.size - qtp}fp` : ''}`, recall: meta?.recall ? `${(meta.recall.length - missed.length)}/${meta.recall.length}` : '-', missed, decoysShown,
      fps: [...gotRec].filter((x) => !expectedRec.has(x)).map(label) });
    if (VERBOSE || ONLY) {
      console.log(`\n=== ${qid} ${q.doc.key} "${q.doc.title}" (${q.doc.occurredAt.slice(0, 10)}) candidates=${res.stats.candidates}`);
      console.log(`  repeats: count=${res.recurrence.count} last90=${res.recurrence.last90Days}`);
      for (const [name, list] of [['REPEAT', res.recurrence.items], ['DEBT', res.debt], ['POSTMORTEM', res.postmortems], ['BACKGROUND', res.background], ['RELATED', res.related]] as const) {
        for (const h of list) console.log(`  ${name.padEnd(10)} ${h.score.toFixed(2)} ${label(h.id).padEnd(22)} ${h.key.padEnd(9)} ${JSON.stringify(h.signals)} | ${h.reasons.map((r) => r.text).join(' · ')}`);
      }
      if (missed.length) console.log(`  MISSED: ${missed.join(', ')}`);
    }
  }

  const P = tp / Math.max(tp + fp, 1), Rr = tp / Math.max(tp + fn, 1);
  console.log('\nquery                    repeats      recall   decoys / false repeats / missed');
  for (const r of rows) if (r.missed.length || r.decoysShown.length || r.fps.length || VERBOSE) console.log(`${r.qid.padEnd(24)} ${r.rec.padEnd(12)} ${r.recall.padEnd(8)} ${[...r.decoysShown, ...r.fps.map((x: string) => `fp:${x}`), ...r.missed.map((x: string) => `miss:${x}`)].join(' ')}`);
  const summary = {
    queries: rows.length,
    repeatPrecision: +P.toFixed(3), repeatRecall: +Rr.toFixed(3), repeatTP: tp, repeatFP: fp, repeatFN: fn,
    labelledRecall: +(recallHit / Math.max(recallTotal, 1)).toFixed(3), labelledFound: recallHit, labelledTotal: recallTotal,
    decoysAsRepeats: decoyRec, decoysInTop5Related: decoyTop, decoysTotal: decoyTotal,
  };
  console.log('\n' + JSON.stringify(summary, null, 2));
  if (!ONLY) fs.writeFileSync(path.join(ROOT, 'eval', 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), summary, rows }, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
