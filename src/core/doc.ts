// The document model: every Jira issue and Confluence page becomes a Doc.
// Mapping is pure (REST JSON in, Doc out) so Forge ingest and the offline eval share it exactly.

import { fromAdf, fromStorage, mergeContent, sectionText } from './content';
import type { Content } from './content';

export type DocKind = 'incident' | 'postmortem' | 'action' | 'work' | 'design' | 'runbook' | 'page';
export type DocStatus = 'open' | 'inprogress' | 'done';
export type LinkRel = 'review' | 'action' | 'cause' | 'relates' | 'duplicate' | 'other';

export interface DocLink {
  rel: LinkRel;
  target: string; // doc id of the other end
  label: string; // human description as Jira shows it from this side, e.g. "is reviewed by"
}

export interface Doc {
  id: string; // 'jira:OPS-23' or 'conf:4161537'
  source: 'jira' | 'confluence';
  key: string; // issue key or page id
  title: string;
  url: string;
  kind: DocKind;
  subkind?: string; // adr, rfc, epic, story, task, bug, capacity-plan...
  status: DocStatus;
  statusText?: string; // Jira status name, or "Rejected" / "Accepted" parsed from a page
  priority?: string;
  container: string; // project key or space key
  labels: string[];
  services: string[]; // canonical service names (components, title mentions)
  resources: string[]; // canonical shared resources mentioned anywhere (pg-main, redis-shared)
  assignee?: { accountId: string; name: string };
  occurredAt: string; // ISO; when it happened (configurable field), else created
  createdAt: string;
  resolvedAt?: string;
  dueDate?: string;
  links: DocLink[];
  mentions: string[]; // doc ids referenced in the text (issue keys, page links)
  resolution?: string; // short "how it was fixed" text, when the item has one
  aliasHits?: { alias: string; canonical: string }[]; // e.g. component "order-worker" counted as "order-pipeline"
}

/** Site-specific knowledge the admin can configure. Nothing here is hardcoded for the demo. */
export interface MatchConfig {
  /** canonical name -> aliases. kind 'service' = owned app, 'resource' = shared infrastructure. */
  entities: Record<string, { kind: 'service' | 'resource'; aliases: string[]; owner?: string }>;
  /** Custom field id holding the real time of an incident (e.g. "Occurred at"). Falls back to created. */
  occurredField?: string;
  resolvedField?: string;
  /** Display names of the site's users. Removed from text: who wrote something is not what it is about. */
  peopleNames?: string[];
}

/** Remove people's names so authorship does not look like topical similarity. */
export function stripNames(text: string, cfg: MatchConfig): string {
  if (!cfg.peopleNames?.length) return text;
  const parts = new Set<string>();
  for (const n of cfg.peopleNames) {
    if (!n || n.length < 3) continue;
    parts.add(n);
    for (const p of n.split(/\s+/)) if (p.length >= 3) parts.add(p);
  }
  const re = new RegExp(`\\b(${[...parts].sort((a, b) => b.length - a.length).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');
  return text.replace(re, ' ');
}

export interface Mapped {
  doc: Doc;
  content: Content; // full text for feature extraction (not stored)
}

// ---------- entities ----------

/** Finds canonical entity names whose name or alias appears as a whole word/phrase in the text. */
export function findEntities(text: string, cfg: MatchConfig, kind?: 'service' | 'resource'): string[] {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9.\-_]+/g, ' ')} `;
  const found: string[] = [];
  for (const [name, e] of Object.entries(cfg.entities)) {
    if (kind && e.kind !== kind) continue;
    if ([name, ...e.aliases].some((a) => lower.includes(` ${a.toLowerCase()} `))) found.push(name);
  }
  return found;
}

export function canonicalEntity(name: string, cfg: MatchConfig): string | undefined {
  const n = name.toLowerCase();
  for (const [canon, e] of Object.entries(cfg.entities)) if (canon === n || e.aliases.some((a) => a.toLowerCase() === n)) return canon;
  return undefined;
}

// ---------- Jira ----------

export const JIRA_FIELDS = ['summary', 'description', 'comment', 'issuetype', 'status', 'labels', 'components', 'assignee', 'created', 'resolutiondate', 'priority', 'issuelinks', 'duedate', 'project', 'updated'];

const KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;
const PAGE_RE = /\/pages\/(\d+)/g;

function mentionsIn(text: string, urls: string[], selfId: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(KEY_RE)) ids.add(`jira:${m[1]}`);
  for (const u of urls) {
    for (const m of u.matchAll(/\/browse\/([A-Z][A-Z0-9]{1,9}-\d+)/g)) ids.add(`jira:${m[1]}`);
    for (const m of u.matchAll(PAGE_RE)) ids.add(`conf:${m[1]}`);
  }
  ids.delete(selfId);
  return [...ids];
}

