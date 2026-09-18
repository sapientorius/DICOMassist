import { describe, expect, it } from 'vitest';
import { makeStudy } from '../test/fixtures/study';
import type { AdditionalImageRequest, SelectionPlan } from './types';
import { assertVisionPayloadFits, canRunRefinement, fixSelectionPlan } from './useLLMChat';

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

  it('accounts for alternate display windows inside the configured image budget', () => {
    const fixed = fixSelectionPlan(plan({
      selections: [{
        ...plan().selections[0], sliceRange: [1, 30], samplingStrategy: 'all',
        displayWindows: [{ label: 'Lung', windowCenter: -600, windowWidth: 1500 }],
      }],
    }), makeStudy(), 6);
    expect(fixed.totalImages).toBeLessThanOrEqual(6);
    expect(fixed.selections[0].samplingParam).toBe(3);
    expect(fixed.selections[0].displayWindows).toHaveLength(1);
  });

  it('permits at most the configured number of targeted refinement rounds', () => {
    const request: AdditionalImageRequest = { needed: true, selections: [{ ...plan().selections[0], sliceRange: [10, 12] }] };
    expect(canRunRefinement(request, 0, 2, 4)).toBe(true);
    expect(canRunRefinement(request, 1, 2, 4)).toBe(true);
    expect(canRunRefinement(request, 2, 2, 4)).toBe(false);
    expect(canRunRefinement(request, 0, 2, 0)).toBe(false);
  });

  it('checks the actual rendered blob payload before a provider request', () => {
    expect(() => assertVisionPayloadFits([new Blob(['small'])], 'claude')).not.toThrow();
    expect(() => assertVisionPayloadFits([new Blob([new Uint8Array(20 * 1024 * 1024 + 1)])], 'openai')).toThrow('above the 20MB openai limit');
  });
});
