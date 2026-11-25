/**
 * Design tokens: the single source of every visual value of the UI (#184).
 *
 * Names follow Tailwind CSS v4's theme namespaces (`--color-*`, `--spacing`,
 * `--text-*`, `--radius-*`, ...), with custom tokens in the same style where
 * Tailwind has no namespace (`--z-*`, `--duration-*`). From this module:
 * - `scripts/build-tokens.ts` generates `src/styles/tokens.css` and the
 *   Figma Variables files in `design/`;
 * - the canvas renderer and the UI import the values CSS cannot reach.
 *
 * Keep this file free of imports and of TypeScript-only runtime syntax
 * (enums, namespaces): Node runs the generator on it by stripping types.
 */

/** Tokens whose value depends on the theme. Keys are names without `--`. */
export type ThemeTokens = Readonly<Record<string, string>>;

/**
 * Default ink of a drawing in each theme. It is also element data: saved
 * drawings store these exact hex values and the renderer swaps one for the
 * other on a theme change, so they must never change.
 */
export const DEFAULT_INK = { dark: '#e2e2ef', light: '#000000' } as const;

/** Default canvas background of each theme, before the user picks one. */
export const CANVAS_BG = { dark: '#080808', light: '#ffffff' } as const;

/** Dark theme, the default (`:root`). */
export const DARK: ThemeTokens = {
  'color-accent': '#c42059',
  'color-accent-subtle': 'rgb(196 32 89 / 0.2)',
  'color-accent-muted': 'rgb(196 32 89 / 0.4)',
  'color-focus-ring': 'var(--color-accent)',
  'color-danger': '#fa0101',
  'color-warning': '#f59e0b',
  // Status colors (#184): text, icons and outlines of toasts, banners and
  // badges; `-subtle` is their 10% tint for backgrounds.
  'color-danger-subtle':
    'color-mix(in oklab, var(--color-danger) 10%, transparent)',
  'color-warning-subtle':
    'color-mix(in oklab, var(--color-warning) 10%, transparent)',
  'color-success': '#7de8a0',
  'color-success-subtle':
    'color-mix(in oklab, var(--color-success) 10%, transparent)',
  'color-info': '#60a5fa',
  'color-info-subtle':
    'color-mix(in oklab, var(--color-info) 10%, transparent)',

  'color-text': '#e8d4d4',
  'color-text-strong': '#fffadf',
  'color-text-muted': 'rgb(141 141 141)',
  'color-text-on-accent': '#ffffff',

  'color-surface-island': 'rgb(21 21 21 / 0.98)',
  'color-border': 'rgb(255 255 255 / 0.18)',
  'color-border-subtle': 'rgb(255 255 255 / 0.08)',
  'color-border-input': 'rgb(89 89 89 / 0.4)',
  'color-hover': 'var(--color-overlay-1)',
  'color-scrim': 'rgb(0 0 0 / 0.5)',
  'color-scrollbar': 'rgb(255 255 255 / 0.1)',

  'color-overlay-1': 'rgb(255 255 255 / 0.12)',
  'color-overlay-2': 'rgb(255 255 255 / 0.18)',
  'color-overlay-3': 'rgb(255 255 255 / 0.3)',
  'color-overlay-4': 'rgb(255 255 255 / 0.6)',

  'color-canvas': CANVAS_BG.dark,
  'color-ink-default': DEFAULT_INK.dark,

  'shadow-island':
    'inset 1px -1px 2px 0 rgb(0 0 0 / 0.9), inset -1px 1px 1px 0 rgb(255 255 255 / 0.2)',
  'shadow-modal':
    '0 8px 48px rgb(0 0 0 / 0.7), 0 0 0 1px rgb(255 255 255 / 0.04)',
  'shadow-popover': '0 8px 32px rgb(0 0 0 / 0.4)',
  // Small raised controls, such as a slider thumb.
  'shadow-control': '0 1px 3px rgb(0 0 0 / 0.3)',

  // overlays migration
  // Text on a solid warning fill (the coffee button): black on amber.
  'color-text-on-warning': '#000000',
  // Floating chrome over the canvas: toasts, the hint bar, the minimap.
  'shadow-float': '0 4px 24px rgb(0 0 0 / 0.5)',

  // core migration
  // Resting fill of a control on an island (buttons, chips, inputs): an
  // overlay in dark, plain white over the light island surface.
  'color-surface-control': 'var(--color-overlay-1)',
};

