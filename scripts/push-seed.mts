// Push the Fernway seed corpus (seed/corpus/*.md) to a Jira + JSM + Confluence site.
//
// Usage (Node 26 runs .ts directly):
//   node scripts/push-seed.ts --dry-run        parse, validate references, write seed/ground-truth.json
//   node scripts/push-seed.ts                  create everything (re-runs skip items already created)
//   node scripts/push-seed.ts --no-triggers    leave out the "new this week" demo trigger items
//
// Env: ATL_SITE (https://x.atlassian.net), ATL_EMAIL, ATL_TOKEN (Atlassian API token).
// State (seed id -> created key/page id) is kept in seed/.state.json so the script is idempotent.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SEED = path.join(ROOT, 'seed');
const STATE_FILE = path.join(SEED, '.state.json');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const NO_TRIGGERS = args.has('--no-triggers');
const UPDATE = args.has('--update');

type Meta = Record<string, string | string[]>;
type Item = { id: string; meta: Meta; body: string; comments: Comment[]; file: string };
type Comment = { who: string; at: string; text: string };
type Ref = { kind: 'issue' | 'page'; key?: string; pageId?: string; url: string; title: string };
type State = { users: Record<string, string>; fields: Record<string, string>; issueTypes: Record<string, string>; items: Record<string, Ref & { pendingRefs?: boolean }> };

const world = JSON.parse(fs.readFileSync(path.join(SEED, 'world.json'), 'utf8'));
const RENAME_DATE = world.services['order-pipeline'].renamedOn as string;
const PAGE_KINDS = new Set(['section', 'page', 'postmortem']);
const ISSUE_KINDS = new Set(['incident', 'epic', 'story', 'task', 'action']);

// ---------- corpus parsing ----------

function parseCorpus(): Item[] {
  const dir = path.join(SEED, 'corpus');
  const items: Item[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const chunk of text.split(/^=== /m).slice(1)) {
      const nl = chunk.indexOf('\n');
      const id = chunk.slice(0, nl).trim();
      const rest = chunk.slice(nl + 1);
      const sep = rest.indexOf('\n---\n');
      if (sep < 0) throw new Error(`${file}:${id} has no --- separator`);
      const meta: Meta = {};
      for (const line of rest.slice(0, sep).split('\n')) {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (!m) continue;
        const v = m[2].trim();
        meta[m[1]] = v.startsWith('[') ? v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean) : v;
      }
      let body = rest.slice(sep + 5);
      const comments: Comment[] = [];
      const ci = body.indexOf('+++ comments');
      if (ci >= 0) {
        for (const m of body.slice(ci + 12).matchAll(/^@(\w+) (\S+) \| (.*)$/gm)) comments.push({ who: m[1], at: m[2], text: m[3] });
        body = body.slice(0, ci);
      }
      items.push({ id, meta, body: body.trim(), comments, file });
    }
  }
  return items;
}

const s = (m: Meta, k: string) => (typeof m[k] === 'string' ? (m[k] as string) : undefined);
const list = (m: Meta, k: string) => (Array.isArray(m[k]) ? (m[k] as string[]) : m[k] ? [m[k] as string] : []);
const refsIn = (text: string) => [...text.matchAll(/\[\[([\w-]+)\]\]/g)].map((m) => m[1]);

function validate(items: Item[]) {
  const ids = new Map(items.map((i) => [i.id, i]));
  const errs: string[] = [];
  for (const it of items) {
    if (!it.meta.kind || !(PAGE_KINDS.has(it.meta.kind as string) || ISSUE_KINDS.has(it.meta.kind as string))) errs.push(`${it.id}: bad kind`);
    if (!s(it.meta, 'date')) errs.push(`${it.id}: missing date`);
    const refs = [...refsIn(it.body), ...it.comments.flatMap((c) => refsIn(c.text)), ...list(it.meta, 'recall'), ...list(it.meta, 'decoys'),
      ...list(it.meta, 'links').map((l) => l.split(':')[0]), ...['parent', 'from', 'incident'].map((k) => s(it.meta, k)).filter(Boolean) as string[]];
    for (const r of refs) if (!ids.has(r)) errs.push(`${it.id}: unknown reference ${r}`);
    for (const r of [...list(it.meta, 'recall'), ...list(it.meta, 'decoys')]) {
      const t = ids.get(r);
      if (t && s(t.meta, 'date')! >= s(it.meta, 'date')!) errs.push(`${it.id}: recall/decoy ${r} is not older`);
    }
    for (const p of ['assignee', 'reporter', 'author']) { const v = s(it.meta, p); if (v && !world.people[v]) errs.push(`${it.id}: unknown person ${v}`); }
    for (const c of it.comments) if (!world.people[c.who]) errs.push(`${it.id}: unknown commenter ${c.who}`);
  }
  if (errs.length) throw new Error('Corpus invalid:\n' + errs.join('\n'));
}

