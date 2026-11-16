/**
 * Spring-animated layout changes for a row of toolbar islands (FLIP: First,
 * Last, Invert, Play). When a live session starts, buttons and islands appear
 * in the top-right row; without this they pop in and the row jumps.
 *
 * Usage: call `capture()` right before any code that shows or hides an
 * element of the row. The first call in a task records where every tracked
 * element sits; a microtask later, once all synchronous callbacks (e.g. every
 * `onLiveReveal` listener) have run, the row is measured again and each
 * element animates from its old box to its new one:
 * - an element that stayed visible slides from its old position;
 * - an element that just appeared scales and fades in, with a spring.
 * Elements that disappeared are already gone (`display: none`), so the rest
 * of the row slides over to close the gap.
 *
 * Only transforms and opacity are animated, so the row never lays out again
 * mid-animation. With `prefers-reduced-motion` changes stay instant.
 */

/** Apple-like spring: fast start, a small overshoot, then settle. */
const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
const DURATION_MS = 420;

export interface RowMorph {
  /** Snapshot the row before a visibility change (idempotent per task). */
  capture(): void;
}

/**
 * @param tracked returns the elements whose movement should animate: the
 *   islands of the row and, if wanted, buttons inside them. Called on every
 *   capture and play, so elements added later are picked up.
 */
export function createRowMorph(tracked: () => Element[]): RowMorph {
  let before: Map<Element, DOMRect> | null = null;

  function snapshot(): Map<Element, DOMRect> {
    const rects = new Map<Element, DOMRect>();
    for (const el of tracked()) {
      // Hidden elements (display: none, or inside a hidden island) have no
      // box: they count as absent so they animate in when they show.
      if (el instanceof HTMLElement && el.offsetParent === null) continue;
      rects.set(el, el.getBoundingClientRect());
    }
    return rects;
  }

  function play(first: Map<Element, DOMRect>): void {
    const last = snapshot();
    for (const [el, to] of last) {
      const from = first.get(el);
      if (!from) {
        el.animate(
          [
            { opacity: 0, transform: 'scale(0.6)' },
            { opacity: 1, transform: 'scale(1)' },
          ],
          { duration: DURATION_MS, easing: SPRING },
        );
        continue;
      }
      // A button inside a tracked island already moves with its island's
      // animation: only its own offset within the island is animated.
      const parent = el.parentElement;
      const parentFrom = parent ? first.get(parent) : undefined;
      const parentTo = parent ? last.get(parent) : undefined;
      const px = parentFrom && parentTo ? parentFrom.left - parentTo.left : 0;
      const py = parentFrom && parentTo ? parentFrom.top - parentTo.top : 0;
      const dx = from.left - to.left - px;
      const dy = from.top - to.top - py;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: 'translate(0, 0)' },
        ],
        { duration: DURATION_MS, easing: SPRING },
      );
    }
  }

  return {
    capture(): void {
      if (before) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      before = snapshot();
      queueMicrotask(() => {
        const first = before;
        before = null;
        if (first) play(first);
      });
    },
  };
}
