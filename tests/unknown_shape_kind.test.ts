import { describe, expect, it } from 'vitest';
import type { Element, ShapeElement } from '../src/elements/element';
import { getShapeDefinition, SHAPE_DEFINITIONS } from '../src/elements/shapes';
import { isValidSessionCommand } from '../src/io/command_validation';
import { validateElements } from '../src/io/element_validation';
import { drawElement } from '../src/rendering/draw_element';
import { getElementBorderPoint } from '../src/rendering/draw_selection';
import { sceneToSVG } from '../src/rendering/export';
import { shapeKindIcon, shapeKindLabelKey } from '../src/ui/shape_icons';

/**
 * A board written by a newer version, with a flowchart kind this one does
 * not know: it must survive loading and saving, and stay usable.
 */
const newer = {
  id: 'loop',
  type: 'shape',
  kind: 'futureSymbol',
  x: 100,
  y: 50,
  width: 160,
  height: 80,
  strokeColor: '#e2e2ef',
  fillColor: 'transparent',
  strokeWidth: 2,
  opacity: 1,
  roughness: 0,
  label: 'Each order',
} as unknown as ShapeElement;

describe('flowchart kinds from a newer version', () => {
  it('survive validation unchanged, so saving never deletes them', () => {
    const [kept] = validateElements([newer])!;
    expect(kept).toEqual(newer);
    // Saving writes what was loaded: a second pass is identical.
    expect(validateElements(JSON.parse(JSON.stringify([kept])))).toEqual([
      newer,
    ]);
  });

  it('are accepted in live session commands', () => {
    expect(
      isValidSessionCommand({ type: 'CREATE_ELEMENTS', elements: [newer] }),
    ).toBe(true);
  });

  it('get the rectangle geometry, so they stay visible and connectable', () => {
    const def = getShapeDefinition(newer.kind);
    expect(def.outline(160, 80)).toEqual(
      SHAPE_DEFINITIONS.predefinedProcess.outline(160, 80),
    );
    expect(def.textBox(160, 80)).toEqual({ x: 0, y: 0, w: 160, h: 80 });
    // Border point toward the right: the rectangle's right side.
    expect(getElementBorderPoint(newer, 1000, 90)).toEqual([260, 90]);
  });

  it('draw on the canvas as a labeled rectangle', () => {
    // A context that records the calls the renderer makes.
    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        if (prop === 'measureText') return () => ({ width: 10 });
        return (...args: unknown[]) => {
          calls.push(`${prop}(${args.map(String).join(',')})`);
        };
      },
      set(target, prop: string, value) {
        target[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    expect(() => drawElement(ctx, newer, [newer])).not.toThrow();
    expect(calls.some((c) => c.startsWith('fillText(Each order'))).toBe(true);
  });

  it('render and export as a labeled rectangle', () => {
    const svg = sceneToSVG([newer as Element], {
      canvasColor: '#080808',
      withBackground: false,
    })!;
    expect(svg).toContain('Each order');
    // A 160 x 80 rectangle (offset by the export padding).
    expect(svg).toContain('<path d="M 24 24 L 184 24 L 184 104 L 24 104 Z"');
  });

  it('have a generic name and icon in the UI', () => {
    expect(shapeKindLabelKey(newer.kind)).toBe('shapeUnknown');
    expect(shapeKindLabelKey('database')).toBe('shapeDatabase');
    expect(shapeKindIcon(newer.kind)).toContain('<path d="M');
  });
});
