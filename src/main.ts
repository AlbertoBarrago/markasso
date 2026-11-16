import { CLOUD_ENABLED } from './config/features';
import type { Scene } from './core/scene';
import { createScene } from './core/scene';
import { fitToElements } from './core/viewport';
import { History } from './engine/history';
import { t } from './i18n';
import { parseBoardUrl } from './io/cloud';
import {
  getActiveLiveRoomId,
  getLiveRoomId,
  joinLiveSession,
} from './io/realtime';
import { initSession, loadSession } from './io/session';
import { decodeScene, isShareHash } from './io/share';
import { initCanvasView } from './ui/canvas_view';
import { initCloudBoards } from './ui/cloud_boards';
import { initCommandPalette } from './ui/command_palette';
import { initContextMenu } from './ui/context_menu';
import { initContextPanel } from './ui/context_panel';
import { confirmDialog } from './ui/dialog';
import { initElementSearch } from './ui/element_search';
import { initFloatingStyleBar } from './ui/floating_style_bar';
import { initGuide } from './ui/guide';
import { initHintBar } from './ui/hint_bar';
import { initIdleTips } from './ui/idle_tips';
import { initImageImport } from './ui/image_import';
import { initLibraryPanel } from './ui/library_panel';
import { setLiveUI } from './ui/live_name';
import { initMacBanner } from './ui/mac_banner';
import { initMcpSetup } from './ui/mcp_setup';
import { initMinimap } from './ui/minimap';
import { initMobileActionBar } from './ui/mobile_action_bar';
import { initReportForm } from './ui/report_form';
import { applySettings, initSettings, loadSettings } from './ui/settings';
import {
  showLiveEndedToast,
  showLiveRejectedToast,
  showLiveStatusToast,
} from './ui/share_actions';
import { initShortcuts } from './ui/shortcuts';
import { initShortcutsHelp } from './ui/shortcuts_help';
import { initStarCta } from './ui/star_cta';
import { initToolbar } from './ui/toolbar';
import { initUpdateBanner } from './ui/update_banner';
import { initWelcome } from './ui/welcome';
import { initWhatsNew } from './ui/whats_new';

function printConsoleGreeting(): void {
  const reset = 'color: inherit; font-size: 13px;';
  const title = 'color: #a78bfa; font-size: 18px; font-weight: bold;';
  const accent = 'color: #60a5fa; font-size: 13px;';
  const muted = 'color: #6b7280; font-size: 12px;';

  console.log('%cMarkasso', title);
  console.log('%cHey nerd 👋  Welcome to the console.', accent);
  console.log(
    "%cI'm Alberto (alBz) — the creator of this little whiteboard.",
    reset,
  );
  console.log(
    '%cIf you have ideas, spot a bug, or just want to say hi — open an issue or a PR:',
    reset,
  );
  console.log('%c→ https://github.com/AlbertoBarrago/markasso', accent);
  console.log(
    "%cAll contributions are welcome. Let's build something cool together.",
    muted,
  );
}

/** Asks before a link replaces the drawing saved in this browser. */
function confirmOpenLink(): Promise<boolean> {
  return confirmDialog({
    title: t('openLinkTitle'),
    message: t('openLinkMessage'),
    confirmKey: 'openLinkConfirm',
    danger: true,
  });
}

