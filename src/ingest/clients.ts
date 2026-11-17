// Thin wrappers over the Jira and Confluence REST APIs.
// Background work runs as the app; anything a user triggers that writes runs as that user (asUser).

import api, { route } from '@forge/api';
import { JIRA_FIELDS } from '../core/doc';

type Who = 'app' | 'user';
const client = (who: Who) => (who === 'user' ? api.asUser() : api.asApp());

async function json(res: { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any> }, what: string): Promise<any> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? {} : res.json();
}

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

export const jira = {
  async fields(): Promise<any[]> {
    return json(await api.asApp().requestJira(route`/rest/api/3/field`, { headers: { Accept: 'application/json' } }), 'list fields');
  },

  async baseUrl(): Promise<string> {
    const r = await json(await api.asApp().requestJira(route`/rest/api/3/serverInfo`, { headers: { Accept: 'application/json' } }), 'server info');
    return String(r.baseUrl).replace(/\/$/, '');
  },

  async activeUserNames(): Promise<string[]> {
    const names: string[] = [];
    for (let start = 0; start < 2000; start += 100) {
      const page = await json(await api.asApp().requestJira(route`/rest/api/3/users/search?startAt=${start}&maxResults=100`, { headers: { Accept: 'application/json' } }), 'list users');
      names.push(...page.filter((u: any) => u.accountType === 'atlassian' && u.active).map((u: any) => u.displayName));
      if (page.length < 100) break;
    }
    return names;
  },

  async issue(key: string, extraFields: string[], who: Who = 'app'): Promise<any> {
    const fields = [...JIRA_FIELDS, ...extraFields].join(',');
    return json(await client(who).requestJira(route`/rest/api/3/issue/${key}?fields=${fields}`, { headers: { Accept: 'application/json' } }), `read ${key}`);
  },

  async search(jql: string, extraFields: string[], nextPageToken?: string): Promise<{ issues: any[]; nextPageToken?: string }> {
    const body = { jql, fields: [...JIRA_FIELDS, ...extraFields], maxResults: 50, ...(nextPageToken ? { nextPageToken } : {}) };
    return json(await api.asApp().requestJira(route`/rest/api/3/search/jql`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }), 'search issues');
  },

  /** Which of these issue keys the current user can see (one JQL search, as the user). */
  async visibleKeys(keys: string[]): Promise<Set<string>> {
    if (!keys.length) return new Set();
    const body = { jql: `key in (${keys.map((k) => `"${k.replace(/"/g, '')}"`).join(',')})`, fields: ['summary'], maxResults: 100 };
    const r = await json(await api.asUser().requestJira(route`/rest/api/3/search/jql`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }), 'check visibility');
    return new Set((r.issues ?? []).map((i: any) => i.key));
  },

  async link(fromKey: string, toKey: string, who: Who = 'user'): Promise<void> {
    await json(await client(who).requestJira(route`/rest/api/3/issueLink`, {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ type: { name: 'Relates' }, outwardIssue: { key: fromKey }, inwardIssue: { key: toKey } }),
    }), `link ${fromKey} to ${toKey}`);
  },

  async comment(key: string, adfBody: unknown, who: Who = 'user'): Promise<{ id: string }> {
    return json(await client(who).requestJira(route`/rest/api/3/issue/${key}/comment`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ body: adfBody }) }), `comment on ${key}`);
  },
};

// Confluence v1 content listing is gone for apps (410), so pages are read with the v2 API and adapted to the
// v1-like shape that mapConfluencePage (shared with the eval) understands.
async function v2ToV1(page: any, spaceKey: string): Promise<any> {
  const labels = await json(await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${page.id}/labels?limit=100`, { headers: { Accept: 'application/json' } }), `labels of ${page.id}`).catch(() => ({ results: [] }));
  return {
    id: page.id, title: page.title,
    body: { storage: { value: page.body?.storage?.value ?? '' } },
    metadata: { labels: { results: (labels.results ?? []).map((l: any) => ({ name: l.name })) } },
    history: { createdDate: page.createdAt },
    version: { when: page.version?.createdAt },
    space: { key: spaceKey },
    _links: { webui: page._links?.webui },
  };
}

const spaceCache = new Map<string, { id: string; key: string }>();
async function spaceByKey(key: string): Promise<{ id: string; key: string }> {
  const hit = spaceCache.get(key);
  if (hit) return hit;
  const r = await json(await api.asApp().requestConfluence(route`/wiki/api/v2/spaces?keys=${key}`, { headers: { Accept: 'application/json' } }), `find space ${key}`);
  const sp = r.results?.[0];
  if (!sp) throw new Error(`Confluence space ${key} not found`);
  const v = { id: String(sp.id), key: sp.key };
  spaceCache.set(key, v);
  return v;
}
async function spaceKeyById(id: string): Promise<string> {
  for (const v of spaceCache.values()) if (v.id === id) return v.key;
  const sp = await json(await api.asApp().requestConfluence(route`/wiki/api/v2/spaces/${id}`, { headers: { Accept: 'application/json' } }), `read space ${id}`);
  spaceCache.set(sp.key, { id: String(sp.id), key: sp.key });
  return sp.key;
}

export const confluence = {
  async page(id: string): Promise<any> {
    const p = await json(await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${id}?body-format=storage`, { headers: { Accept: 'application/json' } }), `read page ${id}`);
    return v2ToV1(p, await spaceKeyById(String(p.spaceId)));
  },

  /** True if the current user can read the page. */
  async canView(id: string): Promise<boolean> {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${id}`, { headers: { Accept: 'application/json' } });
    return res.ok;
  },

  /** One page of pages in a space (cursor-based). */
  async pages(spaceKey: string, cursor?: string): Promise<{ results: any[]; next?: string }> {
    const sp = await spaceByKey(spaceKey);
    const r = cursor
      ? await json(await api.asApp().requestConfluence(route`/wiki/api/v2/spaces/${sp.id}/pages?body-format=storage&limit=25&status=current&cursor=${cursor}`, { headers: { Accept: 'application/json' } }), `list pages in ${spaceKey}`)
      : await json(await api.asApp().requestConfluence(route`/wiki/api/v2/spaces/${sp.id}/pages?body-format=storage&limit=25&status=current`, { headers: { Accept: 'application/json' } }), `list pages in ${spaceKey}`);
    const next = r._links?.next ? new URL(r._links.next, 'https://x').searchParams.get('cursor') ?? undefined : undefined;
    return { results: await Promise.all((r.results ?? []).map((p: any) => v2ToV1(p, spaceKey))), next };
  },

  /** Ids of pages changed in the last N days in the given spaces (v1 search is still supported). */
  async recentlyModifiedIds(spaceKeys: string[], sinceDays: number, start: number): Promise<{ ids: string[]; size: number }> {
    const cql = `type=page AND space IN (${spaceKeys.map((k) => `"${k.replace(/"/g, '')}"`).join(',')}) AND lastmodified >= now("-${sinceDays | 0}d")`;
    const r = await json(await api.asApp().requestConfluence(route`/wiki/rest/api/search?cql=${cql}&limit=25&start=${start}`, { headers: { Accept: 'application/json' } }), 'search recent pages');
    const ids = (r.results ?? []).map((x: any) => String(x.content?.id ?? '')).filter(Boolean);
    return { ids, size: (r.results ?? []).length };
  },
};
