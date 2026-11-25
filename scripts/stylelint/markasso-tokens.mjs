/**
 * Stylelint rules that keep the CSS on the design token scales (#184).
 *
 * Built-in rules cannot check the grammar the tokens define: a spacing value
 * must be `calc(var(--spacing) * N)` with N one of the allowed steps, and a
 * media query may only use the agreed breakpoints. The scales come from
 * src/design/tokens.ts (Node strips its types on import), so the lint and
 * the generated tokens can never disagree.
 */
import stylelint from 'stylelint';
import {
  BREAKPOINTS,
  SHORT_VIEWPORT,
  SPACING_STEPS,
} from '../../src/design/tokens.ts';

const {
  createPlugin,
  utils: { report, ruleMessages },
} = stylelint;

const NS = 'markasso';
const STEPS = new Set(SPACING_STEPS.map(String));
const GLOBAL = new Set(['inherit', 'initial', 'unset', 'revert']);

/**
 * Splits a declaration value into its space-separated parts, keeping
 * function calls (with their inner spaces) whole.
 * @param {string} value
 * @returns {string[]}
 */
function parts(value) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * One rule that checks every part of the declarations whose property
 * matches, with `isAllowed` deciding each part.
 * @param {string} name rule name without namespace
 * @param {RegExp} property properties the rule applies to
 * @param {(part: string) => boolean} isAllowed
 * @param {string} expected human description of the allowed values
 */
function scaleRule(name, property, isAllowed, expected) {
  const ruleName = `${NS}/${name}`;
  const messages = ruleMessages(ruleName, {
    rejected: (prop, part) =>
      `"${part}" in "${prop}" is off the scale: use ${expected}`,
  });
  /** @type {import('stylelint').Rule} */
  const rule = (enabled) => (root, result) => {
    if (!enabled) return;
    root.walkDecls(property, (decl) => {
      if (decl.prop.startsWith('--')) return;
      for (const part of parts(decl.value)) {
        if (GLOBAL.has(part) || isAllowed(part)) continue;
        report({
          result,
          ruleName,
          node: decl,
          word: part,
          message: messages.rejected(decl.prop, part),
        });
      }
    });
  };
  rule.ruleName = ruleName;
  rule.messages = messages;
  rule.meta = { url: 'https://github.com/AlbertoBarrago/markasso/issues/184' };
  return createPlugin(ruleName, rule);
}

/** `var(--name)` or `var(--name, fallback)` with a name matching `prefix`. */
const tokenVar = (prefix) =>
  new RegExp(`^var\\(--${prefix}[a-z0-9-]*(?:,[^)]*)?\\)$`);

const SPACING_CALC = /^calc\(var\(--spacing\) \* (-?)([\d.]+)\)$/;

/** A spacing part: `0`, `auto`, the `1px` hairline, a %, a token or a step. */
function isSpacing(part) {
  if (part === '0' || part === 'auto' || part === '1px' || part === '-1px')
    return true;
  if (/^-?[\d.]+%$/.test(part)) return true;
  // Any custom property: layout variables set at runtime, or tokens.
  if (/^var\(--[a-z0-9-]+(?:,[^)]*)?\)$/.test(part)) return true;
  const m = SPACING_CALC.exec(part);
  return Boolean(m?.[2] && STEPS.has(m[2]));
}

const spacing = scaleRule(
  'spacing-scale',
  /^(margin|padding|gap|row-gap|column-gap|inset)(-.*)?$/,
  isSpacing,
  `calc(var(--spacing) * N) with N in {${SPACING_STEPS.join(', ')}}, 0, 1px, auto or %`,
);

const fontSize = scaleRule(
  'font-size-scale',
  /^font-size$/,
  (part) => tokenVar('text-').test(part) || part === '1em' || part === '100%',
  'a --text-* token',
);

const radius = scaleRule(
  'radius-scale',
  /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/,
  (part) =>
    tokenVar('radius-').test(part) ||
    part === '0' ||
    part === '50%' ||
    part === '/',
  'a --radius-* token, 0 or 50%',
);

const zIndex = scaleRule(
  'z-index-scale',
  /^z-index$/,
  (part) =>
    tokenVar('z-').test(part) ||
    /^calc\(var\(--z-[a-z]+\) [+-] \d+\)$/.test(part) ||
    ['auto', '0', '-1'].includes(part),
  'a --z-* token, calc(var(--z-*) + n), auto, 0 or -1',
);

/** Media conditions the design allows (Tailwind's breakpoints and more). */
const MEDIA_ALLOWED = new Set([
  ...Object.values(BREAKPOINTS).flatMap((v) => [
    `(width < ${v})`,
    `(width >= ${v})`,
  ]),
  SHORT_VIEWPORT,
  '(pointer: coarse)',
  '(pointer: fine)',
  '(hover: hover)',
  '(hover: none)',
  '(prefers-reduced-motion: reduce)',
  '(prefers-color-scheme: dark)',
  '(prefers-color-scheme: light)',
  '(forced-colors: active)',
  'print',
  'screen',
]);

const mediaRuleName = `${NS}/media-query-scale`;
const mediaMessages = ruleMessages(mediaRuleName, {
  rejected: (condition) =>
    `"${condition}" is not an agreed media condition: use the breakpoints, e.g. (width < ${BREAKPOINTS.sm}), (width >= ${BREAKPOINTS.md}) or ${SHORT_VIEWPORT}`,
});
/** @type {import('stylelint').Rule} */
const mediaRule = (enabled) => (root, result) => {
  if (!enabled) return;
  root.walkAtRules('media', (atRule) => {
    const conditions = atRule.params
      .split(/,|\band\b|\bnot\b|\bonly\b/)
      .map((c) => c.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    for (const condition of conditions) {
      if (MEDIA_ALLOWED.has(condition)) continue;
      report({
        result,
        ruleName: mediaRuleName,
        node: atRule,
        word: condition,
        message: mediaMessages.rejected(condition),
      });
    }
  });
};
mediaRule.ruleName = mediaRuleName;
mediaRule.messages = mediaMessages;
mediaRule.meta = {
  url: 'https://github.com/AlbertoBarrago/markasso/issues/184',
};
const media = createPlugin(mediaRuleName, mediaRule);

export default [spacing, fontSize, radius, zIndex, media];
