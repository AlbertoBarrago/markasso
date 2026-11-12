import { worldToScreen } from '../core/viewport';
import type { History } from '../engine/history';
import { t } from '../i18n';
import { getElementBounds } from '../rendering/draw_selection';
import {
  createColorPicker,
  loadCustomColor,
  saveCustomColor,
  strokeSwatchPreview,
  updateCustomColorButton,
} from './color_picker';
import type { ContextPanelHandle } from './context_panel';
import {
  applyFontSize,
  applyStrokeOrLabelColor,
  deleteSelection,
  duplicateSelection,
  isSwatchActive,
  reorderSelection,
} from './style_actions';
import {
  isFloatingStyleControls,
  onStyleControlsModeChange,
} from './style_controls_mode';
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
import { getStyleState, type StyleState } from './style_state';

/** Distance between the bar and the selection or the toolbar. */
const GAP = 12;
/** Minimum distance from the window edges. */
const MARGIN = 8;

type PopoverKind = 'stroke' | 'fill' | 'line' | 'text';

const ICON_LINE = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="16" x2="15" y2="5"/><path d="M9 5h6v6"/></svg>`;
const ICON_TEXT = `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M3 4h14v2.5H12v9.5H8V6.5H3z"/></svg>`;
const ICON_MORE = `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><circle cx="5" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="15" cy="10" r="1.6"/></svg>`;

/**
 * The floating style bar (Settings > Floating style bar), the web twin of the
 * macOS app's `FloatingStyleBar`: the main styles of the selection in a
 * compact bar placed above it (below when there is no room), or under the
 * toolbar while a drawing tool is active with nothing selected. What does not
 * fit (opacity, alignment, layers, locks, the less used styles) is behind
 * More..., which opens the full context panel.
 *
 * Controls read `getStyleState` and dispatch through `style_actions`, so they
 * share sections, values and undo steps with the context panel. Every control
 * carries `data-prop`/`data-val`; `markActive` highlights them from the state.
 * Desktop only: touch devices keep the mobile action bar.
 */
