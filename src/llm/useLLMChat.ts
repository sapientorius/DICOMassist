import { computed, ref, type Ref } from 'vue';
import type { StudyMetadata } from '../dicom/types';
import type { AnalysisBudgetEstimate, AnalysisSettings } from './analysisConfig';
import { estimateAnalysisBudget } from './analysisConfig';
import type { AdditionalImageRequest, ChatMessage, DisplayWindow, ProviderConfig, SelectionPlan, SeriesSelection, StructuredAnalysis, ViewportContext } from './types';
import { createLLMService, getConfiguredModels } from './LLMServiceFactory';
import { formatStructuredAnalysis } from './analysisResults';
import { getProviderAnalysisConfig } from './providerConfig';
import { createSliceMontage } from '../filtering/SliceMontage';
import { exportSlicesToJpeg, type ExportedSlice } from '../filtering/SliceExporter';
import { inspectExportQuality, inspectPlanQuality, type QualityWarning } from '../filtering/qualityChecks';
import { selectOverviewSlices, selectSlicesForSelection } from '../filtering/SliceSelector';
import { logger } from '../utils/logger';

export type ChatStatus = 'idle' | 'planning' | 'awaiting-confirmation' | 'exporting' | 'analyzing' | 'refining' | 'following-up' | 'error';

export interface PipelineStep {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
  detail?: string;
  durationMs?: number;
}

export interface SliceMapping {
  imageIndex: number;
  kind: 'slice' | 'montage';
  instanceNumber?: number;
  imageId?: string;
  zPosition?: number;
  label: string;
  seriesNumber: string;
  windowCenter?: number;
  windowWidth?: number;
  windowLabel?: string;
  width?: number;
  height?: number;
  pixelCount?: number;
  renderPath?: 'cornerstone' | 'fallback';
  refinementRound: number;
}

export interface AnalysisRoundLog {
  round: number;
  imageCount: number;
  requestedAdditionalImages?: boolean;
  reason?: string;
  durationMs?: number;
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
  comparisonLog: ComparisonLog;
}

const STATUS_LABELS: Record<ChatStatus, string> = {
  idle: '', planning: 'Analyzing metadata...', 'awaiting-confirmation': 'Review selection plan...',
  exporting: 'Preparing images...', analyzing: 'Generating analysis...', refining: 'Requesting targeted additional images...', 'following-up': 'Thinking...', error: 'Error',
};
const LEGACY_MAX_TOTAL_IMAGES = 20;
const OVERVIEW_IMAGE_RESOLUTION = 256 * 256;

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
  return [...unique.values()].slice(0, 1);
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

export function canRunRefinement(request: AdditionalImageRequest, completedRounds: number, maxRounds: number, remainingImages: number): boolean {
  return request.needed && request.selections.length > 0 && completedRounds < maxRounds && remainingImages > 0;
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
  const refinementReserve = settings.maxRefinementRounds > 0 ? Math.max(2, Math.floor(firstEstimate.approvedImages * 0.25)) : 0;
  const initialImageBudget = Math.max(1, firstEstimate.approvedImages - 1 - refinementReserve);
  const corrected = fixSelectionPlan(plan, metadata, initialImageBudget);
  const budget = estimateAnalysisBudget(settings, requested, sourcePixelsForPlan(corrected, metadata));
  return { plan: corrected, budget, initialImageBudget };
}

function combinePlans(initial: SelectionPlan, extra: SelectionPlan[]): SelectionPlan {
  const selections = [
    ...initial.selections,
    ...extra.flatMap((plan) => plan.selections.map((selection) => ({ ...selection, role: 'supplementary' as const }))),
  ];
  const primary = selections[0];
  return {
    ...initial,
    selections: [primary, ...selections.slice(1)],
    totalImages: selections.reduce((sum, selection) => sum + estimateSliceCount(selection), 0),
  };
}

function refinementHint(clinicalHint: string, request: AdditionalImageRequest, mappings: SliceMapping[]): string {
  const seen = mappings.filter((mapping) => mapping.kind === 'slice').map((mapping) => `#${mapping.seriesNumber}/${mapping.instanceNumber}`).join(', ');
  const requestedSelections = request.selections.map((selection) => {
    const windows = [
      `W:${selection.windowWidth} C:${selection.windowCenter}`,
      ...(selection.displayWindows ?? []).map((window) => `${window.label} W:${window.windowWidth} C:${window.windowCenter}`),
    ].join(', ');
    return `Series #${selection.seriesNumber}, instances ${selection.sliceRange[0]}-${selection.sliceRange[1]}, ${selection.samplingStrategy}${selection.samplingParam ? ` (${selection.samplingParam})` : ''}, ${windows}; coverage: ${selection.coverageGoal || selection.rationale}`;
  }).join('\n');
  return [
    clinicalHint,
    '',
    'The vision analysis needs targeted additional images. Create a NEW, minimal supplementary selection plan only.',
    `Visual gap: ${request.reason || 'The supplied images did not adequately cover a structure.'}`,
    `Vision model's requested targets:\n${requestedSelections}`,
    `Already exported image references: ${seen || 'none'}. Avoid duplicating them where possible.`,
  ].join('\n');
}

