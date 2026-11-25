import { defineConfig, devices } from '@playwright/test';

/**
 * Visual regression suite for the UI chrome (design token migration, #184).
 *
 * Baselines are platform-specific (font rasterization differs between macOS
 * and Linux), so the suite runs locally through the `verify` skill, not in CI.
 * The dev server gets its own port, and `strictPort` plus
 * `reuseExistingServer: false` make a taken port fail the run instead of
 * screenshotting someone else's server.
 */
const PORT = Number(process.env.VISUAL_PORT ?? 5198);

export default defineConfig({
  testDir: 'visual',
  testMatch: '**/*.visual.ts',
  snapshotPathTemplate:
    '{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}-{platform}{ext}',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      maxDiffPixels: 0,
    },
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: 'tablet',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 720, height: 900 },
      },
    },
    {
      name: 'narrow',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 600, height: 900 },
      },
    },
    {
      // Coarse pointer and touch: the only context that shows the mobile sheet.
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 812 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: `pnpm dev --port ${PORT} --strictPort --open false`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
