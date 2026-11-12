import type { Command } from '../commands/commands';
import type { Element } from './element';

/** The style of an element that "copy style" carries to other elements. */
export type StyleSnapshot = Omit<
  Extract<Command, { type: 'APPLY_STYLE' }>,
  'type' | 'ids'
>;

/** Captures the style of `el`; keys the element does not set stay absent. */
export function captureStyle(el: Element): StyleSnapshot {
  const values: Record<string, unknown> = {
    strokeColor: el.strokeColor,
    fillColor: el.fillColor,
    strokeWidth: el.strokeWidth,
    opacity: el.opacity,
    roughness: el.roughness,
    strokeStyle: el.strokeStyle,
    lineCap: el.lineCap,
    lineJoin: el.lineJoin,
    shadowBlur: el.shadowBlur,
    shadowColor: el.shadowColor,
    shadowOffsetX: el.shadowOffsetX,
    shadowOffsetY: el.shadowOffsetY,
    ...(el.type === 'rectangle' || el.type === 'rhombus'
      ? { cornerRadius: el.cornerRadius }
      : {}),
  };
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== undefined),
  ) as StyleSnapshot;
}

/** The APPLY_STYLE command that applies `snapshot` to the selection. */
export function applyStyleCommand(snapshot: StyleSnapshot): Command {
  return { type: 'APPLY_STYLE', ...snapshot };
}