/** Light theme (`[data-theme="light"]`). Same keys as {@link DARK}. */
export const LIGHT: ThemeTokens = {
  'color-accent': '#af145a',
  'color-accent-subtle': 'rgb(175 20 90 / 0.2)',
  'color-accent-muted': 'rgb(175 20 90 / 0.4)',
  'color-focus-ring': 'var(--color-accent)',
  'color-danger': '#cb0303',
  // 5.6:1 on #f5f5f5; the dark theme's amber is about 2:1 on light.
  'color-warning': '#8a6000',
  // On the light surface the status colors keep 4.5:1 also on their own
  // 10% tint (danger 4.5, warning 4.5, success 5.6, info 5.3).
  'color-danger-subtle':
    'color-mix(in oklab, var(--color-danger) 10%, transparent)',
  'color-warning-subtle':
    'color-mix(in oklab, var(--color-warning) 10%, transparent)',
  'color-success': '#166534',
  'color-success-subtle':
    'color-mix(in oklab, var(--color-success) 10%, transparent)',
  'color-info': '#1d4ed8',
  'color-info-subtle':
    'color-mix(in oklab, var(--color-info) 10%, transparent)',

  'color-text': '#000000',
  'color-text-strong': '#000000',
  // Keeps a hierarchy: 7.8:1 on #f5f5f5, still AAA.
  'color-text-muted': '#4d4d4d',
  'color-text-on-accent': '#ffffff',

  'color-surface-island': '#f5f5f5',
  // 4.5:1 against white.
  'color-border': '#767676',
  'color-border-subtle': 'rgb(0 0 0 / 0.12)',
  // Blends to about #737373 on white: 4.6:1.
  'color-border-input': 'rgb(0 0 0 / 0.55)',
  // The accent at 8% (#184, decision 3).
  'color-hover': 'color-mix(in oklab, var(--color-accent) 8%, transparent)',
  'color-scrim': 'rgb(0 0 0 / 0.25)',
  'color-scrollbar': 'rgb(0 0 0 / 0.2)',

  'color-overlay-1': 'rgb(0 0 0 / 0.15)',
  'color-overlay-2': 'rgb(0 0 0 / 0.25)',
  'color-overlay-3': 'rgb(0 0 0 / 0.4)',
  'color-overlay-4': 'rgb(0 0 0 / 0.6)',

  'color-canvas': CANVAS_BG.light,
  'color-ink-default': DEFAULT_INK.light,

  'shadow-island':
    'inset 1px -1px 2px 0 rgb(0 0 0 / 0.35), inset -1px 1px 3px 0 rgb(255 255 255 / 0.9)',
  'shadow-modal': '0 8px 32px rgb(0 0 0 / 0.16), 0 0 0 1px rgb(0 0 0 / 0.04)',
  // Same as dark for now: the light theme overrides some popovers in
  // theme.css until their areas are migrated.
  'shadow-popover': '0 8px 32px rgb(0 0 0 / 0.4)',
  'shadow-control': '0 1px 3px rgb(0 0 0 / 0.3)',

  // overlays migration
  // White on the dark amber: 5.6:1.
  'color-text-on-warning': '#ffffff',
  'shadow-float': '0 2px 12px rgb(0 0 0 / 0.15)',

  // core migration
  'color-surface-control': '#ffffff',
};

/**
 * Spacing base: every length is `calc(var(--spacing) * N)` with N one of
 * {@link SPACING_STEPS}, as Tailwind v4 compiles `p-N`.
 */
export const SPACING = '0.25rem';

/**
 * Allowed spacing multipliers: Tailwind v4's default scale without the half
 * steps 1.5, 2.5 and 3.5 (6, 10 and 14px), which merge into their
 * neighbours. `px` is a literal 1px hairline.
 */
export const SPACING_STEPS = [
  0, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40,
  44, 48, 52, 56, 60, 64, 72, 80, 96,
] as const;

/** Breakpoints, in rem. CSS cannot read variables in `@media`: write
 * `(width < 40rem)` and keep it in sync with these values. */
export const BREAKPOINTS = {
  sm: '40rem',
  md: '48rem',
  lg: '64rem',
  xl: '80rem',
  '2xl': '96rem',
} as const;

/** The one custom media condition: short viewports (no Tailwind name). */
export const SHORT_VIEWPORT = '(height < 50rem)';

/** Theme-independent tokens (`:root`). Keys are names without `--`. */
export const SHARED: ThemeTokens = {
  spacing: SPACING,

  'text-2xs': '0.6875rem',
  'text-xs': '0.75rem',
  'text-sm': '0.875rem',
  'text-base': '1rem',
  'text-lg': '1.125rem',
  'text-xl': '1.25rem',
  'text-2xl': '1.5rem',
  'text-3xl': '1.875rem',
  'text-4xl': '2.25rem',
  'text-7xl': '4.5rem',

  'font-brand': '"Kode Mono", monospace',
  'font-sans': 'system-ui, -apple-system, sans-serif',
  'font-mono': '"Roboto Mono", ui-monospace, monospace',
  'font-weight-normal': '400',
  'font-weight-medium': '500',
  'font-weight-semibold': '600',
  'font-weight-bold': '700',

  'leading-none': '1',
  'leading-tight': '1.25',
  'leading-snug': '1.375',
  'leading-relaxed': '1.625',

  'radius-sm': '0.25rem',
  'radius-md': '0.375rem',
  'radius-lg': '0.5rem',
  'radius-xl': '0.75rem',
  'radius-2xl': '1rem',
  'radius-full': 'calc(infinity * 1px)',

  'ease-out': 'cubic-bezier(0, 0, 0.2, 1)',
  'ease-out-soft': 'cubic-bezier(0.2, 0.7, 0.2, 1)',
  'duration-fast': '100ms',
  'duration-base': '150ms',
  'duration-slow': '300ms',
  'duration-reveal': '600ms',

  'z-base': '0',
  'z-raised': '10',
  'z-chrome': '50',
  'z-panel': '200',
  'z-popover': '500',
  'z-modal': '1000',
  'z-toast': '10000',

  ...Object.fromEntries(
    Object.entries(BREAKPOINTS).map(([k, v]) => [`breakpoint-${k}`, v]),
  ),
};
