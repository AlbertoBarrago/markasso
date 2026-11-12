import { screenToWorld } from '../core/viewport';
import type { Element } from '../elements/element';
import type { History } from '../engine/history';
import { t } from '../i18n';
import { hitTest, type SelectTool } from '../tools/select_tool';
import {
  copySelection,
  copySelectionAsPNG,
  copySelectionAsSVG,
  cutSelection,
  pasteFromSystemClipboard,
} from './clipboard_actions';
import {
  buildContextMenu,
  type ContextMenuAction,
  type ContextMenuModel,
} from './context_menu_items';
import { showNoticeToast } from './share_actions';
import {
  copyStyle,
  deleteSelection,
  duplicateSelection,
  groupSelection,
  hasCopiedStyle,
  pasteStyle,
  reorderSelection,
  selectAll,
  toggleSelectionLock,
  ungroupSelection,
} from './style_actions';
import { selectedElements } from './style_state';

export interface ContextMenuDeps {
  readonly canvas: HTMLCanvasElement;
  readonly history: History;
  readonly selectTool: SelectTool;
  /** Opens the text, shape label or connector label editor of `el`. */
  readonly editText: (el: Element) => void;
}

/**
 * The right-click menu of the canvas (desktop; touch keeps its long-press
 * menu in canvas_view.ts). A right click first selects what it hits, like a
 * left click (a whole group, unless the selection already holds the element),
 * or clears the selection on empty canvas; `buildContextMenu` then decides
 * the items. Keyboard: arrows, Home/End, Enter, Escape.
 */