// ---------- ground truth (eval set) ----------

function groundTruth(items: Item[], state?: State) {
  const where = (id: string) => state?.items[id]?.key ?? state?.items[id]?.pageId ?? null;
  const clusters: Record<string, string[]> = {};
  for (const it of items) { const c = s(it.meta, 'cluster'); if (c) (clusters[c] ??= []).push(it.id); }
  return {
    note: 'Seeded demo data. Ground truth for Déjà Vu matching: for each query item, which OLDER items should be surfaced (recall) and which look similar but must not match strongly (decoys).',
    generatedFrom: 'seed/corpus/*.md',
    clusters: Object.fromEntries(Object.entries(clusters).map(([c, ids]) => [c, ids.map((id) => ({ id, ref: where(id) }))])),
    oneOffIncidents: items.filter((i) => i.meta.kind === 'incident' && !i.meta.cluster).map((i) => ({ id: i.id, ref: where(i.id) })),
    queries: items.filter((i) => i.meta.recall || i.meta.decoys).map((i) => ({
      id: i.id, ref: where(i.id), kind: i.meta.kind, trigger: s(i.meta, 'trigger') === 'true', cluster: s(i.meta, 'cluster') ?? null,
      recall: list(i.meta, 'recall').map((id) => ({ id, ref: where(id) })),
      decoys: list(i.meta, 'decoys').map((id) => ({ id, ref: where(id) })),
    })),
  };
}

// ---------- markdown -> blocks -> ADF / Confluence storage ----------

type Inline = { t: 'text'; v: string; code?: boolean; bold?: boolean } | { t: 'link'; v: string; href: string } | { t: 'ref'; id: string };
type Block = { t: 'h'; level: number; c: Inline[] } | { t: 'p'; c: Inline[] } | { t: 'ul' | 'ol'; items: Inline[][] } | { t: 'code'; lang: string; v: string } | { t: 'table'; header: Inline[][]; rows: Inline[][][] } | { t: 'quote'; c: Inline[] };

function inline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\[\[([\w-]+)\]\]|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    if (m.index! > last) out.push({ t: 'text', v: src.slice(last, m.index) });
    if (m[1]) out.push({ t: 'text', v: m[1], code: true });
    else if (m[2]) out.push({ t: 'ref', id: m[2] });
    else if (m[3]) out.push({ t: 'link', v: m[3], href: m[4] });
    else if (m[5]) out.push({ t: 'text', v: m[5], bold: true });
    last = m.index! + m[0].length;
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return out;
}

