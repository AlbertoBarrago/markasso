import {
  ARROW_HEAD_STYLES,
  type Element,
  SHAPE_KINDS,
} from '../elements/element';
import type { History } from '../engine/history';
import { t } from '../i18n';
import { getElementBounds } from '../rendering/draw_selection';
import {
  ARROW_HEAD_STYLE_LABEL_KEYS,
  arrowHeadStyleIcon,
} from './arrow_head_icons';
import {
  bindUndoTransaction,
  createColorPicker,
  loadCustomColor,
  saveCustomColor,
  strokeSwatchPreview,
  updateCustomColorButton,
} from './color_picker';
import { SHAPE_KIND_LABEL_KEYS, shapeKindIcon } from './shape_icons';
import {
  applyFontSize,
  applyStrokeOrLabelColor,
  deleteSelection,
  duplicateSelection,
  isSwatchActive,
  type LayerMove,
  reorderSelection,
  toggleSelectionLock,
  toggleTextFormat,
} from './style_actions';
import { isFloatingStyleControls } from './style_controls_mode';
import {
  arrowHeadOptions,
  FILL_PRESETS,
  FONT_FAMILIES,
  ICON_DELETE,
  ICON_DUPLICATE,
  ICON_TO_FRONT,
  routingOptions,
  STROKE_PRESETS,
  strokeStyleOptions,
  strokeWidthOptions,
  textAlignOptions,
} from './style_presets';
import {
  getStyleState,
  hasShapeLabel,
  type StyleState,
  selectedElements,
} from './style_state';

/** Lets other style surfaces (the floating bar) drive the context panel. */
export interface ContextPanelHandle {
  /**
   * With the floating style bar on, opens the full panel for the current
   * selection or tool (More... in the bar), or closes it when already open.
   */
  toggleFull(): void;
  /** Re-reads the style controls setting. */
  refresh(): void;
}

