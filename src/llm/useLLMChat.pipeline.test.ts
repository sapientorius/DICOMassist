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
  resolveRenderSpec: vi.fn(async (_series, spec) => ({ label: spec.label || 'DICOM default', windowCenter: 40, windowWidth: 400, key: spec.mode })),
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
vi.mock('../filtering/SliceExporter', () => ({ exportSlicesToJpeg: mocks.exportSlicesToJpeg, resolveRenderSpec: mocks.resolveRenderSpec }));
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

  it('executes a concrete vision image request directly and stops after the targeted second analysis', async () => {
    const service = {
      getSelectionPlan: vi.fn().mockResolvedValueOnce(plan([1, 1])),
      analyzeSlices: vi.fn()
        .mockResolvedValueOnce({
          summary: 'Need more coverage.', findings: [], limitations: [],
          evidenceLedger: { entries: [{ id: 'F1', status: 'active', summary: 'Questionable feature', confidence: 'possible', assetIds: ['asset-1'], openQuestion: 'Does it persist?' }] },
          nextAction: 'request_images',
          imageRequest: {
            reason: 'Adjacent slices are needed.',
            requests: [{ kind: 'neighbours', sourceImageIndex: 1, before: 0, after: 1, renderings: [{ mode: 'dicom-default' }] }],
          },
          additionalImageRequest: { needed: false, selections: [] },
        })
        .mockResolvedValueOnce({
          summary: 'Targeted images reviewed.', findings: [{ summary: 'Visible feature', confidence: 'possible', imageIndices: [2] }], limitations: [],
          evidenceLedger: { entries: [{ id: 'F1', status: 'resolved', summary: 'Visible feature', confidence: 'possible', assetIds: ['asset-2'] }] },
          nextAction: 'complete',
          additionalImageRequest: { needed: false, selections: [] },
        }),
      synthesizeFinalAnalysis: vi.fn().mockResolvedValue({
        summary: 'Final evidence synthesis.', findings: [{ summary: 'Visible feature', confidence: 'possible', imageIndices: [2] }], limitations: [],
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

    expect(service.getSelectionPlan).toHaveBeenCalledTimes(1);
    expect(service.analyzeSlices).toHaveBeenCalledTimes(2);
    expect(service.synthesizeFinalAnalysis).toHaveBeenCalledTimes(1);
    expect(chat.pipeline.value?.comparisonLog.rounds).toHaveLength(2);
    expect(chat.pipeline.value?.refinementRound).toBe(1);
    expect(chat.messages.value.at(-1)?.content).toContain('Final evidence synthesis.');
    expect(chat.messages.value.at(-1)?.content).not.toContain('Targeted images reviewed.');
    expect(chat.pipeline.value?.ledgerEntryCount).toBe(1);
  });

  it('shows the last self-contained retrieval assessment with a visible warning when final synthesis fails', async () => {
    const service = {
      getSelectionPlan: vi.fn().mockResolvedValue(plan([1, 1])),
      analyzeSlices: vi.fn().mockResolvedValue({
        summary: 'Standalone retrieval assessment.', findings: [], limitations: [],
        evidenceLedger: { entries: [] }, nextAction: 'complete', additionalImageRequest: { needed: false, selections: [] },
      }),
      synthesizeFinalAnalysis: vi.fn().mockRejectedValue(new Error('Final provider timeout.')),
      sendFollowUp: vi.fn(),
    };
    mocks.createLLMService.mockReturnValue(service);
    const chat = useLLMChat(ref(makeStudy()), ref({
      provider: 'ollama',
      profiles: { ollama: { textModel: 'planner', visionModel: 'vision' } },
    }));

    await chat.startAnalysis('evaluate target');
    await chat.confirmPlan(chat.currentPlan.value!);

    expect(chat.messages.value.at(-1)?.content).toContain('Standalone retrieval assessment.');
    expect(chat.messages.value.at(-1)?.content).toContain('Final synthesis was unavailable');
    expect(chat.pipeline.value?.steps.find((step) => step.id === 'synthesize')).toMatchObject({ status: 'error' });
  });

  it('does not loop when a requested rendering is already archived locally', async () => {
    mocks.resolveRenderSpec.mockResolvedValue({ label: 'Primary window', windowCenter: 40, windowWidth: 400, key: 'wl:40:400' });
    const service = {
      getSelectionPlan: vi.fn().mockResolvedValue(plan([1, 1])),
      analyzeSlices: vi.fn().mockResolvedValue({
        summary: 'Need a duplicate rendering.', findings: [], limitations: [], evidenceLedger: { entries: [] },
        nextAction: 'request_images',
        imageRequest: { reason: 'Check the same source.', requests: [{ kind: 'neighbours', sourceImageIndex: 1, before: 0, after: 0, renderings: [{ mode: 'window-level', windowCenter: 40, windowWidth: 400 }] }] },
        additionalImageRequest: { needed: false, selections: [] },
      }),
      synthesizeFinalAnalysis: vi.fn().mockResolvedValue({ summary: 'Final after duplicate request.', findings: [], limitations: [] }),
      sendFollowUp: vi.fn(),
    };
    mocks.createLLMService.mockReturnValue(service);
    const chat = useLLMChat(ref(makeStudy()), ref({
      provider: 'ollama', profiles: { ollama: { textModel: 'planner', visionModel: 'vision' } },
    }));

    await chat.startAnalysis('evaluate target');
    await chat.confirmPlan(chat.currentPlan.value!);

    expect(service.analyzeSlices).toHaveBeenCalledTimes(1);
    expect(service.synthesizeFinalAnalysis).toHaveBeenCalledTimes(1);
    expect(chat.messages.value.at(-1)?.content).toContain('Final after duplicate request.');
  });
});