function relOf(typeName: string): LinkRel {
  const t = typeName.toLowerCase();
  if (t.includes('review')) return 'review';
  if (t.includes('action item')) return 'action';
  if (t.includes('problem') || t.includes('cause')) return 'cause';
  if (t.includes('duplicate')) return 'duplicate';
  if (t.includes('relate')) return 'relates';
  return 'other';
}

const statusOf = (cat?: string): DocStatus => (cat === 'done' ? 'done' : cat === 'indeterminate' ? 'inprogress' : 'open');

export function mapJiraIssue(issue: any, site: string, cfg: MatchConfig): Mapped {
  const f = issue.fields ?? {};
  const id = `jira:${issue.key}`;
  const desc = fromAdf(f.description);
  const comments = (f.comment?.comments ?? []).map((c: any) => fromAdf(c.body));
  const content = mergeContent([desc, ...comments]);
  const typeName: string = f.issuetype?.name ?? '';
  const labels: string[] = f.labels ?? [];

  const links: DocLink[] = (f.issuelinks ?? []).map((l: any) => {
    // On this issue, `inwardIssue` present => this issue is the outward side, and vice versa.
    const other = l.inwardIssue ?? l.outwardIssue;
    const label = l.inwardIssue ? l.type?.outward : l.type?.inward;
    return { rel: relOf(l.type?.name ?? ''), target: `jira:${other?.key}`, label: label ?? l.type?.name ?? 'relates to' };
  }).filter((l: DocLink) => l.target !== 'jira:undefined');

  let kind: DocKind = 'work';
  if (/post-incident review|postmortem|post mortem/i.test(typeName)) kind = 'postmortem';
  else if (/incident/i.test(typeName)) kind = 'incident';
  else if (labels.includes('postmortem-action') || (f.issuelinks ?? []).some((l: any) => /action item/i.test(l.type?.name ?? '') && l.outwardIssue)) kind = 'action';

  const components: string[] = (f.components ?? []).map((c: any) => c.name);
  const services = new Set<string>();
  const resources = new Set<string>();
  const aliasHits: { alias: string; canonical: string }[] = [];
  for (const c of components) {
    const canon = canonicalEntity(c, cfg);
    if (!canon) { services.add(c.toLowerCase()); continue; } // unconfigured components still name a service
    if (canon !== c.toLowerCase()) aliasHits.push({ alias: c, canonical: canon });
    (cfg.entities[canon].kind === 'service' ? services : resources).add(canon);
  }
  for (const s of findEntities(f.summary ?? '', cfg, 'service')) services.add(s);
  for (const l of labels) { const canon = canonicalEntity(l, cfg); if (canon) (cfg.entities[canon].kind === 'service' ? services : resources).add(canon); }
  for (const r of findEntities(content.text, cfg, 'resource')) resources.add(r);

  const occurred = (cfg.occurredField && f[cfg.occurredField]) || f.created;
  const resolved = (cfg.resolvedField && f[cfg.resolvedField]) || f.resolutiondate || undefined;
  const resolution = sectionText(desc, 'resolution', 'fix', 'how it was fixed', 'workaround');

  return {
    content: { ...content, text: stripNames(`${f.summary ?? ''}\n${content.text}`, cfg) },
    doc: {
      id, source: 'jira', key: issue.key, title: f.summary ?? issue.key, url: `${site}/browse/${issue.key}`,
      kind, subkind: typeName.toLowerCase().replace(/^\[system\]\s*/, ''),
      status: statusOf(f.status?.statusCategory?.key), statusText: f.status?.name, priority: f.priority?.name,
      container: f.project?.key ?? issue.key.split('-')[0], labels,
      services: [...services], resources: [...resources],
      assignee: f.assignee ? { accountId: f.assignee.accountId, name: f.assignee.displayName } : undefined,
      occurredAt: toIso(occurred), createdAt: toIso(f.created), resolvedAt: resolved ? toIso(resolved) : undefined,
      dueDate: f.duedate ?? undefined, links,
      mentions: mentionsIn(content.text, content.urls, id),
      resolution: resolution ? clip(resolution, 500) : undefined,
      aliasHits: aliasHits.length ? aliasHits : undefined,
    },
  };
}

