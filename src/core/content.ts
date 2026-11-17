// Turns Jira ADF and Confluence storage XHTML into one simple structure the matcher understands.

export interface Section {
  heading: string; // lowercased heading text, '' for content before the first heading
  text: string;
}

export interface Content {
  text: string; // all prose, code included, as plain text
  codeBlocks: string[]; // contents of code blocks (logs, errors, alerts, SQL)
  codeSpans: string[]; // inline code fragments (`max_connections`)
  sections: Section[];
  urls: string[]; // link targets (smart links, anchors)
}

export function emptyContent(): Content {
  return { text: '', codeBlocks: [], codeSpans: [], sections: [], urls: [] };
}

/** Merge several contents (description + comments) into one. */
export function mergeContent(parts: Content[]): Content {
  const out = emptyContent();
  for (const p of parts) {
    out.text += (out.text ? '\n' : '') + p.text;
    out.codeBlocks.push(...p.codeBlocks);
    out.codeSpans.push(...p.codeSpans);
    out.sections.push(...p.sections);
    out.urls.push(...p.urls);
  }
  return out;
}

// ---------- ADF (Jira descriptions and comments) ----------

interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: { type: string; attrs?: Record<string, any> }[];
  content?: AdfNode[];
}

export function fromAdf(doc: unknown): Content {
  const out = emptyContent();
  if (!doc || typeof doc !== 'object') return out;
  let current: Section = { heading: '', text: '' };
  out.sections.push(current);
  const lines: string[] = [];

  const inlineText = (n: AdfNode): string => {
    if (n.type === 'text') {
      const t = n.text ?? '';
      for (const m of n.marks ?? []) {
        if (m.type === 'code') out.codeSpans.push(t);
        if (m.type === 'link' && m.attrs?.href) out.urls.push(String(m.attrs.href));
      }
      return t;
    }
    if (n.type === 'inlineCard' || n.type === 'blockCard' || n.type === 'embedCard') {
      if (n.attrs?.url) out.urls.push(String(n.attrs.url));
      return ' ';
    }
    if (n.type === 'mention') return n.attrs?.text ? String(n.attrs.text) : ' ';
    if (n.type === 'hardBreak') return '\n';
    return (n.content ?? []).map(inlineText).join('');
  };

  const block = (n: AdfNode) => {
    switch (n.type) {
      case 'heading': {
        const h = inlineText(n).trim();
        current = { heading: h.toLowerCase(), text: '' };
        out.sections.push(current);
        lines.push(h);
        return;
      }
      case 'codeBlock': {
        const code = (n.content ?? []).map((c) => c.text ?? '').join('');
        out.codeBlocks.push(code);
        current.text += code + '\n';
        lines.push(code);
        return;
      }
      case 'paragraph': {
        const t = inlineText(n);
        current.text += t + '\n';
        lines.push(t);
        return;
      }
      default:
        // Lists, tables, panels, quotes: recurse into children; stray inline nodes are kept as text.
        for (const c of n.content ?? []) {
          if (!isInline(c)) { block(c); continue; }
          const t = inlineText(c);
          current.text += t + '\n';
          lines.push(t);
        }
    }
  };
  for (const n of (doc as AdfNode).content ?? []) block(n);
  out.text = lines.join('\n');
  return out;
}

function isInline(n: AdfNode): boolean {
  return ['text', 'inlineCard', 'mention', 'hardBreak', 'emoji', 'date', 'status'].includes(n.type);
}

// ---------- Confluence storage format (XHTML) ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: '…', ndash: '–', mdash: '—' };
function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ');

export function fromStorage(xhtml: string): Content {
  const out = emptyContent();
  if (!xhtml) return out;
  // 1. Pull out code macros (their CDATA bodies are logs, SQL, commands).
  let html = xhtml.replace(/<ac:structured-macro[^>]*ac:name="(?:code|noformat)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g, (_m, inner: string) => {
    const body = /<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>/.exec(inner)?.[1] ?? '';
    out.codeBlocks.push(body);
    return `<p>${body.replace(/</g, '&lt;')}</p>`;
  });
  // 2. Inline code and links.
  html = html.replace(/<code>([\s\S]*?)<\/code>/g, (_m, c: string) => { out.codeSpans.push(stripTags(c).trim()); return c; });
  for (const m of html.matchAll(/<a [^>]*href="([^"]+)"/g)) out.urls.push(decode(m[1]));
  for (const m of html.matchAll(/<ri:page [^>]*ri:content-id="(\d+)"/g)) out.urls.push(`/pages/${m[1]}`);
  // 3. Split by headings into sections; block tags become line breaks.
  const parts = html.split(/(<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/);
  let current: Section = { heading: '', text: '' };
  out.sections.push(current);
  const lines: string[] = [];
  for (const part of parts) {
    const h = /^<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>$/.exec(part);
    if (h) {
      const title = stripTags(h[1]).trim();
      current = { heading: title.toLowerCase(), text: '' };
      out.sections.push(current);
      lines.push(title);
      continue;
    }
    const text = stripTags(part.replace(/<\/(p|li|tr|th|td|blockquote|div)>|<br\s*\/?>/g, '\n')).replace(/\n\s*\n+/g, '\n').trim();
    if (text) { current.text += text + '\n'; lines.push(text); }
  }
  out.text = lines.join('\n');
  return out;
}

/** The text of the first section whose heading matches, e.g. "resolution". */
export function sectionText(c: Content, ...headings: string[]): string | undefined {
  for (const h of headings) {
    const s = c.sections.find((x) => x.heading === h || x.heading.startsWith(h));
    if (s && s.text.trim()) return s.text.trim();
  }
  return undefined;
}
