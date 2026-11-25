# Pinned web fonts

The Google Fonts stylesheet and font files that `index.html`, `/agents/`, `/mac/` and `/cloud/` load (Kode Mono 500, Roboto Mono 500), as served to Playwright's Chromium. The visual suite answers those requests with these files, so baselines never depend on the network or on font updates.

Kode Mono is under the SIL Open Font License 1.1, Roboto Mono under the Apache License 2.0: both allow redistribution.

To refresh them after changing the font URL, record the stylesheet and the `fonts.gstatic.com` files it links again, then run `pnpm test:visual:update`.