function exportedToMapping(frame: ExportedSlice, seriesNumber: string, seriesDescription: string, totalSlices: number, imageId: string | undefined, round: number, imageIndex: number): SliceMapping {
  return {
    imageIndex,
    kind: 'slice',
    instanceNumber: frame.instanceNumber,
    imageId,
    zPosition: frame.zPosition,
    label: `${seriesDescription || `Series #${seriesNumber}`} — Slice ${frame.instanceNumber}/${totalSlices} (${frame.windowLabel || 'primary'}; position=${frame.zPosition.toFixed(0)}mm)`,
    seriesNumber,
    windowCenter: frame.windowCenter,
    windowWidth: frame.windowWidth,
    windowLabel: frame.windowLabel,
    width: frame.width,
    height: frame.height,
    pixelCount: frame.pixelCount,
    renderPath: frame.renderPath,
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
      comparisonLog: { provider: models.providerLabel, planningModel: models.textModel, visionModel: models.visionModel, settings, startedAt: Date.now(), rounds: [] },
      steps: [
        { id: 'plan', label: `Selection planning (${models.providerLabel}: ${models.textModel})`, status: 'pending' },
        { id: 'select', label: 'Selecting detail and overview images', status: 'pending' },
        { id: 'export', label: 'Rendering DICOM images', status: 'pending' },
        { id: 'analyze', label: `Analyzing images (${models.providerLabel}: ${models.visionModel})`, status: 'pending' },
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
          status: 'done', detail: `${plan.totalImages} detail images + 1 overview; ~${budget.estimatedInputTokens.toLocaleString()} input tokens`, durationMs: Math.round(end - start),
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
  ): Promise<{ exported: ExportedSlice[]; sourceSliceCount: number; seriesSliceCount: number }> {
    const exportedFrames: ExportedSlice[] = [];
    let sourceSliceCount = 0;
    let seriesSliceCount = 0;
    for (const selection of plan.selections) {
      const series = study.series.find((candidate) => String(candidate.seriesNumber) === selection.seriesNumber);
      if (!series) continue;
      const selected = selectSlicesForSelection(study, selection, settings.maxImages);
      if (!selected.length) continue;
      sourceSliceCount += selected.length;
      seriesSliceCount += series.slices.length;
      for (const window of imageVariants(selection)) {
        const available = Math.max(0, settings.maxImages - blobs.length);
        if (!available) break;
        const unseen = selected.filter((slice) => !uniqueImageIds.has(`${slice.imageId}:${window.label}`));
        if (!unseen.length) continue;
        const frames = await exportSlicesToJpeg(unseen.slice(0, available), window.windowCenter, window.windowWidth, {
          maxImagePixels: settings.maxImagePixels,
          windowLabel: window.label,
        });
        for (const frame of frames) {
          const source = unseen.find((slice) => slice.instanceNumber === frame.instanceNumber);
          if (!source || uniqueImageIds.has(`${source.imageId}:${window.label}`)) continue;
          uniqueImageIds.add(`${source.imageId}:${window.label}`);
          blobs.push(frame.blob);
          mappings.push(exportedToMapping(frame, selection.seriesNumber, series.seriesDescription, series.slices.length, source.imageId, round, blobs.length));
          exportedFrames.push(frame);
        }
      }
    }
    if (includeMontage && blobs.length < settings.maxImages) {
      const primary = plan.selections[0];
      const series = study.series.find((candidate) => String(candidate.seriesNumber) === primary.seriesNumber);
      if (series) {
        const overviewSlices = selectOverviewSlices(study, primary.seriesNumber);
        const overviewFrames = await exportSlicesToJpeg(overviewSlices, primary.windowCenter, primary.windowWidth, { maxImagePixels: OVERVIEW_IMAGE_RESOLUTION, windowLabel: 'Overview' });
        const montage = await createSliceMontage(overviewFrames, series.seriesDescription || `Series #${primary.seriesNumber}`);
        if (montage && blobs.length < settings.maxImages) {
          blobs.unshift(montage.blob);
          mappings.unshift({ imageIndex: 1, kind: 'montage', label: montage.label, seriesNumber: primary.seriesNumber, refinementRound: round });
          mappings.forEach((mapping, index) => { mapping.imageIndex = index + 1; });
        }
      }
    }
    return { exported: exportedFrames, sourceSliceCount, seriesSliceCount };
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
      const allPlans: SelectionPlan[] = [];
      let allExported: ExportedSlice[] = [];
      let sourceSliceCount = 0;
      let seriesSliceCount = 0;
      let round = 0;
      const activePlan = initialPlan;
      let analysis: StructuredAnalysis | null = null;

      status.value = 'exporting';
      updatePipeline((state) => ({ ...state, steps: updateStep(state.steps, 'select', { status: 'active', detail: `Selecting ${activePlan.totalImages} planned detail images and overview...` }) }));
      const exportStart = performance.now();
      const firstExport = await appendPlanImages(study, activePlan, effectiveSettings, blobs, mappings, round, true, uniqueImageIds);
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
        qualityWarnings: [...state.qualityWarnings, ...inspectExportQuality(allExported)],
        steps: updateStep(
          updateStep(state.steps, 'select', { status: 'done', detail: `${sourceSliceCount} source slices plus overview montage` }),
          'export', { status: 'done', detail: `${blobs.length} images (${effectiveSettings.maxImages} budget)`, durationMs: Math.round(performance.now() - exportStart) },
        ),
      }));

      while (true) {
        status.value = 'analyzing';
        const analysisStart = performance.now();
        const combinedPlan = combinePlans(initialPlan, allPlans);
        updatePipeline((state) => ({ ...state, steps: updateStep(state.steps, 'analyze', { status: 'active', detail: `Sending ${blobs.length} images (round ${round + 1})...` }) }));
        analysis = await service.analyzeSlices(blobs, study, clinicalHint, combinedPlan, mappings.map((mapping) => mapping.label), surveyMode, {
          settings: effectiveSettings,
          refinementRound: round,
          remainingRefinementRounds: Math.max(0, effectiveSettings.maxRefinementRounds - round),
        });
        if (request !== requestVersion) return;
        const durationMs = Math.round(performance.now() - analysisStart);
        updatePipeline((state) => ({
          ...state,
          refinementRound: round,
          comparisonLog: { ...state.comparisonLog, rounds: [...state.comparisonLog.rounds, { round, imageCount: blobs.length, requestedAdditionalImages: analysis?.additionalImageRequest.needed, reason: analysis?.additionalImageRequest.reason, durationMs }] },
          steps: updateStep(state.steps, 'analyze', { status: 'done', detail: `Round ${round + 1} response received`, durationMs }),
        }));

        const imageRequest = analysis.additionalImageRequest;
        const remainingImages = effectiveSettings.maxImages - blobs.length;
        if (!canRunRefinement(imageRequest, round, effectiveSettings.maxRefinementRounds, remainingImages)) {
          if (imageRequest.needed && (round >= effectiveSettings.maxRefinementRounds || remainingImages <= 0)) {
            analysis.limitations = [...analysis.limitations, 'The model requested additional images, but the configured refinement-round or image budget had been reached.'];
          }
          break;
        }

        round++;
        status.value = 'refining';
        const refinementStepId = `refinement-${round}`;
        updatePipeline((state) => ({
          ...state,
          steps: [...state.steps, { id: refinementStepId, label: `Refinement ${round}: planner review`, status: 'active', detail: imageRequest.reason || 'Targeted visual gap' }],
        }));
        const refinementSettings = { ...effectiveSettings, maxImages: remainingImages };
        const rawRefinementPlan = await service.getSelectionPlan(study, refinementHint(clinicalHint, imageRequest, mappings), undefined, refinementSettings);
        if (request !== requestVersion) return;
        const refinementPlan = fixSelectionPlan(rawRefinementPlan, study, remainingImages);
        allPlans.push(refinementPlan);
        updatePipeline((state) => ({ ...state, steps: updateStep(state.steps, refinementStepId, { status: 'done', detail: `${refinementPlan.totalImages} targeted images` }) }));
        const refinementExport = await appendPlanImages(study, refinementPlan, effectiveSettings, blobs, mappings, round, false, uniqueImageIds);
        allExported = [...allExported, ...refinementExport.exported];
        sourceSliceCount += refinementExport.sourceSliceCount;
        seriesSliceCount += refinementExport.seriesSliceCount;
        if (!refinementExport.exported.length) {
          analysis.limitations = [...analysis.limitations, 'No non-duplicate images could be exported for the requested refinement.'];
          break;
        }
        updatePipeline((state) => ({
          ...state,
          sliceCount: sourceSliceCount,
          totalSlices: seriesSliceCount,
          exportedSizes: blobs.map((blob) => `${Math.round(blob.size / 1024)}KB`),
          sliceMappings: mappings,
          qualityWarnings: [...state.qualityWarnings, ...inspectExportQuality(refinementExport.exported)],
        }));
      }

      if (!analysis) throw new Error('The analysis model did not return a result.');
      messages.value = [...messages.value, { id: makeId(), role: 'assistant', content: formatStructuredAnalysis(analysis, mappings.map((mapping) => mapping.label)), timestamp: Date.now() }];
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
