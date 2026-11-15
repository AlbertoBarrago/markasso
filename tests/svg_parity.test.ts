import { describe, expect, it } from 'vitest';
import type { Element } from '../src/elements/element';
import { createStencil } from '../src/elements/stencils/registry';
import { sceneToSVG } from '../src/rendering/export';

const base = {
  strokeColor: '#e2e2ef',
  fillColor: 'transparent',
  strokeWidth: 2,
  opacity: 1,
  roughness: 0,
} as const;

const rect = (extra: Record<string, unknown> = {}) =>
  ({
    ...base,
    id: 'r',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    ...extra,
  }) as unknown as Element;

const text = (extra: Record<string, unknown> = {}) =>
  ({
    ...base,
    id: 't',
    type: 'text',
    x: 0,
    y: 0,
    width: 200,
    height: 60,
    content: 'x',
    fontSize: 16,
    fontFamily: 'monospace',
    ...extra,
  }) as unknown as Element;

const svg = (elements: Element[], theme?: 'light' | 'dark') =>
  sceneToSVG(elements, {
    canvasColor: theme === 'light' ? '#ffffff' : '#080808',
    withBackground: false,
    ...(theme && { theme }),
  })!;

describe('SVG export in a theme', () => {
  it('swaps the default inks like the canvas', () => {
    expect(svg([rect()], 'light')).toContain('stroke="#000000"');
    expect(svg([rect({ strokeColor: '#000000' })], 'dark')).toContain(
      'stroke="#e2e2ef"',
    );
    // Black on its own fill stays black in the dark theme.
    expect(
      svg([rect({ strokeColor: '#000000', fillColor: '#ffd43b' })], 'dark'),
    ).toContain('stroke="#000000"');
  });

  it('resolves an icon on its fill and its hanging label without it', () => {
    const out = svg(
      [
        createStencil(
          's',
          { kind: 'builtin', ref: 'generic/server' },
          32,
          32,
          { ...base, strokeColor: '#000000', fillColor: '#ffd43b' },
          'Server',
        ),
      ],
      'dark',
    );
    // Black artwork on its yellow fill, light label on the canvas.
    expect(out).toContain('stroke="#000000"');
    expect(out).toContain('fill="#e2e2ef"');
  });

  it('keeps the stored colors without a theme', () => {
    expect(svg([rect()])).toContain('stroke="#e2e2ef"');
  });

  it("gives code blocks the theme's colors", () => {
    const code = text({ isCode: true });
    expect(svg([code], 'light')).toContain('fill="rgba(0,0,0,0.05)"');
    expect(svg([code], 'dark')).toContain('fill="rgba(0,0,0,0.55)"');
  });
});

describe('SVG export of text', () => {
  it('draws a code block with its box, unwrapped and with its spaces', () => {
    const out = svg([
      text({ isCode: true, content: 'if (a) {\n    return  b;\n}' }),
    ]);
    expect(out).toContain('rx="6"');
    expect(out).toContain('xml:space="preserve"');
    expect(out).toContain('>    return  b;</tspan>');
    // Lines 1.3 apart from a 10 px padding.
    expect(out).toContain('y="34">if (a) {</tspan>');
    expect(out).toContain('y="54.8">    return  b;</tspan>');
  });

  it('underlines and strikes through', () => {
    const out = svg([
      text({ fontFamily: 'Arial', underline: true, strikethrough: true }),
    ]);
    expect(out).toContain('text-decoration="underline line-through"');
  });
});

describe('SVG export of rotated shapes', () => {
  it('turns the label with its shape', () => {
    const out = svg([rect({ label: 'Hello', rotation: 0.5 })]);
    expect(out).toMatch(/<g transform="rotate\([^"]+\)"><rect [^>]*\/><text /);
  });
});

describe('SVG export of a rounded rhombus', () => {
  it('rounds its corners like the canvas', () => {
    const out = svg([
      {
        ...base,
        id: 'd',
        type: 'rhombus',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        cornerRadius: 10,
      } as unknown as Element,
    ]);
    // A square diamond: right-angle corners, tangent points r away.
    expect(out).toContain('A 10 10 0 0 1');
    expect(out).not.toContain('<polygon');
  });
});

describe('SVG export of caps and joins', () => {
  it("uses the element's own, with round caps for a dotted stroke", () => {
    expect(svg([rect({ lineCap: 'butt', lineJoin: 'miter' })])).toContain(
      'stroke-linecap="butt" stroke-linejoin="miter"',
    );
    expect(svg([rect({ lineCap: 'square', strokeStyle: 'dotted' })])).toContain(
      'stroke-linecap="round" stroke-linejoin="round"',
    );
    expect(svg([rect()])).toContain(
      'stroke-linecap="round" stroke-linejoin="round"',
    );
  });
});

describe('SVG export markup', () => {
  /** Attribute names of every tag, which XML requires to be unique per tag. */
  function duplicateAttributes(doc: string): string[] {
    const dups: string[] = [];
    for (const [, tag] of doc.matchAll(/<([^/!][^>]*)>/g)) {
      const names = [...tag!.matchAll(/\s([\w:-]+)="/g)].map((m) => m[1]!);
      const seen = new Set<string>();
      for (const name of names) {
        if (seen.has(name)) dups.push(`${name} in <${tag!.slice(0, 40)}`);
        seen.add(name);
      }
    }
    return dups;
  }

  it('never repeats an attribute, whatever the stroke style', () => {
    const kinds: Array<Record<string, unknown>> = [
      { type: 'rectangle', width: 80, height: 40 },
      { type: 'ellipse', width: 80, height: 40 },
      { type: 'rhombus', width: 80, height: 40, cornerRadius: 6 },
      { type: 'line', x2: 100, y2: 0 },
      { type: 'line', x2: 100, y2: 60, routing: 'elbow' },
      { type: 'arrow', x2: 100, y2: 0 },
      {
        type: 'polygon',
        points: [
          [0, 0],
          [50, 0],
          [25, 40],
        ],
        closed: true,
      },
      { type: 'curve', x2: 100, y2: 0, cx: 50, cy: -40 },
    ];
    for (const strokeStyle of ['solid', 'dashed', 'dotted']) {
      const elements = kinds.map(
        (kind, i) =>
          ({
            ...base,
            id: `e${i}`,
            x: 0,
            y: i * 100,
            strokeStyle,
            ...kind,
          }) as unknown as Element,
      );
      expect(duplicateAttributes(svg(elements, 'dark'))).toEqual([]);
    }
  });
});
