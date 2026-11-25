/**
 * Stylelint rules that keep the CSS on the design token scales (#184).
 *
 * Built-in rules cannot check the grammar the tokens define: a spacing value
 * must be `calc(var(--spacing) * N)` with N one of the allowed steps, a font
 * size or radius must be one of the generated tokens, and a media query may
 * only use the agreed breakpoints. The scales come from src/design/tokens.ts
 * (Node strips its types on import), so lint and tokens cannot disagree.
 *
 * Values are compared case-insensitively (CSS keywords and function names
 * are), and warnings point at the exact part of the value that is off.
 */
import stylelint from 'stylelint';
import {
  BREAKPOINTS,
  SHARED,
  SHORT_VIEWPORT,
  SPACING_STEPS,
} from '../../src/design/tokens.ts';

const {
  createPlugin,
  utils: { report, ruleMessages },
} = stylelint;

const NS = 'markasso';
const META = { url: 'https://github.com/AlbertoBarrago/markasso/issues/184' };
const STEPS = new Set(SPACING_STEPS.map(String));
const GLOBAL = new Set(['inherit', 'initial', 'unset', 'revert']);

/** Names of the generated tokens of one namespace, e.g. `text-`. */
const tokensOf = (prefix) =>
  new Set(Object.keys(SHARED).filter((name) => name.startsWith(prefix)));
const TEXT = tokensOf('text-');
const RADIUS = tokensOf('radius-');
const Z = tokensOf('z-');

/**
 * Splits a declaration value into its top-level parts (space- or
 * slash-separated), keeping function calls whole, with each part's offset.
 * @param {string} value
 * @returns {{ text: string, index: number }[]}
 */
function parts(value) {
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i <= value.length; i++) {
    const ch = value[i];
    const boundary =
      i === value.length || (depth === 0 && (/\s/.test(ch) || ch === '/'));
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (boundary) {
      if (start !== -1) out.push({ text: value.slice(start, i), index: start });
      start = -1;
    } else if (start === -1) {
      start = i;
    }
  }
  return out;
}

/**
 * Canonical spelling of a part: lowercase except custom property names, no
 * spaces around `*`, parentheses and commas, single spaces around binary
 * `+` and `-` (CSS requires spaces there, so `-1px` and `--x` are safe).
 */
