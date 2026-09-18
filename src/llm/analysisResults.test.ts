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

  it('parses direct image retrieval requests with all supported targeting modes', () => {
    const requests = [
      { kind: 'instances', seriesInstanceUID: 'series-a', instanceNumbers: [10, 12], renderings: [{ mode: 'window-level', windowCenter: 50, windowWidth: 120 }] },
      { kind: 'neighbours', sourceImageIndex: 2, before: 2, after: 3, renderings: [{ mode: 'relative-display', brightness: 'brighter', contrast: 'higher' }] },
      { kind: 'crop', sourceImageIndex: 3, rect: [0.2, 0.1, 0.5, 0.6], renderings: [{ mode: 'series-percentile', lowPercentile: 1, highPercentile: 99 }] },
      { kind: 'cross-plane', sourceImageIndex: 4, targetSeriesInstanceUID: 'series-b', neighbours: 1, renderings: [{ mode: 'dicom-default' }] },
    ];
    const result = parseStructuredAnalysis(JSON.stringify({
      nextAction: 'request_images', summary: '', findings: [], limitations: [],
      imageRequest: {
        reason: 'Need targeted image detail.',
        requestsJson: JSON.stringify(requests),
      },
    }));

    expect(result.nextAction).toBe('request_images');
    expect(result.imageRequest?.requests.map((request) => request.kind)).toEqual(['instances', 'neighbours', 'crop', 'cross-plane']);
    expect(result.imageRequest?.requests[2]).toMatchObject({ rect: [0.2, 0.1, 0.5, 0.6] });
  });

  it('keeps a malformed provider response visible instead of inventing structured findings', () => {
    const result = parseStructuredAnalysis('free text response');
    expect(result.summary).toBe('free text response');
    expect(result.findings).toEqual([]);
    expect(result.additionalImageRequest.needed).toBe(false);
  });
});