async function bootstrap(): Promise<void> {
  printConsoleGreeting();
  const appEl = document.getElementById('app') as HTMLElement;
  const toolbar = document.getElementById('toolbar') as HTMLElement;
  const workspace = document.getElementById('workspace') as HTMLElement;
  const canvas = document.getElementById('main') as HTMLCanvasElement;

  if (!appEl || !toolbar || !workspace || !canvas) {
    throw new Error('Missing required DOM elements');
  }

  const cloudRoute = CLOUD_ENABLED
    ? parseBoardUrl(new URL(location.href))
    : null;

  // Check for share link in URL hash — takes priority over session
  let sharedElements: Awaited<ReturnType<typeof decodeScene>> = null;
  if (!cloudRoute && isShareHash(location.hash)) {
    sharedElements = await decodeScene(location.hash);
  }

  const session = loadSession();
  // A shared or live link replaces the drawing saved in this browser, which
  // autosave would then overwrite: ask first. Cancelling opens that drawing
  // and leaves the link in the address, so a reload offers it again once the
  // drawing is safe. Rejoining the room the drawing already comes from needs
  // no question.
  if (session && sharedElements && !(await confirmOpenLink())) {
    sharedElements = null;
  }
  if (sharedElements) {
    // Remove hash from URL without reloading to keep the URL clean after load
    history.replaceState(null, '', location.pathname + location.search);
  }
  const liveRoom = cloudRoute ? null : getLiveRoomId();
  const joinLive =
    liveRoom !== null &&
    (!session || session.liveRoom === liveRoom || (await confirmOpenLink()));
  let baseScene: Scene;
  if (sharedElements) {
    const vp = fitToElements(
      sharedElements,
      window.innerWidth,
      window.innerHeight,
      { maxZoom: 1 },
    );
    baseScene = { ...createScene(), elements: sharedElements, viewport: vp };
  } else if (session && !cloudRoute) {
    const base = createScene();
    baseScene = {
      ...base,
      elements: session.elements,
      viewport: session.viewport,
      appState: {
        ...base.appState,
        gridVisible: session.gridVisible,
        gridSize: session.gridSize,
        gridType: session.gridType,
      },
    };
  } else {
    baseScene = createScene();
  }
  const hist = new History(baseScene);

  await initCloudBoards(hist);

  // Restore persisted UI settings before first paint
  applySettings(appEl, loadSettings());

  const { openImagePicker } = initImageImport(workspace, hist);
  initToolbar(toolbar, hist, openImagePicker);
  const reportForm = initReportForm(appEl);
  const guide = initGuide(appEl);
  const mcpSetup = initMcpSetup(appEl);
  const starCta = initStarCta(appEl);
  const { openPreferences, openFile } = initSettings(
    appEl,
    toolbar,
    hist,
    () => reportForm.open(),
    () => guide.open(),
    () => starCta.open(),
    () => mcpSetup.open(),
  );
  const { selectTool, historyActions, editText } = initCanvasView(canvas, hist);
  initContextMenu({ canvas, history: hist, selectTool, editText });
  const contextPanel = initContextPanel(workspace, hist, (source) =>
    selectTool.activateFormatPainter(source),
  );
  initFloatingStyleBar(workspace, hist, canvas, contextPanel);
  initMobileActionBar(workspace, hist, historyActions);
  initShortcuts(hist, selectTool, openPreferences, openFile, historyActions);
  initCommandPalette(
    hist,
    selectTool,
    () => mcpSetup.open(),
    openFile,
    historyActions,
  );
  initMinimap(workspace, hist);
  initElementSearch(workspace, hist);
  initLibraryPanel(workspace, hist, canvas);
  initShortcutsHelp(appEl);
  initHintBar(appEl, hist);
  initIdleTips(appEl, hist);
  initSession(hist, {
    // A cloud board is saved in the cloud: keep it out of the local session,
    // which holds the drawing of this browser.
    paused: () =>
      CLOUD_ENABLED && parseBoardUrl(new URL(location.href)) !== null,
    liveRoom: getActiveLiveRoomId,
  });
  // People arriving through a shared or live link see the board first; the
  // notice stays unseen and shows on their next plain visit.
  const invited = !!cloudRoute || sharedElements !== null || joinLive;
  const showedWhatsNew = !invited && initWhatsNew(appEl);
  const showedWelcome =
    !invited && !showedWhatsNew && !session && !sharedElements;
  if (showedWelcome) initWelcome(appEl, hist, () => mcpSetup.open());
  // One announcement at a time: the What's New card already presents the Mac
  // app, so the Mac banner waits for a visit without a card.
  if (!showedWhatsNew && !showedWelcome) initMacBanner();
  initUpdateBanner();

  // Join a live session if the URL points to one (…?live=roomId)
  if (joinLive) {
    joinLiveSession(hist, {
      onStatus: (connected) => {
        setLiveUI(connected);
        showLiveStatusToast(connected);
      },
      onEnded: (reason) => {
        setLiveUI(false);
        showLiveEndedToast(reason);
      },
      onRejected: showLiveRejectedToast,
    });
  }
}

bootstrap();
