import './styles/base.css';
import './styles/theme.css';
import './styles/cloud-page.css';
import './styles/agents-page.css';
import { t } from './i18n';
import { readStorage } from './io/safe_storage';
import { initSiteFx } from './site_fx';
import { MCP_DOCS_URL } from './ui/mcp_clients';
import { createMcpTabs } from './ui/mcp_tabs';

/**
 * The /agents page: what Markasso does with AI agents, the demo, and the
 * install snippets. The static HTML carries the English copy (what search
 * engines index); here it is translated, and the snippets come from the same
 * widget as the in-app "Connect AI agent" dialog.
 */
const media = window.matchMedia('(prefers-color-scheme: light)');
// Device appearance when browser storage is unavailable.
const theme = readStorage('markasso-theme');
function applyTheme(): void {
  const light = theme === 'light' || (theme !== 'dark' && media.matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
}
applyTheme();
media.addEventListener('change', applyTheme);

document.title = `Markasso: ${t('agentsPageTitle')}`;
for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]'))
  element.textContent = t(element.dataset.i18n!);

document
  .getElementById('mcp-tabs')
  ?.replaceWith(createMcpTabs({ label: t('agentsPageConnect') }).element);
document.getElementById('mcp-docs')?.setAttribute('href', MCP_DOCS_URL);

// A looping demo is motion: with reduced motion it stays on its poster and
// the native controls let people play it on purpose.
const video = document.querySelector<HTMLVideoElement>('.demo video');
if (video && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  video.autoplay = false;
  video.removeAttribute('autoplay');
  video.pause();
  video.controls = true;
}

// Last: the title is typed from its translated text.
initSiteFx();
