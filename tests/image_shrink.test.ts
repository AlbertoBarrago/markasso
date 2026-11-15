import { afterEach, describe, expect, it, vi } from 'vitest';
import { shrinkForLive } from '../src/ui/image_shrink';

/** A canvas whose encoded size follows its pixel count, like a real one. */
function fakeCanvas(options: { failDraw?: boolean } = {}) {
  const canvas = {
    width: 0,
    height: 0,
    encoded: [] as string[],
    getContext: () => ({
      clearRect: () => {},
      drawImage: () => {
        if (options.failDraw) throw new Error('canvas too large');
      },
    }),
    toDataURL: (type: string) => {
      const prefix = `data:${type};base64,`;
      canvas.encoded.push(prefix);
      return prefix + 'x'.repeat(canvas.width * canvas.height);
    },
  };
  vi.stubGlobal('document', { createElement: () => canvas });
  return canvas;
}

const photo = { naturalWidth: 2000, naturalHeight: 1000 } as HTMLImageElement;
const bigPng = `data:image/png;base64,${'x'.repeat(2_000_000)}`;
const bigJpeg = `data:image/jpeg;base64,${'x'.repeat(2_000_000)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('shrinkForLive', () => {
  it('leaves an image that already fits as it is', () => {
    fakeCanvas();
    expect(shrinkForLive(photo, 'data:image/png;base64,xx', 1_000)).toBeNull();
  });

  it('re-encodes a JPEG as JPEG within the limit, same aspect', () => {
    const canvas = fakeCanvas();
    const shrunk = shrinkForLive(photo, bigJpeg, 380_000)!;
    expect(shrunk.src.startsWith('data:image/jpeg')).toBe(true);
    expect(shrunk.src.length).toBeLessThanOrEqual(380_000);
    expect(shrunk.width / shrunk.height).toBeCloseTo(2, 1);
    // Never WebP, which the MCP's PNG export cannot read.
    expect(canvas.encoded.some((p) => p.includes('webp'))).toBe(false);
  });

  it('keeps any other source as PNG, so transparency survives', () => {
    fakeCanvas();
    const shrunk = shrinkForLive(photo, bigPng, 380_000)!;
    expect(shrunk.src.startsWith('data:image/png')).toBe(true);
    expect(shrunk.src.length).toBeLessThanOrEqual(380_000);
  });

  it('bounds the working canvas for a huge image', () => {
    const canvas = fakeCanvas();
    const huge = {
      naturalWidth: 20_000,
      naturalHeight: 10_000,
    } as HTMLImageElement;
    const sizes: number[] = [];
    const toDataURL = canvas.toDataURL;
    canvas.toDataURL = (type: string) => {
      sizes.push(Math.max(canvas.width, canvas.height));
      return toDataURL(type);
    };
    shrinkForLive(
      huge,
      `data:image/png;base64,${'x'.repeat(400_000)}`,
      380_000,
    );
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4_096);
  });

  it('falls back to the original when the canvas fails', () => {
    fakeCanvas({ failDraw: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(shrinkForLive(photo, bigPng, 380_000)).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});