function blocks(md: string): Block[] {
  const lines = md.split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) out.push({ t: 'p', c: inline(para.join(' ')) }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^```(\w*)\s*$/))) {
      flush(); const code: string[] = [];
      while (++i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i]);
      out.push({ t: 'code', lang: m[1] || 'text', v: code.join('\n') }); continue;
    }
    if (/^\|/.test(l)) {
      flush(); const cells = (r: string) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));
      const header = cells(l); const rows: Inline[][][] = [];
      if (/^\|[\s:|-]+\|$/.test((lines[i + 1] ?? '').trim())) i++;
      while (i + 1 < lines.length && /^\|/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push({ t: 'table', header, rows }); continue;
    }
    if ((m = l.match(/^(#{1,6}) (.*)$/))) { flush(); out.push({ t: 'h', level: m[1].length, c: inline(m[2]) }); continue; }
    if ((m = l.match(/^\s*([-*]|\d+\.) (.*)$/))) {
      flush(); const kind = /\d/.test(m[1]) ? 'ol' : 'ul'; const its: Inline[][] = [inline(m[2])];
      while (i + 1 < lines.length && (m = lines[i + 1].match(/^\s*([-*]|\d+\.) (.*)$/))) { its.push(inline(m[2])); i++; }
      out.push({ t: kind, items: its }); continue;
    }
    if ((m = l.match(/^> (.*)$/))) { flush(); out.push({ t: 'quote', c: inline(m[1]) }); continue; }
    if (!l.trim()) { flush(); continue; }
    para.push(l.trim());
  }
  flush();
  return out;
}

type Resolver = (id: string) => Ref | undefined;

function adfInline(c: Inline[], r: Resolver): any[] {
  return c.flatMap((x) => {
    if (x.t === 'text') { const marks = [x.code && { type: 'code' }, x.bold && { type: 'strong' }].filter(Boolean); return x.v ? [{ type: 'text', text: x.v, ...(marks.length ? { marks } : {}) }] : []; }
    if (x.t === 'link') return [{ type: 'text', text: x.v, marks: [{ type: 'link', attrs: { href: x.href } }] }];
    const ref = r(x.id);
    return ref ? [{ type: 'inlineCard', attrs: { url: ref.url } }] : [{ type: 'text', text: `(${x.id})` }];
  });
}
const adfPara = (c: Inline[], r: Resolver) => ({ type: 'paragraph', content: adfInline(c, r) });

function toAdf(bs: Block[], r: Resolver): any {
  const content = bs.map((b) => {
    switch (b.t) {
      case 'h': return { type: 'heading', attrs: { level: b.level }, content: adfInline(b.c, r) };
      case 'p': return adfPara(b.c, r);
      case 'ul': case 'ol': return { type: b.t === 'ul' ? 'bulletList' : 'orderedList', content: b.items.map((it) => ({ type: 'listItem', content: [adfPara(it, r)] })) };
      case 'code': return { type: 'codeBlock', attrs: { language: b.lang }, content: b.v ? [{ type: 'text', text: b.v }] : [] };
      case 'quote': return { type: 'blockquote', content: [adfPara(b.c, r)] };
      case 'table': return { type: 'table', content: [
        { type: 'tableRow', content: b.header.map((h) => ({ type: 'tableHeader', content: [adfPara(h, r)] })) },
        ...b.rows.map((row) => ({ type: 'tableRow', content: row.map((c) => ({ type: 'tableCell', content: [adfPara(c, r)] })) })),
      ] };
    }
  });
  return { type: 'doc', version: 1, content };
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function htmlInline(c: Inline[], r: Resolver): string {
  return c.map((x) => {
    if (x.t === 'text') { let v = esc(x.v); if (x.code) v = `<code>${v}</code>`; if (x.bold) v = `<strong>${v}</strong>`; return v; }
    if (x.t === 'link') return `<a href="${esc(x.href)}">${esc(x.v)}</a>`;
    const ref = r(x.id);
    return ref ? `<a href="${esc(ref.url)}">${esc(ref.kind === 'issue' ? `${ref.key} ${ref.title}` : ref.title)}</a>` : esc(`(${x.id})`);
  }).join('');
}
function toStorage(bs: Block[], r: Resolver): string {
  return bs.map((b) => {
    switch (b.t) {
      case 'h': return `<h${b.level}>${htmlInline(b.c, r)}</h${b.level}>`;
      case 'p': return `<p>${htmlInline(b.c, r)}</p>`;
      case 'ul': case 'ol': return `<${b.t}>${b.items.map((it) => `<li>${htmlInline(it, r)}</li>`).join('')}</${b.t}>`;
      case 'quote': return `<blockquote><p>${htmlInline(b.c, r)}</p></blockquote>`;
      case 'code': return `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${esc(b.lang === 'text' ? 'none' : b.lang)}</ac:parameter><ac:plain-text-body><![CDATA[${b.v.replace(/]]>/g, ']]]]><![CDATA[>')}]]></ac:plain-text-body></ac:structured-macro>`;
      case 'table': return `<table><tbody><tr>${b.header.map((h) => `<th>${htmlInline(h, r)}</th>`).join('')}</tr>${b.rows.map((row) => `<tr>${row.map((c) => `<td>${htmlInline(c, r)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
  }).join('\n');
}

