import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudyMetadata } from '../dicom/types';
import { createLLMService, fetchProviderModels } from './LLMServiceFactory';
import { getProviderProfile, migrateProviderConfig } from './providerConfig';
import type { ProviderConfig } from './types';

const metadata: StudyMetadata = {
  studyDescription: 'Test study',
  modality: 'CT',
  primarySeriesUID: 'series-1',
  series: [],
};

const selectionPlanJson = JSON.stringify({
  targetSeries: '1',
  sliceRange: [1, 4],
  samplingStrategy: 'uniform',
  samplingParam: 4,
  windowCenter: 40,
  windowWidth: 400,
  reasoning: 'test',
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('provider configuration migration', () => {
  it('retains legacy Claude and Ollama values in provider profiles', () => {
    const config = migrateProviderConfig({
      provider: 'claude',
      apiKey: 'legacy-claude-key',
      ollamaUrl: 'http://127.0.0.1:11434',
      ollamaTextModel: 'planner',
      ollamaVisionModel: 'vision',
    });

    expect(config.provider).toBe('claude');
    expect(getProviderProfile(config, 'claude').apiKey).toBe('legacy-claude-key');
    expect(getProviderProfile(config, 'ollama')).toMatchObject({
      baseUrl: 'http://127.0.0.1:11434',
      textModel: 'planner',
      visionModel: 'vision',
    });
  });
});

describe('provider model catalogues', () => {
  it('normalizes and marks OpenRouter image-capable models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: 'vendor/text', name: 'Text only', architecture: { input_modalities: ['text'] } },
        { id: 'vendor/vision', name: 'Vision', architecture: { input_modalities: ['text', 'image'] } },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProviderModels('openrouter', { apiKey: 'router-key' })).resolves.toEqual([
      { id: 'vendor/text', label: 'Text only (vendor/text)', supportsVision: false },
      { id: 'vendor/vision', label: 'Vision (vendor/vision)', supportsVision: true },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer router-key' }) }),
    );
  });

  it('reports missing credentials and unreachable LM Studio servers clearly', async () => {
    await expect(fetchProviderModels('openrouter', {})).rejects.toThrow('OpenRouter API key is required');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(fetchProviderModels('lmstudio', { baseUrl: 'http://localhost:1234/v1' })).rejects.toThrow(
      'Cannot load the LM Studio (Local) model catalogue',
    );
  });
});

describe('OpenAI-compatible provider requests', () => {
  const config: ProviderConfig = {
    provider: 'openai',
    profiles: {
      openai: { apiKey: 'openai-key', textModel: 'planner-model', visionModel: 'vision-model' },
    },
  };

  it('uses the configured text and vision models for each pipeline call', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: selectionPlanJson } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'analysis' } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'follow-up' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = createLLMService(config);
    const plan = await service.getSelectionPlan(metadata, 'look for a finding');
    expect(plan).toMatchObject({ targetSeries: '1' });
    await expect(service.analyzeSlices([new Blob(['jpeg'])], metadata, 'hint', plan, ['Slice 1'])).resolves.toBe('analysis');
    await expect(service.sendFollowUp([{ id: '1', role: 'user', content: 'Explain more', timestamp: 1 }], metadata)).resolves.toBe('follow-up');

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const analysisBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const followUpBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);

    expect(firstBody.model).toBe('planner-model');
    expect(analysisBody.model).toBe('vision-model');
    expect(analysisBody.messages[1].content[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(followUpBody.model).toBe('planner-model');
  });

  it('requires both model roles for cloud providers', () => {
    expect(() => createLLMService({
      provider: 'openai',
      profiles: { openai: { apiKey: 'openai-key', textModel: 'planner-only' } },
    })).toThrow('Select a vision model for OpenAI');
  });
});
