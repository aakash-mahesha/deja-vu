// Rovo agent actions (also exposed as MCP tools). Inputs are extracted by the LLM, so:
//   - the context (issue/page being viewed) wins over guessed inputs,
//   - write actions are two-step: without confirmed=true they only return a preview and change nothing,
//   - the acting user comes from the invocation context, never from inputs.

import type { DebtItem, Hit, RelatedResult } from '../core/match';
import { escalate, followupDebt, linkAsRelated, related } from '../services/related';

interface ActionPayload {
  context?: { jira?: { issueKey?: string }; confluence?: { contentId?: string } };
  [input: string]: unknown;
}
interface ActionContext { principal?: { accountId?: string }; accountId?: string }

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const yes = (v: unknown) => v === true || v === 'true';
const day = (iso: string) => iso.slice(0, 10);
const who = (c?: ActionContext) => c?.principal?.accountId ?? c?.accountId ?? '';

function brief(h: Hit) {
  return { key: h.key, title: h.title, url: h.url, kind: h.subkind ?? h.kind, status: h.statusText ?? h.status, date: day(h.occurredAt), score: h.score, why: h.reasons.map((r) => r.text) };
}
function debtBrief(d: DebtItem) {
  return { key: d.key, title: d.title, url: d.url, owner: d.assignee?.name ?? 'unassigned', ageDays: d.ageDays, overdueDays: d.overdueDays ?? 0, from: d.via, status: d.statusText ?? d.status };
}

export function summarize(r: RelatedResult) {
  return {
    about: { key: r.query.key, title: r.query.title, kind: r.query.kind, date: day(r.query.occurredAt), services: r.query.services },
    repeat: r.recurrence.count
      ? { occurrence: r.recurrence.count, inLast90Days: r.recurrence.last90Days, firstSeen: r.recurrence.firstSeen ? day(r.recurrence.firstSeen) : undefined,
          past: r.recurrence.items.map((h) => ({ ...brief(h), howItWasFixed: h.resolution })) }
      : 'No earlier occurrence of the same cause was found.',
    openFollowUps: r.debt.map(debtBrief),
    postmortems: r.postmortems.map(brief),
    readFirst: r.background.map(brief),
    alsoRelated: r.related.map(brief),
    note: `Deterministic match over ${r.stats.indexed} indexed items (${r.stats.candidates} compared). Every item lists why it matched.`,
  };
}

export async function findRelatedAction(payload: ActionPayload, context?: ActionContext) {
  const issueKey = str(payload.issueKey) ?? payload.context?.jira?.issueKey;
  const pageId = str(payload.pageId) ?? payload.context?.confluence?.contentId;
  const text = str(payload.description);
  try {
    const res = await related(issueKey ? { issueKey } : pageId ? { pageId } : { text }, 'user');
    return summarize(res);
  } catch (e: any) {
    return { error: String(e?.message ?? e), hint: 'Ask for an issue key (like OPS-51), a Confluence page, or a short description of the problem.', user: who(context) ? 'known' : 'unknown' };
  }
}

export async function followupDebtAction(payload: ActionPayload) {
  const res = await followupDebt(str(payload.service));
  const byService: Record<string, number> = {};
  for (const i of res.items) for (const s of i.services.length ? i.services : ['(no service)']) byService[s] = (byService[s] ?? 0) + 1;
  return {
    service: res.service ?? 'all services', openActionItems: res.total,
    oldestFirst: res.items.slice(0, 15).map(debtBrief),
    perService: byService,
  };
}

export async function linkRelatedAction(payload: ActionPayload, context?: ActionContext) {
  const issueKey = str(payload.issueKey) ?? payload.context?.jira?.issueKey;
  const targets = (str(payload.relatedKeys) ?? '').split(/[\s,;]+/).filter(Boolean);
  if (!issueKey || !targets.length) return { error: 'Need the issue to link from (issueKey) and the issues to link (relatedKeys).' };
  if (!yes(payload.confirmed)) {
    return { preview: true, wouldLink: targets.map((t) => `${issueKey} relates to ${t}`), instruction: 'Nothing has been changed. Show this to the user and call again with confirmed=true only after they explicitly agree.' };
  }
  return { done: true, ...(await linkAsRelated(issueKey, targets, who(context))) };
}

export async function escalateAction(payload: ActionPayload, context?: ActionContext) {
  const actionKey = str(payload.actionItemKey);
  if (!actionKey) return { error: 'Need the action item key (actionItemKey).' };
  const contextKey = str(payload.incidentKey) ?? payload.context?.jira?.issueKey;
  if (!yes(payload.confirmed)) {
    return { preview: true, wouldComment: `On ${actionKey}: mention the assignee, say how long it has been open${contextKey ? ` and that ${contextKey} looks like a repeat` : ''}.`, instruction: 'Nothing has been changed. Show this to the user and call again with confirmed=true only after they explicitly agree.' };
  }
  return { done: true, ...(await escalate(actionKey, contextKey, str(payload.note), who(context))) };
}
