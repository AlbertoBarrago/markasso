/** A vertical extent on screen, in pixels. */
export interface VerticalSpan {
  top: number;
  bottom: number;
}

/**
 * The top of the floating style bar placed next to a selection: above
 * everything the selection draws (its box and, when shown, its rotation
 * handle), or below it when the bar would cross the window's top margin.
 * Keeping the handle clear matters: a bar over it leaves no way to rotate.
 *
 * With `windowHeight`, the result is also kept inside the window, and when
 * clamping would push the bar back over the handle (a tall or rotated
 * selection), the other side, then the window's top and bottom edges are
 * tried; the first position that leaves the handle free wins.
 *
 * @param selection Rows of the selection box.
 * @param handle Rows of the rotation handle, or null when none is drawn.
 * @param barHeight Height of the bar.
 * @param gap Distance kept between the bar and what it avoids.
 * @param margin Minimum distance from the window's edges.
 * @param windowHeight Height of the window, to clamp into it.
 */
export function styleBarTopForSelection(
  selection: VerticalSpan,
  handle: VerticalSpan | null,
  barHeight: number,
  gap: number,
  margin: number,
  windowHeight?: number,
): number {
  const top = Math.min(selection.top, handle?.top ?? Infinity);
  const bottom = Math.max(selection.bottom, handle?.bottom ?? -Infinity);
  const above = top - gap - barHeight;
  const below = bottom + gap;
  const preferred = above < margin ? below : above;
  if (windowHeight === undefined) return preferred;

  const maxTop = windowHeight - barHeight - margin;
  const clamp = (t: number) => Math.min(Math.max(margin, t), maxTop);
  const leavesHandle = (t: number) =>
    !handle || t + barHeight <= handle.top || t >= handle.bottom;
  const candidates = [
    preferred,
    preferred === above ? below : above,
    margin,
    maxTop,
  ];
  return candidates.map(clamp).find(leavesHandle) ?? clamp(preferred);
}