// ---------- HTTP ----------

const SITE = process.env.ATL_SITE?.replace(/\/$/, '') ?? '';
const AUTH = 'Basic ' + Buffer.from(`${process.env.ATL_EMAIL}:${process.env.ATL_TOKEN}`).toString('base64');

async function api(method: string, p: string, body?: unknown, okStatuses: number[] = []): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(SITE + p, { method, headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 429 && attempt < 5) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
    const text = await res.text();
    if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 600)}`);
    return text ? JSON.parse(text) : {};
  }
}

// ---------- site setup ----------

const fmtDate = (d: string) => d.replace('T', ' ') + ' UTC';
const jiraDate = (d: string) => `${d.length === 16 ? d + ':00' : d}.000+0000`;
const person = (k?: string) => (k ? world.people[k].displayName : undefined);

async function ensureUsers(st: State) {
  for (const [k, p] of Object.entries<any>(world.people)) {
    if (st.users[k]) continue;
    const found = await api('GET', `/rest/api/3/user/search?query=${encodeURIComponent(p.displayName)}`);
    const u = found.find((x: any) => x.displayName === p.displayName && x.active);
    if (!u) throw new Error(`No active user named ${p.displayName}`);
    st.users[k] = u.accountId;
  }
}

async function ensureProjects(st: State) {
  const me = (await api('GET', '/rest/api/3/myself')).accountId;
  for (const p of [world.projects.jira, world.projects.jsm]) {
    const existing = await api('GET', `/rest/api/3/project/${p.key}`, undefined, [404]);
    if (!existing.id) {
      console.log(`creating project ${p.key}`);
      await api('POST', '/rest/api/3/project', { key: p.key, name: p.name, projectTypeKey: p.type, projectTemplateKey: p.template, leadAccountId: me, assigneeType: 'UNASSIGNED', description: 'Fernway seeded demo data for Déjà Vu' });
    }
    const comps = await api('GET', `/rest/api/3/project/${p.key}/components`);
    const want = [...Object.keys(world.services), 'order-worker', ...Object.keys(world.infrastructure)];
    for (const c of want) if (!comps.some((x: any) => x.name === c)) await api('POST', '/rest/api/3/component', { name: c, project: p.key, description: world.services[c]?.layer ?? (c === 'order-worker' ? 'Old name of order-pipeline (until 2026-06-15)' : world.infrastructure[c]) });
    const types = await api('GET', `/rest/api/3/issuetype/project?projectId=${(await api('GET', `/rest/api/3/project/${p.key}`)).id}`);
    for (const t of types) st.issueTypes[`${p.key}:${t.name}`] = t.id;
  }
  const space = await api('GET', `/wiki/rest/api/space/${world.projects.confluence.key}?expand=homepage`, undefined, [404]);
  if (!space.key) {
    console.log('creating Confluence space');
    await api('POST', '/wiki/rest/api/space', { key: world.projects.confluence.key, name: world.projects.confluence.name, description: { plain: { value: 'Fernway engineering docs (seeded demo data for Déjà Vu)', representation: 'plain' } } });
  }
}

async function ensureFields(st: State) {
  const all = await api('GET', '/rest/api/3/field');
  for (const name of ['Occurred at', 'Resolved at']) {
    if (st.fields[name]) continue;
    const f = all.find((x: any) => x.name === name && x.custom) ?? await api('POST', '/rest/api/3/field', { name, type: 'com.atlassian.jira.plugin.system.customfieldtypes:datetime', searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:datetimerange', description: 'When the incident or work actually happened (seeded data cannot be backdated)' });
    st.fields[name] = f.id;
  }
  // Put the fields on every screen of the two projects so the API can set them.
  let startAt = 0; const screens: any[] = [];
  for (;;) { const pg = await api('GET', `/rest/api/3/screens?startAt=${startAt}&maxResults=100`); screens.push(...pg.values); if (pg.isLast || !pg.values.length) break; startAt += pg.values.length; }
  const keys = [world.projects.jira.key, world.projects.jsm.key];
  for (const sc of screens.filter((x) => keys.some((k) => x.name.startsWith(`${k}:`) || x.name.startsWith(`${k} `)))) {
    const tabs = await api('GET', `/rest/api/3/screens/${sc.id}/tabs`);
    if (!tabs.length) continue;
    const present = new Set<string>();
    for (const t of tabs) for (const f of await api('GET', `/rest/api/3/screens/${sc.id}/tabs/${t.id}/fields`)) present.add(f.id);
    for (const fid of [...Object.values(st.fields), 'reporter']) if (!present.has(fid)) await api('POST', `/rest/api/3/screens/${sc.id}/tabs/${tabs[0].id}/fields`, { fieldId: fid }, [400]);
  }
}

// ---------- create items ----------

function issueTypeFor(st: State, it: Item): { project: string; typeId: string } {
  const k = it.meta.kind as string;
  const pick = (proj: string, ...names: string[]) => {
    for (const n of names) { const id = st.issueTypes[`${proj}:${n}`]; if (id) return { project: proj, typeId: id }; }
    throw new Error(`No issue type ${names.join('/')} in ${proj}. Have: ${Object.keys(st.issueTypes).filter((x) => x.startsWith(proj)).join(', ')}`);
  };
  if (k === 'incident') return pick(world.projects.jsm.key, '[System] Incident', 'Incident');
  if (k === 'postmortem') return pick(world.projects.jsm.key, '[System] Post-incident review', 'Post-incident review');
  if (k === 'epic') return pick(world.projects.jira.key, 'Epic');
  if (k === 'story') return pick(world.projects.jira.key, 'Story');
  return pick(world.projects.jira.key, 'Task');
}

function headerLine(it: Item): string {
  const m = it.meta; const parts: string[] = [];
  if (m.kind === 'incident') {
    parts.push(`**Occurred:** ${fmtDate(s(m, 'date')!)}`);
    if (s(m, 'resolved')) parts.push(`**Resolved:** ${fmtDate(s(m, 'resolved')!)}`);
    if (s(m, 'service')) parts.push(`**Service:** ${componentFor(it)}`);
  } else if (PAGE_KINDS.has(m.kind as string)) {
    parts.push(`Written ${s(m, 'date')!.slice(0, 10)} by ${person(s(m, 'author'))}`);
    if (s(m, 'updated')) parts.push(`last updated ${s(m, 'updated')!.slice(0, 10)}`);
  } else {
    parts.push(`**Created:** ${s(m, 'date')!.slice(0, 10)} by ${person(s(m, 'reporter'))}`);
    if (s(m, 'due')) parts.push(`**Due:** ${s(m, 'due')}`);
  }
  parts.push('seeded demo data');
  return parts.join(' · ');
}

function componentFor(it: Item): string | undefined {
  const svc = s(it.meta, 'service');
  if (svc === 'order-pipeline' && s(it.meta, 'date')! < RENAME_DATE) return 'order-worker';
  return svc;
}

const statusTarget = (it: Item) => {
  const v = s(it.meta, 'status') ?? 'todo';
  return v === 'done' || v === 'resolved' ? 'done' : v === 'inprogress' ? 'indeterminate' : 'new';
};

async function transition(key: string, target: string) {
  if (target === 'new') return;
  for (let step = 0; step < 5; step++) {
    const issue = await api('GET', `/rest/api/3/issue/${key}?fields=status`);
    const cat = issue.fields.status.statusCategory.key;
    if (cat === target) return;
    const { transitions } = await api('GET', `/rest/api/3/issue/${key}/transitions`);
    const t = transitions.find((x: any) => x.to.statusCategory.key === target && !/cancel|declin|reject|won/i.test(x.name))
      ?? transitions.find((x: any) => x.to.statusCategory.key === 'indeterminate' && x.to.id !== issue.fields.status.id);
    if (!t) { console.warn(`  ! no transition toward ${target} for ${key}`); return; }
    try { await api('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } }); }
    catch { await api('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id }, fields: { resolution: { name: 'Done' } } }); }
  }
}

async function link(type: string, outward: string, inward: string) {
  await api('POST', '/rest/api/3/issueLink', { type: { name: type }, outwardIssue: { key: outward }, inwardIssue: { key: inward } });
}

async function createIssue(st: State, it: Item, resolve: Resolver, summary = s(it.meta, 'title')!, bodyMd = it.body, overrideKind?: string) {
  const { project, typeId } = issueTypeFor(st, overrideKind ? { ...it, meta: { ...it.meta, kind: overrideKind } } : it);
  const m = it.meta;
  const fields: any = {
    project: { key: project }, issuetype: { id: typeId }, summary,
    description: toAdf(blocks(headerLine(it) + '\n\n' + bodyMd), resolve),
    labels: ['deja-vu-seed', `seed-${it.id}`, ...list(m, 'labels').filter((l) => !l.includes(' '))],
  };
  const comp = componentFor(it); if (comp) fields.components = [{ name: comp }];
  if (s(m, 'priority')) fields.priority = { name: s(m, 'priority') };
  if (s(m, 'assignee')) fields.assignee = { accountId: st.users[s(m, 'assignee')!] };
  if (s(m, 'reporter') || s(m, 'author')) fields.reporter = { accountId: st.users[(s(m, 'reporter') ?? s(m, 'author'))!] };
  if (s(m, 'due')) fields.duedate = s(m, 'due');
  if (s(m, 'parent') && st.items[s(m, 'parent')!]?.key) fields.parent = { key: st.items[s(m, 'parent')!].key };
  fields[st.fields['Occurred at']] = jiraDate(s(m, 'date')!);
  if (s(m, 'resolved')) fields[st.fields['Resolved at']] = jiraDate(s(m, 'resolved')!);
  let res;
  try { res = await api('POST', '/rest/api/3/issue', { fields }); }
  catch (e: any) {
    // Drop fields the screen rejects, then retry once.
    let bad: string[] = [];
    try { bad = Object.keys(JSON.parse(e.message.slice(e.message.indexOf('{'))).errors ?? {}); } catch { /* not JSON */ }
    if (!bad.length) throw e;
    console.warn(`  ! ${it.id}: dropping fields ${bad.join(', ')}`);
    for (const b of bad) delete fields[b];
    res = await api('POST', '/rest/api/3/issue', { fields });
  }
  return res.key as string;
}

async function addComments(st: State, key: string, it: Item, resolve: Resolver) {
  for (const c of it.comments) {
    await api('POST', `/rest/api/3/issue/${key}/comment`, { body: toAdf(blocks(`**${person(c.who)}** · ${fmtDate(c.at)}\n\n${c.text}`), resolve) });
  }
}

async function createPage(st: State, it: Item, resolve: Resolver, homepageId: string) {
  const parentId = s(it.meta, 'parent') ? st.items[s(it.meta, 'parent')!]?.pageId : homepageId;
  const title = s(it.meta, 'title')!;
  const existing = await api('GET', `/wiki/rest/api/content?spaceKey=${world.projects.confluence.key}&title=${encodeURIComponent(title)}&type=page`);
  let page = existing.results?.[0];
  if (!page) {
    page = await api('POST', '/wiki/rest/api/content', {
      type: 'page', title, space: { key: world.projects.confluence.key }, ancestors: [{ id: parentId }],
      body: { storage: { value: toStorage(blocks(headerLine(it) + '\n\n' + it.body), resolve), representation: 'storage' } },
    });
  }
  const labels = ['deja-vu-seed', `seed-${it.id}`, ...list(it.meta, 'labels')].map((name) => ({ prefix: 'global', name: name.toLowerCase() }));
  await api('POST', `/wiki/rest/api/content/${page.id}/label`, labels);
  return { pageId: page.id as string, url: `${SITE}/wiki/spaces/${world.projects.confluence.key}/pages/${page.id}` };
}

async function updatePageBody(st: State, it: Item, resolve: Resolver) {
  const ref = st.items[it.id];
  const cur = await api('GET', `/wiki/rest/api/content/${ref.pageId}?expand=version`);
  await api('PUT', `/wiki/rest/api/content/${ref.pageId}`, { type: 'page', title: cur.title, version: { number: cur.version.number + 1 },
    body: { storage: { value: toStorage(blocks(headerLine(it) + '\n\n' + it.body), resolve), representation: 'storage' } } });
}

// ---------- update existing items in place (after editing the corpus) ----------

async function updateAll(state: State, all: Item[], save: () => void) {
  const r: Resolver = (x) => state.items[x];
  const people = (who: Meta) => {
    const f: any = {}; const a = s(who, 'assignee'); const rp = s(who, 'reporter') ?? s(who, 'author');
    if (a) f.assignee = { accountId: state.users[a] }; if (rp) f.reporter = { accountId: state.users[rp] }; return f;
  };
  for (const it of all) {
    const ref = state.items[it.id]; if (!ref) continue;
    if (ref.kind === 'page') {
      await updatePageBody(state, it, r);
      const pir = state.items[`${it.id}#pir`];
      if (pir?.key) {
        const pirBody = `Post-incident review for [[${s(it.meta, 'incident')}]]. Full write-up: [[${it.id}]].`;
        await api('PUT', `/rest/api/3/issue/${pir.key}`, { fields: { description: toAdf(blocks(headerLine(it) + '\n\n' + pirBody), r), ...people({ assignee: it.meta.author, reporter: it.meta.author }) } });
      }
      console.log(`updated page ${it.id}${pir?.key ? ` + ${pir.key}` : ''}`);
      continue;
    }
    await api('PUT', `/rest/api/3/issue/${ref.key}`, { fields: { description: toAdf(blocks(headerLine(it) + '\n\n' + it.body), r), ...people(it.meta) } });
    const existing = (await api('GET', `/rest/api/3/issue/${ref.key}/comment?maxResults=100&orderBy=created`)).comments;
    for (let i = 0; i < it.comments.length; i++) {
      const c = it.comments[i];
      const body = toAdf(blocks(`**${person(c.who)}** · ${fmtDate(c.at)}\n\n${c.text}`), r);
      if (existing[i]) await api('PUT', `/rest/api/3/issue/${ref.key}/comment/${existing[i].id}`, { body });
      else await api('POST', `/rest/api/3/issue/${ref.key}/comment`, { body });
    }
    console.log(`updated ${ref.key} ${it.id}`);
  }
  save();
}

