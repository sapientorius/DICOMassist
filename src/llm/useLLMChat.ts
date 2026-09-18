import { computed, ref, type Ref } from 'vue';
import type { StudyMetadata } from '../dicom/types';
import type { AnalysisBudgetEstimate, AnalysisSettings } from './analysisConfig';
import { estimateAnalysisBudget, estimateImageTokens, getSafeImageTokenBudget } from './analysisConfig';
import type { AdaptiveImageRequestSet, AdditionalImageRequest, AnalysisRequestContext, ChatMessage, DisplayWindow, EvidenceLedger, FinalAnalysis, ProviderConfig, ProviderType, SelectionPlan, SeriesSelection, StructuredAnalysis, ViewportContext } from './types';
import { createLLMService, getConfiguredModels } from './LLMServiceFactory';
import { formatFinalAnalysis, formatStructuredAnalysis } from './analysisResults';
import { buildAnalysisSystemPrompt, buildAnalysisUserPrompt, buildFinalAnalysisSystemPrompt, buildFinalAnalysisUserPrompt } from './PromptBuilder';
import { getProviderAnalysisConfig } from './providerConfig';
import { createSliceMontage } from '../filtering/SliceMontage';
import { exportSlicesToJpeg, resolveRenderSpec, type ExportedSlice } from '../filtering/SliceExporter';
import { inspectExportQuality, inspectPlanQuality, type QualityWarning } from '../filtering/qualityChecks';
import { selectOverviewSlices, selectSlicesForSelection } from '../filtering/SliceSelector';
import { resolveAdaptiveImageRequests } from '../filtering/adaptiveRetrieval';
import { logger } from '../utils/logger';

export type ChatStatus = 'idle' | 'planning' | 'awaiting-confirmation' | 'exporting' | 'analyzing' | 'refining' | 'synthesizing' | 'following-up' | 'error';

export interface PipelineStep {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
  detail?: string;
  durationMs?: number;
}

export interface SliceMapping {
  imageIndex: number;
  /** Stable local identity that survives per-round workset reordering. */
  assetId: string;
  assetRole: 'overview' | 'planned' | 'requested';
  kind: 'slice' | 'montage';
  instanceNumber?: number;
  imageId?: string;
  seriesInstanceUID?: string;
  zPosition?: number;
  patientPoint?: [number, number, number];
  label: string;
  seriesNumber: string;
  windowCenter?: number;
  windowWidth?: number;
  windowLabel?: string;
  width?: number;
  height?: number;
  pixelCount?: number;
  renderPath?: 'cornerstone' | 'fallback';
  crop?: [number, number, number, number];
  refinementRound: number;
}

export interface AnalysisRoundLog {
  round: number;
  imageCount: number;
  requestedAdditionalImages?: boolean;
  reason?: string;
  durationMs?: number;
  estimatedInputTokens?: number;
  archivedImageCount?: number;
  excludedImageCount?: number;
  ledgerEntryCount?: number;
}

export interface ComparisonLog {
  provider: string;
  planningModel: string;
  visionModel: string;
  settings: AnalysisSettings;
  startedAt: number;
  rounds: AnalysisRoundLog[];
}

export interface PipelineState {
  steps: PipelineStep[];
  plan: SelectionPlan | null;
  sliceCount: number;
  totalSlices: number;
  exportedSizes: string[];
  sliceMappings: SliceMapping[];
  budget: AnalysisBudgetEstimate | null;
  qualityWarnings: QualityWarning[];
  refinementRound: number;
  archiveImageCount: number;
  activeImageCount: number;
  excludedImageCount: number;
  ledgerEntryCount: number;
  comparisonLog: ComparisonLog;
}

const STATUS_LABELS: Record<ChatStatus, string> = {
  idle: '', planning: 'Analyzing metadata...', 'awaiting-confirmation': 'Review selection plan...',
  exporting: 'Preparing images...', analyzing: 'Generating analysis...', refining: 'Requesting targeted additional images...', synthesizing: 'Synthesizing final analysis...', 'following-up': 'Thinking...', error: 'Error',
};
const LEGACY_MAX_TOTAL_IMAGES = 20;
const OVERVIEW_IMAGE_RESOLUTION = 256 * 256;
const DEEP_INITIAL_IMAGE_BUDGET = 40;
const RESERVED_IMAGES_PER_REFINEMENT = 12;
const MEBIBYTE = 1024 * 1024;
const PROVIDER_PAYLOAD_LIMITS: Record<ProviderType, number> = {
  // Conservative limits keep the client below documented remote request ceilings;
  // local servers still get a larger but finite browser-safe transport budget.
  claude: 30 * MEBIBYTE,
  openai: 20 * MEBIBYTE,
  openrouter: 20 * MEBIBYTE,
  ollama: 64 * MEBIBYTE,
  lmstudio: 64 * MEBIBYTE,
};

const WORKSET_PROMPT_RESERVE_TOKENS = 512;

export interface ImageAsset {
  id: string;
  blob: Blob;
  mapping: SliceMapping;
  pixelCount: number;
  role: SliceMapping['assetRole'];
}

export interface ContextWorkset {
  assets: ImageAsset[];
  excludedAssets: ImageAsset[];
  budget: AnalysisBudgetEstimate;
}

export type WorksetPromptTokenEstimator = (assets: ImageAsset[]) => number;

function estimateLedgerTokens(ledger: EvidenceLedger): number {
  return Math.ceil(JSON.stringify(ledger).length / 4);
}

function activeEvidenceAssetIds(ledger: EvidenceLedger): Set<string> {
  return new Set(ledger.entries
    .filter((entry) => entry.status !== 'ruled_out')
    .flatMap((entry) => entry.assetIds));
}

/**
 * Builds the only image set sent to one vision call. Archive order never
 * changes; this function only creates a locally ordered view over those assets.
 */