export function initContextMenu(deps: ContextMenuDeps): void {
  const { canvas, history, selectTool } = deps;
  const isMac = navigator.platform.toUpperCase().includes('MAC');

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('elementMenu'));
  menu.hidden = true;
  // Focused on open, so the arrows reach the items without a focus ring on
  // the first one when the menu was opened with the mouse.
  menu.tabIndex = -1;
  document.body.appendChild(menu);

  /** Selects what a right click at the point hits, as a left click would. */
  function selectAt(clientX: number, clientY: number): void {
    const scene = history.present;
    const rect = canvas.getBoundingClientRect();
    const [wx, wy] = screenToWorld(
      scene.viewport,
      clientX - rect.left,
      clientY - rect.top,
    );
    const hit = hitTest(scene.elements, wx, wy, scene.viewport);
    if (!hit) {
      if (scene.selectedIds.size > 0)
        history.dispatch({ type: 'CLEAR_SELECTION' });
      selectTool.activeGroupId = null;
      return;
    }
    if (scene.selectedIds.has(hit.id)) return;
    if (hit.groupId) {
      const ids = scene.elements
        .filter((el) => el.groupId === hit.groupId)
        .map((el) => el.id);
      history.dispatch({ type: 'SELECT_ELEMENTS', ids });
      selectTool.activeGroupId = hit.groupId;
    } else {
      history.dispatch({ type: 'SELECT_ELEMENTS', ids: [hit.id] });
      selectTool.activeGroupId = null;
    }
  }

  /** Reports a clipboard action that the browser refused. */
  async function clipboardTask(
    task: () => Promise<unknown>,
    okKey?: string,
  ): Promise<void> {
    try {
      await task();
      if (okKey) showNoticeToast(t(okKey));
    } catch (err) {
      console.warn('Clipboard action failed', err);
      showNoticeToast(t('clipboardUnavailable'), true);
    }
  }

  function run(action: ContextMenuAction): void {
    switch (action) {
      case 'cut':
        cutSelection(history);
        return;
      case 'copy':
        if (!copySelection(history))
          showNoticeToast(t('clipboardUnavailable'), true);
        return;
      case 'paste':
        void clipboardTask(() => pasteFromSystemClipboard(history));
        return;
      case 'copyAsPng':
        void clipboardTask(() => copySelectionAsPNG(history), 'copiedAsPng');
        return;
      case 'copyAsSvg':
        void clipboardTask(() => copySelectionAsSVG(history), 'copiedAsSvg');
        return;
      case 'editText': {
        const el = selectedElements(history.present)[0];
        if (el) deps.editText(el);
        return;
      }
      case 'copyStyle':
        copyStyle(history);
        return;
      case 'pasteStyle':
        selectTool.formatPainterActive = false;
        pasteStyle(history);
        return;
      case 'sendBackward':
        reorderSelection(history, 'backward');
        return;
      case 'bringForward':
        reorderSelection(history, 'forward');
        return;
      case 'sendToBack':
        reorderSelection(history, 'back');
        return;
      case 'bringToFront':
        reorderSelection(history, 'front');
        return;
      case 'group':
        groupSelection(history);
        return;
      case 'ungroup':
        selectTool.activeGroupId = null;
        ungroupSelection(history);
        return;
      case 'duplicate':
        duplicateSelection(history);
        return;
      case 'lock':
      case 'unlock':
        toggleSelectionLock(history);
        return;
      case 'delete':
        deleteSelection(history);
        return;
      case 'selectAll':
        selectAll(history);
        return;
    }
  }

  function render(model: ContextMenuModel): void {
    const children: HTMLElement[] = [];
    model.forEach((group, i) => {
      if (i > 0) {
        const divider = document.createElement('div');
        divider.className = 'menu-divider';
        divider.setAttribute('role', 'separator');
        children.push(divider);
      }
      for (const item of group) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `menu-item${item.danger ? ' menu-item--danger' : ''}`;
        btn.setAttribute('role', 'menuitem');
        btn.tabIndex = -1;
        const label = document.createElement('span');
        label.className = 'menu-item-label';
        label.textContent = t(item.labelKey);
        btn.appendChild(label);
        if (item.shortcut) {
          const hint = document.createElement('span');
          hint.className = 'menu-item-hint';
          hint.textContent = item.shortcut;
          btn.appendChild(hint);
        }
        btn.addEventListener('click', () => {
          close(false);
          run(item.action);
        });
        children.push(btn);
      }
    });
    menu.replaceChildren(...children);
  }

  /** At the pointer, flipped left or up when the window has no room. */
  function place(clientX: number, clientY: number): void {
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const left =
      clientX + w > window.innerWidth - 8 ? Math.max(8, clientX - w) : clientX;
    const top =
      clientY + h > window.innerHeight - 8 ? Math.max(8, clientY - h) : clientY;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function items(): HTMLButtonElement[] {
    return [...menu.querySelectorAll<HTMLButtonElement>('.menu-item')];
  }

  function open(clientX: number, clientY: number): void {
    selectAt(clientX, clientY);
    render(
      buildContextMenu(history.present, {
        hasCopiedStyle: hasCopiedStyle(),
        isMac,
      }),
    );
    menu.hidden = false;
    place(clientX, clientY);
    menu.focus({ preventScroll: true });
  }

  function close(restoreFocus: boolean): void {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    if (restoreFocus) canvas.focus({ preventScroll: true });
  }

  canvas.addEventListener('contextmenu', (e) => {
    // Touch long-press has its own menu (canvas_view.ts).
    if ((e as PointerEvent).pointerType === 'touch') return;
    e.preventDefault();
    open(e.clientX, e.clientY);
  });

  menu.addEventListener('contextmenu', (e) => e.preventDefault());

  // Capture phase on the document: Escape closes the menu wherever focus is,
  // before the canvas shortcuts see it.
  document.addEventListener(
    'keydown',
    (e) => {
      if (menu.hidden || e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    },
    true,
  );

  menu.addEventListener('keydown', (e) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (i: number): void =>
      list[(i + list.length) % list.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        focusAt(index + 1);
        break;
      case 'ArrowUp':
        focusAt(index - 1);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(list.length - 1);
        break;
      case 'Tab':
        close(true);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!menu.hidden && !menu.contains(e.target as Node)) close(false);
    },
    true,
  );
  canvas.addEventListener('wheel', () => close(false), { passive: true });
  window.addEventListener('resize', () => close(false));
  window.addEventListener('blur', () => close(false));
}
