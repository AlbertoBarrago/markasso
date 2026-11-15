/**
 * Shrinks an imported image so a live room can carry it. A room refuses any
 * message over 512 KB (see MAX_MSG_BYTES in worker.ts), so an image whose
 * data URL is larger never reaches the others. Used only in a live session:
 * a local drawing keeps the original image.
 */

/** Largest data URL kept for a live session, with room for the command. */
export const LIVE_IMAGE_MAX_CHARS = 380_000;

/** Encoding attempts before giving up, each at 3/4 of the previous size. */
const ATTEMPTS = 8;
const QUALITY = 0.82;

export interface ShrunkImage {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

/** Largest side and area of the working canvas, inside browser limits. */
const MAX_SIDE = 4_096;
const MAX_AREA = 16_000_000;

/**
 * The image re-encoded at the largest size whose data URL fits `maxChars`:
 * JPEG for a JPEG source, PNG for anything else, so transparency is never
 * lost to a guess. Not WebP, which every browser can show but the MCP's PNG
 * export (Resvg) cannot. Null when it fits as it is, when no attempt fits,
 * or when the canvas fails (the room then says so when it refuses it).
 */
export function shrinkForLive(
  image: CanvasImageSource & { naturalWidth: number; naturalHeight: number },
  src: string,
  maxChars = LIVE_IMAGE_MAX_CHARS,
): ShrunkImage | null {
  if (src.length <= maxChars) return null;
  const type = src.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const { naturalWidth: w, naturalHeight: h } = image;
    // Data URL size follows the pixel count: start near the size that
    // fits, within what a canvas can hold.
    let scale = Math.min(
      1,
      Math.sqrt(maxChars / src.length),
      MAX_SIDE / Math.max(w, h),
      Math.sqrt(MAX_AREA / (w * h)),
    );
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const width = Math.max(1, Math.round(w * scale));
      const height = Math.max(1, Math.round(h * scale));
      canvas.width = width;
      canvas.height = height;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
      const encoded =
        type === 'image/jpeg'
          ? canvas.toDataURL(type, QUALITY)
          : canvas.toDataURL(type);
      if (encoded.length <= maxChars) return { src: encoded, width, height };
      scale *= 0.75;
    }
  } catch (error) {
    console.error('Could not shrink the image for the live session', error);
  }
  return null;
}
