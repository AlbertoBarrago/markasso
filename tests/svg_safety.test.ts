import { describe, expect, it } from 'vitest';
import { checkSvgMarkup } from '../src/io/svg_safety';

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="g"><stop offset="0" stop-color="#f90"/></linearGradient></defs><rect width="48" height="48" fill="url(#g)"/><use href="#g"/></svg>';

describe('checkSvgMarkup', () => {
  it('accepts a plain vendor-style icon unchanged in substance', () => {
    const out = checkSvgMarkup(`<?xml version="1.0"?>\n<!-- AWS -->\n${ICON}`);
    expect(out).not.toBeNull();
    expect(out!.startsWith('<svg ')).toBe(true);
    expect(out).toContain('fill="url(#g)"');
    expect(out).not.toContain('<?xml');
    expect(out).not.toContain('AWS');
  });

  it('adds pixel dimensions from the viewBox and the namespace', () => {
    const out = checkSvgMarkup(
      '<svg viewBox="0 0 64 32" width="100%"><path d="M0 0h1"/></svg>',
    );
    expect(out).toContain('width="64"');
    expect(out).toContain('height="32"');
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('keeps references inside the document and inline rasters', () => {
    expect(
      checkSvgMarkup(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image href="data:image/png;base64,AAAA=="/><use xlink:href="#a"/></svg>',
      ),
    ).not.toBeNull();
  });

  it('accepts quoted values holding = or > and character references', () => {
    expect(
      checkSvgMarkup(
        '<svg data-note="a=b &gt; c" viewBox="0 0 8 8"><title>A &amp; B</title><rect width="8" height="8"/></svg>',
      ),
    ).not.toBeNull();
  });

  it('scans pathological input in linear time', () => {
    const start = performance.now();
    expect(checkSvgMarkup(`<svg ${'a'.repeat(60_000)}></svg>`)).toBeNull();
    expect(checkSvgMarkup(`<svg>${'<g>'.repeat(20_000)}</svg>`)).toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it.each([
    ['a script', '<svg><script>alert(1)</script></svg>'],
    ['a prefixed script', '<svg><svg:script>alert(1)</svg:script></svg>'],
    ['foreignObject', '<svg><foreignObject><div/></foreignObject></svg>'],
    ['animation', '<svg><set attributeName="x" to="1"/></svg>'],
    ['an event attribute', '<svg onload="alert(1)"></svg>'],
    ['a mixed-case event attribute', '<svg><rect onMouseOver="x"/></svg>'],
    [
      'an event attribute after a quoted ">"',
      '<svg><rect title=">" onload="alert(1)"/></svg>',
    ],
    ['an external href', '<svg><use href="https://evil.test/a.svg#x"/></svg>'],
    ['a javascript link', '<svg><a xlink:href="javascript:alert(1)"/></svg>'],
    ['an external url()', '<svg><rect fill="url(https://evil.test/x)"/></svg>'],
    [
      'a CSS import',
      '<svg><style>@import "https://evil.test/x.css";</style></svg>',
    ],
    [
      'a DOCTYPE with entities',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>',
    ],
    ['CDATA', '<svg><style><![CDATA[a{}]]></style></svg>'],
    ['a processing instruction', '<svg><?php echo 1 ?></svg>'],
    ['an unquoted attribute', '<svg><rect width=10/></svg>'],
    ['a non-SVG root', '<html><svg></svg></html>'],
    ['trailing markup', '<svg></svg><script>alert(1)</script>'],
    ['a stray <', '<svg><rect width="1" < /></svg>'],
    [
      'an escaped CSS import',
      '<svg><style>@\\69mport "https://evil.test/x.css";</style></svg>',
    ],
    [
      'a referenced CSS import',
      '<svg><style>@&#105;mport "https://evil.test/x.css";</style></svg>',
    ],
    [
      'an escaped url()',
      '<svg><style>a{fill:\\75 rl(https://evil.test/x)}</style></svg>',
    ],
    [
      'a referenced url()',
      '<svg><rect fill="u&#114;l(https://evil.test/x)"/></svg>',
    ],
    [
      'image-set()',
      '<svg><style>a{fill:image-set("https://evil.test/x" 1x)}</style></svg>',
    ],
    ['@font-face', '<svg><style>@font-face{src:local(x)}</style></svg>'],
    [
      'xml:base',
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink" xml:base="https://evil.test/p.svg"><image xlink:href="#icon"/></svg>',
    ],
    [
      'an encoded javascript link',
      '<svg><a href="&#106;avascript:alert(1)"/></svg>',
    ],
    [
      'an unclosed element',
      '<svg viewBox="0 0 8 8"><g><rect width="8" height="8"/></svg>',
    ],
    ['a mismatched case', '<svg><g></G></svg>'],
    ['an undeclared prefix', '<svg><use xlink:href="#a"/></svg>'],
    ['a duplicate attribute', '<svg><rect width="1" width="2"/></svg>'],
    ['an undeclared entity', '<svg><title>&nbsp;</title></svg>'],
    [
      'a comment hiding markup from HTML parsers',
      '<svg><!-- a --!> <script>x</script> --></svg>',
    ],
    ['attributes without whitespace', '<svg><rect width="1"height="2"/></svg>'],
    ['a space before the tag name', '<svg>< rect/></svg>'],
  ])('rejects %s', (_, markup) => {
    expect(checkSvgMarkup(markup)).toBeNull();
  });
});
