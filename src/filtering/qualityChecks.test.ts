import { describe, expect, it } from 'vitest';
import { makeSeries, makeStudy } from '../test/fixtures/study';
import type { SelectionPlan } from '../llm/types';
import { inspectPlanQuality } from './qualityChecks';

const plan: SelectionPlan = {
  reasoning: 'test', totalImages: 2, targetSeries: '1', sliceRange: [1, 2], samplingStrategy: 'uniform', samplingParam: 2, windowCenter: 40, windowWidth: 400,
  selections: [{ seriesNumber: '1', role: 'primary', rationale: 'test', sliceRange: [1, 2], samplingStrategy: 'uniform', samplingParam: 2, windowCenter: 40, windowWidth: 400 }],
};

describe('plan quality checks', () => {
  it('warns about scout and duplicate-position series before export', () => {
    const series = makeSeries({ isScout: true, slices: [
      { instanceNumber: 1, imageId: 'a', imagePositionPatient: [0, 0, 0], imageOrientationPatient: [1, 0, 0, 0, 1, 0], positionAlongNormal: 0 },
      { instanceNumber: 2, imageId: 'b', imagePositionPatient: [0, 0, 0], imageOrientationPatient: [1, 0, 0, 0, 1, 0], positionAlongNormal: 0 },
    ], instanceNumberRange: [1, 2] });
    const warnings = inspectPlanQuality(makeStudy([series]), plan);
    expect(warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(['scout', 'duplicate-position']));
  });
});

