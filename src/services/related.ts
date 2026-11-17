// Use cases shared by the issue panel, the Rovo agent actions and the MCP tools.

import type { Doc } from '../core/doc';
import { clip, findEntities } from '../core/doc';
import { emptyContent } from '../core/content';
import { extractFeatures } from '../core/features';
import { findRelated } from '../core/match';
import type { DebtItem, RelatedResult, Stored } from '../core/match';
import { mapIssue, mapPage } from '../ingest/indexer';
import { confluence, jira } from '../ingest/clients';
import { SqlIndex, audit } from '../store/sql';
import { matchConfig } from '../store/settings';

const index = new SqlIndex();
const DAY = 86_400_000;

export interface QueryRef {
  issueKey?: string;
  pageId?: string;
  text?: string;
}

/** Builds the query document. Issues and pages are read fresh and written back to the index (keeps it current). */
async function queryDoc(ref: QueryRef, who: 'app' | 'user'): Promise<Stored> {
  if (ref.issueKey) {
    const s = await mapIssue(ref.issueKey.trim().toUpperCase(), who);
    await index.upsert(s.doc, s.f).catch(() => undefined);
    return s;
  }
  if (ref.pageId) {
    const s = await mapPage(String(ref.pageId).trim());
    await index.upsert(s.doc, s.f).catch(() => undefined);
    return s;
  }
  const text = (ref.text ?? '').trim();
  if (!text) throw new Error('Give an issue key, a page id, or a description of the problem.');
  const { cfg } = await matchConfig();
  const content = emptyContent();
  content.text = text;
  // Lines that look like errors or logs are treated as code, so they count as an error signature.
  content.codeBlocks = [text.split('\n').filter((l) => /error|exception|fail|timeout|refused|denied|expired|oom|killed|cannot|too many|\[firing\]/i.test(l)).join('\n')].filter(Boolean);
  const now = new Date().toISOString();
  const doc: Doc = {
    id: `text:${now}`, source: 'jira', key: 'your description', title: clip(text, 120), url: '', kind: 'incident', status: 'open',
    container: '', labels: [], services: findEntities(text, cfg, 'service'), resources: findEntities(text, cfg, 'resource'),
    occurredAt: now, createdAt: now, links: [], mentions: [],
  };
  return { doc, f: extractFeatures(doc, content) };
}

export async function related(ref: QueryRef, who: 'app' | 'user' = 'app'): Promise<RelatedResult> {
  const q = await queryDoc(ref, who);
  // Look back from when the item happened (the configured "occurred" field, else its creation time).
  const res = await findRelated(q, index, { now: new Date().toISOString(), asOf: q.doc.occurredAt, treatAsIncident: !!ref.text });
  return who === 'user' ? onlyVisible(res) : res;
}

/** The index is built as the app; never show a user an item they cannot open themselves. */
async function onlyVisible(res: RelatedResult): Promise<RelatedResult> {
  const all = [...res.recurrence.items, ...res.debt, ...res.postmortems, ...res.background, ...res.related];
  const issueKeys = [...new Set(all.filter((h) => h.id.startsWith('jira:')).map((h) => h.key))];
  const pageIds = [...new Set(all.filter((h) => h.id.startsWith('conf:')).map((h) => h.key))];
  const [keys, pages] = await Promise.all([
    jira.visibleKeys(issueKeys),
    Promise.all(pageIds.map(async (id) => [id, await confluence.canView(id).catch(() => false)] as const)),
  ]);
  const okPages = new Set(pages.filter(([, ok]) => ok).map(([id]) => id));
  const ok = (h: { id: string; key: string }) => (h.id.startsWith('jira:') ? keys.has(h.key) : okPages.has(h.key));
  const items = res.recurrence.items.filter(ok);
  return {
    ...res,
    recurrence: { ...res.recurrence, items, count: items.length ? Math.max(res.recurrence.count - (res.recurrence.items.length - items.length), 2) : 0 },
    debt: res.debt.filter(ok), postmortems: res.postmortems.filter(ok), background: res.background.filter(ok), related: res.related.filter(ok),
  };
}

