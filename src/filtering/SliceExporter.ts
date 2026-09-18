import { imageLoader, utilities } from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/core';
import type { SeriesMetadata } from '../dicom/types';
import type { NormalizedCrop, RenderSpec } from '../llm/types';
import type { SelectedSlice } from './types';

type IImage = Types.IImage;

const DEFAULT_MAX_IMAGE_PIXELS = 1_150_000;
const JPEG_QUALITY = 0.9;

export interface SliceExportOptions {
  maxImagePixels?: number;
  windowLabel?: string;
  /** Crop in normalized source-image coordinates. Applied before resizing/JPEG encoding. */
  crop?: NormalizedCrop;
}

export interface ResolvedRenderSpec {
  label: string;
  windowCenter: number;
  windowWidth: number;
  /** Stable rendering identity; callers must use this rather than a human label for deduplication. */
  key: string;
}

export interface ExportedSlice {
  blob: Blob;
  instanceNumber: number;
  zPosition: number;
  width: number;
  height: number;
  pixelCount: number;
  contrast: number;
  windowCenter: number;
  windowWidth: number;
  windowLabel?: string;
  crop?: NormalizedCrop;
  renderPath: 'cornerstone' | 'fallback';
}

const SERIES_WINDOW_CACHE = new Map<string, Promise<{ windowCenter: number; windowWidth: number }>>();

export async function exportSlicesToJpeg(
  slices: SelectedSlice[],
  windowCenter: number,
  windowWidth: number,
  options: SliceExportOptions = {},
): Promise<ExportedSlice[]> {
  const results: ExportedSlice[] = [];
  for (const slice of slices) {
    const exported = await renderSliceToJpeg(slice.imageId, slice.instanceNumber, slice.zPosition, windowCenter, windowWidth, options);
    if (exported) results.push(exported);
  }
  return results;
}

export function calculateExportDimensions(width: number, height: number, maxPixels: number): [number, number] {
  const pixels = width * height;
  if (pixels <= maxPixels) return [width, height];
  const scale = Math.sqrt(maxPixels / pixels);
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export function calculatePercentileWindow(values: number[], lowPercentile: number, highPercentile: number): { windowCenter: number; windowWidth: number } | null {
  if (!values.length || !Number.isFinite(lowPercentile) || !Number.isFinite(highPercentile)) return null;
  const low = Math.max(0, Math.min(100, lowPercentile));
  const high = Math.max(0, Math.min(100, highPercentile));
  if (low >= high) return null;
  const sorted = [...values].filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const at = (percentile: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(((sorted.length - 1) * percentile) / 100)))];
  const minimum = at(low);
  const maximum = at(high);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) return null;
  return { windowCenter: (minimum + maximum) / 2, windowWidth: maximum - minimum };
}

async function getSeriesPercentileWindow(series: SeriesMetadata, lowPercentile: number, highPercentile: number): Promise<{ windowCenter: number; windowWidth: number }> {
  const key = `${series.seriesInstanceUID}:${lowPercentile}:${highPercentile}`;
  const cached = SERIES_WINDOW_CACHE.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const samples: number[] = [];
    const maxSourceSlices = 24;
    const step = Math.max(1, Math.ceil(series.slices.length / maxSourceSlices));
    for (let index = 0; index < series.slices.length; index += step) {
      try {
        const image = await imageLoader.loadAndCacheImage(series.slices[index].imageId) as IImage;
        const pixels = image.getPixelData();
        const pixelStep = Math.max(1, Math.ceil(pixels.length / 4096));
        const slope = image.slope ?? 1;
        const intercept = image.intercept ?? 0;
        for (let pixelIndex = 0; pixelIndex < pixels.length; pixelIndex += pixelStep) samples.push(Number(pixels[pixelIndex]) * slope + intercept);
      } catch {
        // A partial histogram is still preferable to refusing a requested render.
      }
    }
    return calculatePercentileWindow(samples, lowPercentile, highPercentile)
      ?? { windowCenter: series.windowCenter ?? 40, windowWidth: series.windowWidth ?? 400 };
  })();
  SERIES_WINDOW_CACHE.set(key, pending);
  return pending;
}

/** Resolve a model-facing display request to concrete DICOM windowing values. */
export async function resolveRenderSpec(series: SeriesMetadata, spec: RenderSpec): Promise<ResolvedRenderSpec> {
  if (spec.mode === 'window-level') {
    return { label: spec.label || `W ${Math.round(spec.windowWidth)} C ${Math.round(spec.windowCenter)}`, windowCenter: spec.windowCenter, windowWidth: spec.windowWidth, key: `wl:${spec.windowCenter}:${spec.windowWidth}` };
  }
  if (spec.mode === 'series-percentile') {
    const window = await getSeriesPercentileWindow(series, spec.lowPercentile, spec.highPercentile);
    return { label: spec.label || `P${spec.lowPercentile}–P${spec.highPercentile}`, ...window, key: `pct:${spec.lowPercentile}:${spec.highPercentile}` };
  }
  if (spec.mode === 'relative-display') {
    const base = series.windowWidth && series.windowCenter != null
      ? { windowCenter: series.windowCenter, windowWidth: series.windowWidth }
      : await getSeriesPercentileWindow(series, 1, 99);
    const contrastMultiplier = spec.contrast === 'higher' ? 0.65 : spec.contrast === 'lower' ? 1.5 : 1;
    const width = Math.max(1, base.windowWidth * contrastMultiplier);
    const centerOffset = spec.brightness === 'brighter' ? -width * 0.15 : spec.brightness === 'darker' ? width * 0.15 : 0;
    return {
      label: spec.label || `${spec.brightness}, ${spec.contrast} contrast`,
      windowCenter: base.windowCenter + centerOffset,
      windowWidth: width,
      key: `relative:${spec.brightness}:${spec.contrast}`,
    };
  }
  const windowCenter = series.windowCenter ?? (await getSeriesPercentileWindow(series, 1, 99)).windowCenter;
  const windowWidth = series.windowWidth ?? (await getSeriesPercentileWindow(series, 1, 99)).windowWidth;
  return { label: spec.label || 'DICOM default', windowCenter, windowWidth, key: 'dicom-default' };
}

