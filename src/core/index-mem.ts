// In-memory index with the same interface as the Forge SQL index. Used by tests and the offline eval.

import type { Features } from './features';
import { indexTerms } from './features';
import type { IndexReader, IndexStats, Stored } from './match';
import type { Doc } from './doc';

export class MemoryIndex implements IndexReader {
  private docs = new Map<string, Stored>();
  private postings = new Map<string, Set<string>>();

  upsert(doc: Doc, f: Features): void {
    this.remove(doc.id);
    this.docs.set(doc.id, { doc, f });
    for (const t of indexTerms(f)) {
      let set = this.postings.get(t);
      if (!set) this.postings.set(t, (set = new Set()));
      set.add(doc.id);
    }
  }

  remove(id: string): void {
    const old = this.docs.get(id);
    if (!old) return;
    for (const t of indexTerms(old.f)) this.postings.get(t)?.delete(id);
    this.docs.delete(id);
  }

  async stats(): Promise<IndexStats> {
    const all = [...this.docs.values()];
    const avg = (fn: (s: Stored) => number) => (all.length ? all.reduce((a, s) => a + fn(s), 0) / all.length : 1);
    return { n: all.length, avg: { w: avg((s) => Object.keys(s.f.w).length), t: avg((s) => s.f.t.length), s: avg((s) => s.f.s.length) } };
  }

  async df(terms: string[]): Promise<Record<string, number>> {
    return Object.fromEntries(terms.map((t) => [t, this.postings.get(t)?.size ?? 0]));
  }

  async candidates(terms: string[], limit: number): Promise<string[]> {
    const count = new Map<string, number>();
    for (const t of terms) for (const id of this.postings.get(t) ?? []) count.set(id, (count.get(id) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
  }

  async load(ids: string[]): Promise<Stored[]> {
    return ids.map((id) => this.docs.get(id)).filter((x): x is Stored => !!x);
  }

  all(): Stored[] {
    return [...this.docs.values()];
  }
}
