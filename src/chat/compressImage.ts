/**
 * Shrinks a photo to something a 2G line can actually send.
 *
 * Why this exists: the shop accepts up to 10 MB, and a phone's camera happily
 * produces 4–8 MB. A farmer standing at a shelf does not need a 12-megapixel
 * capture to ask "is this the right bag?" — he needs the label legible. The target
 * here is **400 KB**, which keeps printed text and leaf detail readable at the size
 * a chat bubble actually displays, and uploads in seconds instead of minutes.
 *
 * The strategy is adaptive rather than a single blunt setting:
 *
 *   1. an image already under the target is sent untouched — re-encoding it would
 *      only lose quality for no gain;
 *   2. the long edge is capped (1600 px) so an oversized capture is downscaled
 *      before any quality is spent on it;
 *   3. quality is stepped down while the result is still too large, and only when
 *      quality alone cannot get there are the dimensions reduced too.
 *
 * That order matters: downscaling first destroys text, dropping quality first
 * damages smooth areas the eye forgives. Both are tried, in that order, and the
 * first result that fits is kept.
 *
 * Formats: JPEG, PNG and WebP are accepted, which is what the shop's bucket takes.
 * A PNG or WebP is re-encoded as JPEG *only* when it is too large; a small one is
 * passed through so transparency is not silently flattened.
 */

/** The ceiling the requirement names, and the one the app uploads at. */
export const IMAGE_TARGET_BYTES = 400 * 1024;

/** Long edge of the downscaled photo. Enough for a label, small enough to send. */
export const MAX_EDGE_PX = 1600;

/** Tried in order; the first that fits is used. */
export const QUALITY_STEPS = [0.82, 0.72, 0.62, 0.52, 0.44] as const;

/** Each pass shrinks the long edge by this factor before quality is tried again. */
export const DIMENSION_STEP = 0.8;

/** How many resize passes before giving up and returning the smallest attempt. */
const MAX_PASSES = 4;

/** What the shop accepts, and what this module will hand back. */
export const COMPRESSIBLE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type CompressResult = {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  /** What arrived, for the log line and for telling the farmer what happened. */
  originalBytes: number;
  /** Whether the bytes were re-encoded at all. */
  compressed: boolean;
  /** Attempts used, so a test can assert it stops as soon as it fits. */
  passes: number;
};

export type CompressOptions = {
  /** Defaults to `IMAGE_TARGET_BYTES`. */
  maxBytes?: number;
  /** Long-edge cap. Defaults to `MAX_EDGE_PX`. */
  maxEdge?: number;
  /** Mime type the caller recognised, used only to decide whether to re-encode. */
  mimeType?: string | null;
};

/** A size that fits a box, keeping the aspect ratio. Never upscales. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / longest);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The output type: what was recognised, or JPEG for anything unknown. */
export function outputTypeFor(mimeType: string | null | undefined): string {
  const base = (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return (COMPRESSIBLE_TYPES as readonly string[]).includes(base) ? base : 'image/jpeg';
}

/** Whether the format can carry transparency, so it is worth keeping when small. */
export function keepsAlpha(mimeType: string | null | undefined): boolean {
  const base = (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'image/png' || base === 'image/webp';
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

async function loadBitmap(blob: Blob): Promise<{ width: number; height: number; draw: (canvas: HTMLCanvasElement, width: number, height: number) => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (canvas, width, height) => {
        const context = canvas.getContext('2d');
        if (!context) return;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, width, height);
      },
    };
  }

  /*
   * Older WebViews have no `createImageBitmap`. An object URL and an <img> is the
   * same operation with a decode step, which is the cost of the fallback rather
   * than a reason to refuse to compress.
   */
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('The photo could not be read.'));
      element.src = url;
    });
    return {
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      draw: (canvas, width, height) => {
        const context = canvas.getContext('2d');
        if (!context) return;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, width, height);
      },
    };
  } finally {
    /* Freed once drawn: a long chat with many photos must not hold them all. */
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Compresses one photo towards `maxBytes`.
 *
 * Always resolves to something sendable: when the platform cannot encode
 * (`toBlob` missing) or decoding fails, the original blob is returned with
 * `compressed: false`, and the caller's own size check decides what to do. A photo
 * that could not be shrunk must not be reported as shrunk.
 */
export async function compressImage(
  file: Blob,
  { maxBytes = IMAGE_TARGET_BYTES, maxEdge = MAX_EDGE_PX, mimeType }: CompressOptions = {},
): Promise<CompressResult> {
  const originalBytes = file.size;
  const declared = mimeType ?? (file as File).type ?? null;

  /* Already sendable: re-encoding would only cost quality. */
  if (originalBytes <= maxBytes) {
    const bitmap = await loadBitmap(file).catch(() => null);
    return {
      blob: file,
      mimeType: outputTypeFor(declared),
      width: bitmap?.width ?? 0,
      height: bitmap?.height ?? 0,
      originalBytes,
      compressed: false,
      passes: 0,
    };
  }

  if (typeof document === 'undefined') {
    return {
      blob: file,
      mimeType: outputTypeFor(declared),
      width: 0,
      height: 0,
      originalBytes,
      compressed: false,
      passes: 0,
    };
  }

  let source: Awaited<ReturnType<typeof loadBitmap>>;
  try {
    source = await loadBitmap(file);
  } catch {
    return {
      blob: file,
      mimeType: outputTypeFor(declared),
      width: 0,
      height: 0,
      originalBytes,
      compressed: false,
      passes: 0,
    };
  }

  /*
   * A small PNG or WebP keeps its own format: flattening it onto a white canvas
   * would turn a transparent label into a white box. Anything else becomes JPEG,
   * which is what a photograph should be.
   */
  const type = keepsAlpha(declared) && originalBytes <= maxBytes * 2 ? outputTypeFor(declared) : 'image/jpeg';

  let edge = Math.min(maxEdge, Math.max(source.width, source.height));
  let smallest: { blob: Blob; width: number; height: number } | null = null;
  let passes = 0;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const size = fitWithin(source.width, source.height, edge);
    if (size.width === 0 || size.height === 0) break;

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    source.draw(canvas, size.width, size.height);

    for (const quality of QUALITY_STEPS) {
      const blob = await canvasToBlob(canvas, type, quality);
      passes += 1;
      if (!blob) break;
      if (!smallest || blob.size < smallest.blob.size) {
        smallest = { blob, width: size.width, height: size.height };
      }
      if (blob.size <= maxBytes) {
        return {
          blob,
          mimeType: type,
          width: size.width,
          height: size.height,
          originalBytes,
          compressed: true,
          passes,
        };
      }
    }

    /* Quality alone could not fit it: take the dimensions down and try again. */
    edge = Math.round(edge * DIMENSION_STEP);
  }

  if (smallest && smallest.blob.size < originalBytes) {
    return {
      blob: smallest.blob,
      mimeType: type,
      width: smallest.width,
      height: smallest.height,
      originalBytes,
      compressed: true,
      passes,
    };
  }

  return {
    blob: file,
    mimeType: outputTypeFor(declared),
    width: source.width,
    height: source.height,
    originalBytes,
    compressed: false,
    passes,
  };
}