export function selectContextWorkset(
  assets: ImageAsset[],
  ledger: EvidenceLedger,
  settings: AnalysisSettings,
  mode: 'retrieval' | 'final',
  estimatePromptTokens?: WorksetPromptTokenEstimator,
): ContextWorkset {
  const evidenceIds = activeEvidenceAssetIds(ledger);
  const overviewBySeries = new Set<string>();
  const anchorIds = new Set<string>();
  for (const asset of assets) {
    if (asset.role !== 'overview' || overviewBySeries.has(asset.mapping.seriesNumber)) continue;
    overviewBySeries.add(asset.mapping.seriesNumber);
    anchorIds.add(asset.id);
  }
  const promptTokensFor = (candidate: ImageAsset[]): number => Math.max(
    WORKSET_PROMPT_RESERVE_TOKENS + estimateLedgerTokens(ledger),
    Math.ceil(estimatePromptTokens?.(candidate) ?? 0),
  );
  const isMandatory = (asset: ImageAsset): boolean => evidenceIds.has(asset.id)
    || anchorIds.has(asset.id)
    || (mode === 'retrieval' && asset.role === 'requested');
  const score = (asset: ImageAsset): number => {
    if (asset.role === 'requested') return mode === 'retrieval' ? 500 : 350;
    if (evidenceIds.has(asset.id)) return 450;
    if (anchorIds.has(asset.id)) return 400;
    if (asset.role === 'planned') return 200;
    return 100;
  };
  const ordered = [...assets].sort((left, right) => score(right) - score(left) || right.mapping.refinementRound - left.mapping.refinementRound || left.mapping.imageIndex - right.mapping.imageIndex);
  const mandatoryAssets = ordered.filter(isMandatory);
  const mandatoryTokens = mandatoryAssets.reduce((total, asset) => total + estimateImageTokens(asset.pixelCount), 0);
  const mandatoryPromptTokens = promptTokensFor(mandatoryAssets);
  const mandatoryImageBudget = getSafeImageTokenBudget(settings, mandatoryPromptTokens);
  if (mandatoryTokens > mandatoryImageBudget) {
    throw new Error(
      `The required evidence set needs ${mandatoryTokens.toLocaleString()} image tokens, above the ${mandatoryImageBudget.toLocaleString()} safe context budget after ${mandatoryPromptTokens.toLocaleString()} prompt tokens. ` +
      'Reduce image resolution or choose a model with a larger configured context window.',
    );
  }
  const selected: ImageAsset[] = [];
  let usedTokens = 0;
  for (const asset of ordered) {
    const tokens = estimateImageTokens(asset.pixelCount);
    const candidate = [...selected, asset];
    const safeImageTokens = getSafeImageTokenBudget(settings, promptTokensFor(candidate));
    if (isMandatory(asset) || usedTokens + tokens <= safeImageTokens) {
      selected.push(asset);
      usedTokens += tokens;
    }
  }
  if (!selected.length && assets.length) {
    throw new Error(
      'No rendered image can fit alongside the required prompt and response reserve in the configured context window. ' +
      'Choose a model with a larger context window or a smaller response budget.',
    );
  }
  const selectedIds = new Set(selected.map((asset) => asset.id));
  const excludedAssets = assets.filter((asset) => !selectedIds.has(asset.id));
  const averagePixels = selected.length ? Math.round(selected.reduce((total, asset) => total + asset.pixelCount, 0) / selected.length) : 0;
  const promptTokens = promptTokensFor(selected);
  const availableInputTokens = Math.floor(Math.max(0, settings.contextWindowTokens - settings.responseTokenBudget) * 0.8);
  return {
    assets: selected,
    excludedAssets,
    budget: {
      requestedImages: assets.length,
      approvedImages: selected.length,
      sourcePixelsPerImage: averagePixels,
      pixelsPerImage: averagePixels,
      estimatedImageTokens: usedTokens,
      estimatedInputTokens: usedTokens + promptTokens + 2_048,
      availableInputTokens,
      wasAdjusted: excludedAssets.length > 0,
      warnings: excludedAssets.length ? [`${excludedAssets.length} archived image(s) were excluded from this context-budgeted workset.`] : [],
    },
  };
}

function makeId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function updateStep(steps: PipelineStep[], id: string, updates: Partial<PipelineStep>): PipelineStep[] {
  return steps.map((step) => step.id === id ? { ...step, ...updates } : step);
}

function windowVariants(selection: SeriesSelection): DisplayWindow[] {
  const unique = new Map<string, DisplayWindow>();
  for (const window of selection.displayWindows ?? []) {
    if (!Number.isFinite(window.windowCenter) || !Number.isFinite(window.windowWidth) || window.windowWidth <= 0) continue;
    const key = `${Math.round(window.windowCenter)}:${Math.round(window.windowWidth)}`;
    if (key !== `${Math.round(selection.windowCenter)}:${Math.round(selection.windowWidth)}`) unique.set(key, window);
  }
  return [...unique.values()];
}

function imageVariants(selection: SeriesSelection): DisplayWindow[] {
  return [{ label: 'Primary window', windowCenter: selection.windowCenter, windowWidth: selection.windowWidth }, ...windowVariants(selection)];
}

function estimateSliceCount(selection: SeriesSelection): number {
  const rangeSize = selection.sliceRange[1] - selection.sliceRange[0] + 1;
  const slices = selection.samplingStrategy === 'uniform' && selection.samplingParam != null
    ? Math.min(selection.samplingParam, rangeSize)
    : selection.samplingStrategy === 'every_nth' && selection.samplingParam != null && selection.samplingParam > 0
      ? Math.ceil(rangeSize / selection.samplingParam)
      : rangeSize;
  return slices * imageVariants(selection).length;
}

function reduceSelection(selection: SeriesSelection, maxImages: number): SeriesSelection {
  const variantCount = imageVariants(selection).length;
  const rangeSize = selection.sliceRange[1] - selection.sliceRange[0] + 1;
  const maxSlices = Math.max(1, Math.min(rangeSize, Math.floor(Math.max(1, maxImages) / variantCount)));
  return { ...selection, samplingStrategy: 'uniform', samplingParam: maxSlices };
}

