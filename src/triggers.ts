// Event handlers: product events keep the index fresh, the queue consumer runs crawls,
// the daily sweep catches anything missed, the lifecycle trigger prepares storage.

import { kvs } from '@forge/kvs';
import { SqlIndex, ensureSchema } from './store/sql';
import { related } from './services/related';
import { ensureIndexed, indexIssue, indexPage, runCrawl, startCrawl } from './ingest/indexer';
import type { CrawlJob } from './ingest/indexer';
import { getSettings, getStatus } from './store/settings';

/**
 * avi:jira:created:issue / updated / deleted. The issue is re-read over REST (the payload shape is not relied on).
 * When an incident is created, its match is computed right away and kept, so repeat rates can be tracked over time.
 */
export async function onIssueEvent(event: any): Promise<void> {
  const key: string | undefined = event?.issue?.key;
  if (!key) return;
  try {
    if (String(event?.eventType ?? '').includes('deleted')) { await new SqlIndex().remove(`jira:${key}`); console.info(`deja-vu: removed ${key}`); return; }
    const state = await ensureIndexed();
    const indexed = await indexIssue(String(key));
    if (!indexed || state !== 'ready' || !String(event?.eventType ?? '').includes('created')) return;
    const res = await related({ issueKey: key }, 'app');
    if (res.query.kind !== 'incident') return;
    const summary = {
      at: new Date().toISOString(), occurrence: res.recurrence.count, last90Days: res.recurrence.last90Days,
      repeats: res.recurrence.items.map((h) => h.key), openFollowUps: res.debt.map((d) => `${d.key} (${d.ageDays}d, ${d.assignee?.name ?? 'unassigned'})`),
      readFirst: res.background.slice(0, 3).map((h) => h.title),
    };
    await kvs.set(`match:${key}`, summary);
    console.info(`deja-vu: ${key} -> ${summary.occurrence ? `occurrence #${summary.occurrence} (${summary.last90Days} in 90d), repeats ${summary.repeats.join(', ')}` : 'no repeat'}; open follow-ups: ${summary.openFollowUps.join(', ') || 'none'}; read first: ${summary.readFirst.join(' | ')}`);
  } catch (e) { console.error(`deja-vu: issue ${key} event failed`, e); }
}

/** avi:confluence:created:page / avi:confluence:updated:page */
export async function onPageEvent(event: any): Promise<void> {
  const id: string | undefined = event?.content?.id;
  if (!id) return;
  try { await ensureIndexed(); await indexPage(String(id), event?.content?.space?.key); }
  catch (e) { console.error(`index page ${id} failed`, e); }
}

/** Queue consumer: one crawl step (resumes itself when it runs out of time). */
export async function indexWorker(event: any): Promise<void> {
  const job = (event?.body ?? event) as CrawlJob;
  await runCrawl(job);
}

/** Daily: re-index what changed in the last two days (events can be missed). */
export async function dailySweep(): Promise<void> {
  const st = await getStatus();
  if (st.state === 'running') return;
  await startCrawl('recent');
}

/** Install / major upgrade: create tables; start a first crawl if the admin already chose what to index. */
export async function onLifecycle(): Promise<void> {
  await ensureSchema();
  const s = await getSettings();
  if (s.jiraProjects.length || s.confluenceSpaces.length) await startCrawl('full');
}
