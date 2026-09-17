import { describe, expect, it } from 'vitest';
import { selectOverviewSlices, selectSlicesForSelection } from './SliceSelector';
import { makeStudy } from '../test/fixtures/study';

describe('selectSlicesForSelection', () => {
  it('samples the inclusive requested instance range uniformly', () => {
    const selected = selectSlicesForSelection(makeStudy(), {
      seriesNumber: '1', role: 'primary', rationale: 'test', sliceRange: [1, 30],
      samplingStrategy: 'uniform', samplingParam: 4, windowCenter: 40, windowWidth: 400,
    });
    expect(selected.map((slice) => slice.instanceNumber)).toEqual([1, 11, 20, 30]);
  });

  it('returns the middle slice with its image ID when one uniform image is requested', () => {
    const selected = selectSlicesForSelection(makeStudy(), {
      seriesNumber: '1', role: 'primary', rationale: 'test', sliceRange: [1, 30],
      samplingStrategy: 'uniform', samplingParam: 1, windowCenter: 40, windowWidth: 400,
    });

    expect(selected).toEqual([expect.objectContaining({ instanceNumber: 15, imageId: 'image-15' })]);
  });

  it('uses the same middle-slice behavior for a one-image overview', () => {
    const selected = selectOverviewSlices(makeStudy(), '1', 1);

    expect(selected).toEqual([expect.objectContaining({ instanceNumber: 15, imageId: 'image-15' })]);
  });

  it('caps unrestricted selections at twenty images', () => {
    const selected = selectSlicesForSelection(makeStudy(), {
      seriesNumber: '1', role: 'primary', rationale: 'test', sliceRange: [1, 30],
      samplingStrategy: 'all', windowCenter: 40, windowWidth: 400,
    });
    expect(selected).toHaveLength(20);
    expect(selected[0].instanceNumber).toBe(1);
    expect(selected.at(-1)?.instanceNumber).toBe(30);
  });
});
