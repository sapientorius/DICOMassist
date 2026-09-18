import { describe, expect, it } from 'vitest';
import type { AnalysisSettings } from './analysisConfig';
import type { EvidenceLedger, StructuredAnalysis } from './types';
import { reconcileEvidenceLedger, selectContextWorkset, type ImageAsset, type SliceMapping } from './useLLMChat';

const settings: AnalysisSettings = {
  profile: 'custom', maxImages: 12, maxImagePixels: 1_000_000, maxRefinementRounds: 2,
  contextWindowTokens: 8_000, responseTokenBudget: 2_000,
};

function asset(id: string, role: SliceMapping['assetRole'], pixelCount: number, imageIndex: number): ImageAsset {
  return {
    id,
    blob: new Blob(['jpeg']),
    pixelCount,
    role,
    mapping: {
      imageIndex, assetId: id, assetRole: role, kind: role === 'overview' ? 'montage' : 'slice', label: id,
      seriesNumber: '1', refinementRound: role === 'requested' ? 1 : 0,
    },
  };
}

function analysis(entries: EvidenceLedger['entries']): StructuredAnalysis {
  return {
    summary: 'Round result.', findings: [], limitations: [], evidenceLedger: { entries },
    nextAction: 'complete', additionalImageRequest: { needed: false, selections: [] },
  };
}

describe('evidence-bounded context worksets', () => {
  it('prioritizes active evidence, new requests, and a series overview before archived redundancy', () => {
    const assets = [
      asset('overview-1', 'overview', 65_536, 1),
      asset('evidence-1', 'planned', 700_000, 2),
      asset('requested-1', 'requested', 700_000, 3),
      asset('older-1', 'planned', 700_000, 4),
    ];
    const ledger: EvidenceLedger = { entries: [{ id: 'F1', status: 'active', summary: 'Focus', confidence: 'possible', assetIds: ['evidence-1'] }] };

    const workset = selectContextWorkset(assets, ledger, settings, 'retrieval');

    expect(workset.assets.map((item) => item.id)).toEqual(['requested-1', 'evidence-1', 'overview-1']);
    expect(workset.excludedAssets.map((item) => item.id)).toEqual(['older-1']);
    expect(workset.budget.estimatedInputTokens).toBeLessThanOrEqual(workset.budget.availableInputTokens);
  });

  it('stops rather than silently dropping evidence that cannot fit safely', () => {
    const ledger: EvidenceLedger = { entries: [{ id: 'F1', status: 'active', summary: 'Large focus', confidence: 'possible', assetIds: ['evidence-1'] }] };
    const assets = [asset('overview-1', 'overview', 65_536, 1), asset('evidence-1', 'planned', 3_000_000, 2)];

    expect(() => selectContextWorkset(assets, ledger, settings, 'final')).toThrow('required evidence set');
  });

  it('counts the actual system, metadata, and ledger prompt estimate in addition to image pixels', () => {
    const promptAwareSettings: AnalysisSettings = { ...settings, contextWindowTokens: 10_000 };
    const assets = [
      asset('overview-1', 'overview', 65_536, 1),
      asset('detail-1', 'planned', 700_000, 2),
      asset('detail-2', 'planned', 700_000, 3),
    ];
    const workset = selectContextWorkset(assets, { entries: [] }, promptAwareSettings, 'final', () => 3_000);

    expect(workset.assets.map((item) => item.id)).toEqual(['overview-1', 'detail-1']);
    expect(workset.excludedAssets.map((item) => item.id)).toEqual(['detail-2']);
    expect(workset.budget.estimatedInputTokens).toBeLessThanOrEqual(workset.budget.availableInputTokens);
  });

  it('keeps stable IDs and explicitly rules out hypotheses omitted from a complete snapshot', () => {
    const assets = [asset('asset-1', 'planned', 65_536, 1), asset('asset-2', 'planned', 65_536, 2)];
    const previous: EvidenceLedger = { entries: [
      { id: 'F1', status: 'active', summary: 'Focus', confidence: 'possible', assetIds: ['asset-1'] },
      { id: 'F2', status: 'active', summary: 'Other focus', confidence: 'possible', assetIds: ['asset-2'] },
    ] };
    const reconciled = reconcileEvidenceLedger(analysis([
      { id: 'provider-renamed', status: 'resolved', summary: 'Focus clarified', confidence: 'probable', assetIds: ['asset-1'] },
    ]), assets, previous);

    expect(reconciled.entries[0]).toMatchObject({ id: 'F1', status: 'resolved' });
    expect(reconciled.entries.find((entry) => entry.id === 'F2')).toMatchObject({ status: 'ruled_out' });
  });
});