/** Open postmortem action items, oldest first, optionally for one service (aliases understood). */
export async function followupDebt(service?: string): Promise<{ service?: string; total: number; items: DebtItem[] }> {
  const { cfg } = await matchConfig();
  const want = service ? (findEntities(service, cfg)[0] ?? service.toLowerCase().trim()) : undefined;
  const now = Date.now();
  const items = (await index.openActionItems())
    .filter((s) => !want || s.doc.services.includes(want) || s.doc.resources.includes(want))
    .map(({ doc }): DebtItem => {
      const age = Math.floor((now - new Date(doc.occurredAt).getTime()) / DAY);
      const overdue = doc.dueDate ? Math.floor((now - new Date(`${doc.dueDate}T00:00:00Z`).getTime()) / DAY) : undefined;
      const from = doc.links.find((l) => l.rel === 'action');
      return {
        id: doc.id, key: doc.key, title: doc.title, url: doc.url, kind: doc.kind, status: doc.status, statusText: doc.statusText,
        occurredAt: doc.occurredAt, score: 1, signals: { lex: 0, sig: 0, tech: 0, ent: 0, link: 0 }, reasons: [],
        assignee: doc.assignee, services: doc.services, ageDays: age, dueDate: doc.dueDate,
        overdueDays: overdue && overdue > 0 ? overdue : undefined, via: from ? from.target.replace(/^jira:/, '') : undefined,
      };
    })
    .sort((a, b) => b.ageDays - a.ageDays);
  return { service: want, total: items.length, items };
}

// ---------- writes (always explicitly confirmed by a person, always audited) ----------

export async function linkAsRelated(issueKey: string, targetKeys: string[], accountId: string): Promise<{ linked: string[]; skipped: string[] }> {
  const issue = await jira.issue(issueKey, [], 'user');
  const already = new Set<string>((issue.fields.issuelinks ?? []).map((l: any) => (l.inwardIssue ?? l.outwardIssue)?.key));
  const linked: string[] = []; const skipped: string[] = [];
  for (const t of [...new Set(targetKeys.map((k) => k.trim().toUpperCase()).filter(Boolean))]) {
    if (t === issueKey || already.has(t)) { skipped.push(t); continue; }
    await jira.link(issueKey, t, 'user');
    linked.push(t);
  }
  await audit(accountId, 'link-related', issueKey, { linked, skipped });
  return { linked, skipped };
}

export async function escalate(actionKey: string, contextKey: string | undefined, note: string | undefined, accountId: string): Promise<{ commented: boolean; mentioned?: string; days: number }> {
  const item = await mapIssue(actionKey, 'user');
  if (item.doc.kind !== 'action') throw new Error(`${actionKey} is not a postmortem action item.`);
  if (item.doc.status === 'done') throw new Error(`${actionKey} is already done.`);
  const days = Math.floor((Date.now() - new Date(item.doc.occurredAt).getTime()) / DAY);
  const owner = item.doc.assignee;
  const text: any[] = [];
  if (owner) text.push({ type: 'mention', attrs: { id: owner.accountId, text: `@${owner.name}` } }, { type: 'text', text: ' ' });
  text.push({ type: 'text', text: `this action item has been open for ${days} days.` });
  if (contextKey) text.push({ type: 'text', text: ` ${contextKey} looks like a repeat of the problem it was meant to prevent, so it is being escalated. ` });
  if (note) text.push({ type: 'text', text: ` ${clip(note, 500)}` });
  const body = { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: text },
    { type: 'paragraph', content: [{ type: 'text', text: 'Escalated with Déjà Vu after a person confirmed it.', marks: [{ type: 'em' }] }] },
  ] };
  await jira.comment(actionKey, body, 'user');
  await audit(accountId, 'escalate-action-item', actionKey, { contextKey, days, owner: owner?.accountId, note });
  return { commented: true, mentioned: owner?.name, days };
}
