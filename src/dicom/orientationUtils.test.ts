import { describe, expect, it } from 'vitest';
import { detectPlaneFromOrientation, positionAlongNormal, sliceNormalFromOrientation } from './orientationUtils';

describe('orientation helpers', () => {
  it('classifies orthogonal acquisition planes', () => {
    expect(detectPlaneFromOrientation('1\\0\\0\\0\\1\\0')).toBe('axial');
    expect(detectPlaneFromOrientation('0\\1\\0\\0\\0\\1')).toBe('sagittal');
    expect(detectPlaneFromOrientation('1\\0\\0\\0\\0\\1')).toBe('coronal');
  });

  it('does not mislabel an oblique acquisition as an anatomical cardinal plane', () => {
    expect(detectPlaneFromOrientation('1\\0\\0\\0\\0.866\\0.5')).toBe('oblique');
  });

  it('projects locations onto the normalized slice normal', () => {
    const normal = sliceNormalFromOrientation([1, 0, 0, 0, 0, 1]);
    expect(normal).toEqual([0, -1, 0]);
    expect(positionAlongNormal([0, 12, 0], normal)).toBe(-12);
  });
});
