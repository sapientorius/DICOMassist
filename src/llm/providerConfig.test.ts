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

const structuredAnalysisJson = JSON.stringify({
  nextAction: 'complete',
  summary: 'analysis',
  findings: [{ summary: 'finding', confidence: 'probable', imageIndices: [1] }],
  limitations: ['sampled images'],
  evidenceLedger: { entriesJson: '[]' },
  imageRequest: null,
  additionalImageRequest: { needed: false, reason: '', selections: [] },
});

const finalAnalysisJson = JSON.stringify({
  summary: 'final analysis',
  findings: [{ summary: 'final finding', confidence: 'probable', imageIndices: [1] }],
  limitations: ['sampled evidence'],
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: structuredAnalysisJson } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: finalAnalysisJson } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'follow-up' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = createLLMService(config);
    const plan = await service.getSelectionPlan(metadata, 'look for a finding');
    expect(plan).toMatchObject({ targetSeries: '1' });
    await expect(service.analyzeSlices([new Blob(['jpeg'])], metadata, 'hint', plan, ['Slice 1'])).resolves.toMatchObject({
      summary: 'analysis', findings: [{ confidence: 'probable', imageIndices: [1] }],
    });
    await expect(service.synthesizeFinalAnalysis([new Blob(['jpeg'])], metadata, 'hint', plan, ['[asset-1] Slice 1'], { entries: [] })).resolves.toMatchObject({
      summary: 'final analysis', findings: [{ confidence: 'probable', imageIndices: [1] }],
    });
    await expect(service.sendFollowUp([{ id: '1', role: 'user', content: 'Explain more', timestamp: 1 }], metadata)).resolves.toBe('follow-up');

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const analysisBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const finalBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    const followUpBody = JSON.parse(fetchMock.mock.calls[3][1].body as string);

    expect(firstBody.model).toBe('planner-model');
    expect(analysisBody.model).toBe('vision-model');
    expect(analysisBody.messages[1].content[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(finalBody.model).toBe('vision-model');
    expect(finalBody.messages[0].content).toContain('final user-facing synthesis');
    expect(followUpBody.model).toBe('planner-model');
  });

  it('requires both model roles for cloud providers', () => {
    expect(() => createLLMService({
      provider: 'openai',
      profiles: { openai: { apiKey: 'openai-key', textModel: 'planner-only' } },
    })).toThrow('Select a vision model for OpenAI');
  });
});

describe('Ollama request budgets', () => {
  it('passes the configured context and response budget to local inference', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: selectionPlanJson } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: structuredAnalysisJson } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: finalAnalysisJson } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createLLMService({
      provider: 'ollama',
      profiles: { ollama: { textModel: 'planner', visionModel: 'vision' } },
    });
    const settings = { profile: 'custom' as const, maxImages: 12, maxImagePixels: 786_432, maxRefinementRounds: 1, contextWindowTokens: 32_768, responseTokenBudget: 3_072 };
    const plan = await service.getSelectionPlan(metadata, 'look for a finding', undefined, settings);
    await service.analyzeSlices([new Blob(['jpeg'])], metadata, 'hint', plan, ['Slice 1'], false, { settings, refinementRound: 0, remainingRefinementRounds: 1 });
    await service.synthesizeFinalAnalysis([new Blob(['jpeg'])], metadata, 'hint', plan, ['[asset-1] Slice 1'], { entries: [] }, settings);

    for (const [, request] of fetchMock.mock.calls) {
      const body = JSON.parse(request.body as string);
      expect(body.options).toMatchObject({ num_ctx: 32_768, num_predict: 3_072, temperature: 0 });
    }
  });
});

