// Admin-editable settings (Forge KVS) and the MatchConfig derived from them.

import { kvs } from '@forge/kvs';
import type { MatchConfig } from '../core/doc';
import { jira } from '../ingest/clients';

export interface Settings {
  /** Jira project keys to index; empty = every project (last 2 years). */
  jiraProjects: string[];
  /** Confluence space keys to index; empty = none. */
  confluenceSpaces: string[];
  /** Name of the date-time custom field holding when an incident really happened (optional). */
  occurredFieldName?: string;
  resolvedFieldName?: string;
  /** Canonical service/resource names and their aliases. Unknown Jira components count as services anyway. */
  entities: MatchConfig['entities'];
}

export const DEFAULT_SETTINGS: Settings = { jiraProjects: [], confluenceSpaces: [], entities: {} };

const SETTINGS_KEY = 'settings';
const PEOPLE_KEY = 'people-names';
const SITE_KEY = 'site-url';
const STATUS_KEY = 'index-status';

/** Saved settings; if none were saved yet, the environment default (forge variables DEJA_VU_DEFAULT_SETTINGS), else empty. */
export async function getSettings(): Promise<Settings> {
  const saved = await kvs.get<Settings>(SETTINGS_KEY);
  if (saved) return { ...DEFAULT_SETTINGS, ...saved };
  const env = process.env.DEJA_VU_DEFAULT_SETTINGS;
  if (env) {
    try { const v = validateSettings(JSON.parse(env)); if (v.ok) return v.settings; } catch { /* ignore a malformed default */ }
  }
  return DEFAULT_SETTINGS;
}

export async function hasSavedSettings(): Promise<boolean> {
  return !!(await kvs.get<Settings>(SETTINGS_KEY));
}

export function validateSettings(input: any): { ok: true; settings: Settings } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Settings must be a JSON object.' };
  const arr = (v: any) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (input.jiraProjects !== undefined && !arr(input.jiraProjects)) return { ok: false, error: 'jiraProjects must be a list of project keys.' };
  if (input.confluenceSpaces !== undefined && !arr(input.confluenceSpaces)) return { ok: false, error: 'confluenceSpaces must be a list of space keys.' };
  const entities: Settings['entities'] = {};
  for (const [name, e] of Object.entries<any>(input.entities ?? {})) {
    if (!e || (e.kind !== 'service' && e.kind !== 'resource')) return { ok: false, error: `entities.${name}.kind must be "service" or "resource".` };
    if (e.aliases !== undefined && !arr(e.aliases)) return { ok: false, error: `entities.${name}.aliases must be a list of strings.` };
    entities[name.toLowerCase()] = { kind: e.kind, aliases: (e.aliases ?? []).map((a: string) => a.toLowerCase()), owner: typeof e.owner === 'string' ? e.owner : undefined };
  }
  return {
    ok: true,
    settings: {
      jiraProjects: (input.jiraProjects ?? []).map((k: string) => k.trim().toUpperCase()).filter(Boolean),
      confluenceSpaces: (input.confluenceSpaces ?? []).map((k: string) => k.trim()).filter(Boolean),
      occurredFieldName: typeof input.occurredFieldName === 'string' && input.occurredFieldName ? input.occurredFieldName : undefined,
      resolvedFieldName: typeof input.resolvedFieldName === 'string' && input.resolvedFieldName ? input.resolvedFieldName : undefined,
      entities,
    },
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  await kvs.set(SETTINGS_KEY, s);
}

/** MatchConfig for this invocation: settings + resolved custom field ids + the site's people names. */
let cached: { at: number; cfg: MatchConfig; site: string } | undefined;
export async function matchConfig(): Promise<{ cfg: MatchConfig; site: string; settings: Settings }> {
  const settings = await getSettings();
  if (cached && Date.now() - cached.at < 60_000) return { cfg: cached.cfg, site: cached.site, settings };
  const [fields, people, site] = await Promise.all([jira.fields(), peopleNames(), siteUrl()]);
  const fid = (name?: string) => (name ? fields.find((f: any) => f.name === name)?.id : undefined);
  const cfg: MatchConfig = { entities: settings.entities, occurredField: fid(settings.occurredFieldName), resolvedField: fid(settings.resolvedFieldName), peopleNames: people };
  cached = { at: Date.now(), cfg, site };
  return { cfg, site, settings };
}

/** Display names of active users, refreshed daily: removed from text so authorship is not mistaken for topic. */
async function peopleNames(): Promise<string[]> {
  const c = await kvs.get<{ at: number; names: string[] }>(PEOPLE_KEY);
  if (c && Date.now() - c.at < 86_400_000) return c.names;
  const names = await jira.activeUserNames();
  await kvs.set(PEOPLE_KEY, { at: Date.now(), names });
  return names;
}

async function siteUrl(): Promise<string> {
  const c = await kvs.get<string>(SITE_KEY);
  if (c) return c;
  const url = await jira.baseUrl();
  await kvs.set(SITE_KEY, url);
  return url;
}

export interface IndexStatus {
  state: 'idle' | 'running' | 'failed';
  mode?: 'full' | 'recent';
  startedAt?: string;
  finishedAt?: string;
  issues: number;
  pages: number;
  errors: number;
  lastError?: string;
}

export async function getStatus(): Promise<IndexStatus> {
  return (await kvs.get<IndexStatus>(STATUS_KEY)) ?? { state: 'idle', issues: 0, pages: 0, errors: 0 };
}
export async function setStatus(s: IndexStatus): Promise<void> {
  await kvs.set(STATUS_KEY, s);
}