function fixSelection(selection: SeriesSelection, metadata: StudyMetadata, budget: number): SeriesSelection | null {
  const series = metadata.series.find((candidate) => String(candidate.seriesNumber) === selection.seriesNumber);
  if (!series || series.isScout || !Number.isFinite(selection.sliceRange[0]) || !Number.isFinite(selection.sliceRange[1])) return null;
  const [minimum, maximum] = series.instanceNumberRange;
  let [start, end] = selection.sliceRange;
  if (start > end) [start, end] = [end, start];
  start = Math.max(minimum, Math.round(start));
  end = Math.min(maximum, Math.round(end));
  if (start > end) return null;

  const windowCenter = Number.isFinite(selection.windowCenter) ? selection.windowCenter : (series.windowCenter ?? 40);
  const windowWidth = Number.isFinite(selection.windowWidth) && selection.windowWidth > 0 ? selection.windowWidth : (series.windowWidth ?? 400);
  const displayWindows = windowVariants({ ...selection, windowCenter, windowWidth }).slice(0, Math.max(0, budget - 1));
  const variantCount = 1 + displayWindows.length;
  const sliceBudget = Math.max(1, Math.floor(budget / variantCount));
  const rangeSize = end - start + 1;
  let samplingStrategy = selection.samplingStrategy;
  let samplingParam = selection.samplingParam;
  if (samplingStrategy === 'all' && rangeSize > sliceBudget) {
    samplingStrategy = 'uniform';
    samplingParam = sliceBudget;
  }
  if ((samplingStrategy === 'uniform' || samplingStrategy === 'every_nth') && (!Number.isFinite(samplingParam) || (samplingParam ?? 0) < 1)) {
    samplingStrategy = 'uniform';
    samplingParam = Math.min(sliceBudget, rangeSize);
  }
  if (samplingStrategy === 'uniform') samplingParam = Math.min(Math.round(samplingParam ?? sliceBudget), rangeSize, sliceBudget);
  if (samplingStrategy === 'every_nth') samplingParam = Math.max(1, Math.round(samplingParam ?? 1));
  return {
    ...selection,
    sliceRange: [start, end],
    samplingStrategy,
    samplingParam,
    windowCenter,
    windowWidth,
    displayWindows,
    coverageGoal: selection.coverageGoal?.trim() || undefined,
  };
}

/** Validates an untrusted LLM response against locally loaded metadata and image budget. */
export function fixSelectionPlan(plan: SelectionPlan, metadata: StudyMetadata, maxTotalImages = LEGACY_MAX_TOTAL_IMAGES): SelectionPlan {
  const budget = Math.max(1, Math.round(maxTotalImages));
  const corrected = plan.selections
    .map((selection) => fixSelection(selection, metadata, budget))
    .filter((selection): selection is SeriesSelection => selection !== null);
  if (corrected.length === 0) throw new Error('The selection plan did not reference a valid series in this study (scout/localizer series are excluded).');

  let selections = corrected;
  let total = selections.reduce((sum, selection) => sum + estimateSliceCount(selection), 0);
  for (let index = selections.length - 1; index >= 0 && total > budget; index--) {
    if (selections[index].role !== 'supplementary') continue;
    const allowed = Math.max(imageVariants(selections[index]).length, estimateSliceCount(selections[index]) - (total - budget));
    selections[index] = reduceSelection(selections[index], allowed);
    total = selections.reduce((sum, selection) => sum + estimateSliceCount(selection), 0);
  }
  if (total > budget) {
    const primary = selections.find((selection) => selection.role === 'primary') ?? selections[0];
    selections = [{ ...reduceSelection(primary, budget), role: 'primary' }];
  }

  const primary = selections.find((selection) => selection.role === 'primary') ?? selections[0];
  return {
    ...plan,
    selections: [primary, ...selections.filter((selection) => selection !== primary)],
    totalImages: selections.reduce((sum, selection) => sum + estimateSliceCount(selection), 0),
    targetSeries: primary.seriesNumber,
    sliceRange: primary.sliceRange,
    windowCenter: primary.windowCenter,
    windowWidth: primary.windowWidth,
    samplingStrategy: primary.samplingStrategy,
    samplingParam: primary.samplingParam,
  };
}

export function canRunRefinement(request: AdaptiveImageRequestSet | AdditionalImageRequest | undefined, completedRounds: number, maxRounds: number, remainingImages: number): boolean {
  const hasRequests = request && ('requests' in request ? request.requests.length > 0 : request.needed && request.selections.length > 0);
  return Boolean(hasRequests) && completedRounds < maxRounds && remainingImages > 0;
}

function sourcePixelsForPlan(plan: SelectionPlan, metadata: StudyMetadata): number {
  let weightedPixels = 0;
  let imageCount = 0;
  for (const selection of plan.selections) {
    const series = metadata.series.find((candidate) => String(candidate.seriesNumber) === selection.seriesNumber);
    const count = estimateSliceCount(selection);
    weightedPixels += (series?.rows ?? 512) * (series?.columns ?? 512) * count;
    imageCount += count;
  }
  return imageCount ? Math.round(weightedPixels / imageCount) : 512 * 512;
}

function budgetPlan(plan: SelectionPlan, metadata: StudyMetadata, settings: AnalysisSettings): { plan: SelectionPlan; budget: AnalysisBudgetEstimate; initialImageBudget: number } {
  const requested = Math.max(
    settings.maxImages,
    plan.selections.reduce((sum, selection) => sum + estimateSliceCount(selection), 0) + 1,
  );
  const firstEstimate = estimateAnalysisBudget(settings, requested, sourcePixelsForPlan(plan, metadata));
  const refinementReserve = settings.maxRefinementRounds > 0
    ? Math.min(RESERVED_IMAGES_PER_REFINEMENT * settings.maxRefinementRounds, Math.floor(firstEstimate.approvedImages * 0.6))
    : 0;
  const initialImageBudget = Math.max(1, Math.min(DEEP_INITIAL_IMAGE_BUDGET, firstEstimate.approvedImages - refinementReserve));
  const draft = fixSelectionPlan(plan, metadata, initialImageBudget);
  const overviewReserve = Math.min(draft.selections.length, Math.max(0, initialImageBudget - 1));
  const corrected = fixSelectionPlan(draft, metadata, Math.max(1, initialImageBudget - overviewReserve));
  const budget = estimateAnalysisBudget(settings, requested, sourcePixelsForPlan(corrected, metadata));
  return { plan: corrected, budget, initialImageBudget };
}

