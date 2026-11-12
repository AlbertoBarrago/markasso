import { describe, expect, it } from 'vitest';
import type {
  Element,
  EllipseElement,
  LineElement,
  RectangleElement,
} from '../src/elements/element';
import { hitTest } from '../src/tools/select_tool';

const base = {
  strokeColor: '#000',
  fillColor: 'transparent',
  strokeWidth: 1,
  opacity: 1,
  roughness: 0,
} as const;
const viewport = { zoom: 1 };

/** A container drawn after (above) the arrow it encloses. */
const container: RectangleElement = {
  ...base,
  id: 'box',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 400,
  height: 200,
};
const arrow: LineElement = {
  ...base,
  id: 'arrow',
  type: 'line',
  x: 50,
  y: 100,
  x2: 350,
  y2: 100,
  arrowHead: 'end',
};

describe('hitTest', () => {
  it('picks a connector below an unfilled shape when its stroke is hit', () => {
    expect(hitTest([arrow, container], 200, 101, viewport)?.id).toBe('arrow');
  });

  it('keeps the shape when the click is off the connector', () => {
    expect(hitTest([arrow, container], 200, 40, viewport)?.id).toBe('box');
  });

  it('keeps the shape near its outline', () => {
    const edgeArrow: LineElement = { ...arrow, y: 2, y2: 2 };
    expect(hitTest([edgeArrow, container], 200, 2, viewport)?.id).toBe('box');
  });

  it('keeps a filled shape over the connector it hides', () => {
    const filled: RectangleElement = { ...container, fillColor: '#4d96ff' };
    expect(hitTest([arrow, filled], 200, 101, viewport)?.id).toBe('box');
  });

  it('applies to unfilled ellipses too', () => {
    const ellipse: EllipseElement = {
      ...base,
      id: 'ellipse',
      type: 'ellipse',
      x: 0,
      y: 0,
      width: 400,
      height: 200,
    };
    expect(hitTest([arrow, ellipse], 200, 100, viewport)?.id).toBe('arrow');
  });

  it('does not let a non-connector below win over the interior', () => {
    const inner: RectangleElement = {
      ...container,
      id: 'inner',
      x: 150,
      y: 50,
      width: 100,
      height: 100,
    };
    const elements: Element[] = [inner, container];
    expect(hitTest(elements, 200, 100, viewport)?.id).toBe('box');
  });

  it('still picks the topmost connector when it is above', () => {
    expect(hitTest([container, arrow], 200, 100, viewport)?.id).toBe('arrow');
  });
});
