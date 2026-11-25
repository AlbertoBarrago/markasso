import { expect, type Page, test } from '@playwright/test';
import board from './fixtures/board.json' with { type: 'json' };

/**
 * Baselines of the UI chrome in both themes, for the design token migration
 * (#184). Every state is reached through keyboard shortcuts, storage or
 * stable ids, so the suite is independent of the UI language.
 *
 * Determinism:
 * - the board is a fixture with fixed element ids (rough shapes seed their
 *   strokes from the id);
 * - storage turns idle tips off and marks the Mac banner as seen;
 * - Google Fonts and the Mac release version are served from fixtures, so
 *   runs never depend on the network;
 * - `fixtures/stable.css` (playwright.config.ts) hides the timed hint pill
 *   and the app version;
 * - every screenshot waits for web fonts and two animation frames.
 */

const BOARD = JSON.stringify(board);
const THEMES = ['dark', 'light'] as const;
type Theme = (typeof THEMES)[number];

/** Canvas background the app picks by default for each theme. */
const CANVAS_BG: Record<Theme, string> = { dark: '#080808', light: '#ffffff' };

test.beforeEach(async ({ page }, testInfo) => {
  const fonts = `${testInfo.project.testDir}/fixtures/fonts`;
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({
      path: `${fonts}/google-fonts.css`,
      contentType: 'text/css',
    }),
  );
  await page.route('https://fonts.gstatic.com/**', (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop();
    return route.fulfill({ path: `${fonts}/${file}` });
  });
  // /mac/ shows the latest Mac release, read live by the worker: pin it.
  await page.route('**/download/mac.json', (route) =>
    route.fulfill({ json: { version: '1.0.0' } }),
  );
});

interface SeedOptions {
  theme: Theme;
  /** Load the fixture board; false gives a first visit (welcome card). */
  board: boolean;
  /** Extra user settings, merged over the defaults the suite seeds. */
  settings?: Record<string, unknown>;
  /** Extra localStorage entries, applied after the defaults. */
  storage?: Record<string, string>;
  /** Leave the release notice open instead of closing it. */
  keepNotice?: boolean;
}

/** Seeds localStorage before any app script runs, then opens the app. */
async function openApp(
  page: Page,
  {
    theme,
    board,
    settings = {},
    storage = {},
    keepNotice = false,
  }: SeedOptions,
) {
  await page.addInitScript(
    ({ theme, bg, board, settings, storage }) => {
      // Runs again on every navigation: seed only once per test.
      if (sessionStorage.getItem('visual-seeded')) return;
      sessionStorage.setItem('visual-seeded', '1');
      localStorage.clear();
      localStorage.setItem('markasso-theme', theme);
      localStorage.setItem(
        'markasso-ui-settings',
        JSON.stringify({ bgColor: bg, showTips: false, ...settings }),
      );
      localStorage.setItem('markasso-mac-banner-dismissed', '1');
      if (board) localStorage.setItem('markasso-session', board);
      for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    },
    {
      theme,
      bg: CANVAS_BG[theme],
      board: board ? BOARD : null,
      settings,
      storage,
    },
  );
  await page.goto('/');
  await expect(page).toHaveTitle(/^Markasso/);
  if (keepNotice) return;
  // A returning visitor gets the release notice once: close it so the
  // baseline does not depend on WHATS_NEW_ID.
  const notice = page.locator('#whats-new-overlay');
  if (await notice.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(notice).toBeHidden();
  }
  // Fit the board to the viewport, so narrow screens show it too.
  if (board) await page.keyboard.press('f');
}

/** Waits for web fonts and two frames, so text and canvas are painted. */
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
  });
}

async function snap(page: Page, name: string, fullPage = false) {
  await settle(page);
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage,
    // Demo videos show whichever frame has loaded: content, not UI chrome.
    mask: [page.locator('video')],
  });
}