// ---------- Confluence ----------

/** v1 content expand list used by ingest (labels and body in one call). */
export const CONFLUENCE_EXPAND = 'body.storage,metadata.labels,history,version,space';

export function mapConfluencePage(page: any, site: string, cfg: MatchConfig): Mapped {
  const content = fromStorage(page.body?.storage?.value ?? '');
  const title: string = page.title ?? '';
  const labels: string[] = (page.metadata?.labels?.results ?? []).map((l: any) => String(l.name).toLowerCase());
  const id = `conf:${page.id}`;
  const head = content.text.slice(0, 400);

  let kind: DocKind = 'page';
  let subkind: string | undefined;
  if (/^adr[- ]?\d+/i.test(title) || labels.includes('adr')) { kind = 'design'; subkind = 'adr'; }
  else if (/^rfc\b/i.test(title) || labels.includes('rfc')) { kind = 'design'; subkind = 'rfc'; }
  else if (/^runbook\b/i.test(title) || labels.includes('runbook')) { kind = 'runbook'; subkind = 'runbook'; }
  else if (/^(postmortem|post-incident)/i.test(title) || labels.includes('postmortem')) { kind = 'postmortem'; subkind = 'postmortem'; }
  else if (labels.some((l) => ['design', 'architecture', 'system-design', 'capacity-plan', 'guide', 'database', 'data-model', 'service-catalog'].includes(l))) {
    kind = 'design'; subkind = labels.find((l) => ['capacity-plan', 'guide', 'service-catalog'].includes(l)) ?? 'design';
  }

  // Pages can state when they were really written ("Written 2025-11-24 by ..."); otherwise use the created date.
  const written = /\b(?:written|date|created)\s*:?\s*(\d{4}-\d{2}-\d{2})/i.exec(head)?.[1];
  const created = page.history?.createdDate ?? page.version?.when ?? new Date(0).toISOString();
  const statusText = /\bstatus:?\s*\*{0,2}\s*(accepted|rejected|proposed|superseded|draft|approved)/i.exec(head)?.[1];

  const services = new Set<string>(findEntities(title, cfg, 'service'));
  for (const l of labels) { const canon = canonicalEntity(l, cfg); if (canon && cfg.entities[canon].kind === 'service') services.add(canon); }

  return {
    content: { ...content, text: stripNames(`${title}\n${content.text}`, cfg) },
    doc: {
      id, source: 'confluence', key: String(page.id), title,
      url: page._links?.webui ? `${site}/wiki${page._links.webui}` : `${site}/wiki/pages/viewpage.action?pageId=${page.id}`,
      kind, subkind, status: 'done', statusText: statusText ? cap(statusText) : undefined,
      container: page.space?.key ?? '', labels,
      services: [...services], resources: findEntities(content.text, cfg, 'resource'),
      occurredAt: written ? `${written}T00:00:00.000Z` : toIso(created), createdAt: toIso(created),
      links: [], mentions: mentionsIn(content.text, content.urls, id),
    },
  };
}

// ---------- helpers ----------

export function toIso(v: string | undefined): string {
  if (!v) return new Date(0).toISOString();
  const d = new Date(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1).toLowerCase();
export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
