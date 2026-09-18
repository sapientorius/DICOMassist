import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeStudy } from '../test/fixtures/study';
import { createLLMService } from './LLMServiceFactory';
import type { ProviderConfig, SelectionPlan } from './types';

const plan: SelectionPlan = {
  reasoning: 'Test selection.', totalImages: 1, targetSeries: '1', sliceRange: [1, 1],
  samplingStrategy: 'uniform', samplingParam: 1, windowCenter: 40, windowWidth: 400,
  selections: [{
    seriesNumber: '1', role: 'primary', rationale: 'Test selection.', sliceRange: [1, 1],
    samplingStrategy: 'uniform', samplingParam: 1, windowCenter: 40, windowWidth: 400,
  }],
};

function claudeResponse(content: Array<Record<string, unknown>>, stopReason = 'end_turn'): Response {
  return {
    ok: true,
    json: async () => ({ content, stop_reason: stopReason }),
  } as Response;
}

describe('Claude structured image analysis', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('disables default Sonnet 5 thinking and recovers once from a response without text', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(claudeResponse([{ type: 'thinking' }], 'max_tokens'))
      .mockResolvedValueOnce(claudeResponse([{
        type: 'text', text: JSON.stringify({
          nextAction: 'complete', summary: 'Recovered structured result.', findings: [], limitations: [], imageRequest: null,
        }),
      }]));
    vi.stubGlobal('fetch', fetchMock);
    const config: ProviderConfig = {
      provider: 'claude',
      profiles: { claude: { apiKey: 'test-key', textModel: 'claude-sonnet-5', visionModel: 'claude-sonnet-5' } },
    };

    const result = await createLLMService(config).analyzeSlices(
      [new Blob(['jpeg'])], makeStudy(), 'Evaluate target.', plan, ['Series #1 Slice 1/30'], false,
    );

    expect(result.summary).toBe('Recovered structured result.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const retryRequest = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(firstRequest.thinking).toEqual({ type: 'disabled' });
    expect(retryRequest.system).toContain('RECOVERY: Your previous response was empty');
  });
});
