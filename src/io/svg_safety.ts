import { MAX_EMBEDDED_SVG_CHARS } from '../elements/stencils/registry';

/**
 * Safety rules for imported icon SVGs, shared by the browser sanitizer
 * (`src/ui/svg_sanitize.ts`, which removes what breaks them) and by
 * {@link checkSvgMarkup}, which runs without a DOM (the MCP server, in Node)
 * and rejects instead of repairing.
 *
 * Icons are only ever rendered as images (canvas drawImage, <img>, SVG
 * <image>), where browsers already run no scripts and load no external
 * resources. These rules are defense in depth for anything that might later
 * handle the markup differently.
 */

/** Elements that carry active content, embedded documents or animation. */
export const FORBIDDEN_SVG_ELEMENTS: ReadonlyArray<string> = [
  'script',
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
];

/** A reference that stays inside the document or is an inline raster image. */
export function isSafeSvgReference(value: string): boolean {
  const v = value.trim();
  return v.startsWith('#') || /^data:image\/(png|jpe?g|gif|webp);/i.test(v);
}

const FORBIDDEN = new Set(FORBIDDEN_SVG_ELEMENTS.map((n) => n.toLowerCase()));

/** An XML name with an optional prefix, matched at a given position. */
const NAME = /[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/y;
/** Character references XML allows without a DTD. */
const REFERENCE = /&(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/iy;
const PREDEFINED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};
/** `url(...)` with an optionally quoted target. */
const URL_CALL = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/**
 * Decodes character references, or returns null when an `&` starts
 * anything else (an undeclared entity: the document is not well formed).
 */
function decodeReferences(raw: string): string | null {
  let out = '';
  let from = 0;
  for (let at = raw.indexOf('&'); at !== -1; at = raw.indexOf('&', from)) {
    REFERENCE.lastIndex = at;
    const match = REFERENCE.exec(raw);
    if (!match) return null;
    out += raw.slice(from, at);
    const body = match[0].slice(1, -1).toLowerCase();
    if (body.startsWith('#')) {
      const code = body.startsWith('#x')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!(code > 0 && code <= 0x10ffff)) return null;
      out += String.fromCodePoint(code);
    } else {
      out += PREDEFINED[body]!;
    }
    from = at + match[0].length;
  }
  return out + raw.slice(from);
}

/**
 * Whether decoded CSS (a `<style>` body, or any attribute value, since
 * presentation attributes take `url()` too) can only reach the document.
 * Strict on purpose: no escapes (`\75 rl(`), no at-rules (`@import`,
 * `@font-face`), no image functions that take a string, and `url()` only
 * with a fragment.
 */
