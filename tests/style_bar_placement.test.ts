import { describe, expect, it } from 'vitest';
import { createViewport } from '../src/core/viewport';
import type { LineElement, RectangleElement } from '../src/elements/element';
import {
  getRotationHandleSpan,
  ROTATION_HANDLE_OFFSET,
  ROTATION_HANDLE_R,
} from '../src/rendering/draw_selection';
import { styleBarTopForSelection } from '../src/ui/style_bar_placement';

function rect(overrides: Partial<RectangleElement> = {}): RectangleElement {
  return {
    id: 'r1',
    type: 'rectangle',
    x: 100,
    y: 200,
    width: 100,
    height: 60,
    strokeColor: '#000',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 1,
    roughness: 0,
    ...overrides,
  };
}

const line: LineElement = {
  id: 'l1',
  type: 'line',
  x: 100,
  y: 200,
  x2: 200,
  y2: 260,
  strokeColor: '#000',
  fillColor: 'transparent',
  strokeWidth: 2,
  opacity: 1,
  roughness: 0,
};

describe('getRotationHandleSpan', () => {
  const vp = createViewport();

  it('covers the handle circle above the selection box', () => {
    const span = getRotationHandleSpan([rect()], vp)!;
    expect(span.top).toBeCloseTo(
      200 - ROTATION_HANDLE_OFFSET - ROTATION_HANDLE_R,
    );
    expect(span.bottom).toBeCloseTo(
      200 - ROTATION_HANDLE_OFFSET + ROTATION_HANDLE_R,
    );
  });

  it('keeps the same screen distance at any zoom', () => {
    const zoomed = { ...vp, zoom: 2 };
    const span = getRotationHandleSpan([rect()], zoomed)!;
    expect(span.top).toBeCloseTo(
      400 - ROTATION_HANDLE_OFFSET - ROTATION_HANDLE_R,
    );
  });

  it('turns with a rotated element (upside down: below the box)', () => {
    const span = getRotationHandleSpan([rect({ rotation: Math.PI })], vp)!;
    expect(span.bottom).toBeCloseTo(
      260 + ROTATION_HANDLE_OFFSET + ROTATION_HANDLE_R,
    );
  });

  it('is null when no handle is drawn', () => {
    expect(getRotationHandleSpan([line], vp)).toBeNull();
    expect(getRotationHandleSpan([rect({ locked: true })], vp)).toBeNull();
  });
});

describe('styleBarTopForSelection', () => {
  const GAP = 12;
  const MARGIN = 8;
  const H = 40;
  const box = { top: 300, bottom: 400 };
  const handleAbove = { top: 259, bottom: 273 };

  it('keeps the plain gap above a selection without a handle', () => {
    expect(styleBarTopForSelection(box, null, H, GAP, MARGIN)).toBe(
      300 - GAP - H,
    );
  });

  it('sits above the rotation handle, not over it', () => {
    const top = styleBarTopForSelection(box, handleAbove, H, GAP, MARGIN);
    expect(top).toBe(259 - GAP - H);
    expect(top + H).toBeLessThanOrEqual(handleAbove.top - GAP);
  });

  it('goes below when the handle leaves no room above', () => {
    // Room for the bar above the box alone, not above the handle too.
    const nearTop = { top: 70, bottom: 170 };
    const handle = { top: 29, bottom: 43 };
    expect(styleBarTopForSelection(nearTop, null, H, GAP, MARGIN)).toBe(18);
    expect(styleBarTopForSelection(nearTop, handle, H, GAP, MARGIN)).toBe(
      170 + GAP,
    );
  });

  it('goes below a handle turned under the box', () => {
    const nearTop = { top: 20, bottom: 120 };
    const handleBelow = { top: 147, bottom: 161 };
    expect(styleBarTopForSelection(nearTop, handleBelow, H, GAP, MARGIN)).toBe(
      161 + GAP,
    );
  });
});
