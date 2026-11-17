// Issue panel: "Has this happened before?" answered inside the issue, with the past fix, the open
// follow-up debt and the documents to read first. Every write is a button the user clicks (and confirms).

import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Button, Heading, Inline, Link, Lozenge, Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle, ModalTransition,
  SectionMessage, Spinner, Stack, Text,
} from '@forge/react';
import { call } from './call';
import type { DebtItem, Hit, RelatedResult } from '../core/match';

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 >= 11 && n % 100 <= 13) || n % 10 > 3 ? 0 : n % 10]}`;
const day = (iso?: string) => (iso ? iso.slice(0, 10) : '');
const statusLozenge = (h: Hit) => (h.status === 'done' ? 'success' : h.status === 'inprogress' ? 'inprogress' : 'new');
const kindLabel = (h: Hit) => ({ adr: 'Decision', rfc: 'RFC', runbook: 'Runbook', postmortem: 'Postmortem', 'capacity-plan': 'Plan', guide: 'Guide' } as Record<string, string>)[h.subkind ?? ''] ?? (h.kind === 'design' ? 'Design' : h.kind);

function Reasons({ hit }: { hit: Hit }) {
  if (!hit.reasons.length) return null;
  return <Text size="small" color="color.text.subtlest">{hit.reasons.map((r) => r.text).join(' · ')}</Text>;
}

function ItemTitle({ hit, tag }: { hit: Hit; tag?: string }) {
  return (
    <Inline space="space.100" alignBlock="center" shouldWrap>
      <Link href={hit.url} openNewTab>{hit.id.startsWith('jira:') ? `${hit.key} ${hit.title}` : hit.title}</Link>
      {tag ? <Lozenge>{tag}</Lozenge> : null}
      {hit.statusText ? <Lozenge appearance={statusLozenge(hit)}>{hit.statusText}</Lozenge> : null}
    </Inline>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack space="space.100">
      <Heading size="xsmall">{title}</Heading>
      {children}
    </Stack>
  );
}

const App = () => {
  const [res, setRes] = useState<RelatedResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<DebtItem | null>(null);
  const [busy, setBusy] = useState(false);

  const [waiting, setWaiting] = useState<'indexing' | 'unconfigured' | null>(null);
  const load = () => {
    setError(null);
    call<{ result?: RelatedResult; error?: string; indexing?: boolean; unconfigured?: boolean }>('getRelated')
      .then((r) => {
        if (r.error) return setError(r.error);
        if (r.indexing) return setWaiting('indexing');
        if (r.unconfigured) return setWaiting('unconfigured');
        setWaiting(null); setRes(r.result ?? null);
      })
      .catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  if (waiting === 'indexing') return <SectionMessage appearance="information" title="Déjà Vu is indexing this site"><Text>The first index of your history is being built in the background. Reopen this issue in a minute or two.</Text></SectionMessage>;
  if (waiting === 'unconfigured') return <SectionMessage appearance="information" title="Déjà Vu is not set up yet"><Text>A Jira admin can choose what to index under Apps → Déjà Vu (or click "Use demo settings" there).</Text></SectionMessage>;
  if (error) return <SectionMessage appearance="error" title="Déjà Vu could not check this issue"><Text>{error}</Text></SectionMessage>;
  if (!res) return <Inline space="space.100" alignBlock="center"><Spinner size="small" /><Text>Looking for earlier occurrences…</Text></Inline>;

  const rec = res.recurrence;
  const unlinked = rec.items.filter((h) => !h.reasons.some((r) => r.text.startsWith('linked in Jira')));

  const linkAll = async () => {
    setBusy(true);
    const r = await call<{ ok?: boolean; linked?: string[]; error?: string }>('linkRepeats', { keys: unlinked.map((h) => h.key) });
    setBusy(false);
    setNotice(r.error ? { kind: 'error', text: r.error } : { kind: 'success', text: `Linked ${r.linked?.length ?? 0} past occurrence(s) to ${res.query.key}.` });
    if (!r.error) load();
  };
  const doEscalate = async () => {
    if (!confirm) return;
    setBusy(true);
    const r = await call<{ ok?: boolean; mentioned?: string; days?: number; error?: string }>('escalate', { actionKey: confirm.key });
    setBusy(false);
    setConfirm(null);
    setNotice(r.error ? { kind: 'error', text: r.error } : { kind: 'success', text: `Escalated ${confirm.key}${r.mentioned ? ` to ${r.mentioned}` : ''}: a comment was added.` });
  };

  return (
    <Stack space="space.200">
      {notice ? <SectionMessage appearance={notice.kind === 'success' ? 'success' : 'error'}><Text>{notice.text}</Text></SectionMessage> : null}

      {rec.count ? (
        <SectionMessage appearance="warning" title={`${ordinal(rec.count)} occurrence${rec.last90Days > 1 ? ` · ${rec.last90Days} in the last 90 days` : ''}`}>
          <Text>First seen {day(rec.firstSeen)}. {res.debt.length ? `${res.debt.length} follow-up${res.debt.length > 1 ? 's' : ''} from earlier postmortems ${res.debt.length > 1 ? 'are' : 'is'} still open.` : 'No open follow-ups from earlier postmortems.'}</Text>
        </SectionMessage>
      ) : res.query.kind === 'incident' ? (
        <SectionMessage appearance="information" title="No earlier incident with the same cause"><Text>Related history, if any, is listed below.</Text></SectionMessage>
      ) : null}

      {res.debt.length ? (
        <Section title="Open follow-up debt">
          {res.debt.map((d) => (
            <Stack key={d.id} space="space.050">
              <ItemTitle hit={d} />
              <Inline space="space.100" alignBlock="center" shouldWrap>
                <Text size="small">{d.assignee?.name ?? 'Unassigned'} · open {d.ageDays} days{d.overdueDays ? ` · overdue ${d.overdueDays} days` : ''}{d.via ? ` · from ${d.via}` : ''}</Text>
                <Button appearance="warning" isDisabled={busy} onClick={() => setConfirm(d)}>Escalate</Button>
              </Inline>
              <Reasons hit={d} />
            </Stack>
          ))}
        </Section>
      ) : null}

      {rec.items.length ? (
        <Section title="Past occurrences and how they were fixed">
          {rec.items.map((h) => (
            <Stack key={h.id} space="space.050">
              <ItemTitle hit={h} />
              <Text size="small">{day(h.occurredAt)}{h.resolution ? ` · Fix: ${h.resolution}` : ''}</Text>
              <Reasons hit={h} />
            </Stack>
          ))}
          {unlinked.length ? <Button isDisabled={busy} onClick={linkAll}>{`Link ${unlinked.length} past occurrence${unlinked.length > 1 ? 's' : ''} to this issue`}</Button> : null}
        </Section>
      ) : null}

      {res.postmortems.length ? (
        <Section title="Postmortems">
          {res.postmortems.slice(0, 4).map((h) => <Stack key={h.id} space="space.050"><ItemTitle hit={h} /><Reasons hit={h} /></Stack>)}
        </Section>
      ) : null}

      {res.background.length ? (
        <Section title="Read first">
          {res.background.slice(0, 5).map((h) => <Stack key={h.id} space="space.050"><ItemTitle hit={h} tag={kindLabel(h)} /><Text size="small">Written {day(h.occurredAt)}</Text><Reasons hit={h} /></Stack>)}
        </Section>
      ) : null}

      {res.related.length ? (
        <Section title="Also related">
          {res.related.slice(0, 4).map((h) => <Stack key={h.id} space="space.050"><ItemTitle hit={h} /><Reasons hit={h} /></Stack>)}
        </Section>
      ) : null}

      {!rec.count && !res.debt.length && !res.postmortems.length && !res.background.length && !res.related.length
        ? <Text>Nothing in the indexed history looks related to this issue.</Text> : null}

      <Text size="small" color="color.text.subtlest">{`Deterministic match over ${res.stats.indexed} indexed items. Each result says why it matched.`}</Text>

      <ModalTransition>
        {confirm ? (
          <Modal onClose={() => setConfirm(null)}>
            <ModalHeader><ModalTitle>Escalate {confirm.key}?</ModalTitle></ModalHeader>
            <ModalBody>
              <Text>{`Déjà Vu will add a comment to ${confirm.key} mentioning ${confirm.assignee?.name ?? 'nobody (it is unassigned)'}, saying it has been open ${confirm.ageDays} days and that ${res.query.key} looks like a repeat. The comment is posted as you.`}</Text>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button appearance="warning" isDisabled={busy} onClick={doEscalate}>Escalate</Button>
            </ModalFooter>
          </Modal>
        ) : null}
      </ModalTransition>
    </Stack>
  );
};

ForgeReconciler.render(<React.StrictMode><App /></React.StrictMode>);
