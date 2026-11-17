// The matcher: given one document, find older documents that matter and explain why.
// Deterministic. The Rovo agent only phrases the answer; it never decides a match.

import type { Doc, DocKind } from './doc';
import type { Features } from './features';
import { indexTerms } from './features';
import { lineTokens } from './text';

// ---------- index interface (implemented by the in-memory index and by Forge SQL) ----------

export interface Stored {
  doc: Doc;
  f: Features;
}

export interface IndexStats {
  n: number; // number of documents
  avg: { w: number; t: number; s: number }; // average feature sizes, for length normalization
}

export interface IndexReader {
  stats(): Promise<IndexStats>;
  df(terms: string[]): Promise<Record<string, number>>;
  /** Doc ids that share any of the given terms, most shared first. */
  candidates(terms: string[], limit: number): Promise<string[]>;
  load(ids: string[]): Promise<Stored[]>;
}

// ---------- tunables (set from the eval, see eval/README) ----------

export const TUNING = {
  weights: { lex: 0.3, sig: 0.25, tech: 0.3, ent: 0.1, link: 0.15 },
  recurrence: {
    minScore: 0.27, minSig: 0.1, minTech: 0.25, // ordinary repeat: overall score plus some cause evidence
    strongSig: 0.3, strongSigScore: 0.25, // same error lines: repeat even across services
    contradictSig: 0.05, contradictMinShingles: 8, // both have error lines but they share almost nothing: different cause
    linkedMinScore: 0.15, // linked by the team to this incident or to a repeat
    transitiveMinScore: 0.15, transitivePairScore: 0.4, maxTransitiveSources: 5, // repeat of a repeat
  },
  /** Absolute evidence (sum of IDF of shared items) needed for full credit; protects against tiny queries. */
  evidence: { tech: 8, sig: 6 },
  expansion: {
    depth: 3, seedRelated: 0.2, seedTop: 3,
    // Reached through a mention or citation (not a Jira link chain): how much it must resemble the query.
    untrustedIncident: { score: 0.15, content: 0.12 }, // incidents have repeats as strong evidence already
    untrustedWork: { score: 0.08, content: 0 }, // features and RFCs reach history through the decisions they touch
    designSeedsForWork: 2,
    maxUntrustedHops: 1, // at most one mention/citation hop per path; Jira link hops after it are fine
  },
  /** Background found by similarity alone must share some content, not only a service. */
  backgroundMinContent: 0.08,
  relatedMin: 0.2,
  backgroundMin: 0.16,
  /** Feature work and RFCs score lower in absolute terms; also accept documents close to the best one. */
  backgroundRelative: 0.55,
  backgroundFloor: 0.1,
  debtDirectMin: 0.3,
  k1: 1.2,
  b: 0.6,
  maxCandidates: 400,
  maxQueryTerms: 90,
};

// ---------- result shape ----------

export interface Reason {
  kind: 'signature' | 'tech' | 'entity' | 'alias' | 'text' | 'link' | 'followup';
  text: string;
}

export interface Hit {
  id: string;
  key: string;
  title: string;
  url: string;
  kind: DocKind;
  subkind?: string;
  status: Doc['status'];
  statusText?: string;
  occurredAt: string;
  score: number; // 0..1
  signals: { lex: number; sig: number; tech: number; ent: number; link: number };
  reasons: Reason[];
  resolution?: string;
  assignee?: Doc['assignee'];
  services: string[];
}

export interface DebtItem extends Hit {
  ageDays: number;
  dueDate?: string;
  overdueDays?: number;
  via?: string; // the incident or review it came from
}

export interface RelatedResult {
  query: { id: string; key: string; title: string; kind: DocKind; occurredAt: string; services: string[] };
  recurrence: { count: number; last90Days: number; firstSeen?: string; items: Hit[] };
  debt: DebtItem[];
  postmortems: Hit[]; // reviews and postmortem pages: how it was handled before
  background: Hit[]; // design decisions, RFCs, guides, runbooks: what to read first
  related: Hit[];
  stats: { candidates: number; indexed: number };
}

// ---------- scoring ----------

const idf = (n: number, df: number) => Math.log(1 + (n - df + 0.5) / (df + 0.5));