export function initContextPanel(
  workspace: HTMLElement,
  history: History,
  onFormatPainter?: (source: Element) => void,
): ContextPanelHandle {
  const panel = document.createElement('div');
  panel.id = 'context-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Context panel');
  workspace.appendChild(panel);

  panel.innerHTML = `
    <div class="cp-section" id="cp-shape-kind-section">
      <div class="cp-label">${t('shapeKind')}</div>
      <div class="cp-btn-row" id="cp-shape-kind-presets" role="group" aria-label="${t('shapeKind')}"></div>
    </div>

    <div class="cp-section">
      <div class="cp-label">${t('fill')}</div>
      <div class="cp-color-row" role="group" aria-label="${t('fill')}">
        <div class="cp-color-swatches" id="cp-fill-swatches"></div>
        <button class="cp-color-more" id="cp-fill-more" title="${t('moreColors')}">+</button>
      </div>
    </div>

    <div class="cp-section">
      <div class="cp-label">${t('stroke')}</div>
      <div class="cp-color-row" role="group" aria-label="${t('stroke')}">
        <div class="cp-color-swatches" id="cp-stroke-swatches"></div>
        <button class="cp-color-more" id="cp-stroke-more" title="${t('moreColors')}">+</button>
      </div>
    </div>

    <div class="cp-section">
      <div class="cp-label">${t('strokeWidth')}</div>
      <div class="cp-btn-row" id="cp-width-presets" role="group" aria-label="${t('strokeWidth')}"></div>
    </div>

    <div class="cp-section">
      <div class="cp-label">${t('strokeStyle')}</div>
      <div class="cp-btn-row" id="cp-style-presets" role="group" aria-label="${t('strokeStyle')}"></div>
    </div>

    <div class="cp-section" id="cp-linecap-section">
      <div class="cp-label">${t('lineCap')}</div>
      <div class="cp-btn-row" id="cp-linecap-presets" role="group" aria-label="${t('lineCap')}"></div>
    </div>

    <div class="cp-section" id="cp-arrowhead-section">
      <div class="cp-label">${t('arrowHead')}</div>
      <div class="cp-btn-row" id="cp-arrowhead-presets" role="group" aria-label="${t('arrowHead')}"></div>
    </div>

    <div class="cp-section" id="cp-start-head-section">
      <div class="cp-label">${t('startHead')}</div>
      <div class="cp-btn-row cp-head-style-row" id="cp-start-head-presets" role="group" aria-label="${t('startHead')}"></div>
    </div>

    <div class="cp-section" id="cp-end-head-section">
      <div class="cp-label">${t('endHead')}</div>
      <div class="cp-btn-row cp-head-style-row" id="cp-end-head-presets" role="group" aria-label="${t('endHead')}"></div>
    </div>

    <div class="cp-section" id="cp-routing-section">
      <div class="cp-label">${t('routing')}</div>
      <div class="cp-btn-row" id="cp-routing-presets" role="group" aria-label="${t('routing')}"></div>
    </div>

    <div class="cp-section">
      <div class="cp-label">${t('roughness')}</div>
      <div class="cp-btn-row" id="cp-roughness-presets" role="group" aria-label="${t('roughness')}"></div>
    </div>

    <div class="cp-section">
      <div class="cp-label">${t('corners')}</div>
      <div class="cp-btn-row" id="cp-border-presets" role="group" aria-label="${t('corners')}"></div>
    </div>

    <div class="cp-section" id="cp-text-props">
      <div class="cp-label">${t('mode')}</div>
      <div class="cp-btn-row" id="cp-textmode-presets" role="group" aria-label="${t('mode')}"></div>
      <div class="cp-label" style="margin-top:4px">${t('fontSize')}</div>
      <div class="cp-font-size-row">
        <input type="number" id="cp-font-size" min="6" max="400" step="1" class="cp-font-size-input" />
      </div>
      <div class="cp-label" style="margin-top:4px">${t('fontFamily')}</div>
      <div class="cp-btn-row" id="cp-font-family-presets" role="group" aria-label="${t('fontFamily')}"></div>
      <div class="cp-label" style="margin-top:4px">${t('style')}</div>
      <div class="cp-btn-row" id="cp-text-format" role="group" aria-label="${t('style')}"></div>
      <div class="cp-label" style="margin-top:4px">${t('alignment')}</div>
      <div class="cp-btn-row" id="cp-align-presets" role="group" aria-label="${t('alignment')}"></div>
    </div>

    <div class="cp-section">
      <div class="cp-label">${t('opacity')}</div>
      <div class="cp-slider-row">
        <input type="range" min="0" max="100" step="1" class="cp-slider" id="cp-opacity" />
      </div>
      <div class="cp-slider-labels">
        <span>0</span>
        <span class="cp-slider-val" id="cp-opacity-val">100</span>
        <span>100</span>
      </div>
    </div>

    <div class="cp-section" id="cp-spatial-align-section">
      <div class="cp-label">${t('alignment')}</div>
      <div class="cp-btn-row" id="cp-spatial-align-actions" role="group" aria-label="${t('alignment')}"></div>
    </div>

    <div class="cp-section">
      <div class="cp-label">${t('layers')}</div>
      <div class="cp-btn-row" id="cp-layer-actions" role="group" aria-label="${t('layers')}"></div>
    </div>

    <div class="cp-section">
      <div class="cp-label">${t('actions')}</div>
      <div class="cp-btn-row" id="cp-actions" role="group" aria-label="${t('actions')}"></div>
    </div>
  `;

  // ── Custom color state (one slot per row, persisted) ──────────────────────
  let customStroke: string | null = loadCustomColor('stroke');
  let customFill: string | null = loadCustomColor('fill');

  const colorPicker = createColorPicker({
    history,
    labels: {
      color: t('color'),
      shades: t('shades'),
      hexCode: t('hexCode'),
      transparent: t('transparent'),
    },
    position: (_anchor, popup) => {
      const panelRect = panel.getBoundingClientRect();
      const popupWidth = popup.offsetWidth;
      const popupHeight = popup.offsetHeight;
      let left = panelRect.right + 8;
      if (left + popupWidth > window.innerWidth - 8) {
        left = panelRect.left - popupWidth - 8;
      }
      if (left < 8) left = 8;
      let top = panelRect.top;
      if (top + popupHeight > window.innerHeight - 8) {
        top = window.innerHeight - popupHeight - 8;
      }
      if (top < 8) top = 8;
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
    },
  });

  function dispatchStrokeOrLabelColor(color: string): void {
    applyStrokeOrLabelColor(history, color);
  }

  function currentStrokeOrLabelColor(): string {
    const scene = history.present;
    const labelTarget =
      scene.appState.activeTool === 'text'
        ? selectedElements(scene).find(hasShapeLabel)
        : undefined;
    if (labelTarget) return labelTarget.labelColor ?? labelTarget.strokeColor;
    return scene.appState.strokeColor;
  }

  // ── Stroke swatches ────────────────────────────────────────────────────────
  const strokeSwatches = panel.querySelector('#cp-stroke-swatches')!;
  for (const color of STROKE_PRESETS) {
    const sw = document.createElement('button');
    sw.className = 'cp-color-swatch';
    const swLabel = color === 'transparent' ? t('transparent') : color;
    sw.title = swLabel;
    sw.setAttribute('aria-label', swLabel);
    sw.setAttribute('aria-pressed', 'false');
    sw.dataset.color = color;
    if (color === 'transparent') {
      sw.classList.add('cp-color-swatch-transparent');
    } else {
      sw.style.background = strokeSwatchPreview(color);
    }
    sw.addEventListener('click', () => dispatchStrokeOrLabelColor(color));
    strokeSwatches.appendChild(sw);
  }

  const strokeMore = panel.querySelector<HTMLButtonElement>('#cp-stroke-more')!;
  updateCustomColorButton(strokeMore, customStroke, t('moreColors'));
  strokeMore.addEventListener('click', () => {
    const currentColor =
      customStroke ??
      currentStrokeOrLabelColor() ??
      STROKE_PRESETS[1] ??
      '#e2e2ef';
    colorPicker.open(strokeMore, currentColor, ({ pick, preview }) => {
      if (preview) {
        dispatchStrokeOrLabelColor(preview);
      }
      if (pick) {
        if (pick === 'transparent') {
          customStroke = null;
          saveCustomColor('stroke', null);
          updateCustomColorButton(strokeMore, null, t('moreColors'));
        } else {
          customStroke = pick;
          saveCustomColor('stroke', pick);
          updateCustomColorButton(strokeMore, pick, t('moreColors'));
          dispatchStrokeOrLabelColor(pick);
        }
      }
    });
  });

  // ── Fill swatches ──────────────────────────────────────────────────────────
  const fillSwatches = panel.querySelector('#cp-fill-swatches')!;
  for (const color of FILL_PRESETS) {
    const sw = document.createElement('button');
    sw.className = 'cp-color-swatch';
    const swLabel = color === 'transparent' ? t('transparent') : color;
    sw.title = swLabel;
    sw.setAttribute('aria-label', swLabel);
    sw.setAttribute('aria-pressed', 'false');
    sw.dataset.color = color;
    if (color === 'transparent') {
      sw.classList.add('cp-color-swatch-transparent');
    } else {
      sw.style.background = color;
    }
    sw.addEventListener('click', () => {
      history.dispatch({ type: 'APPLY_STYLE', fillColor: color });
    });
    fillSwatches.appendChild(sw);
  }

  const fillMore = panel.querySelector<HTMLButtonElement>('#cp-fill-more')!;
  updateCustomColorButton(fillMore, customFill, t('moreColors'));
  fillMore.addEventListener('click', () => {
    const currentColor =
      customFill ??
      history.present.appState.fillColor ??
      FILL_PRESETS[1] ??
      '#ffffff';
    const base = currentColor === 'transparent' ? '#ffffff' : currentColor;
    colorPicker.open(fillMore, base, ({ pick, preview }) => {
      if (preview) {
        history.dispatch({ type: 'APPLY_STYLE', fillColor: preview });
      }
      if (pick) {
        if (pick === 'transparent') {
          customFill = null;
          saveCustomColor('fill', null);
          updateCustomColorButton(fillMore, null, t('moreColors'));
        } else {
          customFill = pick;
          saveCustomColor('fill', pick);
          updateCustomColorButton(fillMore, pick, t('moreColors'));
          history.dispatch({ type: 'APPLY_STYLE', fillColor: pick });
        }
      }
    });
  });

  // ── Width presets ──────────────────────────────────────────────────────────
  const widthPresets = panel.querySelector('#cp-width-presets')!;
  const WIDTHS = strokeWidthOptions();
  for (const w of WIDTHS) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-width-btn';
    btn.title = w.label;
    btn.dataset.value = String(w.value);
    btn.addEventListener('click', () => {
      history.dispatch({ type: 'APPLY_STYLE', strokeWidth: w.value });
    });
    widthPresets.appendChild(btn);
  }
  const widthInput = document.createElement('input');
  widthInput.type = 'number';
  widthInput.min = '1';
  widthInput.max = '100';
  widthInput.step = '1';
  widthInput.className = 'cp-font-size-input';
  widthInput.style.width = '52px';
  let widthDisplay: HTMLDivElement | null = null;
  if (widthInput.type !== 'number') {
    widthDisplay = document.createElement('div');
    widthDisplay.setAttribute('aria-live', 'polite');
    widthDisplay.className = 'cp-width-display';
    widthPresets.appendChild(widthDisplay);
  } else {
    widthInput.addEventListener('change', () => {
      const v = Math.max(
        1,
        Math.min(100, Math.round(Number(widthInput.value))),
      );
      widthInput.value = String(v);
      history.dispatch({ type: 'APPLY_STYLE', strokeWidth: v });
    });
    widthPresets.appendChild(widthInput);
  }

  // ── Style presets ──────────────────────────────────────────────────────────
  const stylePresets = panel.querySelector('#cp-style-presets')!;
  const STYLES = strokeStyleOptions();
  for (const s of STYLES) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-style-btn';
    btn.title = s.label;
    btn.dataset.style = s.value;
    btn.addEventListener('click', () => {
      history.dispatch({
        type: 'APPLY_STYLE',
        strokeStyle: s.value as 'solid' | 'dashed' | 'dotted',
      });
    });
    stylePresets.appendChild(btn);
  }

  // ── Line cap presets ───────────────────────────────────────────────────────
  const lineCapPresets = panel.querySelector('#cp-linecap-presets')!;
  const LINE_CAPS: Array<{
    value: 'butt' | 'round' | 'square';
    label: string;
    icon: string;
  }> = [
    {
      value: 'butt',
      label: t('capButt'),
      icon: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><line x1="4" y1="10" x2="16" y2="10" stroke="currentColor" stroke-width="4" stroke-linecap="butt"/><line x1="4" y1="5" x2="4" y2="15" stroke="currentColor" stroke-width="1.2" opacity="0.4"/><line x1="16" y1="5" x2="16" y2="15" stroke="currentColor" stroke-width="1.2" opacity="0.4"/></svg>`,
    },
    {
      value: 'round',
      label: t('capRound'),
      icon: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><line x1="4" y1="10" x2="16" y2="10" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`,
    },
    {
      value: 'square',
      label: t('capSquare'),
      icon: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><line x1="5" y1="10" x2="15" y2="10" stroke="currentColor" stroke-width="4" stroke-linecap="square"/></svg>`,
    },
  ];
  for (const c of LINE_CAPS) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-linecap-btn';
    btn.title = c.label;
    btn.setAttribute('aria-label', c.label);
    btn.innerHTML = c.icon;
    btn.dataset.cap = c.value;
    btn.addEventListener('click', () => {
      history.dispatch({ type: 'APPLY_STYLE', lineCap: c.value });
    });
    lineCapPresets.appendChild(btn);
  }

  // ── Arrowhead presets ─────────────────────────────────────────────────────
  const arrowHeadPresets = panel.querySelector('#cp-arrowhead-presets')!;
  const ARROW_HEADS = arrowHeadOptions();
  for (const ah of ARROW_HEADS) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-arrowhead-btn';
    btn.title = ah.label;
    btn.setAttribute('aria-label', ah.label);
    btn.innerHTML = ah.icon;
    btn.dataset.arrowhead = ah.value;
    btn.addEventListener('click', () => {
      history.dispatch({ type: 'APPLY_STYLE', arrowHead: ah.value });
    });
    arrowHeadPresets.appendChild(btn);
  }

  // ── Arrowhead styles (per end) ────────────────────────────────────────────
  for (const placement of ['start', 'end'] as const) {
    const row = panel.querySelector(`#cp-${placement}-head-presets`)!;
    for (const style of ARROW_HEAD_STYLES) {
      const label = t(ARROW_HEAD_STYLE_LABEL_KEYS[style]);
      const btn = document.createElement('button');
      btn.className = 'cp-btn cp-head-style-btn';
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.innerHTML = arrowHeadStyleIcon(style, placement);
      btn.dataset.value = style;
      btn.addEventListener('click', () => {
        history.dispatch(
          placement === 'start'
            ? { type: 'APPLY_STYLE', startHeadStyle: style }
            : { type: 'APPLY_STYLE', endHeadStyle: style },
        );
      });
      row.appendChild(btn);
    }
  }

  // ── Connector routing ─────────────────────────────────────────────────────
  const routingPresets = panel.querySelector('#cp-routing-presets')!;
  const ROUTINGS = routingOptions();
  for (const r of ROUTINGS) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-routing-btn';
    btn.title = r.label;
    btn.setAttribute('aria-label', r.label);
    btn.innerHTML = r.icon;
    btn.dataset.value = r.value;
    btn.addEventListener('click', () => {
      history.dispatch({ type: 'APPLY_STYLE', routing: r.value });
    });
    routingPresets.appendChild(btn);
  }

  // ── Flowchart shape kind ──────────────────────────────────────────────────
  // With shapes selected the kind is restyled in place (undoable); in tool
  // mode it only changes what the shape tool draws next.
  const shapeKindPresets = panel.querySelector('#cp-shape-kind-presets')!;
  for (const kind of SHAPE_KINDS) {
    const label = t(SHAPE_KIND_LABEL_KEYS[kind]);
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-shape-kind-btn';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = shapeKindIcon(kind);
    btn.dataset.value = kind;
    btn.addEventListener('click', () => {
      const hasSelectedShape = selectedElements(history.present).some(
        (el) => el.type === 'shape',
      );
      if (hasSelectedShape) {
        history.dispatch({ type: 'APPLY_STYLE', shapeKind: kind });
      } else {
        history.dispatch({ type: 'SET_TOOL', tool: 'shape', shapeKind: kind });
      }
    });
    shapeKindPresets.appendChild(btn);
  }

  // ── Roughness presets ──────────────────────────────────────────────────────
  const roughnessPresets = panel.querySelector('#cp-roughness-presets')!;
  const ROUGHNESS = [
    { value: 0, label: t('smooth') },
    { value: 0.5, label: t('medium') },
    { value: 1, label: t('rough') },
  ];
  for (const r of ROUGHNESS) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-roughness-btn';
    btn.title = r.label;
    btn.dataset.roughness = String(r.value);
    btn.addEventListener('click', () => {
      history.dispatch({ type: 'APPLY_STYLE', roughness: r.value });
    });
    roughnessPresets.appendChild(btn);
  }

  // ── Border presets ─────────────────────────────────────────────────────────
  const borderPresets = panel.querySelector('#cp-border-presets')!;
  const BORDERS = [
    { value: 'sharp', label: t('sharp') },
    { value: 'rounded', label: t('rounded') },
  ];
  for (const b of BORDERS) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-border-btn';
    btn.title = b.label;
    btn.dataset.border = b.value;
    btn.addEventListener('click', () => {
      history.dispatch({
        type: 'APPLY_STYLE',
        cornerRadius: b.value === 'rounded' ? 8 : 0,
      });
    });
    borderPresets.appendChild(btn);
  }

  // ── Font size input ────────────────────────────────────────────────────────
  const fontSizeInput = panel.querySelector<HTMLInputElement>('#cp-font-size')!;
  fontSizeInput.addEventListener('focus', () => fontSizeInput.select());
  fontSizeInput.addEventListener('change', () => {
    applyFontSize(history, parseInt(fontSizeInput.value, 10));
  });
  fontSizeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fontSizeInput.blur();
  });

  // ── Font family presets ────────────────────────────────────────────────────
  const fontFamilyPresets = panel.querySelector('#cp-font-family-presets')!;
  for (const f of FONT_FAMILIES) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-font-family-btn';
    btn.title = f.title;
    btn.textContent = f.label;
    btn.style.fontFamily = f.family;
    btn.dataset.family = f.family;
    btn.addEventListener('click', () => {
      history.dispatch({ type: 'SET_FONT_FAMILY', family: f.family });
    });
    fontFamilyPresets.appendChild(btn);
  }

  // ── Text mode toggle ───────────────────────────────────────────────────────
  const textModePresets = panel.querySelector('#cp-textmode-presets')!;
  const TEXT_MODES: { value: 'text' | 'code'; label: string; icon: string }[] =
    [
      {
        value: 'text',
        label: t('text'),
        icon: `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M3 4h14v2.5H12v9.5H8V6.5H3z"/></svg>`,
      },
      {
        value: 'code',
        label: t('code'),
        icon: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6L3 10l4 4"/><path d="M13 6l4 4-4 4"/></svg>`,
      },
    ];
  for (const m of TEXT_MODES) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn';
    btn.title = m.label;
    btn.innerHTML = m.icon;
    btn.dataset.mode = m.value;
    btn.addEventListener('click', () => {
      history.dispatch({ type: 'SET_TEXT_MODE', mode: m.value });
    });
    textModePresets.appendChild(btn);
  }

  // ── Text format buttons (bold / italic / underline / strikethrough) ────────
  const textFormatRow = panel.querySelector('#cp-text-format')!;
  const TEXT_FORMATS: Array<{
    key: 'bold' | 'italic' | 'underline' | 'strikethrough';
    label: string;
    html: string;
  }> = [
    { key: 'bold', label: t('bold'), html: '<strong>B</strong>' },
    { key: 'italic', label: t('italic'), html: '<em>I</em>' },
    {
      key: 'underline',
      label: t('underline'),
      html: '<span style="text-decoration:underline">U</span>',
    },
    {
      key: 'strikethrough',
      label: t('strikethrough'),
      html: '<span style="text-decoration:line-through">S</span>',
    },
  ];
  for (const f of TEXT_FORMATS) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-text-fmt-btn';
    btn.title = f.label;
    btn.innerHTML = f.html;
    btn.dataset.fmt = f.key;
    btn.addEventListener('click', () => toggleTextFormat(history, f.key));
    textFormatRow.appendChild(btn);
  }

  // ── Align presets ──────────────────────────────────────────────────────────
  const alignPresets = panel.querySelector('#cp-align-presets')!;
  const ALIGNS = textAlignOptions();
  for (const a of ALIGNS) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-align-btn';
    btn.title = a.label;
    btn.innerHTML = a.icon;
    btn.dataset.align = a.value;
    btn.addEventListener('click', () => {
      history.dispatch({ type: 'APPLY_STYLE', textAlign: a.value });
    });
    alignPresets.appendChild(btn);
  }

  // ── Opacity slider ─────────────────────────────────────────────────────────
  const opacitySlider = panel.querySelector<HTMLInputElement>('#cp-opacity')!;
  const opacityVal = panel.querySelector('#cp-opacity-val')!;
  bindUndoTransaction(opacitySlider, history);
  opacitySlider.addEventListener('input', () => {
    opacityVal.textContent = opacitySlider.value;
    history.dispatch({
      type: 'APPLY_STYLE',
      opacity: Number(opacitySlider.value) / 100,
    });
  });

  // ── Spatial alignment actions (multi-select) ──────────────────────────────
  const spatialAlignActions = panel.querySelector('#cp-spatial-align-actions')!;
  type SpatialAlignment =
    | 'left'
    | 'center-h'
    | 'right'
    | 'top'
    | 'middle-v'
    | 'bottom';
  const SPATIAL_ALIGNS: {
    value: SpatialAlignment;
    label: string;
    icon: string;
  }[] = [
    {
      value: 'left',
      label: t('left'),
      icon: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="2" x2="3" y2="18"/><rect x="5" y="5" width="6" height="4" rx="1"/><rect x="5" y="11" width="10" height="4" rx="1"/></svg>`,
    },
    {
      value: 'center-h',
      label: t('center'),
      icon: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="2" x2="10" y2="18"/><rect x="4" y="5" width="12" height="4" rx="1"/><rect x="6" y="11" width="8" height="4" rx="1"/></svg>`,
    },
    {
      value: 'right',
      label: t('right'),
      icon: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="2" x2="17" y2="18"/><rect x="9" y="5" width="6" height="4" rx="1"/><rect x="5" y="11" width="10" height="4" rx="1"/></svg>`,
    },
    {
      value: 'top',
      label: 'Top',
      icon: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="3" x2="18" y2="3"/><rect x="5" y="5" width="4" height="6" rx="1"/><rect x="11" y="5" width="4" height="10" rx="1"/></svg>`,
    },
    {
      value: 'middle-v',
      label: 'Middle',
      icon: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="10" x2="18" y2="10"/><rect x="5" y="4" width="4" height="12" rx="1"/><rect x="11" y="6" width="4" height="8" rx="1"/></svg>`,
    },
    {
      value: 'bottom',
      label: 'Bottom',
      icon: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="17" x2="18" y2="17"/><rect x="5" y="9" width="4" height="6" rx="1"/><rect x="11" y="5" width="4" height="10" rx="1"/></svg>`,
    },
  ];
  for (const sa of SPATIAL_ALIGNS) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-spatial-align-btn';
    btn.title = sa.label;
    btn.innerHTML = sa.icon;
    btn.dataset.spatialAlign = sa.value;
    btn.addEventListener('click', () => {
      const scene = history.present;
      const elements = scene.elements.filter(
        (el) => scene.selectedIds.has(el.id) && !el.locked,
      );
      if (elements.length < 2) return;

      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const el of elements) {
        const b = getElementBounds(el);
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
      }

      const moves = elements.map((el) => {
        const b = getElementBounds(el);
        let newX = el.x;
        let newY = el.y;
        switch (sa.value) {
          case 'left':
            newX = el.x + (minX - b.x);
            break;
          case 'center-h':
            newX = el.x + ((minX + maxX) / 2 - (b.x + b.w / 2));
            break;
          case 'right':
            newX = el.x + (maxX - (b.x + b.w));
            break;
          case 'top':
            newY = el.y + (minY - b.y);
            break;
          case 'middle-v':
            newY = el.y + ((minY + maxY) / 2 - (b.y + b.h / 2));
            break;
          case 'bottom':
            newY = el.y + (maxY - (b.y + b.h));
            break;
        }
        return { id: el.id, x: newX, y: newY };
      });

      history.dispatch({ type: 'ALIGN_ELEMENTS', moves });
    });
    spatialAlignActions.appendChild(btn);
  }

  // ── Layer actions ──────────────────────────────────────────────────────────
  const layerActions = panel.querySelector('#cp-layer-actions')!;
  const LAYERS: Array<{ icon: string; label: string; action: LayerMove }> = [
    {
      icon: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="17" x2="17" y2="17"/><polyline points="10,14 10,4"/><polyline points="6,8 10,4 14,8"/><line x1="3" y1="17" x2="17" y2="17"/></svg>`,
      label: t('toBack'),
      action: 'back',
    },
    {
      icon: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="4" x2="10" y2="16"/><polyline points="6,12 10,16 14,12"/></svg>`,
      label: t('backward'),
      action: 'backward',
    },
    {
      icon: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="16" x2="10" y2="4"/><polyline points="6,8 10,4 14,8"/></svg>`,
      label: t('forward'),
      action: 'forward',
    },
    {
      icon: ICON_TO_FRONT,
      label: t('toFront'),
      action: 'front',
    },
  ];
  for (const l of LAYERS) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-layer-btn';
    btn.innerHTML = l.icon;
    btn.title = l.label;
    btn.dataset.layer = l.action;
    btn.addEventListener('click', () => reorderSelection(history, l.action));
    layerActions.appendChild(btn);
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  const actions = panel.querySelector('#cp-actions')!;
  const ACTIONS = [
    {
      icon: ICON_DUPLICATE,
      label: t('duplicate'),
      action: 'duplicate',
    },
    {
      icon: ICON_DELETE,
      label: t('delete'),
      action: 'delete',
    },
  ];
  for (const a of ACTIONS) {
    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-action-btn';
    btn.innerHTML = a.icon;
    btn.title = a.label;
    btn.dataset.action = a.action;
    btn.addEventListener('click', () => {
      if (a.action === 'duplicate') duplicateSelection(history);
      else deleteSelection(history);
    });
    actions.appendChild(btn);
  }

  // ── Format painter button (single-selection only) ──────────────────────────
  const formatPainterBtn = document.createElement('button');
  formatPainterBtn.className = 'cp-btn cp-action-btn';
  formatPainterBtn.id = 'cp-format-painter';
  formatPainterBtn.title = t('formatPainter');
  formatPainterBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h8a3 3 0 0 1 0 6H8"/><polyline points="8,7 8,17"/><line x1="6" y1="17" x2="10" y2="17"/></svg>`;
  formatPainterBtn.addEventListener('click', () => {
    const scene = history.present;
    const ids = [...scene.selectedIds];
    if (ids.length !== 1) return;
    const el = scene.elements.find((e) => e.id === ids[0]);
    if (!el) return;
    onFormatPainter?.(el);
  });
  actions.appendChild(formatPainterBtn);

  // ── Lock / Unlock button ───────────────────────────────────────────────────
  const lockBtn = document.createElement('button');
  lockBtn.className = 'cp-btn cp-action-btn';
  lockBtn.id = 'cp-lock-btn';
  const LOCK_ICON = `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="9" width="10" height="8" rx="1.5"/><path d="M7 9V6a3 3 0 0 1 6 0v3"/></svg>`;
  const UNLOCK_ICON = `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="9" width="10" height="8" rx="1.5"/><path d="M7 9V6a3 3 0 0 1 6 0"/></svg>`;
  lockBtn.innerHTML = LOCK_ICON;
  lockBtn.title = t('lockElements');
  lockBtn.addEventListener('click', () => toggleSelectionLock(history));
  actions.appendChild(lockBtn);

  const strokeSection = strokeSwatches.parentElement!.parentElement!;
  const fillSection = fillSwatches.parentElement!.parentElement!;
  const textPropsSection = panel.querySelector<HTMLElement>('#cp-text-props')!;

  /** Shows or hides the section that holds `#<rowId>`. */
  function showSection(rowId: string, visible: boolean): void {
    panel.querySelector<HTMLElement>(`#${rowId}`)!
      .parentElement!.style.display = visible ? '' : 'none';
  }

  /**
   * Marks as active (and aria-pressed) the buttons of `#<rowId>` whose
   * `data-<key>` equals `value`.
   */
  function markActive(rowId: string, key: string, value: string): void {
    const row = panel.querySelector<HTMLElement>(`#${rowId}`)!;
    row.querySelectorAll<HTMLButtonElement>('.cp-btn').forEach((btn) => {
      const on = btn.dataset[key] === value;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  /** Marks the swatch (or the custom color button) matching `current`. */
  function markSwatches(
    swatches: ParentNode,
    more: HTMLButtonElement,
    custom: string | null,
    current: string,
  ): void {
    swatches
      .querySelectorAll<HTMLButtonElement>('.cp-color-swatch')
      .forEach((sw) => {
        const on = isSwatchActive(sw.dataset.color ?? '', current);
        sw.classList.toggle('active', on);
        sw.setAttribute('aria-pressed', String(on));
      });
    const customOn = !!custom && isSwatchActive(custom, current);
    more.classList.toggle('active', customOn);
    more.setAttribute('aria-pressed', String(customOn));
  }

  // ── Sync panel ─────────────────────────────────────────────────────────────
  /** With the floating style bar on, More... asked for the full panel. */
  let fullRequested = false;

  function render(state: StyleState): void {
    const { sections: show, values } = state;
    // The floating bar can change the custom color slots too.
    customStroke = loadCustomColor('stroke');
    customFill = loadCustomColor('fill');
    updateCustomColorButton(strokeMore, customStroke, t('moreColors'));
    updateCustomColorButton(fillMore, customFill, t('moreColors'));

    markSwatches(strokeSwatches, strokeMore, customStroke, values.strokeColor);
    markSwatches(fillSwatches, fillMore, customFill, values.fillColor);
    markActive('cp-width-presets', 'value', String(values.strokeWidth));
    if (widthDisplay) widthDisplay.textContent = `${values.strokeWidth}px`;
    else widthInput.value = String(values.strokeWidth);
    markActive('cp-style-presets', 'style', values.strokeStyle);
    markActive('cp-roughness-presets', 'roughness', String(values.roughness));
    markActive('cp-linecap-presets', 'cap', values.lineCap);
    markActive('cp-arrowhead-presets', 'arrowhead', values.arrowHead);
    markActive(
      'cp-border-presets',
      'border',
      values.rounded ? 'rounded' : 'sharp',
    );
    markActive('cp-start-head-presets', 'value', values.startHeadStyle);
    markActive('cp-end-head-presets', 'value', values.endHeadStyle);
    markActive('cp-routing-presets', 'value', values.routing);
    markActive('cp-shape-kind-presets', 'value', values.shapeKind ?? '');
    opacitySlider.value = String(Math.round(values.opacity * 100));
    opacityVal.textContent = String(Math.round(values.opacity * 100));

    strokeSection.style.display = show.stroke ? '' : 'none';
    (strokeSection.querySelector('.cp-label') as HTMLElement).textContent =
      state.strokeIsColor ? t('color') : t('stroke');
    fillSection.style.display = show.fill ? '' : 'none';
    showSection('cp-width-presets', show.width);
    showSection('cp-style-presets', show.strokeStyle);
    showSection('cp-roughness-presets', show.strokeStyle);
    showSection('cp-linecap-presets', show.lineCap);
    showSection('cp-arrowhead-presets', show.arrowHead);
    showSection('cp-start-head-presets', show.startHead);
    showSection('cp-end-head-presets', show.endHead);
    showSection('cp-routing-presets', show.routing);
    showSection('cp-border-presets', show.border);
    showSection('cp-shape-kind-presets', show.shapeKind);
    showSection('cp-spatial-align-actions', show.spatialAlign);
    showSection('cp-actions', show.actions);
    formatPainterBtn.style.display = show.formatPainter ? '' : 'none';

    lockBtn.classList.toggle('active', values.allLocked);
    lockBtn.setAttribute('aria-pressed', String(values.allLocked));
    lockBtn.innerHTML = values.allLocked ? UNLOCK_ICON : LOCK_ICON;
    lockBtn.title = values.allLocked ? t('unlockElements') : t('lockElements');

    textPropsSection.style.display = show.text ? '' : 'none';
    if (show.text) {
      fontSizeInput.value = String(values.fontSize ?? '');
      markActive('cp-font-family-presets', 'family', values.fontFamily ?? '');
      markActive('cp-textmode-presets', 'mode', values.textMode);
      markActive('cp-align-presets', 'align', values.textAlign);
      textFormatRow
        .querySelectorAll<HTMLButtonElement>('.cp-btn')
        .forEach((btn) => {
          const key = btn.dataset.fmt as keyof typeof values.textFormat;
          const on = values.textFormat[key];
          btn.classList.toggle('active', on);
          btn.setAttribute('aria-pressed', String(on));
        });
    }
  }

  function sync(): void {
    const state = getStyleState(history.present);
    if (state === null) fullRequested = false;
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    const isOpen =
      !isTouch &&
      state !== null &&
      (!isFloatingStyleControls() || fullRequested);
    panel.classList.toggle('open', isOpen);
    if (isOpen && state) render(state);
  }

  history.subscribe(sync);
  sync();

  return {
    toggleFull() {
      fullRequested = !fullRequested;
      sync();
    },
    refresh() {
      fullRequested = false;
      sync();
    },
  };
}
