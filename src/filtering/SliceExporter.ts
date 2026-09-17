import { imageLoader, utilities } from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/core';
import type { SelectedSlice } from './types';

type IImage = Types.IImage;

const DEFAULT_MAX_IMAGE_PIXELS = 1_150_000;
const JPEG_QUALITY = 0.9;

export interface SliceExportOptions {
  maxImagePixels?: number;
  windowLabel?: string;
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
  renderPath: 'cornerstone' | 'fallback';
}

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
  const resized = await resizeCanvas(canvas, maxPixels);
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
    renderPath,
  };
}
