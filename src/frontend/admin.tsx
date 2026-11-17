// Admin page: what is indexed, re-index buttons, settings (projects, spaces, date field, service aliases), audit log.

import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Button, Heading, Inline, SectionMessage, Spinner, Stack, Text, TextArea } from '@forge/react';
import { call } from './call';

interface AdminData {
  settings: unknown;
  status: { state: string; mode?: string; startedAt?: string; finishedAt?: string; issues: number; pages: number; errors: number; lastError?: string };
  kinds: Record<string, number>;
  audit: { at: string; account_id: string; action: string; target: string }[];
}

const App = () => {
  const [data, setData] = useState<AdminData | null>(null);
  const [json, setJson] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => call<AdminData>('adminStatus').then((d) => { setData(d); setJson((j) => j || JSON.stringify(d.settings, null, 2)); });
  useEffect(() => { load(); }, []);

  if (!data) return <Inline space="space.100"><Spinner size="small" /><Text>Loading…</Text></Inline>;
  const total = Object.values(data.kinds).reduce((a, b) => a + b, 0);
  const st = data.status;

  const save = async () => {
    const r = await call<{ ok?: boolean; error?: string; settings?: unknown }>('saveSettings', { json });
    setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: 'Settings saved. Run "Index everything" to apply them to existing items.' });
    if (r.settings) setJson(JSON.stringify(r.settings, null, 2));
  };
  const useDemo = async () => {
    const r = await call<{ ok?: boolean; error?: string; settings?: unknown }>('useDemoSettings');
    setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: 'Demo settings applied (Fernway projects OPS and FERN, space FERN). Now click "Index everything".' });
    if (r.settings) setJson(JSON.stringify(r.settings, null, 2));
  };
  const reindex = async (mode: 'full' | 'recent') => {
    const r = await call<{ ok?: boolean; error?: string }>('indexNow', { mode });
    setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: 'Indexing started in the background. Refresh in a minute to see progress.' });
    load();
  };

  return (
    <Stack space="space.300">
      <Heading size="medium">Déjà Vu</Heading>
      {msg ? <SectionMessage appearance={msg.ok ? 'success' : 'error'}><Text>{msg.text}</Text></SectionMessage> : null}

      <Stack space="space.100">
        <Heading size="small">Index</Heading>
        <Text>{`${total} items indexed: ${Object.entries(data.kinds).map(([k, n]) => `${n} ${k}`).join(', ') || 'none yet'}.`}</Text>
        <Text>{`Last run: ${st.state}${st.mode ? ` (${st.mode})` : ''}${st.startedAt ? `, started ${st.startedAt.slice(0, 16).replace('T', ' ')}` : ''}${st.finishedAt ? `, finished ${st.finishedAt.slice(0, 16).replace('T', ' ')}` : ''} · ${st.issues} issues, ${st.pages} pages, ${st.errors} errors`}</Text>
        {st.lastError ? <Text size="small" color="color.text.danger">{st.lastError}</Text> : null}
        <Inline space="space.100">
          <Button appearance="primary" onClick={() => reindex('full')}>Index everything</Button>
          <Button onClick={() => reindex('recent')}>Index recent changes</Button>
          <Button appearance="subtle" onClick={load}>Refresh</Button>
        </Inline>
      </Stack>

      <Stack space="space.100">
        <Heading size="small">Settings</Heading>
        <Text size="small">jiraProjects / confluenceSpaces: what to index (empty project list = all projects). occurredFieldName: date-time field with when an incident really happened. entities: services and shared resources with their aliases (old names, nicknames).</Text>
        <TextArea value={json} onChange={(e: any) => setJson(e.target.value)} resize="vertical" />
        <Inline space="space.100">
          <Button appearance="primary" onClick={save}>Save settings</Button>
          <Button onClick={useDemo}>Use demo settings</Button>
        </Inline>
      </Stack>

      <Stack space="space.100">
        <Heading size="small">Recent actions (audit log)</Heading>
        {data.audit.length ? data.audit.map((a, i) => <Text key={i} size="small">{`${a.at.slice(0, 16).replace('T', ' ')} · ${a.action} · ${a.target}`}</Text>) : <Text size="small">No write actions yet.</Text>}
      </Stack>
    </Stack>
  );
};

ForgeReconciler.render(<React.StrictMode><App /></React.StrictMode>);
