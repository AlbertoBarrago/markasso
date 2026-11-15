/**
 * The same angle within [-π, π): a rotation that keeps accumulating across
 * drags or remote commands would otherwise leave the ±2π range that
 * `element_validation` accepts, and the element would be dropped on reload.
 */
export function normalizeRotation(rotation: number): number {
  return rotation - 2 * Math.PI * Math.round(rotation / (2 * Math.PI));
}

/** Returns the top-left corner and positive dimensions of a signed rectangle. */
export function normalizeRect(rect: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): { x: number; y: number; w: number; h: number } {
  return {
    x: rect.width < 0 ? rect.x + rect.width : rect.x,
    y: rect.height < 0 ? rect.y + rect.height : rect.y,
    w: Math.abs(rect.width),
    h: Math.abs(rect.height),
  };
}
