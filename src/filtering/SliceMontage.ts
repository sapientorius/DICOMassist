import type { ExportedSlice } from './SliceExporter';

export interface SliceMontage {
  blob: Blob;
  label: string;
  sourceCount: number;
}

/** Creates one low-resolution spatial overview without consuming diagnostic detail pixels. */
export async function createSliceMontage(frames: ExportedSlice[], title: string): Promise<SliceMontage | null> {
  if (!frames.length || typeof createImageBitmap === 'undefined') return null;
  const sources = frames.slice(0, 16);
  const bitmaps = await Promise.all(sources.map((frame) => createImageBitmap(frame.blob)));
  try {
    const columns = Math.min(4, bitmaps.length);
    const tileWidth = 192;
    const tileHeight = 192;
    const headerHeight = 22;
    const rows = Math.ceil(bitmaps.length / columns);
    const canvas = new OffscreenCanvas(columns * tileWidth, rows * (tileHeight + headerHeight));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#9ca3af';
    context.font = '12px sans-serif';
    bitmaps.forEach((bitmap, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * tileWidth;
      const y = row * (tileHeight + headerHeight);
      const scale = Math.min(tileWidth / bitmap.width, tileHeight / bitmap.height);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, x + (tileWidth - width) / 2, y, width, height);
      context.fillText(`Slice ${sources[index].instanceNumber}`, x + 4, y + tileHeight + 15);
    });
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    return { blob, label: `Overview montage — ${title} (${sources.length} sampled slices)`, sourceCount: sources.length };
  } finally {
    bitmaps.forEach((bitmap) => bitmap.close());
  }
}

