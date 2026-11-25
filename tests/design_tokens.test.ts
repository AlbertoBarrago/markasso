import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderCss, renderFigma } from '../src/design/render_tokens';
import { DARK, LIGHT, SHARED } from '../src/design/tokens';

const set = {
  shared: SHARED,
  dark: DARK,
  light: LIGHT,
};
const read = (p: string) =>
  readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('design tokens', () => {
  it('generated files match src/design/tokens.ts (run `pnpm tokens`)', () => {
    expect(read('src/styles/tokens.css')).toBe(renderCss(set));
    expect(read('design/tokens.dark.json')).toBe(renderFigma(set, 'dark'));
    expect(read('design/tokens.light.json')).toBe(renderFigma(set, 'light'));
  });

  it('defines every theme token in both themes', () => {
    expect(Object.keys(LIGHT).sort()).toEqual(Object.keys(DARK).sort());
  });

  it('references only defined tokens inside token values', () => {
    const defined = new Set([...Object.keys(SHARED), ...Object.keys(DARK)]);
    for (const value of [DARK, LIGHT, SHARED].flatMap(Object.values)) {
      for (const [, name] of value.matchAll(/var\(--([a-z0-9-]+)\)/g)) {
        expect(defined, name).toContain(name);
      }
    }
  });

  it('keeps every CSS variable used by the app defined', () => {
    // Variables set at runtime or locally scoped by a component.
    const local = new Set([
      'toolbar-panel-top',
      'toolbar-panel-bottom',
      'toolbar-hint-transform',
      'toolbar-hint-top',
      'toolbar-hint-center',
      'wl-logo-offset',
      'grid-x',
      'grid-y',
      'fsb-swatch',
      'i',
    ]);
    const defined = new Set([...Object.keys(SHARED), ...Object.keys(DARK)]);
    const css = read('src/styles/tokens.css');
    expect(css).toContain('--color-canvas:');
    const used = new Set<string>();
    for (const file of [
      'src/style.css',
      'src/styles/base.css',
      'src/styles/theme.css',
      'src/styles/overlays.css',
      'src/styles/menu.css',
      'src/styles/context-panel.css',
      'src/styles/mobile.css',
      'src/styles/library.css',
      'src/styles/ui-components.css',
      'src/site/shared/site.css',
      'src/site/agents/agents.css',
      'src/styles/mcp-tabs.css',
    ]) {
      for (const [, name] of read(file).matchAll(/var\(--([a-z0-9-]+)/g)) {
        if (name) used.add(name);
      }
    }
    const missing = [...used].filter((n) => !defined.has(n) && !local.has(n));
    expect(missing).toEqual([]);
  });

  it('maps the pill radius and aliases into the Figma files', () => {
    const dark = JSON.parse(renderFigma(set, 'dark'));
    expect(dark.radius.full.$value).toEqual({ value: 9999, unit: 'px' });
    expect(dark.color['focus-ring'].$value).toBe('{color.accent}');
    expect(dark.color.accent.$value.hex).toBe('#c42059');
  });

  it('gives every Figma token a DTCG type or an alias', () => {
    for (const theme of ['dark', 'light'] as const) {
      const root = JSON.parse(renderFigma(set, theme)) as Record<
        string,
        Record<string, { $type?: string; $value: unknown }>
      >;
      for (const [group, tokens] of Object.entries(root)) {
        for (const [key, token] of Object.entries(tokens)) {
          const isAlias =
            typeof token.$value === 'string' && token.$value.startsWith('{');
          expect(
            isAlias || token.$type,
            `${theme} ${group}.${key}`,
          ).toBeTruthy();
        }
      }
    }
  });

  it('resolves a color-mix fade of a token to its color with scaled alpha', () => {
    const light = JSON.parse(renderFigma(set, 'light'));
    expect(light.color.hover).toEqual({
      $type: 'color',
      $value: {
        colorSpace: 'srgb',
        components: [175 / 255, 20 / 255, 90 / 255],
        hex: '#af145a',
        alpha: 0.08,
      },
      $description: LIGHT['color-hover'],
    });
    const dark = JSON.parse(renderFigma(set, 'dark'));
    expect(dark.color.hover.$value).toBe('{color.overlay-1}');
  });

  it('fades an already translucent token by multiplying its alpha', () => {
    const faded = {
      ...set,
      light: {
        ...LIGHT,
        'color-hover':
          'color-mix(in srgb, var(--color-accent-subtle) 50%, transparent)',
      },
    };
    const light = JSON.parse(renderFigma(faded, 'light'));
    expect(light.color.hover.$value).toMatchObject({
      hex: '#af145a',
      alpha: 0.1,
    });
  });

  it('renders shadows as typed DTCG layers', () => {
    const light = JSON.parse(renderFigma(set, 'light'));
    expect(light.shadow.island.$type).toBe('shadow');
    expect(light.shadow.island.$value[0]).toMatchObject({
      inset: true,
      offsetX: { value: 1, unit: 'px' },
      offsetY: { value: -1, unit: 'px' },
      color: { hex: '#000000', alpha: 0.35 },
    });
  });
});
