import type { Scene } from '../core/scene';
import { t } from '../i18n';
import { dialog } from './dialog';

/** Asks whether the image keeps the canvas background; null when cancelled. */
async function askBackground(): Promise<boolean | null> {
  const choice = await dialog({
    title: t('exportBackgroundTitle'),
    message: t('exportBackgroundMessage'),
    choices: [
      { key: 'exportTransparent' },
      { key: 'exportWithBackground', primary: true },
    ],
  });
  return choice === null ? null : choice === 'exportWithBackground';
}

/**
 * Exports an image (PNG or SVG) after asking about the background, the same
 * way from the menu and from the command palette: a light drawing exported
 * transparent from the dark theme would vanish on a white page.
 */
export async function exportImage(
  scene: () => Scene,
  run: (scene: Scene, withBackground: boolean) => void,
): Promise<void> {
  const withBackground = await askBackground();
  if (withBackground !== null) run(scene(), withBackground);
}