describe('Claude provider requests', () => {
  const claudeConfig: ProviderConfig = {
    provider: 'claude',
    profiles: {
      claude: { apiKey: 'claude-key', textModel: 'claude-sonnet-5', visionModel: 'claude-sonnet-5-20260901' },
    },
  };

  it('omits temperature for Sonnet 5 planning, vision, and follow-up requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'text', text: selectionPlanJson }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'text', text: structuredAnalysisJson }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'text', text: 'follow-up' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = createLLMService(claudeConfig);
    const plan = await service.getSelectionPlan(metadata, 'look for a finding');
    await expect(service.analyzeSlices([new Blob(['jpeg'])], metadata, 'hint', plan, ['Slice 1'])).resolves.toMatchObject({
      summary: 'analysis', findings: [{ confidence: 'probable', imageIndices: [1] }],
    });
    await expect(service.sendFollowUp([{ id: '1', role: 'user', content: 'Explain more', timestamp: 1 }], metadata)).resolves.toBe('follow-up');

    const planningBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const analysisBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const followUpBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(planningBody).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            additionalProperties: false,
            required: ['reasoning', 'selections', 'totalImages'],
            properties: {
              selections: {
                minItems: 1,
                items: {
                  additionalProperties: false,
                  required: [
                    'seriesNumber', 'role', 'rationale', 'sliceRange', 'samplingStrategy',
                    'samplingParam', 'windowCenter', 'windowWidth', 'coverageGoal', 'displayWindows',
                  ],
                },
              },
            },
          },
        },
      },
    });
    expect(planningBody.output_config.format.schema.properties.selections.items.properties.samplingParam).toEqual({
      anyOf: [{ type: 'number' }, { type: 'null' }],
    });
    expect(analysisBody.output_config.format.schema).toMatchObject({
      required: ['nextAction', 'summary', 'findings', 'limitations', 'evidenceLedger', 'imageRequest'],
      additionalProperties: false,
    });
    expect(analysisBody.output_config.format.schema.properties.imageRequest).toEqual({
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: { reason: { type: 'string' }, requestsJson: { type: 'string' } },
          required: ['reason', 'requestsJson'],
          additionalProperties: false,
        },
      ],
    });
    expect(analysisBody.thinking).toEqual({ type: 'disabled' });
    expect(followUpBody).not.toHaveProperty('output_config');
    expect(followUpBody).not.toHaveProperty('thinking');

    for (const [, request] of fetchMock.mock.calls) {
      const body = JSON.parse(request.body as string);
      expect(body).not.toHaveProperty('temperature');
    }
  });

  it('retains temperature for older Claude models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: selectionPlanJson }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const service = createLLMService({
      provider: 'claude',
      profiles: {
        claude: {
          apiKey: 'claude-key',
          textModel: 'claude-sonnet-4-5-20250929',
          visionModel: 'claude-sonnet-4-5-20250929',
        },
      },
    });
    await service.getSelectionPlan(metadata, 'look for a finding');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.temperature).toBe(0);
    expect(body).not.toHaveProperty('thinking');
    expect(body).toHaveProperty('output_config.format.schema');
  });

  it('retries once without structured output when Claude rejects a schema for complexity', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error', error: { type: 'invalid_request_error', message: 'Schema is too complex.' },
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [{ type: 'text', text: selectionPlanJson }], stop_reason: 'end_turn',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = createLLMService(claudeConfig);
    await expect(service.getSelectionPlan(metadata, 'look for a finding')).resolves.toMatchObject({ targetSeries: '1' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallbackBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(fallbackBody).not.toHaveProperty('output_config');
  });

  it('omits temperature for Claude Opus 4.7 and newer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'text', text: selectionPlanJson }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'text', text: selectionPlanJson }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    for (const model of ['claude-opus-4-7-20260416', 'claude-opus-5']) {
      const service = createLLMService({
        provider: 'claude',
        profiles: { claude: { apiKey: 'claude-key', textModel: model, visionModel: model } },
      });
      await service.getSelectionPlan(metadata, 'look for a finding');
    }

    for (const [, request] of fetchMock.mock.calls) {
      const body = JSON.parse(request.body as string);
      expect(body).not.toHaveProperty('temperature');
    }
  });

  it('retries a truncated selection plan once with a larger output budget', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [{ type: 'text', text: '{"reasoning":"partial' }],
        stop_reason: 'max_tokens',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [{ type: 'text', text: selectionPlanJson }],
        stop_reason: 'end_turn',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = createLLMService(claudeConfig);
    await expect(service.getSelectionPlan(metadata, 'look for a finding')).resolves.toMatchObject({ targetSeries: '1' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(firstBody.max_tokens).toBe(4096);
    expect(retryBody.max_tokens).toBe(8192);
    expect(retryBody.output_config).toEqual(firstBody.output_config);
    expect(retryBody.thinking).toEqual({ type: 'adaptive' });
  });

  it('reports a clear error after the selection-plan retry is also truncated', async () => {
    const truncatedResponse = () => new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"reasoning":"partial' }],
      stop_reason: 'max_tokens',
    }), { status: 200 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(truncatedResponse());
    vi.stubGlobal('fetch', fetchMock);

    const service = createLLMService(claudeConfig);
    await expect(service.getSelectionPlan(metadata, 'look for a finding')).rejects.toThrow(
      'Claude model "claude-sonnet-5" truncated the selection plan at the 8,192-token limit',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports Claude refusals and missing text blocks without masking them as JSON errors', async () => {
    const refusalFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'I cannot help with that.' }],
      stop_reason: 'refusal',
    }), { status: 200 }));
    vi.stubGlobal('fetch', refusalFetch);

    const service = createLLMService(claudeConfig);
    await expect(service.getSelectionPlan(metadata, 'look for a finding')).rejects.toThrow(
      'Claude model "claude-sonnet-5" refused to create a selection plan',
    );

    const emptyFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'thinking', thinking: 'considering the study' }],
      stop_reason: 'end_turn',
    }), { status: 200 }));
    vi.stubGlobal('fetch', emptyFetch);

    await expect(service.getSelectionPlan(metadata, 'look for a finding')).rejects.toThrow(
      'Claude model "claude-sonnet-5" returned no text for the selection plan (stop reason: end_turn)',
    );
  });
});
