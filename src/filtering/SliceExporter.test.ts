import { describe, expect, it } from 'vitest';
import { calculateExportDimensions, calculatePercentileWindow, normaliseCrop } from './SliceExporter';

describe('DICOM image export dimensions', () => {
  it('enforces a pixel budget without upscaling small source images', () => {
    expect(calculateExportDimensions(512, 512, 1_150_000)).toEqual([512, 512]);
    const [width, height] = calculateExportDimensions(2048, 2048, 1_150_000);
    expect(width * height).toBeLessThanOrEqual(1_150_000 + 5_000);
    expect(width).toBe(height);
  });

  it('derives robust windowing and keeps crops within source bounds', () => {
    expect(calculatePercentileWindow([0, 10, 20, 30, 1000], 0, 75)).toEqual({ windowCenter: 15, windowWidth: 30 });
    expect(calculatePercentileWindow([1, 1], 1, 99)).toBeNull();
    expect(normaliseCrop({ rect: [0.8, 0.8, 0.5, 0.5] })).toEqual({ rect: [0.8, 0.8, 0.19999999999999996, 0.19999999999999996] });
    expect(normaliseCrop({ rect: [0, 0, 0, 1] })).toBeUndefined();
  });
});
