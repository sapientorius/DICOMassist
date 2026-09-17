import { describe, expect, it } from 'vitest';
import { formatStructuredAnalysis, parseStructuredAnalysis } from './analysisResults';

describe('structured analysis results', () => {
  it('preserves evidence references and a targeted additional-image request', () => {
    const result = parseStructuredAnalysis(JSON.stringify({
      summary: 'Possible focal signal change.',
      findings: [{ summary: 'Signal change', confidence: 'possible', imageIndices: [2] }],
      limitations: ['Only a sample was provided.'],
      additionalImageRequest: {
        needed: true, reason: 'Need adjacent slices.', selections: [{
          seriesNumber: '1', role: 'supplementary', rationale: 'Clarify extent', sliceRange: [12, 18], samplingStrategy: 'uniform', samplingParam: 5, windowCenter: 40, windowWidth: 400, coverageGoal: 'Adjacent anatomy',
        }],
      },
    }));

    expect(result.additionalImageRequest).toMatchObject({ needed: true, selections: [{ seriesNumber: '1', sliceRange: [12, 18] }] });
    expect(formatStructuredAnalysis(result, ['overview', 'Series 1 Slice 14'])).toContain('Image 2 (Series 1 Slice 14)');
  });

  it('keeps a malformed provider response visible instead of inventing structured findings', () => {
    const result = parseStructuredAnalysis('free text response');
    expect(result.summary).toBe('free text response');
    expect(result.findings).toEqual([]);
    expect(result.additionalImageRequest.needed).toBe(false);
  });
});

