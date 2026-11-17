// Resolvers for the issue panel and the admin page (UI Kit -> backend).

import Resolver from '@forge/resolver';
import { escalate, linkAsRelated, related } from '../services/related';
import { getSettings, getStatus, saveSettings, validateSettings } from '../store/settings';
import { SqlIndex, recentAudit } from '../store/sql';
import { ensureIndexed, startCrawl } from '../ingest/indexer';
import demoSettings from '../../seed/settings.json';

const resolver = new Resolver();
const index = new SqlIndex();

const issueKeyOf = (context: any): string | undefined => context?.extension?.issue?.key;
const accountOf = (context: any): string => context?.accountId ?? '';

/** Issue panel: everything Déjà Vu knows about this issue. */
resolver.define('getRelated', async ({ context }) => {
  const key = issueKeyOf(context);
  if (!key) return { error: 'No issue in context.' };
  try {
    const state = await ensureIndexed();
    if (state === 'started' || state === 'running') return { indexing: true };
    if (state === 'unconfigured') return { unconfigured: true };
    return { result: await related({ issueKey: key }, 'user') };
  } catch (e: any) {
    console.error('getRelated failed', e);
    return { error: String(e?.message ?? e) };
  }
});

/** Panel button: link the selected past occurrences to this issue. The click is the confirmation. */
resolver.define('linkRepeats', async ({ payload, context }) => {
  const key = issueKeyOf(context);
  const targets: string[] = Array.isArray(payload?.keys) ? payload.keys : [];
  if (!key || !targets.length) return { error: 'Nothing to link.' };
  try { return { ok: true, ...(await linkAsRelated(key, targets, accountOf(context))) }; }
  catch (e: any) { return { error: String(e?.message ?? e) }; }
});

/** Panel button: escalate one stale action item to its owner. The click (and the confirm dialog) is the confirmation. */
resolver.define('escalate', async ({ payload, context }) => {
  const actionKey = typeof payload?.actionKey === 'string' ? payload.actionKey : '';
  if (!actionKey) return { error: 'No action item given.' };
  try { return { ok: true, ...(await escalate(actionKey, issueKeyOf(context), undefined, accountOf(context))) }; }
  catch (e: any) { return { error: String(e?.message ?? e) }; }
});

// ---------- admin page ----------

resolver.define('adminStatus', async () => {
  const [settings, status, kinds, auditRows] = await Promise.all([getSettings(), getStatus(), index.countsByKind().catch(() => ({})), recentAudit(10).catch(() => [])]);
  return { settings, status, kinds, audit: auditRows };
});

resolver.define('saveSettings', async ({ payload }) => {
  let parsed: unknown;
  try { parsed = typeof payload?.json === 'string' ? JSON.parse(payload.json) : payload?.settings; }
  catch (e: any) { return { error: `Not valid JSON: ${e.message}` }; }
  const v = validateSettings(parsed);
  if (!v.ok) return { error: v.error };
  await saveSettings(v.settings);
  return { ok: true, settings: v.settings };
});

/** One click for a fresh demo site: the Fernway projects, space, date field and service aliases. */
resolver.define('useDemoSettings', async () => {
  const v = validateSettings(demoSettings);
  if (!v.ok) return { error: v.error };
  await saveSettings(v.settings);
  return { ok: true, settings: v.settings };
});

resolver.define('indexNow', async ({ payload }) => {
  const started = await startCrawl(payload?.mode === 'recent' ? 'recent' : 'full');
  return started ? { ok: true } : { error: 'Indexing is already running.' };
});

export const handler = resolver.getDefinitions();
