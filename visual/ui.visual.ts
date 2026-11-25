import { expect, type Page, test } from '@playwright/test';
import board from './fixtures/board.json' with { type: 'json' };

/**
 * Baselines of the UI chrome in both themes, for the design token migration
 * (#184). Every state is reached through keyboard shortcuts or stable ids, so
 * the suite is independent of the UI language.
 *
 * Determinism: the board is a fixture with fixed element ids (rough shapes
 * seed their strokes from the id), idle tips are turned off, storage marks
 * the release notice and the Mac banner as seen, and every screenshot waits
 * for web fonts and two animation frames so the canvas has painted.
 */

const BOARD = JSON.stringify(board);
const THEMES = ['dark', 'light'] as const;
type Theme = (typeof THEMES)[number];

/** Canvas background the app picks by default for each theme. */
const CANVAS_BG: Record<Theme, string> = { dark: '#080808', light: '#ffffff' };

interface SeedOptions {
  theme: Theme;
  /** Load the fixture board; false gives a first visit (welcome card). */
  board: boolean;
}

/** Seeds localStorage before any app script runs, then opens the app. */
async function openApp(page: Page, { theme, board }: SeedOptions) {
  await page.addInitScript(
    ({ theme, bg, board }) => {
      // Runs again on every navigation: seed only once per test.
      if (sessionStorage.getItem('visual-seeded')) return;
      sessionStorage.setItem('visual-seeded', '1');
      localStorage.clear();
      localStorage.setItem('markasso-theme', theme);
      localStorage.setItem(
        'markasso-ui-settings',
        JSON.stringify({ bgColor: bg, showTips: false }),
      );
      localStorage.setItem('markasso-mac-banner-dismissed', '1');
      if (board) localStorage.setItem('markasso-session', board);
    },
    { theme, bg: CANVAS_BG[theme], board: board ? BOARD : null },
  );
  await page.goto('/');
  await expect(page).toHaveTitle(/^Markasso/);
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
    // The app version changes on every release.
    mask: [page.locator('.menu-version')],
  });
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

    test('main menu', async ({ page }) => {
      await openApp(page, { theme, board: true });
      await page.locator('#menu-btn').click();
      await expect(page.locator('.settings-panel.open')).toBeVisible();
      await snap(page, `${theme}-menu`);
    });

    test('selection with style controls', async ({ page }, testInfo) => {
      await openApp(page, { theme, board: true });
      await page.locator('#main').focus();
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

    test('command palette', async ({ page }, testInfo) => {
      // The palette is a keyboard feature: small screens never open it.
      test.skip(
        ['narrow', 'mobile'].includes(testInfo.project.name),
        'not available below the tablet width',
      );
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

    for (const path of ['/agents/', '/mac/']) {
      test(`page ${path}`, async ({ page }) => {
        await page.addInitScript((theme) => {
          localStorage.setItem('markasso-theme', theme);
        }, theme);
        // /mac/ shows the latest Mac release, read live by the worker: pin it.
        await page.route('**/download/mac.json', (route) =>
          route.fulfill({ json: { version: '1.0.0' } }),
        );
        await page.goto(path);
        if (path === '/mac/') {
          await expect(page.locator('#mac-version')).toHaveText('1.0.0 beta');
        }
        await snap(page, `${theme}-page-${path.replaceAll('/', '')}`, true);
      });
    }
  });
}
