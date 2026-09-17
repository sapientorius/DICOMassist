import { describe, expect, it } from 'vitest';
import { estimateAnalysisBudget, getProviderAnalysisSettings, normaliseAnalysisSettings } from './analysisConfig';

describe('analysis settings and preflight budget', () => {
  it('provides portable named profiles and a larger Claude context declaration', () => {
    expect(normaliseAnalysisSettings({ profile: 'fast' })).toMatchObject({ maxImages: 8, maxRefinementRounds: 0 });
    expect(normaliseAnalysisSettings({ profile: 'deep' })).toMatchObject({ maxImages: 32, maxRefinementRounds: 2 });
    expect(getProviderAnalysisSettings('claude')).toMatchObject({ contextWindowTokens: 200_000, maxImages: 16 });
  });

  it('reserves enough input capacity even for a very small local context window', () => {
    const settings = normaliseAnalysisSettings({ profile: 'custom', contextWindowTokens: 4096, responseTokenBudget: 4096 });
    expect(settings.responseTokenBudget).toBeLessThan(4096);
    const estimate = estimateAnalysisBudget(settings, 20, 1_150_000);
    expect(estimate.approvedImages).toBeGreaterThan(0);
    expect(estimate.wasAdjusted).toBe(true);
  });

  it('reduces images before exceeding the declared context capacity', () => {
    const estimate = estimateAnalysisBudget({
      profile: 'custom', maxImages: 32, maxImagePixels: 1_150_000, maxRefinementRounds: 2, contextWindowTokens: 8_000, responseTokenBudget: 4_000,
    }, 32, 1_150_000);
    expect(estimate.approvedImages).toBeLessThan(32);
    expect(estimate.estimatedImageTokens).toBeLessThanOrEqual(Math.floor(estimate.availableInputTokens * 0.8));
    expect(estimate.warnings).not.toHaveLength(0);
  });
});

