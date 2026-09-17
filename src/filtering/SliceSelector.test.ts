import { describe, expect, it } from 'vitest';
import { selectSlicesForSelection } from './SliceSelector';
import { makeStudy } from '../test/fixtures/study';

describe('selectSlicesForSelection', () => {
  it('samples the inclusive requested instance range uniformly', () => {
    const selected = selectSlicesForSelection(makeStudy(), {
      seriesNumber: '1', role: 'primary', rationale: 'test', sliceRange: [1, 30],
      samplingStrategy: 'uniform', samplingParam: 4, windowCenter: 40, windowWidth: 400,
    });
    expect(selected.map((slice) => slice.instanceNumber)).toEqual([1, 11, 20, 30]);
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