function cssIsLocal(css: string): boolean {
  if (/[\\@]/.test(css)) return false;
  if (/(image-set|image|cross-fade|element|expression|src)\s*\(/i.test(css))
    return false;
  const calls = [...css.matchAll(URL_CALL)];
  if (calls.some((m) => !m[2]!.trim().startsWith('#'))) return false;
  // A url( the pattern could not read (unbalanced quotes) is not local.
  return (css.match(/url\s*\(/gi) ?? []).length === calls.length;
}

const isSpace = (c: string | undefined) =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r';

function prefixOf(name: string): string | null {
  const at = name.indexOf(':');
  return at === -1 ? null : name.slice(0, at);
}

function localOf(name: string): string {
  return name.slice(name.indexOf(':') + 1).toLowerCase();
}

/**
 * Checks an SVG without a DOM parser, in one linear pass. Returns the markup
 * ready to embed (XML declaration and comments dropped, `xmlns` and pixel
 * `width`/`height` added on the root like the browser sanitizer does), or
 * null when it is not a well-formed plain SVG or contains anything the
 * browser sanitizer would strip or that could reach outside the document:
 * forbidden elements, event attributes, external references, `xml:base`,
 * CSS escapes, at-rules or external `url()`, DOCTYPE or entity
 * declarations, CDATA, processing instructions. Being strict costs nothing
 * for vendor icon sets, which contain none of it.
 */
export function checkSvgMarkup(markup: string): string | null {
  // Larger files could never be embedded anyway; the cap also bounds the scan.
  if (markup.length > MAX_EMBEDDED_SVG_CHARS) return null;
  const text = markup.replace(/^﻿/, '');
  const n = text.length;
  let i = 0;
  while (isSpace(text[i])) i++;
  if (
    text.startsWith('<?xml', i) &&
    (isSpace(text[i + 5]) || text[i + 5] === '?')
  ) {
    const end = text.indexOf('?>', i);
    if (end === -1) return null;
    i = end + 2;
  }

  /** Open elements, by exact name: XML names are case-sensitive. */
  const stack: string[] = [];
  const declared = new Set(['xml', 'xmlns']);
  const used = new Set<string>();
  let out = '';
  let rootDone = false;

  while (i < n) {
    if (text[i] !== '<') {
      const next = text.indexOf('<', i);
      const end = next === -1 ? n : next;
      const run = text.slice(i, end);
      const decoded = decodeReferences(run);
      if (decoded === null) return null;
      // Only whitespace outside the root element.
      if ((stack.length === 0 || rootDone) && decoded.trim()) return null;
      const open = stack[stack.length - 1];
      if (open && localOf(open) === 'style' && !cssIsLocal(decoded))
        return null;
      out += run;
      i = end;
      continue;
    }

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) return null;
      // "--" inside a comment is not XML, and HTML parsers end comments on
      // forms like "--!>": such a comment could hide markup.
      const body = text.slice(i + 4, end);
      if (body.includes('--') || body.endsWith('-')) return null;
      i = end + 3;
      continue;
    }
    // DOCTYPE, CDATA, processing instructions.
    if (text[i + 1] === '!' || text[i + 1] === '?') return null;

    const closing = text[i + 1] === '/';
    let j = i + (closing ? 2 : 1);
    NAME.lastIndex = j;
    const nameMatch = NAME.exec(text);
    if (!nameMatch) return null;
    const name = nameMatch[0];
    j += name.length;
    const prefix = prefixOf(name);
    if (prefix) used.add(prefix);

    if (closing) {
      while (isSpace(text[j])) j++;
      if (text[j] !== '>' || stack.pop() !== name) return null;
      if (stack.length === 0) rootDone = true;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    const attrs: Array<[string, string]> = [];
    let selfClosing = false;
    for (;;) {
      const start = j;
      while (isSpace(text[j])) j++;
      if (text[j] === '>') break;
      if (text[j] === '/' && text[j + 1] === '>') {
        selfClosing = true;
        j++;
        break;
      }
      // Attributes are separated by whitespace.
      if (j === start) return null;
      NAME.lastIndex = j;
      const attr = NAME.exec(text);
      if (!attr) return null;
      j += attr[0].length;
      while (isSpace(text[j])) j++;
      if (text[j] !== '=') return null;
      j++;
      while (isSpace(text[j])) j++;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") return null;
      const end = text.indexOf(quote, j + 1);
      if (end === -1) return null;
      const value = text.slice(j + 1, end);
      if (value.includes('<')) return null;
      attrs.push([attr[0], value]);
      j = end + 1;
    }
    // `j` now sits on the tag's closing `>`.

    if (rootDone) return null;
    if (stack.length === 0 && (name !== 'svg' || out.trim())) return null;
    if (FORBIDDEN.has(localOf(name))) return null;
    const seen = new Set<string>();
    for (const [attrName, raw] of attrs) {
      if (seen.has(attrName)) return null;
      seen.add(attrName);
      const attrPrefix = prefixOf(attrName);
      if (attrPrefix === 'xmlns') declared.add(attrName.slice(6));
      else if (attrPrefix) used.add(attrPrefix);
      const attrLocal = localOf(attrName);
      const value = decodeReferences(raw);
      if (value === null) return null;
      if (attrLocal.startsWith('on') || attrLocal === 'base') return null;
      if (
        (attrLocal === 'href' || attrLocal === 'src') &&
        !isSafeSvgReference(value)
      )
        return null;
      if (!cssIsLocal(value)) return null;
    }

    if (stack.length === 0) {
      out += rootTag(attrs, selfClosing);
      if (selfClosing) rootDone = true;
    } else {
      out += text.slice(i, j + 1);
    }
    if (!selfClosing) stack.push(name);
    i = j + 1;
  }

  if (!rootDone || stack.length > 0) return null;
  for (const prefix of used) if (!declared.has(prefix)) return null;
  return out.trim();
}

/**
 * The root start tag with the browser sanitizer's fix-ups: without explicit
 * pixel dimensions some browsers give the image a natural size of 0.
 * Values are kept raw (already valid XML) and re-quoted with `"`.
 */
function rootTag(attrs: Array<[string, string]>, selfClosing: boolean): string {
  const get = (name: string) => attrs.find(([n]) => n === name)?.[1];
  const set = (name: string, value: string) => {
    const at = attrs.findIndex(([n]) => n === name);
    if (at === -1) attrs.push([name, value]);
    else attrs[at] = [name, value];
  };
  const viewBox = get('viewBox')
    ?.trim()
    .split(/[\s,]+/);
  const relative = (name: string) => {
    const value = get(name);
    return value === undefined || /%\s*$/.test(value);
  };
  if (viewBox?.length === 4 && (relative('width') || relative('height'))) {
    set('width', viewBox[2] ?? '64');
    set('height', viewBox[3] ?? '64');
  }
  if (get('xmlns') === undefined) set('xmlns', 'http://www.w3.org/2000/svg');
  const body = attrs
    .map(([name, value]) => `${name}="${value.replace(/"/g, '&quot;')}"`)
    .join(' ');
  return `<svg ${body}${selfClosing ? '/' : ''}>`;
}
