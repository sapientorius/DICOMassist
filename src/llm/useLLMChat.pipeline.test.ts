import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStudy } from '../test/fixtures/study';
import type { ProviderConfig, SelectionPlan } from './types';

const mocks = vi.hoisted(() => ({
  createLLMService: vi.fn(),
  getConfiguredModels: vi.fn(() => ({ providerLabel: 'Ollama (Local)', textModel: 'planner', visionModel: 'vision' })),
  selectSlicesForSelection: vi.fn(),
  selectOverviewSlices: vi.fn(() => []),
  exportSlicesToJpeg: vi.fn(),
  createSliceMontage: vi.fn(async () => null),
}));

vi.mock('./LLMServiceFactory', () => ({
  createLLMService: mocks.createLLMService,
  getConfiguredModels: mocks.getConfiguredModels,
}));
vi.mock('../filtering/SliceSelector', () => ({
  selectSlicesForSelection: mocks.selectSlicesForSelection,
  selectOverviewSlices: mocks.selectOverviewSlices,
}));
vi.mock('../filtering/SliceExporter', () => ({ exportSlicesToJpeg: mocks.exportSlicesToJpeg }));
vi.mock('../filtering/SliceMontage', () => ({ createSliceMontage: mocks.createSliceMontage }));

import { useLLMChat } from './useLLMChat';

function plan(range: [number, number]): SelectionPlan {
  return {
    reasoning: 'test', totalImages: 1, targetSeries: '1', sliceRange: range, samplingStrategy: 'uniform', samplingParam: 1, windowCenter: 40, windowWidth: 400,
    selections: [{ seriesNumber: '1', role: 'primary', rationale: 'test', sliceRange: range, samplingStrategy: 'uniform', samplingParam: 1, windowCenter: 40, windowWidth: 400, coverageGoal: 'target' }],
  };
}

describe('adaptive planning pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectSlicesForSelection.mockImplementation((_study, selection) => [{
      imageId: `image-${selection.sliceRange[0]}`,
      instanceNumber: selection.sliceRange[0],
      zPosition: selection.sliceRange[0],
    }]);
    mocks.exportSlicesToJpeg.mockImplementation(async (slices, windowCenter, windowWidth, options) => slices.map((slice: { instanceNumber: number; zPosition: number }) => ({
      blob: new Blob(['jpeg']), instanceNumber: slice.instanceNumber, zPosition: slice.zPosition,
      width: 256, height: 256, pixelCount: 65_536, contrast: 128, windowCenter, windowWidth, windowLabel: options?.windowLabel, renderPath: 'cornerstone',
    })));
  });

  it('routes a concrete vision request through the planner and stops after the targeted second analysis', async () => {
    const service = {
      getSelectionPlan: vi.fn().mockResolvedValueOnce(plan([1, 1])).mockResolvedValueOnce(plan([10, 12])),
      analyzeSlices: vi.fn()
        .mockResolvedValueOnce({
          summary: 'Need more coverage.', findings: [], limitations: [],
          additionalImageRequest: { needed: true, reason: 'Adjacent slices are needed.', selections: plan([10, 12]).selections },
        })
        .mockResolvedValueOnce({
          summary: 'Targeted images reviewed.', findings: [{ summary: 'Visible feature', confidence: 'possible', imageIndices: [2] }], limitations: [],
          additionalImageRequest: { needed: false, selections: [] },
        }),
      sendFollowUp: vi.fn(),
    };
    mocks.createLLMService.mockReturnValue(service);
    const config: ProviderConfig = {
      provider: 'ollama',
      profiles: {
        ollama: {
          textModel: 'planner', visionModel: 'vision',
          analysis: { profile: 'custom', maxImages: 8, maxImagePixels: 786_432, maxRefinementRounds: 1, contextWindowTokens: 32_768, responseTokenBudget: 2_048 },
        },
      },
    };
    const chat = useLLMChat(ref(makeStudy()), ref(config));

    await chat.startAnalysis('evaluate target');
    await chat.confirmPlan(chat.currentPlan.value!);

    expect(service.getSelectionPlan).toHaveBeenCalledTimes(2);
    expect(service.analyzeSlices).toHaveBeenCalledTimes(2);
    expect(chat.pipeline.value?.comparisonLog.rounds).toHaveLength(2);
    expect(chat.pipeline.value?.refinementRound).toBe(1);
    expect(chat.messages.value.at(-1)?.content).toContain('Targeted images reviewed.');
  });
});

