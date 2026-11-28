/**
 * Minimal Markdown-to-HTML renderer covering only the subset of syntax used
 * by docs/MANUAL.md (headings, tables, lists, blockquotes, hr, bold/code/links).
 * Not a general-purpose parser — kept deliberately small to avoid pulling in
 * a Markdown dependency for a single in-app document.
 */

function escapeHtml(text: string): string {
  // Quotes too: link targets end up inside an attribute.
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Bold, inline code and links. With `webLinksOnly`, a link whose target is
 * not http(s) keeps only its label: text from outside the app (an agent's
 * reply) must never produce a `javascript:` or other scriptable URL.
 */
function renderInline(text: string, webLinksOnly = false): string {
  // Code spans and links are cut out first and held as placeholders, so bold
  // never reaches inside a code span or a link target. NUL cannot come from
  // the input (stripped), so placeholders cannot be forged.
  const held: string[] = [];
  const hold = (html: string): string => `\0${held.push(html) - 1}\0`;
  const bold = (escaped: string): string =>
    escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  let out = text
    .replace(/\0/g, '')
    .replace(/`([^`]+)`/g, (_m, code: string) =>
      hold(`<code>${escapeHtml(code)}</code>`),
    )
    .replace(
      /\[([^\]]+)\]\(([^)\s\0]+)\)/g,
      (_m, label: string, href: string) => {
        const inner = bold(escapeHtml(label));
        return hold(
          webLinksOnly && !/^https?:\/\//i.test(href)
            ? inner
            : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`,
        );
      },
    );
  out = bold(escapeHtml(out));
  // A link label may itself hold a code span: restore until none is left.
  for (let prev = ''; out !== prev; ) {
    prev = out;
    out = out.replace(/\0(\d+)\0/g, (_m, i: string) => held[Number(i)] ?? '');
  }
  return out;
}

/**
 * Renders a chat message (an agent's reply): paragraphs with their line
 * breaks, `-` and `1.` lists, fenced code blocks, and the inline subset
 * above with web links only. Everything else stays escaped text.
 */
export function renderChatMarkdown(markdown: string): string {
  const html: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;
  let code: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      html.push(
        `<p>${paragraph.map((line) => renderInline(line, true)).join('<br>')}</p>`,
      );
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (listTag && listItems.length > 0) {
      html.push(
        `<${listTag}>${listItems.map((item) => `<li>${renderInline(item, true)}</li>`).join('')}</${listTag}>`,
      );
    }
    listItems = [];
    listTag = null;
  };

  for (const line of markdown.split('\n')) {
    if (code) {
      if (line.trim().startsWith('```')) {
        html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.trim().startsWith('```')) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    const unordered = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ordered || unordered) {
      flushParagraph();
      const tag = ordered ? 'ol' : 'ul';
      if (listTag && listTag !== tag) flushList();
      listTag = tag;
      listItems.push((ordered ?? unordered)![1]!);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  // An unclosed fence still shows its content.
  if (code) html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushParagraph();
  flushList();
  return html.join('');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderTable(rows: readonly string[]): string {
  const header = tableCells(rows[0]!);
  const body = rows.slice(2).map(tableCells);
  const thead = `<thead><tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${body
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`,
    )
    .join('')}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

export interface MarkdownSection {
  readonly id: string;
  readonly title: string;
}

export interface RenderedMarkdown {
  readonly html: string;
  readonly sections: readonly MarkdownSection[];
}

/** Renders the body of the document, skipping any leading raw-HTML preamble. */
export function renderMarkdown(markdown: string): RenderedMarkdown {
  const bodyStart = markdown.startsWith('## ')
    ? 0
    : markdown.indexOf('\n## ') + 1 || 0;
  const lines = markdown.slice(bodyStart).split('\n');

  const html: string[] = [];
  const sections: MarkdownSection[] = [];
  const seenIds = new Set<string>();
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (listTag && listItems.length > 0) {
      html.push(
        `<${listTag}>${listItems.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${listTag}>`,
      );
    }
    listItems = [];
    listTag = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      i++;
      continue;
    }
    if (line.startsWith('### ')) {
      flushParagraph();
      flushList();
      html.push(`<h3>${renderInline(line.slice(4))}</h3>`);
      i++;
      continue;
    }
    if (line.startsWith('## ')) {
      flushParagraph();
      flushList();
      const title = line.slice(3).trim();
      let id = slugify(title);
      while (seenIds.has(id)) id = `${id}-2`;
      seenIds.add(id);
      sections.push({ id, title });
      html.push(`<h2 id="${id}">${renderInline(title)}</h2>`);
      i++;
      continue;
    }
    if (line.trim() === '---') {
      flushParagraph();
      flushList();
      html.push('<hr>');
      i++;
      continue;
    }
    if (line.startsWith('> ')) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${renderInline(line.slice(2))}</blockquote>`);
      i++;
      continue;
    }
    if (
      line.startsWith('| ') &&
      /^\|[-\s|]+\|$/.test(lines[i + 1]?.trim() ?? '')
    ) {
      flushParagraph();
      flushList();
      const tableLines = [line, lines[i + 1]!];
      let j = i + 2;
      while (j < lines.length && lines[j]!.startsWith('|')) {
        tableLines.push(lines[j]!);
        j++;
      }
      html.push(renderTable(tableLines));
      i = j;
      continue;
    }
    const orderedMatch = /^\d+\.\s+(.*)$/.exec(line);
    const unorderedMatch = /^-\s+(.*)$/.exec(line);
    if (orderedMatch || unorderedMatch) {
      flushParagraph();
      const tag = orderedMatch ? 'ol' : 'ul';
      if (listTag && listTag !== tag) flushList();
      listTag = tag;
      listItems.push((orderedMatch ?? unorderedMatch)![1]!);
      i++;
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flushParagraph();
  flushList();

  return { html: html.join('\n'), sections };
}