interface Ctx {
  n: number;
  avg: IndexStats['avg'];
  dfs: Record<string, number>;
}

/** Query-side BM25, normalized by the query's own score so the result is about 0..1. */
function bm25(qTerms: Record<string, number>, dTerms: Record<string, number>, dLen: number, avgLen: number, ns: string, ctx: Ctx): { score: number; shared: [string, number][]; mass: number } {
  const { k1, b } = TUNING;
  const norm = (len: number) => k1 * (1 - b + b * (len / Math.max(avgLen, 1)));
  let num = 0, den = 0, mass = 0;
  const shared: [string, number][] = [];
  const qLen = Object.keys(qTerms).length;
  for (const [t, qtf] of Object.entries(qTerms)) {
    const df = ctx.dfs[`${ns}:${t}`] ?? 0;
    if (df === 0) continue; // unseen elsewhere: says nothing about other docs
    const w = idf(ctx.n, df) * Math.min(qtf, 3);
    const self = (qtf * (k1 + 1)) / (qtf + norm(qLen));
    den += w * self;
    const dtf = dTerms[t];
    if (dtf) {
      const part = w * ((dtf * (k1 + 1)) / (dtf + norm(dLen)));
      num += part;
      mass += idf(ctx.n, df);
      shared.push([t, part]);
    }
  }
  shared.sort((a, b2) => b2[1] - a[1]);
  return { score: den > 0 ? Math.min(1, num / den) : 0, shared, mass };
}

const asTf = (list: string[]) => Object.fromEntries(list.map((x) => [x, 1]));

export function linked(a: Doc, b: Doc): string | undefined {
  const l = a.links.find((x) => x.target === b.id) ?? b.links.find((x) => x.target === a.id);
  if (l) return `linked in Jira (${l.label})`;
  if (a.mentions.includes(b.id)) return `mentioned in ${a.key}`;
  if (b.mentions.includes(a.id)) return `${b.key} mentions ${a.key}`;
  return undefined;
}

