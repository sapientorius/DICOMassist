import { describe, expect, it } from 'vitest';
import { makeStudy } from '../test/fixtures/study';
import type { SelectionPlan } from './types';
import { fixSelectionPlan } from './useLLMChat';

function plan(overrides: Partial<SelectionPlan> = {}): SelectionPlan {
  return {
    reasoning: 'test', totalImages: 999,
    selections: [{ seriesNumber: '1', role: 'primary', rationale: 'test', sliceRange: [-10, 99], samplingStrategy: 'all', windowCenter: Number.NaN, windowWidth: -1 }],
    targetSeries: '1', sliceRange: [-10, 99], samplingStrategy: 'all', windowCenter: Number.NaN, windowWidth: -1,
    ...overrides,
  };
}

describe('fixSelectionPlan', () => {
  it('locally clamps LLM ranges, applies image budget, and supplies valid windowing', () => {
    const fixed = fixSelectionPlan(plan(), makeStudy());
    expect(fixed.selections).toHaveLength(1);
    expect(fixed.sliceRange).toEqual([1, 30]);
    expect(fixed.samplingStrategy).toBe('uniform');
    expect(fixed.samplingParam).toBe(20);
    expect(fixed.windowCenter).toBe(40);
    expect(fixed.windowWidth).toBe(400);
  });

  it('rejects plans that reference no locally available series', () => {
    expect(() => fixSelectionPlan(plan({ selections: [{ ...plan().selections[0], seriesNumber: '404' }] }), makeStudy())).toThrow('valid series');
  });
});
