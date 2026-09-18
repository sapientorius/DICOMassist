import { describe, expect, it } from 'vitest';
import { buildAnalysisSystemPrompt, buildFinalAnalysisSystemPrompt } from './PromptBuilder';

describe('analysis refinement prompt', () => {
  it('makes retrieval rounds maintain an internal evidence ledger instead of a user-facing report', () => {
    const prompt = buildAnalysisSystemPrompt(false, {
      refinementRound: 2,
      remainingRefinementRounds: 3,
      remainingImageBudget: 37,
      maxNewImages: 12,
    });

    expect(prompt).toContain('## EVIDENCE LEDGER');
    expect(prompt).toContain('internal retrieval round');
    expect(prompt).toContain('Preserve an existing ledger entry ID');
    expect(prompt).toContain('at most 12 material entries');
  });

  it('requires a concrete image request for sampling-based limitations while capacity remains', () => {
    const prompt = buildAnalysisSystemPrompt(false, {
      refinementRound: 0,
      remainingRefinementRounds: 5,
      remainingImageBudget: 60,
      maxNewImages: 12,
    });

    expect(prompt).toContain('## FINALITY GATE — APPLY BEFORE CHOOSING nextAction');
    expect(prompt).toContain('If ANY check fails and image slots/rounds remain, you MUST set nextAction to "request_images".');
    expect(prompt).toContain('Use a concrete, executable request');
    expect(prompt).toContain('The client retrieves requested images locally');
    expect(prompt).toContain('5 round(s), 60 total image slot(s), and 12 new image slot(s) are available now.');
  });

  it('forbids further retrieval after the final round or budget is exhausted', () => {
    const prompt = buildAnalysisSystemPrompt(false, {
      refinementRound: 5,
      remainingRefinementRounds: 0,
      remainingImageBudget: 0,
      maxNewImages: 0,
    });

    expect(prompt).toContain('No additional image rounds or image slots remain. Set nextAction to complete.');
  });

  it('reserves a single self-contained report for final synthesis', () => {
    const prompt = buildFinalAnalysisSystemPrompt(false);

    expect(prompt).toContain('ONE self-contained assessment');
    expect(prompt).toContain('Do NOT refer to previous rounds');
    expect(prompt).toContain('evidence ledger itself');
    expect(prompt).toContain('summary: string');
  });
});