export function initFloatingStyleBar(
  workspace: HTMLElement,
  history: History,
  canvas: HTMLCanvasElement,
  contextPanel: ContextPanelHandle,
): void {
  const bar = document.createElement('div');
  bar.id = 'floating-style-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', t('styleBar'));
  bar.hidden = true;
  workspace.appendChild(bar);

  const popover = document.createElement('div');
  popover.className = 'fsb-popover';
  popover.setAttribute('role', 'dialog');
  popover.hidden = true;
  document.body.appendChild(popover);
  let openKind: PopoverKind | null = null;
  let popoverAnchor: HTMLElement | null = null;

  const colorPicker = createColorPicker({
    history,
    labels: {
      color: t('color'),
      shades: t('shades'),
      hexCode: t('hexCode'),
      transparent: t('transparent'),
    },
    position: (_anchor, popup) => {
      const r = popover.getBoundingClientRect();
      const left = Math.min(
        Math.max(MARGIN, r.left),
        window.innerWidth - popup.offsetWidth - MARGIN,
      );
      let top = r.bottom + MARGIN;
      if (top + popup.offsetHeight > window.innerHeight - MARGIN)
        top = Math.max(MARGIN, r.top - popup.offsetHeight - MARGIN);
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
    },
  });

  // ── Building blocks ────────────────────────────────────────────────────────
  function button(
    className: string,
    label: string,
    html: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = html;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** A preset button highlighted while `values[prop]` equals `val`. */
  function preset(
    className: string,
    label: string,
    html: string,
    prop: string,
    val: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = button(className, label, html, onClick);
    btn.dataset.prop = prop;
    btn.dataset.val = val;
    btn.setAttribute('aria-pressed', 'false');
    return btn;
  }

  function group(section: string, ...children: HTMLElement[]): HTMLElement {
    const el = document.createElement('div');
    el.className = 'fsb-group';
    el.dataset.section = section;
    el.append(...children);
    bar.appendChild(el);
    return el;
  }

  function togglePopover(kind: PopoverKind, anchor: HTMLElement): void {
    if (openKind === kind) closePopover();
    else openPopover(kind, anchor);
  }

  // ── Bar ────────────────────────────────────────────────────────────────────
  const strokeBtn = button('fsb-color-btn', t('stroke'), '', () =>
    togglePopover('stroke', strokeBtn),
  );
  strokeBtn.setAttribute('aria-haspopup', 'dialog');
  const fillBtn = button('fsb-color-btn', t('fill'), '', () =>
    togglePopover('fill', fillBtn),
  );
  fillBtn.setAttribute('aria-haspopup', 'dialog');
  group('stroke', strokeBtn);
  group('fill', fillBtn);

  group(
    'width',
    ...strokeWidthOptions().map((w) => {
      const btn = preset(
        'cp-btn cp-width-btn',
        w.label,
        '',
        'strokeWidth',
        String(w.value),
        () => history.dispatch({ type: 'APPLY_STYLE', strokeWidth: w.value }),
      );
      // The width icon is drawn by `.cp-width-btn[data-value]::before`.
      btn.dataset.value = String(w.value);
      return btn;
    }),
  );

  group(
    'strokeStyle',
    ...strokeStyleOptions().map((s) => {
      const btn = preset(
        'cp-btn cp-style-btn',
        s.label,
        '',
        'strokeStyle',
        s.value,
        () => history.dispatch({ type: 'APPLY_STYLE', strokeStyle: s.value }),
      );
      btn.dataset.style = s.value;
      return btn;
    }),
  );

  const lineBtn = button('cp-btn', t('lineOptions'), ICON_LINE, () =>
    togglePopover('line', lineBtn),
  );
  lineBtn.setAttribute('aria-haspopup', 'dialog');
  group('line', lineBtn);

  const textBtn = button('cp-btn', t('textOptions'), ICON_TEXT, () =>
    togglePopover('text', textBtn),
  );
  textBtn.setAttribute('aria-haspopup', 'dialog');
  group('text', textBtn);

  group(
    'arrange',
    button('cp-btn', t('duplicate'), ICON_DUPLICATE, () =>
      duplicateSelection(history),
    ),
    button('cp-btn', t('toFront'), ICON_TO_FRONT, () =>
      reorderSelection(history, 'front'),
    ),
    button('cp-btn', t('delete'), ICON_DELETE, () => deleteSelection(history)),
  );

  const moreBtn = button('cp-btn', t('moreStyles'), ICON_MORE, () => {
    closePopover();
    contextPanel.toggleFull();
  });
  group('more', moreBtn);

  // ── Popover ────────────────────────────────────────────────────────────────
  function section(label: string, ...children: HTMLElement[]): HTMLElement {
    const el = document.createElement('div');
    el.className = 'fsb-pop-section';
    const title = document.createElement('div');
    title.className = 'cp-label';
    title.textContent = label;
    const row = document.createElement('div');
    row.className = 'cp-btn-row';
    row.append(...children);
    el.append(title, row);
    return el;
  }

  function colorSection(
    kind: 'stroke' | 'fill',
    state: StyleState,
  ): HTMLElement {
    const prop = kind === 'stroke' ? 'strokeColor' : 'fillColor';
    const apply = (color: string): void => {
      if (kind === 'stroke') applyStrokeOrLabelColor(history, color);
      else history.dispatch({ type: 'APPLY_STYLE', fillColor: color });
    };
    const presets = kind === 'stroke' ? STROKE_PRESETS : FILL_PRESETS;
    const swatches = presets.map((color) => {
      const label = color === 'transparent' ? t('transparent') : color;
      const sw = preset('cp-color-swatch', label, '', prop, color, () =>
        apply(color),
      );
      if (color === 'transparent')
        sw.classList.add('cp-color-swatch-transparent');
      else
        sw.style.background =
          kind === 'stroke' ? strokeSwatchPreview(color) : color;
      return sw;
    });
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'cp-color-more';
    const custom = loadCustomColor(kind);
    updateCustomColorButton(more, custom, t('moreColors'));
    more.dataset.prop = prop;
    more.dataset.custom = custom ?? '';
    more.addEventListener('click', () => {
      const current = state.values[prop];
      const start =
        loadCustomColor(kind) ??
        (current === 'transparent' ? '#ffffff' : current);
      colorPicker.open(more, start, ({ pick, preview }) => {
        if (preview) apply(preview);
        if (!pick) return;
        const next = pick === 'transparent' ? null : pick;
        saveCustomColor(kind, next);
        updateCustomColorButton(more, next, t('moreColors'));
        more.dataset.custom = next ?? '';
        if (next) apply(next);
      });
    });
    const title =
      kind === 'fill'
        ? t('fill')
        : state.strokeIsColor
          ? t('color')
          : t('stroke');
    const el = section(title, ...swatches);
    el.querySelector('.cp-btn-row')!.appendChild(more);
    return el;
  }

  function lineSections(state: StyleState): HTMLElement[] {
    const sections: HTMLElement[] = [];
    if (state.sections.arrowHead)
      sections.push(
        section(
          t('arrowHead'),
          ...arrowHeadOptions().map((ah) =>
            preset('cp-btn', ah.label, ah.icon, 'arrowHead', ah.value, () =>
              history.dispatch({ type: 'APPLY_STYLE', arrowHead: ah.value }),
            ),
          ),
        ),
      );
    if (state.sections.routing)
      sections.push(
        section(
          t('routing'),
          ...routingOptions().map((r) =>
            preset('cp-btn', r.label, r.icon, 'routing', r.value, () =>
              history.dispatch({ type: 'APPLY_STYLE', routing: r.value }),
            ),
          ),
        ),
      );
    return sections;
  }

  function textSections(): HTMLElement[] {
    const size = document.createElement('input');
    size.type = 'number';
    size.min = '6';
    size.max = '400';
    size.step = '1';
    size.className = 'cp-font-size-input fsb-font-size';
    size.setAttribute('aria-label', t('fontSize'));
    size.addEventListener('focus', () => size.select());
    size.addEventListener('change', () =>
      applyFontSize(history, parseInt(size.value, 10)),
    );
    size.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') size.blur();
    });
    const families = FONT_FAMILIES.map((f) => {
      const btn = preset('cp-btn', f.title, '', 'fontFamily', f.family, () =>
        history.dispatch({ type: 'SET_FONT_FAMILY', family: f.family }),
      );
      btn.textContent = f.label;
      btn.style.fontFamily = f.family;
      return btn;
    });
    const aligns = textAlignOptions().map((a) =>
      preset('cp-btn', a.label, a.icon, 'textAlign', a.value, () =>
        history.dispatch({ type: 'APPLY_STYLE', textAlign: a.value }),
      ),
    );
    return [
      section(t('fontSize'), size),
      section(t('fontFamily'), ...families),
      section(t('alignment'), ...aligns),
    ];
  }

  function openPopover(kind: PopoverKind, anchor: HTMLElement): void {
    const state = getStyleState(history.present);
    if (!state) return;
    openKind = kind;
    popoverAnchor = anchor;
    popover.setAttribute('aria-label', anchor.title);
    popover.replaceChildren(
      ...(kind === 'stroke' || kind === 'fill'
        ? [colorSection(kind, state)]
        : kind === 'line'
          ? lineSections(state)
          : textSections()),
    );
    popover.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    markActive(state);
    placePopover();
  }

  function closePopover(): void {
    if (openKind === null) return;
    openKind = null;
    popoverAnchor?.setAttribute('aria-expanded', 'false');
    popoverAnchor = null;
    popover.hidden = true;
    popover.replaceChildren();
  }

  /** Below the anchor, or above it when the window has no room below. */
  function placePopover(): void {
    if (!popoverAnchor) return;
    const a = popoverAnchor.getBoundingClientRect();
    const w = popover.offsetWidth;
    const h = popover.offsetHeight;
    let top = a.bottom + MARGIN;
    if (top + h > window.innerHeight - MARGIN) top = a.top - MARGIN - h;
    const left = Math.min(
      Math.max(MARGIN, a.left + a.width / 2 - w / 2),
      window.innerWidth - w - MARGIN,
    );
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(Math.max(MARGIN, top))}px`;
  }

  document.addEventListener(
    'pointerdown',
    (e) => {
      const target = e.target as Node;
      if (
        openKind !== null &&
        !popover.contains(target) &&
        !bar.contains(target) &&
        !colorPicker.contains(target)
      )
        closePopover();
    },
    true,
  );
  popover.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    const anchor = popoverAnchor;
    closePopover();
    anchor?.focus();
  });

  // ── Sync ───────────────────────────────────────────────────────────────────
  /** Highlights the controls of the bar and the popover from the state. */
  function markActive(state: StyleState): void {
    const values = state.values as unknown as Record<string, unknown>;
    for (const el of [
      ...bar.querySelectorAll<HTMLElement>('[data-prop]'),
      ...popover.querySelectorAll<HTMLElement>('[data-prop]'),
    ]) {
      const current = String(values[el.dataset.prop!] ?? '');
      const candidate = el.dataset.val ?? el.dataset.custom ?? '';
      const on = candidate !== '' && isSwatchActive(candidate, current);
      el.classList.toggle('active', on);
      if (el.dataset.val !== undefined)
        el.setAttribute('aria-pressed', String(on));
    }
    const size = popover.querySelector<HTMLInputElement>('.fsb-font-size');
    if (size && document.activeElement !== size)
      size.value = String(state.values.fontSize ?? '');

    strokeBtn.style.setProperty(
      '--fsb-swatch',
      state.values.strokeColor === 'transparent'
        ? 'transparent'
        : strokeSwatchPreview(state.values.strokeColor),
    );
    fillBtn.style.setProperty('--fsb-swatch', state.values.fillColor);
    const strokeLabel = state.strokeIsColor ? t('color') : t('stroke');
    strokeBtn.title = strokeLabel;
    strokeBtn.setAttribute('aria-label', strokeLabel);
    strokeBtn.classList.toggle(
      'fsb-color-btn--transparent',
      state.values.strokeColor === 'transparent',
    );
    fillBtn.classList.toggle(
      'fsb-color-btn--transparent',
      state.values.fillColor === 'transparent',
    );
  }

  function showGroups(state: StyleState): void {
    const s = state.sections;
    const visible: Record<string, boolean> = {
      stroke: s.stroke,
      fill: s.fill,
      width: s.width,
      strokeStyle: s.strokeStyle,
      line: s.arrowHead || s.routing,
      text: s.text,
      arrange: s.actions,
      more: true,
    };
    bar.querySelectorAll<HTMLElement>('.fsb-group').forEach((g) => {
      g.hidden = !visible[g.dataset.section!];
    });
    if (
      openKind !== null &&
      popoverAnchor?.closest<HTMLElement>('.fsb-group')?.hidden
    )
      closePopover();
  }

  /** The selection's bounds in window coordinates. */
  function selectionRect(state: StyleState): DOMRect | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of state.selected) {
      const b = getElementBounds(el);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
    const { viewport } = history.present;
    const c = canvas.getBoundingClientRect();
    const [left, top] = worldToScreen(viewport, minX, minY);
    const [right, bottom] = worldToScreen(viewport, maxX, maxY);
    return new DOMRect(c.left + left, c.top + top, right - left, bottom - top);
  }

  /**
   * The bar's top-left: above the selection (below it when there is no room
   * above), or under the toolbar (above it when docked at the bottom) in tool
   * mode; always clamped to the window.
   */
  function place(state: StyleState): void {
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
    let top: number;
    let centerX: number;
    if (state.mode === 'selection') {
      const r = selectionRect(state);
      if (!r) return;
      centerX = r.left + r.width / 2;
      top = r.top - GAP - h;
      if (top < MARGIN) top = r.bottom + GAP;
    } else {
      const toolbar = document.querySelector<HTMLElement>('.tb-island-tools');
      const r = toolbar?.getBoundingClientRect();
      if (!r) return;
      centerX = r.left + r.width / 2;
      const rootStyle = getComputedStyle(document.documentElement);
      if (r.top < window.innerHeight / 2) {
        // `--toolbar-panel-top` already includes the hint row under the toolbar.
        const panelTop = parseFloat(
          rootStyle.getPropertyValue('--toolbar-panel-top'),
        );
        top = panelTop > 0 ? panelTop : r.bottom + GAP;
      } else {
        const panelBottom = parseFloat(
          rootStyle.getPropertyValue('--toolbar-panel-bottom'),
        );
        top =
          (panelBottom > 0 ? window.innerHeight - panelBottom : r.top - GAP) -
          h;
      }
    }
    const left = Math.min(
      Math.max(MARGIN, centerX - w / 2),
      window.innerWidth - w - MARGIN,
    );
    top = Math.min(Math.max(MARGIN, top), window.innerHeight - h - MARGIN);
    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
  }

  const coarse = window.matchMedia('(pointer: coarse)');
  let pointerDown = false;

  function sync(): void {
    const state = getStyleState(history.present);
    // Hidden while dragging or typing, so it never covers what is being edited.
    const editingText = document.activeElement instanceof HTMLTextAreaElement;
    const visible =
      state !== null &&
      isFloatingStyleControls() &&
      !coarse.matches &&
      !pointerDown &&
      !editingText;
    if (!visible || !state) {
      bar.hidden = true;
      closePopover();
      return;
    }
    bar.hidden = false;
    showGroups(state);
    markActive(state);
    place(state);
    if (openKind !== null) placePopover();
  }

  canvas.addEventListener('pointerdown', () => {
    pointerDown = true;
    sync();
  });
  const release = (): void => {
    if (!pointerDown) return;
    pointerDown = false;
    sync();
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('resize', sync);
  document.addEventListener('focusin', sync);
  document.addEventListener('focusout', () => queueMicrotask(sync));
  coarse.addEventListener('change', sync);
  onStyleControlsModeChange(() => {
    contextPanel.refresh();
    sync();
  });
  history.subscribe(sync);
  sync();
}
