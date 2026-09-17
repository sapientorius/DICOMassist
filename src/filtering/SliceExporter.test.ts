import { describe, expect, it } from 'vitest';
import { calculateExportDimensions } from './SliceExporter';

describe('DICOM image export dimensions', () => {
  it('enforces a pixel budget without upscaling small source images', () => {
    expect(calculateExportDimensions(512, 512, 1_150_000)).toEqual([512, 512]);
    const [width, height] = calculateExportDimensions(2048, 2048, 1_150_000);
    expect(width * height).toBeLessThanOrEqual(1_150_000 + 5_000);
    expect(width).toBe(height);
  });
});

