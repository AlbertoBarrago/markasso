import type { ConnectorRouting } from '../elements/element';
import { t } from '../i18n';

/**
 * Presets and icons of the style controls, shared by the context panel and
 * the floating style bar. Labels are read when called, after the locale loads.
 */

/** Swatch presets of the stroke and fill color rows. */
const SHARED_COLOR_PRESETS = [
  '#e2e2ef',
  '#ff6b6b',
  '#6bcb77',
  '#4d96ff',
  '#c77dff',
];
export const FILL_PRESETS = ['transparent', ...SHARED_COLOR_PRESETS];
export const STROKE_PRESETS = FILL_PRESETS;

export interface IconPreset<T> {
  readonly value: T;
  readonly label: string;
  readonly icon: string;
}

export function strokeWidthOptions(): Array<{ value: number; label: string }> {
  return [
    { value: 1, label: t('thin') },
    { value: 3, label: t('medium') },
    { value: 8, label: t('thick') },
  ];
}

export function strokeStyleOptions(): Array<{
  value: 'solid' | 'dashed' | 'dotted';
  label: string;
}> {
  return [
    { value: 'solid', label: t('solid') },
    { value: 'dashed', label: t('dashed') },
    { value: 'dotted', label: t('dotted') },
  ];
}

export function arrowHeadOptions(): IconPreset<
  'none' | 'end' | 'start' | 'both'
>[] {
  return [
    {
      value: 'none',
      label: t('arrowNone'),
      icon: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><line x1="3" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    },
    {
      value: 'end',
      label: t('arrowEnd'),
      icon: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="10" x2="15" y2="10"/><path d="M11 6l4 4-4 4"/></svg>`,
    },
    {
      value: 'start',
      label: t('arrowStart'),
      icon: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="10" x2="17" y2="10"/><path d="M9 6L5 10l4 4"/></svg>`,
    },
    {
      value: 'both',
      label: t('arrowBoth'),
      icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="10" x2="14" y2="10"/><path d="M8 5L3.5 10 8 15"/><path d="M12 5l4.5 5-4.5 5"/></svg>`,
    },
  ];
}

export function routingOptions(): IconPreset<ConnectorRouting>[] {
  return [
    {
      value: 'straight',
      label: t('routingStraight'),
      icon: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="16" x2="16" y2="4"/></svg>`,
    },
    {
      value: 'elbow',
      label: t('routingElbow'),
      icon: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16v-6h12V4"/></svg>`,
    },
  ];
}

export function textAlignOptions(): IconPreset<'left' | 'center' | 'right'>[] {
  return [
    {
      value: 'left',
      label: t('left'),
      icon: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="9" x2="13" y2="9"/><line x1="3" y1="13" x2="17" y2="13"/><line x1="3" y1="17" x2="11" y2="17"/></svg>`,
    },
    {
      value: 'center',
      label: t('center'),
      icon: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><line x1="3" y1="5" x2="17" y2="5"/><line x1="5" y1="9" x2="15" y2="9"/><line x1="3" y1="13" x2="17" y2="13"/><line x1="6" y1="17" x2="14" y2="17"/></svg>`,
    },
    {
      value: 'right',
      label: t('right'),
      icon: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><line x1="3" y1="5" x2="17" y2="5"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="3" y1="13" x2="17" y2="13"/><line x1="9" y1="17" x2="17" y2="17"/></svg>`,
    },
  ];
}

export const FONT_FAMILIES = [
  { label: 'Aa', family: 'Arial, sans-serif', title: 'Arial' },
  { label: 'Ss', family: 'Georgia, serif', title: 'Georgia' },
  { label: 'M_', family: '"Courier New", monospace', title: 'Monospace' },
  { label: 'Ff', family: '"Comic Sans MS", cursive', title: 'Comic Sans' },
];

export const ICON_TO_FRONT = `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="3" x2="17" y2="3"/><polyline points="10,6 10,16"/><polyline points="6,12 10,16 14,12"/></svg>`;
export const ICON_DUPLICATE = `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="9" height="9" rx="1.5"/><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-7A1.5 1.5 0 0 0 3 5.5v7A1.5 1.5 0 0 0 4.5 14H7"/></svg>`;
export const ICON_DELETE = `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6 17,6"/><path d="M8 6V4h4v2"/><rect x="5" y="6" width="10" height="10" rx="1"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="12" y1="10" x2="12" y2="14"/></svg>`;