async function canvasToJpeg(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob | null> {
  if (canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', JPEG_QUALITY));
}

function getContrast(canvas: HTMLCanvasElement | OffscreenCanvas): number {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return 0;
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let minimum = 255;
  let maximum = 0;
  for (let index = 0; index < imageData.length; index += 4) {
    const value = imageData[index];
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return maximum - minimum;
}

async function resizeCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, maxPixels: number): Promise<HTMLCanvasElement | OffscreenCanvas> {
  const [width, height] = calculateExportDimensions(canvas.width, canvas.height, maxPixels);
  if (width === canvas.width && height === canvas.height) return canvas;
  const resized = new OffscreenCanvas(width, height);
  const context = resized.getContext('2d');
  if (!context) return canvas;
  context.drawImage(canvas as CanvasImageSource, 0, 0, width, height);
  return resized;
}

export function normaliseCrop(crop: NormalizedCrop | undefined): NormalizedCrop | undefined {
  if (!crop) return undefined;
  const [left, top, width, height] = crop.rect;
  if (![left, top, width, height].every(Number.isFinite) || left < 0 || top < 0 || width <= 0 || height <= 0) return undefined;
  const clampedLeft = Math.min(1, left);
  const clampedTop = Math.min(1, top);
  const clampedWidth = Math.min(1 - clampedLeft, width);
  const clampedHeight = Math.min(1 - clampedTop, height);
  return clampedWidth > 0 && clampedHeight > 0 ? { rect: [clampedLeft, clampedTop, clampedWidth, clampedHeight] } : undefined;
}

async function cropCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, crop: NormalizedCrop | undefined): Promise<HTMLCanvasElement | OffscreenCanvas> {
  const normalized = normaliseCrop(crop);
  if (!normalized) return canvas;
  const [left, top, width, height] = normalized.rect;
  const sourceX = Math.round(left * canvas.width);
  const sourceY = Math.round(top * canvas.height);
  const sourceWidth = Math.max(1, Math.round(width * canvas.width));
  const sourceHeight = Math.max(1, Math.round(height * canvas.height));
  const target = new OffscreenCanvas(sourceWidth, sourceHeight);
  const context = target.getContext('2d');
  if (!context) return canvas;
  context.drawImage(canvas as CanvasImageSource, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
  return target;
}

/**
 * Cornerstone's CPU renderer applies the image's Modality/VOI LUT and
 * photometric settings. It is used for export first; the explicit fallback
 * makes image transfer resilient on browsers that cannot create a temporary
 * Cornerstone rendering surface.
 */
async function renderWithCornerstone(image: IImage, windowCenter: number, windowWidth: number): Promise<HTMLCanvasElement | null> {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = image.columns;
  canvas.height = image.rows;
  const renderingImage = { ...image, windowCenter, windowWidth } as IImage;
  try {
    await utilities.renderToCanvasCPU(canvas, renderingImage);
    return canvas;
  } catch {
    return null;
  }
}

function renderFallback(image: IImage, windowCenter: number, windowWidth: number): OffscreenCanvas | null {
  const width = image.columns;
  const height = image.rows;
  if (!width || !height) return null;
  const pixelData = image.getPixelData();
  const slope = image.slope ?? 1;
  const intercept = image.intercept ?? 0;
  const lower = windowCenter - windowWidth / 2;
  const upper = windowCenter + windowWidth / 2;
  const invert = image.invert || image.photometricInterpretation === 'MONOCHROME1';
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < Math.min(pixelData.length, width * height); index++) {
    const modalityValue = Number(pixelData[index]) * slope + intercept;
    let value = modalityValue <= lower ? 0 : modalityValue >= upper ? 255 : ((modalityValue - lower) / Math.max(windowWidth, 1)) * 255;
    if (invert) value = 255 - value;
    const offset = index * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

async function renderSliceToJpeg(
  imageId: string,
  instanceNumber: number,
  zPosition: number,
  windowCenter: number,
  windowWidth: number,
  options: SliceExportOptions,
): Promise<ExportedSlice | null> {
  const image = await imageLoader.loadAndCacheImage(imageId) as IImage;
  const maxPixels = Math.max(1, Math.round(options.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS));
  let canvas: HTMLCanvasElement | OffscreenCanvas | null = await renderWithCornerstone(image, windowCenter, windowWidth);
  const renderPath: ExportedSlice['renderPath'] = canvas ? 'cornerstone' : 'fallback';
  if (!canvas) canvas = renderFallback(image, windowCenter, windowWidth);
  if (!canvas) return null;
  const cropped = await cropCanvas(canvas, options.crop);
  const resized = await resizeCanvas(cropped, maxPixels);
  const blob = await canvasToJpeg(resized);
  if (!blob) return null;
  return {
    blob,
    instanceNumber,
    zPosition,
    width: resized.width,
    height: resized.height,
    pixelCount: resized.width * resized.height,
    contrast: getContrast(resized),
    windowCenter,
    windowWidth,
    windowLabel: options.windowLabel,
    crop: normaliseCrop(options.crop),
    renderPath,
  };
}