function patientPointForSlice(series: StudyMetadata['series'][number], slice: StudyMetadata['series'][number]['slices'][number]): [number, number, number] {
  const [rowSpacing, columnSpacing] = series.pixelSpacing ?? [1, 1];
  const row = slice.imageOrientationPatient.slice(0, 3);
  const column = slice.imageOrientationPatient.slice(3, 6);
  const x = ((series.columns ?? 0) * columnSpacing) / 2;
  const y = ((series.rows ?? 0) * rowSpacing) / 2;
  return [
    slice.imagePositionPatient[0] + row[0] * x + column[0] * y,
    slice.imagePositionPatient[1] + row[1] * x + column[1] * y,
    slice.imagePositionPatient[2] + row[2] * x + column[2] * y,
  ];
}

function renderIdentity(imageId: string, key: string, crop?: [number, number, number, number]): string {
  return `${imageId}:${key}:${crop?.map((value) => value.toFixed(4)).join(':') ?? 'full'}`;
}

function maximumImagesThisRound(totalImages: number, currentImages: number, completedRounds: number, maxRounds: number): number {
  const remaining = Math.max(0, totalImages - currentImages);
  const roundsAfterThis = Math.max(0, maxRounds - completedRounds - 1);
  return Math.max(0, remaining - Math.min(remaining, roundsAfterThis * RESERVED_IMAGES_PER_REFINEMENT));
}

function buildSeriesCatalog(study: StudyMetadata): string {
  return study.series
    .filter((series) => !series.isScout)
    .map((series) => `UID=${series.seriesInstanceUID} | #${series.seriesNumber} | ${series.seriesDescription || '(unnamed)'} | ${series.anatomicalPlane} | instances ${series.instanceNumberRange[0]}-${series.instanceNumberRange[1]} | ${series.slices.length} slices | position ${series.zMin.toFixed(1)}-${series.zMax.toFixed(1)}mm`)
    .join('\n');
}

function buildImageManifest(mappings: SliceMapping[]): string {
  return mappings.map((mapping, index) => {
    if (mapping.kind === 'montage') return `Image ${index + 1}: asset=${mapping.assetId} overview montage for series #${mapping.seriesNumber}`;
    const point = mapping.patientPoint ? ` patientPoint=${mapping.patientPoint.map((value) => value.toFixed(1)).join(',')}` : '';
    const crop = mapping.crop ? ` crop=${mapping.crop.map((value) => value.toFixed(3)).join(',')}` : '';
    return `Image ${index + 1}: asset=${mapping.assetId} UID=${mapping.seriesInstanceUID} instance=${mapping.instanceNumber} W=${Math.round(mapping.windowWidth ?? 0)} C=${Math.round(mapping.windowCenter ?? 0)}${crop}${point}`;
  }).join('\n');
}

function archiveAssets(blobs: Blob[], mappings: SliceMapping[]): ImageAsset[] {
  return mappings.flatMap((mapping) => {
    const blob = blobs[mapping.imageIndex - 1];
    if (!blob) return [];
    return [{
      id: mapping.assetId,
      blob,
      mapping,
      pixelCount: mapping.pixelCount ?? OVERVIEW_IMAGE_RESOLUTION,
      role: mapping.assetRole,
    }];
  });
}

