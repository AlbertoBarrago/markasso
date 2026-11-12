import { describe, expect, it } from 'vitest';
import type { ActiveTool } from '../src/core/app_state';
import { createScene, type Scene } from '../src/core/scene';
import type {
  Element,
  LineElement,
  RectangleElement,
  TextElement,
} from '../src/elements/element';
import { getStyleState } from '../src/ui/style_state';

const base = {
  strokeColor: '#ff6b6b',
  fillColor: '#4d96ff',
  strokeWidth: 3,
  opacity: 0.5,
  roughness: 1,
  x: 0,
  y: 0,
} as const;

const rect: RectangleElement = {
  ...base,
  id: 'r',
  type: 'rectangle',
  width: 10,
  height: 10,
  cornerRadius: 8,
};
const line: LineElement = {
  ...base,
  id: 'l',
  type: 'line',
  x2: 10,
  y2: 10,
  arrowHead: 'end',
  endHeadStyle: 'triangle',
  routing: 'elbow',
};
const text: TextElement = {
  ...base,
  id: 't',
  type: 'text',
  content: 'hi',
  fontSize: 24,
  fontFamily: 'Georgia, serif',
  width: 20,
  height: 24,
  textAlign: 'center',
  bold: true,
};

function sceneWith(
  elements: Element[],
  selected: string[],
  activeTool: ActiveTool = 'select',
): Scene {
  const scene = createScene();
  return {
    ...scene,
    elements,
    selectedIds: new Set(selected),
    appState: { ...scene.appState, activeTool },
  };
}

describe('getStyleState', () => {
  it('is null with nothing selected and no drawing tool', () => {
    expect(getStyleState(sceneWith([rect], []))).toBeNull();
  });

  it('reads the first selected element in selection mode', () => {
    const state = getStyleState(sceneWith([rect], ['r']))!;
    expect(state.mode).toBe('selection');
    expect(state.values).toMatchObject({
      strokeColor: '#ff6b6b',
      fillColor: '#4d96ff',
      strokeWidth: 3,
      roughness: 1,
      opacity: 0.5,
      rounded: true,
    });
    expect(state.sections).toMatchObject({
      stroke: true,
      fill: true,
      width: true,
      strokeStyle: true,
      border: true,
      arrowHead: false,
      routing: false,
      text: false,
      actions: true,
      formatPainter: true,
      spatialAlign: false,
    });
  });

  it('shows connector controls for a selected line', () => {
    const state = getStyleState(sceneWith([line], ['l']))!;
    expect(state.sections).toMatchObject({
      arrowHead: true,
      endHead: true,
      startHead: false,
      routing: true,
      lineCap: true,
      fill: false,
    });
    expect(state.values).toMatchObject({
      arrowHead: 'end',
      endHeadStyle: 'triangle',
      routing: 'elbow',
    });
  });

  it('shows text controls only when every selected element is text', () => {
    const textOnly = getStyleState(sceneWith([text], ['t']))!;
    expect(textOnly.strokeIsColor).toBe(true);
    expect(textOnly.sections).toMatchObject({ text: true, width: false });
    expect(textOnly.values).toMatchObject({
      fontSize: 24,
      fontFamily: 'Georgia, serif',
      textAlign: 'center',
    });
    expect(textOnly.values.textFormat.bold).toBe(true);

    const mixed = getStyleState(sceneWith([text, rect], ['t', 'r']))!;
    expect(mixed.sections.text).toBe(false);
    expect(mixed.sections.spatialAlign).toBe(true);
    expect(mixed.sections.formatPainter).toBe(false);
  });

  it('edits label colors when the text tool is active on shapes', () => {
    const state = getStyleState(
      sceneWith([{ ...rect, labelColor: '#c77dff' }], ['r'], 'text'),
    )!;
    expect(state.labelColorMode).toBe(true);
    expect(state.values.strokeColor).toBe('#c77dff');
    expect(state.sections).toMatchObject({ fill: false, width: false });
  });

  it('uses the tool defaults in tool mode', () => {
    const state = getStyleState(sceneWith([], [], 'line'))!;
    expect(state.mode).toBe('tool');
    expect(state.sections).toMatchObject({
      arrowHead: true,
      routing: true,
      fill: false,
      actions: false,
    });
    const textTool = getStyleState(sceneWith([], [], 'text'))!;
    expect(textTool.sections).toMatchObject({
      text: true,
      width: false,
      fill: true,
    });
    expect(textTool.values.fontSize).toBe(20);
  });

  it('reports a fully locked selection', () => {
    const state = getStyleState(sceneWith([{ ...rect, locked: true }], ['r']))!;
    expect(state.values.allLocked).toBe(true);
  });
});
