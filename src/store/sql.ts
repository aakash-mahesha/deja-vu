// Forge SQL storage for the index. Same IndexReader interface as the in-memory index used by the eval.
//
// Tables
//   doc      one row per document: metadata + the Doc and Features as JSON text
//   posting  (term, doc_id) for every index term of a document (words, technical terms, shingles, entities, mentions)
//   audit    every write the app performs on behalf of a user

import { sql, migrationRunner } from '@forge/sql';
import type { Doc } from '../core/doc';
import type { Features } from '../core/features';
import { indexTerms } from '../core/features';
import type { IndexReader, IndexStats, Stored } from '../core/match';

let schemaReady: Promise<void> | undefined;

/** Idempotent; runs the migrations once per function instance. */
export function ensureSchema(): Promise<void> {
  schemaReady ??= migrationRunner
    .enqueue('v001_doc', `CREATE TABLE IF NOT EXISTS doc (
        id VARCHAR(96) NOT NULL PRIMARY KEY,
        kind VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL,
        container VARCHAR(64) NOT NULL,
        occurred_at VARCHAR(32) NOT NULL,
        wlen INT NOT NULL, tlen INT NOT NULL, slen INT NOT NULL,
        doc_json MEDIUMTEXT NOT NULL,
        features_json MEDIUMTEXT NOT NULL,
        indexed_at VARCHAR(32) NOT NULL,
        KEY doc_kind_status (kind, status))`)
    .enqueue('v002_posting', `CREATE TABLE IF NOT EXISTS posting (
        term VARCHAR(255) NOT NULL,
        doc_id VARCHAR(96) NOT NULL,
        PRIMARY KEY (term, doc_id),
        KEY posting_doc (doc_id))`)
    .enqueue('v003_audit', `CREATE TABLE IF NOT EXISTS audit (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        at VARCHAR(32) NOT NULL,
        account_id VARCHAR(128) NOT NULL,
        action VARCHAR(64) NOT NULL,
        target VARCHAR(96) NOT NULL,
        detail MEDIUMTEXT NOT NULL)`)
    .run()
    .then(() => undefined)
    .catch((e) => { schemaReady = undefined; throw e; });
  return schemaReady;
}

const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const placeholders = (n: number) => Array(n).fill('?').join(',');

export class SqlIndex implements IndexReader {
  async stats(): Promise<IndexStats> {
    await ensureSchema();
    const r = await sql.prepare<{ n: number; w: number; t: number; s: number }>('SELECT COUNT(*) AS n, AVG(wlen) AS w, AVG(tlen) AS t, AVG(slen) AS s FROM doc').execute();
    const row = r.rows[0] ?? { n: 0, w: 1, t: 1, s: 1 };
    return { n: Number(row.n) || 0, avg: { w: Number(row.w) || 1, t: Number(row.t) || 1, s: Number(row.s) || 1 } };
  }

  async df(terms: string[]): Promise<Record<string, number>> {
    await ensureSchema();
    const out: Record<string, number> = {};
    for (const part of chunk([...new Set(terms)], 400)) {
      const r = await sql.prepare<{ term: string; c: number }>(`SELECT term, COUNT(*) AS c FROM posting WHERE term IN (${placeholders(part.length)}) GROUP BY term`).bindParams(...part).execute();
      for (const row of r.rows) out[row.term] = Number(row.c);
    }
    return out;
  }

  async candidates(terms: string[], limit: number): Promise<string[]> {
    await ensureSchema();
    if (!terms.length) return [];
    const r = await sql.prepare<{ doc_id: string; c: number }>(
      `SELECT doc_id, COUNT(*) AS c FROM posting WHERE term IN (${placeholders(terms.length)}) GROUP BY doc_id ORDER BY c DESC LIMIT ${Math.max(1, Math.min(limit, 500)) | 0}`,
    ).bindParams(...terms).execute();
    return r.rows.map((x) => x.doc_id);
  }

  async load(ids: string[]): Promise<Stored[]> {
    await ensureSchema();
    const out: Stored[] = [];
    // Small batches keep each response far below the 4 MiB limit.
    for (const part of chunk([...new Set(ids)], 40)) {
      const r = await sql.prepare<{ doc_json: string; features_json: string }>(`SELECT doc_json, features_json FROM doc WHERE id IN (${placeholders(part.length)})`).bindParams(...part).execute();
      for (const row of r.rows) out.push({ doc: JSON.parse(row.doc_json), f: JSON.parse(row.features_json) });
    }
    return out;
  }

  async upsert(doc: Doc, f: Features): Promise<void> {
    await ensureSchema();
    await sql.prepare(`INSERT INTO doc (id, kind, status, container, occurred_at, wlen, tlen, slen, doc_json, features_json, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE kind = VALUES(kind), status = VALUES(status), container = VALUES(container), occurred_at = VALUES(occurred_at),
          wlen = VALUES(wlen), tlen = VALUES(tlen), slen = VALUES(slen), doc_json = VALUES(doc_json), features_json = VALUES(features_json), indexed_at = VALUES(indexed_at)`)
      .bindParams(doc.id, doc.kind, doc.status, doc.container.slice(0, 64), doc.occurredAt, Object.keys(f.w).length, f.t.length, f.s.length, JSON.stringify(doc), JSON.stringify(f), new Date().toISOString())
      .execute();
    await sql.prepare('DELETE FROM posting WHERE doc_id = ?').bindParams(doc.id).execute();
    const terms = [...new Set(indexTerms(f).map((t) => t.slice(0, 255)))];
    for (const part of chunk(terms, 300)) {
      await sql.prepare(`INSERT IGNORE INTO posting (term, doc_id) VALUES ${part.map(() => '(?, ?)').join(',')}`).bindParams(...part.flatMap((t) => [t, doc.id])).execute();
    }
  }

  async remove(id: string): Promise<void> {
    await ensureSchema();
    await sql.prepare('DELETE FROM posting WHERE doc_id = ?').bindParams(id).execute();
    await sql.prepare('DELETE FROM doc WHERE id = ?').bindParams(id).execute();
  }

  /** Open action items, optionally for one service (filtered in code: services live in the JSON). */
  async openActionItems(): Promise<Stored[]> {
    await ensureSchema();
    const r = await sql.prepare<{ doc_json: string; features_json: string }>("SELECT doc_json, features_json FROM doc WHERE kind = 'action' AND status <> 'done' LIMIT 500").execute();
    return r.rows.map((row) => ({ doc: JSON.parse(row.doc_json), f: JSON.parse(row.features_json) }));
  }

  async countsByKind(): Promise<Record<string, number>> {
    await ensureSchema();
    const r = await sql.prepare<{ kind: string; c: number }>('SELECT kind, COUNT(*) AS c FROM doc GROUP BY kind').execute();
    return Object.fromEntries(r.rows.map((x) => [x.kind, Number(x.c)]));
  }
}

export async function audit(accountId: string, action: string, target: string, detail: unknown): Promise<void> {
  await ensureSchema();
  await sql.prepare('INSERT INTO audit (at, account_id, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .bindParams(new Date().toISOString(), accountId || 'unknown', action, target, JSON.stringify(detail)).execute();
}

export async function recentAudit(limit = 20): Promise<{ at: string; account_id: string; action: string; target: string; detail: string }[]> {
  await ensureSchema();
  const r = await sql.prepare<{ at: string; account_id: string; action: string; target: string; detail: string }>(`SELECT at, account_id, action, target, detail FROM audit ORDER BY id DESC LIMIT ${limit | 0}`).execute();
  return r.rows;
}