function normalizedEvidenceSummary(summary: string): string {
  return summary.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Makes a provider-owned snapshot safe for the next local round. Matching prior
 * evidence retains its stable local ID; omitted prior hypotheses remain visible
 * as ruled out rather than disappearing silently.
 */
export function reconcileEvidenceLedger(analysis: StructuredAnalysis, workset: ImageAsset[], previous: EvidenceLedger): EvidenceLedger {
  const availableAssetIds = new Set(workset.map((asset) => asset.id));
  const entries = analysis.evidenceLedger.entries.length
    ? analysis.evidenceLedger.entries
    : analysis.findings.slice(0, 12).map((finding, index) => ({
      id: previous.entries[index]?.id ?? `F${index + 1}`,
      status: 'active' as const,
      summary: finding.summary,
      confidence: finding.confidence,
      assetIds: finding.imageIndices.map((imageIndex) => workset[imageIndex - 1]?.id).filter((assetId): assetId is string => Boolean(assetId)).slice(0, 4),
    }));
  const unmatchedPrevious = [...previous.entries];
  const reconciled = entries.map((entry) => {
    const exact = unmatchedPrevious.find((candidate) => candidate.id === entry.id);
    const matchingAsset = unmatchedPrevious.find((candidate) => candidate.assetIds.some((assetId) => entry.assetIds.includes(assetId)));
    const matchingSummary = unmatchedPrevious.find((candidate) => normalizedEvidenceSummary(candidate.summary) === normalizedEvidenceSummary(entry.summary));
    const prior = exact ?? matchingAsset ?? matchingSummary;
    if (prior) unmatchedPrevious.splice(unmatchedPrevious.indexOf(prior), 1);
    return {
      ...entry,
      id: prior?.id ?? entry.id,
      assetIds: entry.assetIds.filter((assetId) => availableAssetIds.has(assetId)).slice(0, 4),
    };
  });
  const omitted = unmatchedPrevious.map((entry) => ({
    ...entry,
    status: 'ruled_out' as const,
    assetIds: entry.assetIds.filter((assetId) => availableAssetIds.has(assetId)).slice(0, 4),
  }));
  return {
    entries: [...reconciled, ...omitted].slice(0, 12),
  };
}

function worksetLabels(assets: ImageAsset[]): string[] {
  return assets.map((asset) => `[${asset.id}] ${asset.mapping.label}`);
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function retrievalPromptTokenEstimator(
  study: StudyMetadata,
  clinicalHint: string,
  plan: SelectionPlan,
  surveyMode: boolean,
  context: AnalysisRequestContext,
  ledger: EvidenceLedger,
): WorksetPromptTokenEstimator {
  return (assets) => {
    const labels = worksetLabels(assets);
    return estimateTextTokens(
      `${buildAnalysisSystemPrompt(surveyMode, context)}\n${labels.join('\n')}\n${buildAnalysisUserPrompt(study, clinicalHint, plan, labels, {
      ...context,
      evidenceLedger: ledger,
      imageManifest: buildImageManifest(assets.map((asset) => asset.mapping)),
      })}`,
    );
  };
}

function finalPromptTokenEstimator(
  study: StudyMetadata,
  clinicalHint: string,
  plan: SelectionPlan,
  surveyMode: boolean,
  ledger: EvidenceLedger,
): WorksetPromptTokenEstimator {
  return (assets) => {
    const labels = worksetLabels(assets);
    return estimateTextTokens(
      `${buildFinalAnalysisSystemPrompt(surveyMode)}\n${labels.join('\n')}\n${buildFinalAnalysisUserPrompt(study, clinicalHint, plan, labels, ledger)}`,
    );
  };
}

export function assertVisionPayloadFits(blobs: Blob[], provider: ProviderType): void {
  const bytes = blobs.reduce((total, blob) => total + blob.size, 0);
  const limit = PROVIDER_PAYLOAD_LIMITS[provider];
  if (bytes > limit) {
    throw new Error(`The rendered image payload is ${(bytes / MEBIBYTE).toFixed(1)}MB, above the ${(limit / MEBIBYTE).toFixed(0)}MB ${provider} limit. No images were omitted; lower image resolution or image count and rerun.`);
  }
}

function exportedToMapping(
  frame: ExportedSlice,
  series: StudyMetadata['series'][number],
  source: StudyMetadata['series'][number]['slices'][number] | undefined,
  round: number,
  imageIndex: number,
  assetRole: SliceMapping['assetRole'],
): SliceMapping {
  const seriesNumber = String(series.seriesNumber);
  return {
    imageIndex,
    assetId: `asset-${imageIndex}`,
    assetRole,
    kind: 'slice',
    instanceNumber: frame.instanceNumber,
    imageId: source?.imageId,
    seriesInstanceUID: series.seriesInstanceUID,
    zPosition: frame.zPosition,
    patientPoint: source ? patientPointForSlice(series, source) : undefined,
    label: `${series.seriesDescription || `Series #${seriesNumber}`} — Slice ${frame.instanceNumber}/${series.slices.length} (${frame.windowLabel || 'primary'}; position=${frame.zPosition.toFixed(0)}mm)`,
    seriesNumber,
    windowCenter: frame.windowCenter,
    windowWidth: frame.windowWidth,
    windowLabel: frame.windowLabel,
    width: frame.width,
    height: frame.height,
    pixelCount: frame.pixelCount,
    renderPath: frame.renderPath,
    crop: frame.crop?.rect,
    refinementRound: round,
  };
}

export function useLLMChat(metadata: Ref<StudyMetadata | null>, providerConfig: Ref<ProviderConfig>) {
  const messages = ref<ChatMessage[]>([]);
  const status = ref<ChatStatus>('idle');
  const error = ref<string | null>(null);
  const currentPlan = ref<SelectionPlan | null>(null);
  const pipeline = ref<PipelineState | null>(null);
  const statusText = computed(() => STATUS_LABELS[status.value]);
  let requestVersion = 0;
  let clinicalHint = '';
  let surveyMode = false;
  let planTiming = { start: 0, end: 0 };

  function updatePipeline(callback: (state: PipelineState) => PipelineState): void {
    if (pipeline.value) pipeline.value = callback(pipeline.value);
  }

  function activeSettings(): AnalysisSettings {
    return getProviderAnalysisConfig(providerConfig.value);
  }

  async function startAnalysis(hint: string, viewportContext?: ViewportContext, options?: { surveyMode?: boolean }): Promise<void> {
    const study = metadata.value;
    if (!study) return;
    const request = ++requestVersion;
    surveyMode = options?.surveyMode ?? false;
    error.value = null;
    const models = getConfiguredModels(providerConfig.value);
    const settings = activeSettings();
    pipeline.value = {
      plan: null, sliceCount: 0, totalSlices: 0, exportedSizes: [], sliceMappings: [], budget: null, qualityWarnings: [], refinementRound: 0,
      archiveImageCount: 0, activeImageCount: 0, excludedImageCount: 0, ledgerEntryCount: 0,
      comparisonLog: { provider: models.providerLabel, planningModel: models.textModel, visionModel: models.visionModel, settings, startedAt: Date.now(), rounds: [] },
      steps: [
        { id: 'plan', label: `Selection planning (${models.providerLabel}: ${models.textModel})`, status: 'pending' },
        { id: 'select', label: 'Selecting detail and overview images', status: 'pending' },
        { id: 'export', label: 'Rendering DICOM images', status: 'pending' },
        { id: 'analyze', label: `Analyzing images (${models.providerLabel}: ${models.visionModel})`, status: 'pending' },
        { id: 'synthesize', label: `Synthesizing final analysis (${models.providerLabel}: ${models.visionModel})`, status: 'pending' },
      ],
    };
    messages.value = [...messages.value, { id: makeId(), role: 'user', content: hint, timestamp: Date.now() }];

    try {
      const service = createLLMService(providerConfig.value);
      status.value = 'planning';
      const start = performance.now();
      updatePipeline((state) => ({ ...state, steps: updateStep(state.steps, 'plan', { status: 'active', detail: 'Sending study metadata and budget...' }) }));
      const rawPlan = await service.getSelectionPlan(study, hint, viewportContext, settings);
      if (request !== requestVersion) return;
      const { plan, budget } = budgetPlan(fixSelectionPlan(rawPlan, study, settings.maxImages), study, settings);
      const end = performance.now();
      currentPlan.value = plan;
      pipeline.value = pipeline.value && {
        ...pipeline.value,
        plan,
        budget,
        qualityWarnings: inspectPlanQuality(study, plan),
        steps: updateStep(pipeline.value.steps, 'plan', {
          status: 'done', detail: `${plan.totalImages} detail images + ${plan.selections.length} overview(s); ~${budget.estimatedInputTokens.toLocaleString()} input tokens`, durationMs: Math.round(end - start),
        }),
      };
      clinicalHint = hint;
      planTiming = { start, end };
      status.value = 'awaiting-confirmation';
    } catch (cause) {
      if (request !== requestVersion) return;
      error.value = cause instanceof Error ? cause.message : 'An unexpected error occurred.';
      status.value = 'error';
    }
  }

  async function appendPlanImages(
    study: StudyMetadata,
    plan: SelectionPlan,
    settings: AnalysisSettings,
    blobs: Blob[],
    mappings: SliceMapping[],
    round: number,
    includeMontage: boolean,
    uniqueImageIds: Set<string>,
    imageLimit: number,
  ): Promise<{ exported: ExportedSlice[]; sourceSliceCount: number; seriesSliceCount: number }> {
    const exportedFrames: ExportedSlice[] = [];
    let sourceSliceCount = 0;
    let seriesSliceCount = 0;
    for (const selection of plan.selections) {
      const series = study.series.find((candidate) => String(candidate.seriesNumber) === selection.seriesNumber);
      if (!series) continue;
      const selected = selectSlicesForSelection(study, selection, imageLimit);
      if (!selected.length) continue;
      sourceSliceCount += selected.length;
      seriesSliceCount += series.slices.length;
      for (const window of imageVariants(selection)) {
        const available = Math.max(0, imageLimit - blobs.length);
        if (!available) break;
        const windowKey = `wl:${window.windowCenter}:${window.windowWidth}`;
        const unseen = selected.filter((slice) => !uniqueImageIds.has(renderIdentity(slice.imageId, windowKey)));
        if (!unseen.length) continue;
        const frames = await exportSlicesToJpeg(unseen.slice(0, available), window.windowCenter, window.windowWidth, {
          maxImagePixels: settings.maxImagePixels,
          windowLabel: window.label,
        });
        for (const frame of frames) {
          const selectedSource = unseen.find((slice) => slice.instanceNumber === frame.instanceNumber);
          const source = selectedSource ? series.slices.find((slice) => slice.imageId === selectedSource.imageId) : undefined;
          if (!source || uniqueImageIds.has(renderIdentity(source.imageId, windowKey))) continue;
          uniqueImageIds.add(renderIdentity(source.imageId, windowKey));
          blobs.push(frame.blob);
          mappings.push(exportedToMapping(frame, series, source, round, blobs.length, 'planned'));
          exportedFrames.push(frame);
        }
      }
    }
    if (includeMontage && blobs.length < imageLimit) {
      for (const selection of plan.selections) {
        if (blobs.length >= imageLimit) break;
        const series = study.series.find((candidate) => String(candidate.seriesNumber) === selection.seriesNumber);
        if (!series) continue;
        const overviewSlices = selectOverviewSlices(study, selection.seriesNumber);
        const overviewFrames = await exportSlicesToJpeg(overviewSlices, selection.windowCenter, selection.windowWidth, { maxImagePixels: OVERVIEW_IMAGE_RESOLUTION, windowLabel: 'Overview' });
        const montage = await createSliceMontage(overviewFrames, series.seriesDescription || `Series #${selection.seriesNumber}`);
        if (!montage || blobs.length >= imageLimit) continue;
        blobs.push(montage.blob);
        mappings.push({ imageIndex: blobs.length, assetId: `asset-${blobs.length}`, assetRole: 'overview', kind: 'montage', label: montage.label, seriesNumber: selection.seriesNumber, seriesInstanceUID: series.seriesInstanceUID, pixelCount: Math.min(4, montage.sourceCount) * 192 * Math.ceil(montage.sourceCount / 4) * 214, refinementRound: round });
      }
    }
    return { exported: exportedFrames, sourceSliceCount, seriesSliceCount };
  }

  async function appendAdaptiveImages(
    study: StudyMetadata,
    request: AdaptiveImageRequestSet,
    settings: AnalysisSettings,
    blobs: Blob[],
    mappings: SliceMapping[],
    sourceMappings: SliceMapping[],
    round: number,
    uniqueImageIds: Set<string>,
    maxNewImages: number,
  ): Promise<ExportedSlice[]> {
    // Requests use the 1-based image index in this round's manifest, not the
    // immutable archive index attached to the local asset.
    const sources = sourceMappings.map((mapping, index) => ({
      imageIndex: index + 1,
      kind: mapping.kind,
      imageId: mapping.imageId,
      instanceNumber: mapping.instanceNumber,
      seriesInstanceUID: mapping.seriesInstanceUID,
      patientPoint: mapping.patientPoint,
    }));
    const resolved = resolveAdaptiveImageRequests(study, request.requests, sources);
    const exported: ExportedSlice[] = [];
    const startingCount = blobs.length;
    for (const target of resolved) {
      for (const spec of target.renderings) {
        if (blobs.length - startingCount >= maxNewImages || blobs.length >= settings.maxImages) return exported;
        const rendering = await resolveRenderSpec(target.series, spec);
        const crop = target.crop?.rect;
        const identity = renderIdentity(target.slice.imageId, rendering.key, crop);
        if (uniqueImageIds.has(identity)) continue;
        const frames = await exportSlicesToJpeg([target.slice], rendering.windowCenter, rendering.windowWidth, {
          maxImagePixels: settings.maxImagePixels,
          windowLabel: rendering.label,
          crop: target.crop,
        });
        const source = target.series.slices.find((slice) => slice.imageId === target.slice.imageId);
        for (const frame of frames) {
          if (uniqueImageIds.has(identity)) continue;
          uniqueImageIds.add(identity);
          blobs.push(frame.blob);
          mappings.push(exportedToMapping(frame, target.series, source, round, blobs.length, 'requested'));
          exported.push(frame);
        }
      }
    }
    return exported;
  }

  async function confirmPlan(candidate: SelectionPlan): Promise<void> {
    const study = metadata.value;
    if (!study) return;
    const request = ++requestVersion;
    error.value = null;
    const settings = activeSettings();
    const prepared = budgetPlan(fixSelectionPlan(candidate, study, settings.maxImages), study, settings);
    const effectiveSettings: AnalysisSettings = {
      ...settings,
      maxImages: prepared.budget.approvedImages,
      maxImagePixels: prepared.budget.pixelsPerImage,
    };
    const initialPlan = prepared.plan;
    currentPlan.value = initialPlan;
    updatePipeline((state) => ({
      ...state,
      plan: initialPlan,
      budget: prepared.budget,
      qualityWarnings: inspectPlanQuality(study, initialPlan),
      comparisonLog: { ...state.comparisonLog, settings: effectiveSettings },
      steps: updateStep(state.steps, 'plan', { status: 'done', durationMs: Math.round(planTiming.end - planTiming.start) }),
    }));

    try {
      const service = createLLMService(providerConfig.value);
      const blobs: Blob[] = [];
      const mappings: SliceMapping[] = [];
      const uniqueImageIds = new Set<string>();
      let allExported: ExportedSlice[] = [];
      let sourceSliceCount = 0;
      let seriesSliceCount = 0;
      let round = 0;
      const activePlan = initialPlan;
      let analysis: StructuredAnalysis | null = null;
      let evidenceLedger: EvidenceLedger = { entries: [] };

      status.value = 'exporting';
      updatePipeline((state) => ({ ...state, steps: updateStep(state.steps, 'select', { status: 'active', detail: `Selecting ${activePlan.totalImages} planned detail images and overview...` }) }));
      const exportStart = performance.now();
      const firstExport = await appendPlanImages(study, activePlan, effectiveSettings, blobs, mappings, round, true, uniqueImageIds, prepared.initialImageBudget);
      allExported = [...allExported, ...firstExport.exported];
      sourceSliceCount += firstExport.sourceSliceCount;
      seriesSliceCount += firstExport.seriesSliceCount;
      if (request !== requestVersion) return;
      if (!blobs.length) throw new Error('No slices matched the confirmed selection plan.');
      updatePipeline((state) => ({
        ...state,
        sliceCount: sourceSliceCount,
        totalSlices: seriesSliceCount,
        exportedSizes: blobs.map((blob) => `${Math.round(blob.size / 1024)}KB`),
        sliceMappings: mappings,
        archiveImageCount: blobs.length,
        activeImageCount: 0,
        excludedImageCount: 0,
        qualityWarnings: [...state.qualityWarnings, ...inspectExportQuality(allExported)],
        steps: updateStep(
          updateStep(state.steps, 'select', { status: 'done', detail: `${sourceSliceCount} source slices plus ${initialPlan.selections.length} overview(s)` }),
          'export', { status: 'done', detail: `${blobs.length} initial images (${effectiveSettings.maxImages} total budget)`, durationMs: Math.round(performance.now() - exportStart) },
        ),
      }));

      while (true) {
        status.value = 'analyzing';
        const analysisStart = performance.now();
        const remainingImages = effectiveSettings.maxImages - blobs.length;
        const maxNewImages = maximumImagesThisRound(effectiveSettings.maxImages, blobs.length, round, effectiveSettings.maxRefinementRounds);
        const analysisContext: AnalysisRequestContext = {
          settings: effectiveSettings,
          refinementRound: round,
          remainingRefinementRounds: Math.max(0, effectiveSettings.maxRefinementRounds - round),
          remainingImageBudget: remainingImages,
          maxNewImages,
          seriesCatalog: buildSeriesCatalog(study),
          evidenceLedger,
        };
        const workset = selectContextWorkset(
          archiveAssets(blobs, mappings), evidenceLedger, effectiveSettings, 'retrieval',
          retrievalPromptTokenEstimator(study, clinicalHint, initialPlan, surveyMode, analysisContext, evidenceLedger),
        );
        assertVisionPayloadFits(workset.assets.map((asset) => asset.blob), providerConfig.value.provider);
        updatePipeline((state) => ({
          ...state,
          budget: workset.budget,
          archiveImageCount: blobs.length,
          activeImageCount: workset.assets.length,
          excludedImageCount: workset.excludedAssets.length,
          ledgerEntryCount: evidenceLedger.entries.length,
          steps: updateStep(state.steps, 'analyze', { status: 'active', detail: `Sending ${workset.assets.length}/${blobs.length} context-budgeted images (round ${round + 1})...` }),
        }));
        analysis = await service.analyzeSlices(workset.assets.map((asset) => asset.blob), study, clinicalHint, initialPlan, worksetLabels(workset.assets), surveyMode, {
          ...analysisContext,
          imageManifest: buildImageManifest(workset.assets.map((asset) => asset.mapping)),
        });
        if (request !== requestVersion) return;
        evidenceLedger = reconcileEvidenceLedger(analysis, workset.assets, evidenceLedger);
        analysis.evidenceLedger = evidenceLedger;
        const durationMs = Math.round(performance.now() - analysisStart);
        updatePipeline((state) => ({
          ...state,
          refinementRound: round,
          ledgerEntryCount: evidenceLedger.entries.length,
          comparisonLog: { ...state.comparisonLog, rounds: [...state.comparisonLog.rounds, { round, imageCount: workset.assets.length, archivedImageCount: blobs.length, excludedImageCount: workset.excludedAssets.length, estimatedInputTokens: workset.budget.estimatedInputTokens, ledgerEntryCount: evidenceLedger.entries.length, requestedAdditionalImages: analysis?.nextAction === 'request_images', reason: analysis?.imageRequest?.reason, durationMs }] },
          steps: updateStep(state.steps, 'analyze', { status: 'done', detail: `Round ${round + 1} response received`, durationMs }),
        }));

        const imageRequest = analysis.imageRequest;
        if (analysis.nextAction !== 'request_images' || !imageRequest || !canRunRefinement(imageRequest, round, effectiveSettings.maxRefinementRounds, remainingImages)) {
          if (analysis.nextAction === 'request_images' && (round >= effectiveSettings.maxRefinementRounds || remainingImages <= 0)) {
            analysis.limitations = [...analysis.limitations, 'The model requested additional images, but the configured refinement-round or image budget had been reached.'];
          }
          break;
        }

        round++;
        status.value = 'refining';
        const refinementStepId = `refinement-${round}`;
        updatePipeline((state) => ({
          ...state,
          steps: [...state.steps, { id: refinementStepId, label: `Refinement ${round}: image retrieval`, status: 'active', detail: imageRequest.reason || 'Targeted visual gap' }],
        }));
        const refinementExported = await appendAdaptiveImages(study, imageRequest, effectiveSettings, blobs, mappings, workset.assets.map((asset) => asset.mapping), round, uniqueImageIds, Math.max(1, maxNewImages));
        allExported = [...allExported, ...refinementExported];
        if (!refinementExported.length) {
          analysis.limitations = [...analysis.limitations, 'No non-duplicate images could be exported for the requested refinement.'];
          break;
        }
        updatePipeline((state) => ({ ...state, steps: updateStep(state.steps, refinementStepId, { status: 'done', detail: `${refinementExported.length} directly requested image renderings` }) }));
        updatePipeline((state) => ({
          ...state,
          sliceCount: mappings.filter((mapping) => mapping.kind === 'slice').length,
          totalSlices: seriesSliceCount,
          exportedSizes: blobs.map((blob) => `${Math.round(blob.size / 1024)}KB`),
          sliceMappings: mappings,
          archiveImageCount: blobs.length,
          qualityWarnings: [...state.qualityWarnings, ...inspectExportQuality(refinementExported)],
        }));
      }

      if (!analysis) throw new Error('The analysis model did not return a result.');
      let finalAnalysis: FinalAnalysis | null = null;
      let finalWorkset: ContextWorkset | null = null;
      try {
        status.value = 'synthesizing';
        finalWorkset = selectContextWorkset(
          archiveAssets(blobs, mappings), evidenceLedger, effectiveSettings, 'final',
          finalPromptTokenEstimator(study, clinicalHint, initialPlan, surveyMode, evidenceLedger),
        );
        assertVisionPayloadFits(finalWorkset.assets.map((asset) => asset.blob), providerConfig.value.provider);
        updatePipeline((state) => ({
          ...state,
          budget: finalWorkset!.budget,
          archiveImageCount: blobs.length,
          activeImageCount: finalWorkset!.assets.length,
          excludedImageCount: finalWorkset!.excludedAssets.length,
          ledgerEntryCount: evidenceLedger.entries.length,
          steps: updateStep(state.steps, 'synthesize', { status: 'active', detail: `Sending ${finalWorkset!.assets.length}/${blobs.length} final evidence images...` }),
        }));
        const finalStart = performance.now();
        finalAnalysis = await service.synthesizeFinalAnalysis(
          finalWorkset.assets.map((asset) => asset.blob), study, clinicalHint, initialPlan, worksetLabels(finalWorkset.assets), evidenceLedger, effectiveSettings, surveyMode,
        );
        if (request !== requestVersion) return;
        updatePipeline((state) => ({
          ...state,
          steps: updateStep(state.steps, 'synthesize', { status: 'done', detail: 'Final synthesis received', durationMs: Math.round(performance.now() - finalStart) }),
        }));
      } catch (finalCause) {
        const detail = finalCause instanceof Error ? finalCause.message : 'Unknown final synthesis error.';
        analysis.limitations = [...analysis.limitations, `Final synthesis was unavailable; showing the last retrieval assessment. ${detail}`];
        updatePipeline((state) => ({ ...state, steps: updateStep(state.steps, 'synthesize', { status: 'error', detail }) }));
      }
      const output = finalAnalysis && finalWorkset
        ? formatFinalAnalysis(finalAnalysis, worksetLabels(finalWorkset.assets))
        : formatStructuredAnalysis(analysis, mappings.map((mapping) => mapping.label));
      messages.value = [...messages.value, { id: makeId(), role: 'assistant', content: output, timestamp: Date.now() }];
      status.value = 'idle';
    } catch (cause) {
      if (request !== requestVersion) return;
      logger.warn('[DICOMassist] analysis failed', cause);
      error.value = cause instanceof Error ? cause.message : 'An unexpected error occurred.';
      status.value = 'error';
    }
  }

  function cancelPlan(): void {
    requestVersion++;
    status.value = 'idle';
    currentPlan.value = null;
    pipeline.value = null;
    if (messages.value.at(-1)?.role === 'user') messages.value = messages.value.slice(0, -1);
  }

  async function sendFollowUp(text: string): Promise<void> {
    const study = metadata.value;
    if (!study || !text.trim()) return;
    const request = ++requestVersion;
    error.value = null;
    const history = [...messages.value, { id: makeId(), role: 'user' as const, content: text.trim(), timestamp: Date.now() }];
    messages.value = history;
    try {
      status.value = 'following-up';
      const response = await createLLMService(providerConfig.value).sendFollowUp(history, study, activeSettings());
      if (request !== requestVersion) return;
      messages.value = [...messages.value, { id: makeId(), role: 'assistant', content: response, timestamp: Date.now() }];
      status.value = 'idle';
    } catch (cause) {
      if (request !== requestVersion) return;
      error.value = cause instanceof Error ? cause.message : 'An unexpected error occurred.';
      status.value = 'error';
    }
  }

  function clearChat(): void {
    requestVersion++;
    surveyMode = false;
    messages.value = [];
    status.value = 'idle';
    error.value = null;
    currentPlan.value = null;
    pipeline.value = null;
  }

  return { messages, status, statusText, error, currentPlan, pipeline, startAnalysis, confirmPlan, cancelPlan, sendFollowUp, clearChat };
}
