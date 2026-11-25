/**
 * The one Node global the Playwright config reads (VISUAL_PORT), declared
 * here so the suite type-checks without pulling in @types/node.
 */
declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
};