function normalize(part) {
  return part
    .split(/(--[A-Za-z0-9_-]+)/)
    .map((piece, i) => (i % 2 ? piece : piece.toLowerCase()))
    .join('')
    .replace(/\s*([*(),])\s*/g, '$1')
    .replace(/\s*([+-])\s+/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `var(--name)` with `name` in `tokens`, without a fallback. */
function isToken(part, tokens) {
  const m = /^var\(--([a-z0-9-]+)\)$/.exec(part);
  return Boolean(m?.[1] && tokens.has(m[1]));
}

// The multiplier is checked wherever `var(--spacing) * N` appears, also
// inside a larger expression such as `calc(var(--spacing) * 20 + env(...))`.
const SPACING_CALC = /var\(--spacing\)\*(-?)([\d.]+)/g;

/**
 * A layout expression (`calc`, `min`, `max`, `clamp`) is on the scale when
 * every length in it comes from the spacing calc, a variable, `env()` or a
 * percentage/viewport unit: no raw px or rem besides the 1px hairline.
 */
function isScaledExpression(part) {
  if (!/^(calc|min|max|clamp)\(/.test(part)) return false;
  for (const [, , step] of part.matchAll(SPACING_CALC)) {
    if (!STEPS.has(step)) return false;
  }
  const rest = part
    .replace(SPACING_CALC, '')
    .replace(/var\([^()]*\)|env\([^()]*\)/g, '');
  const lengths = rest.match(/-?\d*\.?\d+(px|rem|em)\b/g) ?? [];
  return lengths.every((l) => l === '1px' || l === '-1px');
}

/** A spacing part: 0, auto, the 1px hairline, a %, a variable or a step. */
function isSpacing(part) {
  if (['0', 'auto', '1px', '-1px'].includes(part)) return true;
  if (/^-?[\d.]+(%|vw|vh|dvh|svh)$/.test(part)) return true;
  if (/^var\(--[a-z0-9-]+\)$/.test(part)) return true;
  // Device safe areas (notches, home indicator).
  if (/^env\(safe-area-inset-(top|right|bottom|left)\)$/.test(part))
    return true;
  // A runtime variable with a fallback: the fallback must be on the scale.
  const fallback = /^var\(--[a-z0-9-]+,(.+)\)$/.exec(part)?.[1];
  if (fallback !== undefined) {
    return isSpacing(fallback) || isScaledExpression(`calc(${fallback})`);
  }
  return isScaledExpression(part);
}

/**
 * One rule checking every part of the declarations whose property matches.
 * @param {string} name rule name without namespace
 * @param {RegExp} property properties the rule applies to (case-insensitive)
 * @param {(part: string) => boolean} isAllowed decides a normalized part
 * @param {string} expected description of the allowed values
 * @param {(value: string, prop: string) => { text: string, index: number }[]} [select]
 *   the parts to check (default: every top-level part)
 */
function scaleRule(name, property, isAllowed, expected, select = parts) {
  const ruleName = `${NS}/${name}`;
  const messages = ruleMessages(ruleName, {
    rejected: (prop, part) =>
      `"${part}" in "${prop}" is off the scale: use ${expected}`,
  });
  /** @type {import('stylelint').Rule} */
  const rule = (enabled) => (root, result) => {
    if (!enabled) return;
    root.walkDecls((decl) => {
      if (decl.prop.startsWith('--') || !property.test(decl.prop)) return;
      // Offset of the value inside the declaration's source string.
      const valueStart = decl.prop.length + (decl.raws.between?.length ?? 1);
      for (const { text, index } of select(decl.value, decl.prop)) {
        const part = normalize(text);
        if (GLOBAL.has(part) || isAllowed(part)) continue;
        report({
          result,
          ruleName,
          node: decl,
          index: valueStart + index,
          endIndex: valueStart + index + text.length,
          message: messages.rejected(decl.prop, text),
        });
      }
    });
  };
  rule.ruleName = ruleName;
  rule.messages = messages;
  rule.meta = META;
  return createPlugin(ruleName, rule);
}

const spacing = scaleRule(
  'spacing-scale',
  /^(margin|padding|scroll-margin|scroll-padding|gap|row-gap|column-gap|inset|top|right|bottom|left)(-.*)?$/i,
  isSpacing,
  `calc(var(--spacing) * N) with N in {${SPACING_STEPS.join(', ')}}, 0, 1px, auto, % or a variable`,
);

const fontSize = scaleRule(
  'font-size-scale',
  /^font(-size)?$/i,
  (part) =>
    isToken(part, TEXT) || ['1em', '100%', 'smaller', 'larger'].includes(part),
  `one of ${[...TEXT].map((t) => `var(--${t})`).join(', ')}`,
  // In the `font` shorthand only the size is a font size: the first part
  // with a length, a keyword size or a function (unitless numbers there are
  // weights, and the part after `/` is the line height).
  (value, prop) => {
    const all = parts(value);
    if (prop.toLowerCase() === 'font-size') return all;
    const size = all.find(
      (p, i) =>
        !(i > 0 && value[p.index - 1] === '/') &&
        /^(var\(|calc\(|clamp\(|min\(|max\(|[\d.]+(px|rem|em|%)|(xx?-)?small$|medium$|(x{1,3}-)?large$)/i.test(
          p.text,
        ),
    );
    return size ? [size] : [];
  },
);

const radius = scaleRule(
  'radius-scale',
  /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/i,
  (part) => isToken(part, RADIUS) || part === '0' || part === '50%',
  'a --radius-* token, 0 or 50%',
);

const zIndex = scaleRule(
  'z-index-scale',
  /^z-index$/i,
  (part) => {
    if (isToken(part, Z) || ['auto', '0', '-1'].includes(part)) return true;
    const m = /^calc\(var\(--([a-z]+(?:-[a-z]+)*)\) [+-] \d+\)$/.exec(part);
    return Boolean(m?.[1] && Z.has(m[1]));
  },
  'a --z-* token, calc(var(--z-*) + n), auto, 0 or -1',
);

/** Media conditions the design allows (Tailwind's breakpoints and more). */
const BOUNDS = Object.values(BREAKPOINTS);
const MEDIA_ALLOWED = new Set([
  ...BOUNDS.flatMap((v) => [`(width < ${v})`, `(width >= ${v})`]),
  // A band between two breakpoints, written as one range.
  ...BOUNDS.flatMap((lo, i) =>
    BOUNDS.slice(i + 1).map((hi) => `(${lo} <= width < ${hi})`),
  ),
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
  root.walkAtRules(/^media$/i, (atRule) => {
    // Query list → queries → features. Keywords (and, or, not, only) join
    // features; each feature in parentheses must be an agreed one.
    const params = atRule.params.toLowerCase().replace(/\s+/g, ' ');
    const conditions = params
      .replace(/\b(and|or|not|only)\b/g, ',')
      .split(',')
      .map((c) => c.trim().replace(/^\(+(?=\()|(?<=\))\)+$/g, ''))
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
mediaRule.meta = META;
const media = createPlugin(mediaRuleName, mediaRule);

export default [spacing, fontSize, radius, zIndex, media];