// ---------- main ----------

async function main() {
  const all = parseCorpus();
  validate(all);
  const items = all.filter((i) => !(NO_TRIGGERS && s(i.meta, 'trigger') === 'true'))
    .sort((a, b) => s(a.meta, 'date')!.localeCompare(s(b.meta, 'date')!));
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.meta.kind as string] = (counts[i.meta.kind as string] ?? 0) + 1;
  console.log(`corpus: ${items.length} items`, counts);

  const state: State = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { users: {}, fields: {}, issueTypes: {}, items: {} };
  const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  const writeGT = () => fs.writeFileSync(path.join(SEED, 'ground-truth.json'), JSON.stringify(groundTruth(all, state), null, 2) + '\n');
  if (DRY) { writeGT(); console.log('dry run OK; wrote seed/ground-truth.json'); return; }
  if (!SITE || !process.env.ATL_TOKEN) throw new Error('Set ATL_SITE, ATL_EMAIL, ATL_TOKEN');

  await ensureUsers(state); save();
  await ensureProjects(state); save();
  await ensureFields(state); save();
  const homepageId = (await api('GET', `/wiki/rest/api/space/${world.projects.confluence.key}?expand=homepage`)).homepage.id;

  if (UPDATE) { await updateAll(state, all, save); writeGT(); return; }

  const pendingIds = new Set<string>();
  const resolver = (forId: string): Resolver => (id) => { const r = state.items[id]; if (!r) pendingIds.add(forId); return r; };
  for (const [id, ref] of Object.entries(state.items)) if (ref.pendingRefs) pendingIds.add(id);
  const byId = new Map(all.map((i) => [i.id, i]));

  for (const it of items) {
    const kind = it.meta.kind as string;
    if (state.items[it.id] && (kind !== 'postmortem' || state.items[`${it.id}#pir`])) continue;
    const r = resolver(it.id);
    process.stdout.write(`${s(it.meta, 'date')} ${kind.padEnd(10)} ${it.id} ... `);
    if (PAGE_KINDS.has(kind)) {
      const p = state.items[it.id]?.pageId ? { pageId: state.items[it.id].pageId!, url: state.items[it.id].url } : await createPage(state, it, r, homepageId);
      state.items[it.id] = { kind: 'page', title: s(it.meta, 'title')!, ...p };
      save();
      if (kind === 'postmortem') {
        // Matching Post-incident review in JSM, linked to the incident and to the page.
        const inc = state.items[s(it.meta, 'incident')!];
        const pirBody = `Post-incident review for [[${s(it.meta, 'incident')}]]. Full write-up: [[${it.id}]].`;
        const pirKey = await createIssue(state, { ...it, meta: { ...it.meta, reporter: s(it.meta, 'author')!, assignee: s(it.meta, 'author')!, status: 'done' } }, r, `PIR: ${byId.get(s(it.meta, 'incident')!)!.meta.title}`, pirBody, 'postmortem');
        state.items[`${it.id}#pir`] = { kind: 'issue', key: pirKey, url: `${SITE}/browse/${pirKey}`, title: `PIR ${s(it.meta, 'title')}` };
        if (inc?.key) await link('Post-Incident Reviews', pirKey, inc.key);
        await transition(pirKey, 'done');
        console.log(`page ${p.pageId} + ${pirKey}`);
      } else console.log(`page ${p.pageId}`);
    } else {
      const key = await createIssue(state, it, r);
      state.items[it.id] = { kind: 'issue', key, url: `${SITE}/browse/${key}`, title: s(it.meta, 'title')! };
      save();
      await addComments(state, key, it, r);
      for (const l of list(it.meta, 'links')) {
        const [target, type] = l.split(':'); const t = state.items[target];
        if (t?.key) await link(type === 'causes' ? 'Problem/Incident' : 'Relates', key, t.key);
      }
      const from = s(it.meta, 'from');
      if (from) {
        const src = state.items[`${from}#pir`] ?? state.items[from];
        if (src?.key) await link('Action item', src.key, key);
        const inc = byId.get(from)?.meta.incident as string | undefined;
        if (inc && state.items[inc]?.key) await link('Relates', key, state.items[inc].key!);
      }
      await transition(key, statusTarget(it));
      console.log(key);
    }
    save();
  }

  // Second pass: rewrite bodies that referenced items created later.
  for (const id of pendingIds) {
    const it = byId.get(id); const ref = state.items[id];
    if (!it || !ref) continue;
    if (refsIn(it.body).some((x) => !state.items[x])) { ref.pendingRefs = true; continue; }
    const r: Resolver = (x) => state.items[x];
    if (ref.kind === 'page') await updatePageBody(state, it, r);
    else await api('PUT', `/rest/api/3/issue/${ref.key}`, { fields: { description: toAdf(blocks(headerLine(it) + '\n\n' + it.body), r) } });
    delete ref.pendingRefs; save();
    console.log(`re-linked ${id}`);
  }
  // People pass: make sure every issue has the intended assignee and reporter (earlier runs may have dropped them).
  for (const it of items) {
    for (const [id, who] of [[it.id, it.meta], [`${it.id}#pir`, { assignee: it.meta.author, reporter: it.meta.author }]] as const) {
      const ref = state.items[id]; if (!ref?.key) continue;
      const want: any = {};
      const a = s(who as Meta, 'assignee'); const rp = s(who as Meta, 'reporter') ?? s(who as Meta, 'author');
      const cur = (await api('GET', `/rest/api/3/issue/${ref.key}?fields=assignee,reporter`)).fields;
      if (a && cur.assignee?.accountId !== state.users[a]) want.assignee = { accountId: state.users[a] };
      if (rp && cur.reporter?.accountId !== state.users[rp]) want.reporter = { accountId: state.users[rp] };
      if (!Object.keys(want).length) continue;
      try { await api('PUT', `/rest/api/3/issue/${ref.key}`, { fields: want }); console.log(`people fixed ${ref.key}`); }
      catch (e: any) { console.warn(`  ! people ${ref.key}: ${e.message.slice(0, 200)}`); }
    }
  }
  save(); writeGT();
  console.log('done; wrote seed/ground-truth.json');
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