export function scorePair(q: Stored, d: Stored, ctx: Ctx): { score: number; signals: Hit['signals']; reasons: Reason[] } {
  const lexR = bm25(q.f.w, d.f.w, Object.keys(d.f.w).length, ctx.avg.w, 'w', ctx);
  const techR = bm25(asTf(q.f.t), asTf(d.f.t), d.f.t.length, ctx.avg.t, 't', ctx);
  const sigR = q.f.s.length && d.f.s.length ? bm25(asTf(q.f.s), asTf(d.f.s), d.f.s.length, ctx.avg.s, 's', ctx) : { score: 0, shared: [] as [string, number][], mass: 0 };
  // Full credit needs enough shared evidence, not just one shared term in a tiny query.
  techR.score *= Math.min(1, techR.mass / TUNING.evidence.tech);
  sigR.score *= Math.min(1, sigR.mass / TUNING.evidence.sig);
  const svc = q.doc.services.filter((s) => d.doc.services.includes(s));
  const res = q.doc.resources.filter((s) => d.doc.resources.includes(s));
  const ent = svc.length ? 1 : res.length ? 0.6 : 0;
  const linkText = linked(q.doc, d.doc);
  const link = linkText ? 1 : 0;

  // A query without error lines (a feature, an RFC) cannot match on signature: give that weight to words and terms.
  // Weight follows the evidence the query can offer: without error lines (a feature, an RFC) the signature weight,
  // and without enough technical terms part of the technical weight, move to wording.
  const W = { ...TUNING.weights };
  if (!q.f.s.length) { W.lex += W.sig; W.sig = 0; }
  const qTechMass = q.f.t.reduce((a, t) => a + ((ctx.dfs[`t:${t}`] ?? 0) > 0 ? idf(ctx.n, ctx.dfs[`t:${t}`]) : 0), 0);
  const techAvail = Math.min(1, qTechMass / TUNING.evidence.tech);
  W.lex += W.tech * (1 - techAvail); W.tech *= techAvail;
  const score = Math.min(1, W.lex * lexR.score + W.sig * sigR.score + W.tech * techR.score + W.ent * ent + W.link * link);

  const reasons: Reason[] = [];
  if (sigR.score >= 0.08 && sigR.shared.length) {
    const best = sigR.shared[0][0].split(' ');
    const line = d.f.l.find((x) => { const toks = lineTokens(x); return best.every((t) => toks.includes(t)); });
    reasons.push({ kind: 'signature', text: line ? `same error: \`${line}\`` : `same error pattern: "${sigR.shared[0][0]}"` });
  }
  if (techR.shared.length && techR.score >= 0.08) {
    reasons.push({ kind: 'tech', text: `shared technical terms: ${techR.shared.slice(0, 5).map(([t]) => `\`${t}\``).join(', ')}` });
  }
  if (svc.length) reasons.push({ kind: 'entity', text: `same service: ${svc.join(', ')}` });
  else if (res.length) reasons.push({ kind: 'entity', text: `same shared resource: ${res.join(', ')}` });
  for (const a of d.doc.aliasHits ?? []) if (q.doc.services.includes(a.canonical) || q.doc.resources.includes(a.canonical)) reasons.push({ kind: 'alias', text: `${a.alias} is an older name for ${a.canonical}` });
  if (lexR.score >= 0.25 && lexR.shared.length) reasons.push({ kind: 'text', text: `similar wording: ${lexR.shared.slice(0, 4).map(([t]) => t).join(', ')}` });
  if (linkText) reasons.push({ kind: 'link', text: linkText });

  return { score, signals: { lex: r2(lexR.score), sig: r2(sigR.score), tech: r2(techR.score), ent, link }, reasons };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function hitOf(d: Stored, scored: ReturnType<typeof scorePair>): Hit {
  return {
    id: d.doc.id, key: d.doc.key, title: d.doc.title, url: d.doc.url, kind: d.doc.kind, subkind: d.doc.subkind,
    status: d.doc.status, statusText: d.doc.statusText, occurredAt: d.doc.occurredAt, score: r2(scored.score),
    signals: scored.signals, reasons: scored.reasons, resolution: d.doc.resolution, assignee: d.doc.assignee, services: d.doc.services,
  };
}

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.floor((new Date(a).getTime() - new Date(b).getTime()) / DAY);

export interface FindOptions {
  /** Only consider documents at or before this time (defaults to the query's own time). */
  asOf?: string;
  /** "now" used for ages of open action items (defaults to real now). */
  now?: string;
  /** Treat a free-text query as an incident so repeats are detected. */
  treatAsIncident?: boolean;
  limit?: number;
}

/** Main entry point. */
export async function findRelated(q: Stored, index: IndexReader, opts: FindOptions = {}): Promise<RelatedResult> {
  const asOf = opts.asOf ?? q.doc.occurredAt;
  const now = opts.now ?? new Date().toISOString();
  const limit = opts.limit ?? 8;
  const isIncident = q.doc.kind === 'incident' || !!opts.treatAsIncident;

  // 1. Statistics for the query's own terms only (keeps storage queries small).
  const qTerms = indexTerms(q.f);
  const [stats, dfs] = await Promise.all([index.stats(), index.df(qTerms)]);
  const ctx: Ctx = { n: Math.max(stats.n, 1), avg: stats.avg, dfs };

  // 2. Candidates: documents sharing the most informative query terms, plus anything linked or mentioned.
  const informative = qTerms.filter((t) => (dfs[t] ?? 0) > 0 && (dfs[t] ?? 0) < ctx.n * 0.5)
    .sort((a, b) => (dfs[a] ?? 0) - (dfs[b] ?? 0)).slice(0, TUNING.maxQueryTerms);
  const direct = [...q.doc.links.map((l) => l.target), ...q.doc.mentions];
  const ids = new Set([...(await index.candidates(informative, TUNING.maxCandidates)), ...direct]);
  ids.delete(q.doc.id);
  const loaded = (await index.load([...ids])).filter((d) => d.doc.occurredAt <= asOf);

  // 3. Score everything.
  const scored = loaded.map((d) => ({ d, s: scorePair(q, d, ctx) })).sort((a, b) => b.s.score - a.s.score);

  // 4. Repeats: older incidents with enough evidence of the same cause (signature or technical overlap, not just the service).
  const R = TUNING.recurrence;
  const byId = new Map(loaded.map((d) => [d.doc.id, d]));
  const scoredById = new Map(scored.map((x) => [x.d.doc.id, x]));
  type Scored = (typeof scored)[number];
  const contradicts = (a: Stored, b: Stored, sig: number) =>
    a.f.s.length >= R.contradictMinShingles && b.f.s.length >= R.contradictMinShingles && sig < R.contradictSig;
  const isRepeatPair = (a: Stored, b: Stored, s: ReturnType<typeof scorePair>, minScore = R.minScore) => b.doc.kind === 'incident' && (
    (s.signals.sig >= R.strongSig && s.score >= R.strongSigScore)
    || (!contradicts(a, b, s.signals.sig) && s.score >= minScore && (s.signals.sig >= R.minSig || s.signals.tech >= R.minTech)));
  const isRepeat = ({ d, s }: Scored) => isRepeatPair(q, d, s);
  const repeats = new Map<string, Scored>();
  if (isIncident) {
    for (const x of scored) if (isRepeat(x)) repeats.set(x.d.doc.id, x);
    // Incidents the team already linked to this one, or to a repeat, are repeats too if they look alike at all.
    const sources = [q.doc, ...[...repeats.values()].map((x) => x.d.doc)];
    await loadMissing(sources.flatMap((d) => d.links.map((l) => l.target)));
    for (const src of sources) for (const l of src.links) {
      if (!['relates', 'duplicate', 'cause'].includes(l.rel) || repeats.has(l.target) || l.target === q.doc.id) continue;
      const d = byId.get(l.target);
      if (!d || d.doc.kind !== 'incident') continue;
      const x = scoredById.get(l.target) ?? { d, s: scorePair(q, d, ctx) };
      if (x.s.score < R.linkedMinScore) continue;
      if (!x.s.reasons.some((r) => r.kind === 'link')) x.s.reasons.push({ kind: 'link', text: `linked by the team to ${src.key}` });
      repeats.set(l.target, x);
    }
    // A strong repeat of a repeat is a repeat too (the same cause described a third way).
    const direct = [...repeats.values()].sort((a, b) => b.s.score - a.s.score).slice(0, R.maxTransitiveSources);
    for (const src of direct) {
      const srcDfs = await index.df(indexTerms(src.d.f));
      const srcCtx: Ctx = { ...ctx, dfs: { ...dfs, ...srcDfs } };
      for (const y of scored) {
        if (repeats.has(y.d.doc.id) || y.d.doc.kind !== 'incident' || y.s.score < R.transitiveMinScore) continue;
        const pair = scorePair(src.d, y.d, srcCtx);
        if (!isRepeatPair(src.d, y.d, pair, R.transitivePairScore)) continue;
        y.s.reasons.push({ kind: 'link', text: `same cause as ${src.d.doc.key}` });
        repeats.set(y.d.doc.id, y);
      }
    }
  }
  const recurrences = [...repeats.values()];
  const recurrenceHits = recurrences.map(({ d, s }) => hitOf(d, s)).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  async function loadMissing(ids: string[]) {
    const missing = [...new Set(ids)].filter((t) => !byId.has(t) && t !== q.doc.id);
    if (!missing.length) return;
    for (const m of await index.load(missing)) if (m.doc.occurredAt <= asOf) byId.set(m.doc.id, m);
  }

  // 5. Follow the graph: from the query, the repeats, strongly related incidents and the best design documents,
  //    walk links and mentions to reviews, postmortems, action items and documents; for design documents also
  //    walk backwards to whatever cites them (the postmortems that blamed a decision are relevant to new work on it).
  const X = TUNING.expansion;
  const bgKinds: DocKind[] = ['design', 'runbook', 'postmortem'];
  const bestBg = Math.max(0, ...scored.filter((x) => bgKinds.includes(x.d.doc.kind)).map((x) => x.s.score));
  const bgOk = (score: number) => score >= TUNING.backgroundMin || (score >= TUNING.backgroundFloor && score >= bestBg * TUNING.backgroundRelative);
  const viaOf = new Map<string, string>(); // reached doc id -> human-readable path reason
  const untrusted = new Set<string>(); // reached through a mention or citation rather than a Jira link chain
  const seeds: Doc[] = [
    q.doc,
    ...recurrences.map((r) => r.d.doc),
    ...scored.filter((x) => x.d.doc.kind === 'incident' && !repeats.has(x.d.doc.id) && x.s.score >= X.seedRelated).slice(0, X.seedTop).map((x) => x.d.doc),
    // Decision documents lead to the postmortems that cite them; used for work items and RFCs, or incidents without repeats.
    ...(!isIncident || !recurrences.length
      ? scored.filter((x) => x.d.doc.kind === 'design' && bgOk(x.s.score)).slice(0, X.designSeedsForWork).map((x) => x.d.doc) : []),
  ];
  const U = isIncident && recurrences.length ? X.untrustedIncident : X.untrustedWork;
  const seen = new Set(seeds.map((d) => d.id));
  const linkSeeds = new Set([q.doc.id, ...recurrences.map((r) => r.d.doc.id)]);
  let frontier = seeds.map((d) => ({ d, trusted: linkSeeds.has(d.id), hops: linkSeeds.has(d.id) ? 0 : 1 }));
  const followKinds: DocKind[] = ['postmortem', 'action', 'design', 'runbook', 'incident'];
  for (let depth = 0; depth < X.depth && frontier.length; depth++) {
    const edges: { from: Doc; to: string; trusted: boolean; why: string; hops: number }[] = [];
    const name = (d: Doc) => (d.source === 'confluence' ? `"${d.title.length > 60 ? d.title.slice(0, 59) + '…' : d.title}"` : d.key);
    for (const { d, trusted, hops } of frontier) {
      const canHop = hops < X.maxUntrustedHops || d.id === q.doc.id || seeds.includes(d);
      // Incidents reached on the way only lead on to their own review and action items, not to other incidents.
      const leaf = d.kind === 'incident' && d.id !== q.doc.id && !repeats.has(d.id) && !seeds.includes(d);
      for (const l of leaf ? d.links.filter((x) => x.rel === 'review' || x.rel === 'action') : d.links) edges.push({ from: d, to: l.target, trusted, why: `via ${d.key} (${l.label})`, hops });
      // Mentions are followed from incidents and postmortems; design documents mention too much to follow forward.
      if (!leaf && d.kind !== 'design') for (const t of d.mentions) {
        const t2 = trusted && d.kind === 'postmortem';
        if (t2 || canHop) edges.push({ from: d, to: t, trusted: t2, why: `mentioned in ${name(d)}`, hops: t2 ? hops : hops + 1 });
      }
      if (d.kind === 'design' && canHop) for (const t of await index.candidates([`m:${d.id}`], 40)) edges.push({ from: d, to: t, trusted: false, why: `cites ${name(d)}`, hops: hops + 1 });
    }
    await loadMissing(edges.map((e) => e.to));
    const next: typeof frontier = [];
    for (const e of edges) {
      if (seen.has(e.to)) continue;
      const d = byId.get(e.to);
      if (!d || !followKinds.includes(d.doc.kind)) continue;
      const viaLink = e.why.startsWith('via ');
      if (!e.trusted && !viaLink) {
        // Reached through a mention or citation: it must look like the query in content, not only share a service.
        const sc = scoredById.get(e.to)?.s ?? scorePair(q, d, ctx);
        const g = sc.signals;
        if (sc.score < U.score || Math.max(g.lex, g.tech, g.sig) < U.content) continue;
      }
      seen.add(e.to);
      viaOf.set(e.to, e.why);
      if (!e.trusted) untrusted.add(e.to);
      next.push({ d: d.doc, trusted: e.trusted, hops: e.hops });
    }
    frontier = next;
  }

  const reached = (id: string) => viaOf.get(id);
  const hitFor = (d: Stored) => {
    const s = scoredById.get(d.doc.id)?.s ?? scorePair(q, d, ctx);
    const h = hitOf(d, s);
    const via = reached(d.doc.id);
    if (via && !h.reasons.some((r) => r.kind === 'link')) h.reasons.unshift({ kind: 'followup', text: via });
    return h;
  };

  // 6. Follow-up debt: open action items reached through the graph, or strongly about the same thing.
  const debtDocs = new Map<string, Stored>();
  for (const id of viaOf.keys()) { const d = byId.get(id); if (d && d.doc.kind === 'action' && d.doc.status !== 'done') debtDocs.set(id, d); }
  for (const { d, s } of scored) if (d.doc.kind === 'action' && d.doc.status !== 'done' && s.score >= TUNING.debtDirectMin) debtDocs.set(d.doc.id, d);
  const debt: DebtItem[] = [...debtDocs.values()].map((d) => {
    const h = hitFor(d);
    const overdue = d.doc.dueDate ? days(now, `${d.doc.dueDate}T00:00:00Z`) : undefined;
    return { ...h, ageDays: Math.max(0, days(now, d.doc.occurredAt)), dueDate: d.doc.dueDate, overdueDays: overdue && overdue > 0 ? overdue : undefined, via: reached(d.doc.id) };
  }).sort((a, b) => b.ageDays - a.ageDays);

  // 7. Postmortems (how it was handled) and background reading (decisions, guides, runbooks). No age penalty.
  const collect = (kinds: DocKind[]) => {
    const m = new Map<string, Hit>();
    for (const id of viaOf.keys()) { const d = byId.get(id); if (d && kinds.includes(d.doc.kind)) m.set(id, hitFor(d)); }
    for (const { d, s } of scored) {
      const content = Math.max(s.signals.lex, s.signals.tech, s.signals.sig);
      if (kinds.includes(d.doc.kind) && bgOk(s.score) && content >= TUNING.backgroundMinContent && !m.has(d.doc.id)) m.set(d.doc.id, hitFor(d));
    }
    return [...m.values()].sort((a, b) => b.score - a.score + (reached(b.id) ? 0.15 : 0) - (reached(a.id) ? 0.15 : 0)).slice(0, limit);
  };
  // A review issue and its postmortem page are one postmortem: keep the page, which holds the write-up.
  const postmortems = collect(['postmortem']).filter((h, _i, all) => {
    if (!h.id.startsWith('jira:')) return true;
    const d = byId.get(h.id);
    return !d?.doc.mentions.some((m) => all.some((x) => x.id === m));
  });
  const background = collect(['design', 'runbook']);

  // 8. Everything else that is clearly related (other incidents, work items), excluding what is already shown.
  const shown = new Set([...recurrenceHits.map((h) => h.id), ...debt.map((h) => h.id), ...postmortems.map((h) => h.id), ...background.map((h) => h.id)]);
  const relatedPool = new Map(scored.filter(({ d, s }) => s.score >= TUNING.relatedMin && !(d.doc.kind === 'action' && d.doc.status === 'done' && !reached(d.doc.id))).map((x) => [x.d.doc.id, x.d]));
  for (const id of viaOf.keys()) { const d = byId.get(id); if (d && d.doc.kind === 'incident') relatedPool.set(id, d); }
  const related = [...relatedPool.values()].filter((d) => !shown.has(d.doc.id)).map((d) => {
    const h = hitFor(d);
    // Say so when an incident looks similar but its error lines do not match: probably a different cause.
    if (isIncident && d.doc.kind === 'incident' && contradicts(q, d, h.signals.sig)) h.reasons.push({ kind: 'text', text: 'different error lines: probably a different cause' });
    return h;
  }).sort((a, b) => b.score - a.score).slice(0, limit);

  const last90 = recurrenceHits.filter((h) => days(asOf, h.occurredAt) <= 90).length;
  return {
    query: { id: q.doc.id, key: q.doc.key, title: q.doc.title, kind: q.doc.kind, occurredAt: q.doc.occurredAt, services: q.doc.services },
    recurrence: {
      count: recurrenceHits.length ? recurrenceHits.length + 1 : 0,
      last90Days: recurrenceHits.length ? last90 + 1 : 0,
      firstSeen: recurrenceHits.at(-1)?.occurredAt,
      items: recurrenceHits.slice(0, limit),
    },
    debt: debt.slice(0, limit),
    postmortems,
    background,
    related,
    stats: { candidates: loaded.length, indexed: stats.n },
  };
}
