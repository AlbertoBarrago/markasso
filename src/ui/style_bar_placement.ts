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
 * @param selection Rows of the selection box.
 * @param handle Rows of the rotation handle, or null when none is drawn.
 * @param barHeight Height of the bar.
 * @param gap Distance kept between the bar and what it avoids.
 * @param margin Minimum distance from the window's top edge.
 */
export function styleBarTopForSelection(
  selection: VerticalSpan,
  handle: VerticalSpan | null,
  barHeight: number,
  gap: number,
  margin: number,
): number {
  const top = Math.min(selection.top, handle?.top ?? Infinity);
  const bottom = Math.max(selection.bottom, handle?.bottom ?? -Infinity);
  const above = top - gap - barHeight;
  return above < margin ? bottom + gap : above;
}
