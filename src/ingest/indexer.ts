// Indexing: one item at a time (events), a full crawl (queue consumer, resumable), and a recent sweep (daily).

import { Queue } from '@forge/events';
import { mapConfluencePage, mapJiraIssue } from '../core/doc';
import type { Mapped } from '../core/doc';
import { extractFeatures } from '../core/features';
import type { Stored } from '../core/match';
import { SqlIndex } from '../store/sql';
import { getStatus, matchConfig, setStatus } from '../store/settings';
import type { Settings } from '../store/settings';
import { confluence, jira } from './clients';

export const INDEX_QUEUE = 'deja-vu-index';
const index = new SqlIndex();

export function toStored(m: Mapped): Stored {
  return { doc: m.doc, f: extractFeatures(m.doc, m.content) };
}

function extraFields(cfg: { occurredField?: string; resolvedField?: string }): string[] {
  return [cfg.occurredField, cfg.resolvedField].filter((x): x is string => !!x);
}

/** Map a Jira issue (fetched fresh) into a stored document, without writing it. */
export async function mapIssue(key: string, who: 'app' | 'user' = 'app'): Promise<Stored> {
  const { cfg, site } = await matchConfig();
  return toStored(mapJiraIssue(await jira.issue(key, extraFields(cfg), who), site, cfg));
}

export async function mapPage(id: string): Promise<Stored> {
  const { cfg, site } = await matchConfig();
  return toStored(mapConfluencePage(await confluence.page(id), site, cfg));
}

function inScope(settings: Settings, projectKey: string): boolean {
  return !settings.jiraProjects.length || settings.jiraProjects.includes(projectKey);
}

export async function indexIssue(key: string): Promise<boolean> {
  const { settings } = await matchConfig();
  if (!inScope(settings, key.split('-')[0])) return false;
  const s = await mapIssue(key);
  await index.upsert(s.doc, s.f);
  return true;
}

export async function indexPage(id: string, spaceKey?: string): Promise<boolean> {
  const { settings } = await matchConfig();
  if (spaceKey && !settings.confluenceSpaces.includes(spaceKey)) return false;
  const s = await mapPage(id);
  if (!settings.confluenceSpaces.includes(s.doc.container)) return false;
  await index.upsert(s.doc, s.f);
  return true;
}

// ---------- crawls (run in the queue consumer, up to 900 s, resumable) ----------

export interface CrawlJob {
  mode: 'full' | 'recent';
  phase: 'jira' | 'confluence';
  nextPageToken?: string;
  spaceIdx?: number;
  start?: number;
  cursor?: string;
  counts?: { issues: number; pages: number; errors: number };
}

/** If nothing is indexed yet (fresh install) and something is configured, start the first full crawl. */
export async function ensureIndexed(): Promise<'ready' | 'started' | 'running' | 'unconfigured'> {
  const [stats, status, { settings }] = await Promise.all([index.stats(), getStatus(), matchConfig()]);
  if (stats.n > 0) return 'ready';
  if (status.state === 'running' && status.startedAt && Date.now() - new Date(status.startedAt).getTime() < 30 * 60_000) return 'running';
  if (!settings.jiraProjects.length && !settings.confluenceSpaces.length) return 'unconfigured';
  await startCrawl('full');
  return 'started';
}

/** Starts a crawl unless one is already running (two crawls at once fight over the same rows). */
export async function startCrawl(mode: 'full' | 'recent'): Promise<boolean> {
  const st = await getStatus();
  if (st.state === 'running' && st.startedAt && Date.now() - new Date(st.startedAt).getTime() < 30 * 60_000) {
    console.info(`deja-vu: ${mode} crawl not started, one is already running`);
    return false;
  }
  console.info(`deja-vu: starting ${mode} crawl`);
  await setStatus({ state: 'running', mode, startedAt: new Date().toISOString(), issues: 0, pages: 0, errors: 0 });
  await new Queue({ key: INDEX_QUEUE }).push({ body: { mode, phase: 'jira' } as any });
  return true;
}

const BUDGET_MS = 780_000; // leave head room under the 900 s consumer limit

export async function runCrawl(job: CrawlJob): Promise<void> {
  const started = Date.now();
  const { cfg, site, settings } = await matchConfig();
  const counts = job.counts ?? { issues: 0, pages: 0, errors: 0 };
  let lastError: string | undefined;
  const fields = extraFields(cfg);

  const save = async (m: Mapped) => {
    try { const s = toStored(m); await index.upsert(s.doc, s.f); }
    catch (e: any) { counts.errors++; lastError = String(e?.message ?? e).slice(0, 300); }
  };
  const resume = async (next: CrawlJob) => {
    await new Queue({ key: INDEX_QUEUE }).push({ body: { ...next, counts } as any });
    const st = await getStatus();
    await setStatus({ ...st, state: 'running', issues: counts.issues, pages: counts.pages, errors: counts.errors, lastError: lastError ?? st.lastError });
  };

  if (job.phase === 'jira') {
    const scope = settings.jiraProjects.length ? `project in (${settings.jiraProjects.map((k) => `"${k}"`).join(',')})` : 'created >= -730d';
    const jql = `${scope}${job.mode === 'recent' ? ' AND updated >= -2d' : ''} ORDER BY created ASC`;
    let token = job.nextPageToken;
    do {
      if (Date.now() - started > BUDGET_MS) return resume({ ...job, nextPageToken: token });
      const page = await jira.search(jql, fields, token);
      for (const issue of page.issues) { await save(mapJiraIssue(issue, site, cfg)); counts.issues++; }
      token = page.nextPageToken;
    } while (token);
    job = { mode: job.mode, phase: 'confluence', spaceIdx: 0, start: 0 };
    await setStatus({ ...(await getStatus()), issues: counts.issues, errors: counts.errors });
  }

  if (job.phase === 'confluence' && settings.confluenceSpaces.length) {
    if (job.mode === 'recent') {
      for (let start = job.start ?? 0; ; start += 25) {
        if (Date.now() - started > BUDGET_MS) return resume({ ...job, start });
        const page = await confluence.recentlyModifiedIds(settings.confluenceSpaces, 2, start);
        for (const id of page.ids) {
          try { await save(mapConfluencePage(await confluence.page(id), site, cfg)); counts.pages++; }
          catch (e: any) { counts.errors++; lastError = String(e?.message ?? e).slice(0, 300); }
        }
        if (page.size < 25) break;
      }
    } else {
      for (let i = job.spaceIdx ?? 0; i < settings.confluenceSpaces.length; i++) {
        let cursor: string | undefined = i === job.spaceIdx ? job.cursor : undefined;
        do {
          if (Date.now() - started > BUDGET_MS) return resume({ ...job, spaceIdx: i, cursor });
          let page;
          try { page = await confluence.pages(settings.confluenceSpaces[i], cursor); }
          catch (e: any) { counts.errors++; lastError = String(e?.message ?? e).slice(0, 300); break; }
          for (const p of page.results) { await save(mapConfluencePage(p, site, cfg)); counts.pages++; }
          cursor = page.next;
        } while (cursor);
      }
    }
  }

  console.info(`deja-vu: ${job.mode} crawl finished: ${counts.issues} issues, ${counts.pages} pages, ${counts.errors} errors${lastError ? ` (last: ${lastError})` : ''}`);
  const st = await getStatus();
  await setStatus({ ...st, state: counts.errors && !counts.issues && !counts.pages ? 'failed' : 'idle', finishedAt: new Date().toISOString(), issues: counts.issues, pages: counts.pages, errors: counts.errors, lastError: lastError ?? st.lastError });
}