/** Skips a test on the projects whose layout does not offer the feature. */
function onlyOn(projects: string[], reason: string) {
  test.skip(!projects.includes(test.info().project.name), reason);
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test('canvas with a board', async ({ page }) => {
      await openApp(page, { theme, board: true });
      await snap(page, `${theme}-canvas`);
    });

    test('welcome card on a first visit', async ({ page }) => {
      await openApp(page, { theme, board: false });
      await expect(page.locator('#welcome-overlay')).toBeVisible();
      await snap(page, `${theme}-welcome`);
    });

    test('release notice for a returning visitor', async ({ page }) => {
      await openApp(page, {
        theme,
        board: true,
        storage: { 'markasso-whats-new-version': '0' },
        keepNotice: true,
      });
      await expect(page.locator('#whats-new-overlay')).toBeVisible();
      await snap(page, `${theme}-whats-new`);
    });

    test('main menu', async ({ page }) => {
      await openApp(page, { theme, board: true });
      await page.locator('#menu-btn').click();
      await expect(page.locator('.settings-panel.open')).toBeVisible();
      await snap(page, `${theme}-menu`);
    });

    test('confirm dialog', async ({ page }) => {
      await openApp(page, { theme, board: true });
      await page.locator('#menu-btn').click();
      await page.locator('#menu-clear').click();
      await expect(page.locator('.app-dialog')).toBeVisible();
      await snap(page, `${theme}-dialog`);
    });

    test('connect AI agent modal', async ({ page }) => {
      // Shares mcp-tabs.css with the /agents/ page.
      await openApp(page, { theme, board: true });
      await page.locator('#menu-btn').click();
      await page.locator('#menu-mcp').click();
      await expect(page.locator('#mcp-setup-modal')).toBeVisible();
      await snap(page, `${theme}-mcp-setup`);
    });

    test('selection with style controls', async ({ page }, testInfo) => {
      await openApp(page, { theme, board: true });
      // Select all reaches the window's key handler: no focus needed.
      await page.keyboard.press('ControlOrMeta+a');
      if (testInfo.project.name === 'mobile') {
        // Touch screens show style controls in a bottom sheet, opened from
        // the action bar (the last button before the danger one).
        await page
          .locator(
            '#mobile-actions .mobile-action-btn:not(.mobile-action-danger)',
          )
          .last()
          .tap();
        await expect(page.locator('#mobile-style-sheet.open')).toBeVisible();
      }
      await snap(page, `${theme}-selection`);
    });

    test('floating style bar clears the rotation handle', async ({ page }) => {
      // Touch screens never show the floating bar (they use the sheet).
      onlyOn(['desktop', 'tablet', 'narrow'], 'no floating bar on touch');
      await openApp(page, {
        theme,
        board: true,
        settings: { styleControls: 'floating' },
      });
      // Click the rhombus: a single element low on the board, so the bar
      // goes above it, where the rotation handle is. Its screen position
      // comes from the viewport the fit saved; the session save is
      // debounced, so wait until it holds the fitted view.
      let viewport = { offsetX: 0, offsetY: 0, zoom: 1 };
      await expect
        .poll(async () => {
          viewport = await page.evaluate(
            () =>
              JSON.parse(localStorage.getItem('markasso-session') ?? '{}')
                .viewport ?? { offsetX: 0, offsetY: 0, zoom: 1 },
          );
          return viewport.zoom;
        })
        .not.toBe(1);
      const rhombus = board.elements.find((el) => el.id === 'el-rhombus');
      const canvas = await page.locator('#main').boundingBox();
      if (!rhombus?.width || !rhombus.height || !canvas) {
        throw new Error('fixture rhombus or canvas missing');
      }
      await page.mouse.click(
        canvas.x +
          (rhombus.x + rhombus.width / 2) * viewport.zoom +
          viewport.offsetX,
        canvas.y +
          (rhombus.y + rhombus.height / 2) * viewport.zoom +
          viewport.offsetY,
      );
      await expect(page.locator('#floating-style-bar')).toBeVisible();
      await snap(page, `${theme}-floating-bar`);
    });

    test('context menu', async ({ page }) => {
      onlyOn(['desktop', 'tablet'], 'right click is a pointer feature');
      await openApp(page, { theme, board: true });
      const box = await page.locator('#main').boundingBox();
      if (!box) throw new Error('canvas not laid out');
      // An empty spot near the top-left of the canvas.
      await page.mouse.click(box.x + 120, box.y + 120, { button: 'right' });
      await expect(page.locator('.context-menu').first()).toBeVisible();
      await snap(page, `${theme}-context-menu`);
    });

    test('toolbar more panel', async ({ page }) => {
      onlyOn(['desktop', 'tablet'], 'the toolbar is replaced on small screens');
      await openApp(page, { theme, board: true });
      await page.locator('#tb-more-tools').click();
      await expect(page.locator('#tb-more-panel')).toBeVisible();
      await snap(page, `${theme}-more-panel`);
    });

    test('mermaid import dialog', async ({ page }) => {
      // Opened from the toolbar's more panel, which small screens replace.
      onlyOn(['desktop', 'tablet'], 'the toolbar is replaced on small screens');
      await openApp(page, { theme, board: true });
      await page.locator('#tb-more-tools').click();
      await page.locator('#tb-more-mermaid').click();
      await expect(page.locator('#mermaid-dialog')).toBeVisible();
      await expect(page.locator('#mermaid-dialog textarea')).toBeFocused();
      await snap(page, `${theme}-mermaid-dialog`);
    });

    test('library panel', async ({ page }) => {
      await openApp(page, {
        theme,
        board: true,
        storage: { 'markasso-library-open': '1' },
      });
      await expect(page.locator('#library-panel.open')).toBeVisible();
      await snap(page, `${theme}-library`);
    });

    test('command palette', async ({ page }) => {
      // The palette is a keyboard feature: small screens never open it.
      onlyOn(['desktop', 'tablet'], 'not available below the tablet width');
      await openApp(page, { theme, board: true });
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.locator('#cmd-palette-overlay')).toBeVisible();
      await snap(page, `${theme}-palette`);
    });

    test('shortcuts help', async ({ page }) => {
      await openApp(page, { theme, board: true });
      await page.keyboard.press('?');
      await expect(page.locator('#shortcuts-help')).toBeVisible();
      await snap(page, `${theme}-shortcuts`);
    });

    for (const path of ['/agents/', '/mac/', '/cloud/']) {
      test(`page ${path}`, async ({ page }) => {
        await page.addInitScript((theme) => {
          localStorage.setItem('markasso-theme', theme);
        }, theme);
        await page.goto(path);
        if (path === '/mac/') {
          await expect(page.locator('#mac-version')).toHaveText('1.0.0 beta');
        }
        await snap(page, `${theme}-page-${path.replaceAll('/', '')}`, true);
      });
    }
  });
}
