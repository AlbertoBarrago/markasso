import { FORBIDDEN_SVG_ELEMENTS, isSafeSvgReference } from '../io/svg_safety';

/**
 * Cleans an imported SVG before it is stored and embedded in diagrams,
 * removing what breaks the shared rules of `src/io/svg_safety.ts` (see
 * there for why they are defense in depth).
 */

/** Returns sanitized SVG markup, or null when the file is not a usable SVG. */
export function sanitizeSvg(markup: string): string | null {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = doc.documentElement;
  if (
    root.nodeName.toLowerCase() !== 'svg' ||
    doc.getElementsByTagName('parsererror').length > 0
  ) {
    return null;
  }

  for (const name of FORBIDDEN_SVG_ELEMENTS) {
    for (const el of [...doc.getElementsByTagName(name)]) el.remove();
  }
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (
        (name === 'href' || name === 'xlink:href') &&
        !isSafeSvgReference(attr.value)
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }

  // Without explicit dimensions some browsers give the image a natural size
  // of 0, and it would never draw: derive them from the viewBox.
  const viewBox = root
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/);
  const relative = (attr: string): boolean =>
    !root.hasAttribute(attr) || /%\s*$/.test(root.getAttribute(attr) ?? '');
  if (viewBox?.length === 4 && (relative('width') || relative('height'))) {
    root.setAttribute('width', viewBox[2] ?? '64');
    root.setAttribute('height', viewBox[3] ?? '64');
  }
  if (!root.hasAttribute('xmlns')) {
    root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }

  return new XMLSerializer().serializeToString(root);
}
