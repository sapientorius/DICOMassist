import { computed, ref, type Ref } from 'vue';
import type { StudyMetadata } from '../dicom/types';
import type { SelectionPlan, SeriesSelection, ChatMessage, ProviderConfig, ViewportContext } from './types';
import { createLLMService, getConfiguredModels } from './LLMServiceFactory';
import { selectSlicesForSelection } from '../filtering/SliceSelector';
import { exportSlicesToJpeg } from '../filtering/SliceExporter';
import { logger } from '../utils/logger';

export type ChatStatus = 'idle' | 'planning' | 'awaiting-confirmation' | 'exporting' | 'analyzing' | 'following-up' | 'error';

export interface PipelineStep {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
  detail?: string;
  durationMs?: number;
}

export interface SliceMapping {
  imageIndex: number;
  instanceNumber: number;
  imageId: string;
  zPosition: number;
  label: string;
  seriesNumber: string;
}

export interface PipelineState {
  steps: PipelineStep[];
  plan: SelectionPlan | null;
  sliceCount: number;
  totalSlices: number;
  exportedSizes: string[];
  sliceMappings: SliceMapping[];
}

const STATUS_LABELS: Record<ChatStatus, string> = {
  idle: '', planning: 'Analyzing metadata...', 'awaiting-confirmation': 'Review selection plan...',
  exporting: 'Preparing images...', analyzing: 'Generating analysis...', 'following-up': 'Thinking...', error: 'Error',
};
const MAX_TOTAL_IMAGES = 20;

function makeId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function updateStep(steps: PipelineStep[], id: string, updates: Partial<PipelineStep>): PipelineStep[] {
  return steps.map((step) => step.id === id ? { ...step, ...updates } : step);
}

function estimateSliceCount(selection: SeriesSelection): number {
  const rangeSize = selection.sliceRange[1] - selection.sliceRange[0] + 1;
  if (selection.samplingStrategy === 'uniform' && selection.samplingParam != null) return Math.min(selection.samplingParam, rangeSize);
  if (selection.samplingStrategy === 'every_nth' && selection.samplingParam != null && selection.samplingParam > 0) return Math.ceil(rangeSize / selection.samplingParam);
  return rangeSize;
}

function fixSelection(selection: SeriesSelection, metadata: StudyMetadata, budget: number): SeriesSelection | null {
  const series = metadata.series.find((candidate) => String(candidate.seriesNumber) === selection.seriesNumber);
  if (!series || !Number.isFinite(selection.sliceRange[0]) || !Number.isFinite(selection.sliceRange[1])) return null;

  const [minimum, maximum] = series.instanceNumberRange;
  let [start, end] = selection.sliceRange;
  if (start > end) [start, end] = [end, start];
  start = Math.max(minimum, Math.round(start));
  end = Math.min(maximum, Math.round(end));
  if (start > end) return null;

  let samplingStrategy = selection.samplingStrategy;
  let samplingParam = selection.samplingParam;
  const rangeSize = end - start + 1;
  if (samplingStrategy === 'all' && rangeSize > budget) {
    samplingStrategy = 'uniform';
    samplingParam = budget;
  }
  if ((samplingStrategy === 'uniform' || samplingStrategy === 'every_nth') && (!Number.isFinite(samplingParam) || (samplingParam ?? 0) < 1)) {
    samplingStrategy = 'uniform';
    samplingParam = Math.min(budget, rangeSize);
  }
  if (samplingStrategy === 'uniform') samplingParam = Math.min(Math.round(samplingParam ?? budget), rangeSize, budget);
  if (samplingStrategy === 'every_nth') samplingParam = Math.max(1, Math.round(samplingParam ?? 1));

  const windowCenter = Number.isFinite(selection.windowCenter) ? selection.windowCenter : (series.windowCenter ?? 40);
  const windowWidth = Number.isFinite(selection.windowWidth) && selection.windowWidth > 0 ? selection.windowWidth : (series.windowWidth ?? 400);
  return { ...selection, sliceRange: [start, end], samplingStrategy, samplingParam, windowCenter, windowWidth };
}

/** Validates an untrusted LLM response against the locally loaded study. */
export function fixSelectionPlan(plan: SelectionPlan, metadata: StudyMetadata): SelectionPlan {
  const corrected = plan.selections
    .map((selection) => fixSelection(selection, metadata, MAX_TOTAL_IMAGES))
    .filter((selection): selection is SeriesSelection => selection !== null);
  if (corrected.length === 0) throw new Error('The selection plan did not reference a valid series in this study.');

  let selections = corrected;
  let total = selections.reduce((sum, selection) => sum + estimateSliceCount(selection), 0);
  for (let index = selections.length - 1; index >= 0 && total > MAX_TOTAL_IMAGES; index--) {
    if (selections[index].role !== 'supplementary') continue;
    const current = estimateSliceCount(selections[index]);
    selections[index] = { ...selections[index], samplingStrategy: 'uniform', samplingParam: Math.max(2, current - (total - MAX_TOTAL_IMAGES)) };
    total = selections.reduce((sum, selection) => sum + estimateSliceCount(selection), 0);
  }
  if (total > MAX_TOTAL_IMAGES) {
    const primary = selections.find((selection) => selection.role === 'primary') ?? selections[0];
    selections = [{ ...primary, role: 'primary', samplingStrategy: 'uniform', samplingParam: MAX_TOTAL_IMAGES }];
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

  async function startAnalysis(hint: string, viewportContext?: ViewportContext, options?: { surveyMode?: boolean }): Promise<void> {
    const study = metadata.value;
    if (!study) return;
    const request = ++requestVersion;
    surveyMode = options?.surveyMode ?? false;
    error.value = null;
    const models = getConfiguredModels(providerConfig.value);
    pipeline.value = {
      plan: null, sliceCount: 0, totalSlices: 0, exportedSizes: [], sliceMappings: [],
      steps: [
        { id: 'plan', label: `Selection planning (${models.providerLabel}: ${models.textModel})`, status: 'pending' },
        { id: 'select', label: 'Selecting slices', status: 'pending' },
        { id: 'export', label: 'Exporting images', status: 'pending' },
        { id: 'analyze', label: `Analyzing images (${models.providerLabel}: ${models.visionModel})`, status: 'pending' },
      ],
    };
    messages.value = [...messages.value, { id: makeId(), role: 'user', content: hint, timestamp: Date.now() }];

    try {
      const service = createLLMService(providerConfig.value);
      status.value = 'planning';
      const start = performance.now();
      updatePipeline((state) => ({ ...state, steps: updateStep(state.steps, 'plan', { status: 'active', detail: 'Sending study metadata...' }) }));
      const rawPlan = await service.getSelectionPlan(study, hint, viewportContext);
      if (request !== requestVersion) return;
      const plan = fixSelectionPlan(rawPlan, study);
      const end = performance.now();
      currentPlan.value = plan;
      pipeline.value = pipeline.value && {
        ...pipeline.value,
        plan,
        steps: updateStep(pipeline.value.steps, 'plan', {
          status: 'done', detail: `Series #${plan.targetSeries}, instances ${plan.sliceRange[0]}–${plan.sliceRange[1]}`,
          durationMs: Math.round(end - start),
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

  async function confirmPlan(candidate: SelectionPlan): Promise<void> {
    const study = metadata.value;
    if (!study) return;
    const request = ++requestVersion;
    error.value = null;
    const plan = fixSelectionPlan(candidate, study);
    currentPlan.value = plan;
    updatePipeline((state) => ({
      ...state, plan,
      steps: updateStep(state.steps, 'plan', { status: 'done', durationMs: Math.round(planTiming.end - planTiming.start) }),
    }));

    try {
      const service = createLLMService(providerConfig.value);
      status.value = 'exporting';
      updatePipeline((state) => ({ ...state, steps: updateStep(state.steps, 'select', { status: 'active', detail: `Selecting from ${plan.selections.length} series...` }) }));
      const exportStart = performance.now();
      const blobs: Blob[] = [];
      const mappings: SliceMapping[] = [];
      let sourceSliceCount = 0;
      let seriesSliceCount = 0;

      for (const selection of plan.selections) {
        const selected = selectSlicesForSelection(study, selection);
        const series = study.series.find((candidateSeries) => String(candidateSeries.seriesNumber) === selection.seriesNumber);
        if (!series || selected.length === 0) continue;
        sourceSliceCount += selected.length;
        seriesSliceCount += series.slices.length;
        updatePipeline((state) => ({ ...state, steps: updateStep(state.steps, 'export', { status: 'active', detail: `Rendering series #${selection.seriesNumber}...` }) }));
        const exported = await exportSlicesToJpeg(selected, selection.windowCenter, selection.windowWidth);
        if (request !== requestVersion) return;
        const axis = series.anatomicalPlane === 'sagittal' ? 'x' : series.anatomicalPlane === 'coronal' ? 'y' : 'z';
        for (const frame of exported) {
          const source = selected.find((slice) => slice.instanceNumber === frame.instanceNumber);
          blobs.push(frame.blob);
          mappings.push({
            imageIndex: blobs.length, instanceNumber: frame.instanceNumber, imageId: source?.imageId ?? '', zPosition: frame.zPosition,
            label: `${series.seriesDescription || `Series #${selection.seriesNumber}`} — Slice ${frame.instanceNumber}/${series.slices.length} (${axis}=${frame.zPosition.toFixed(0)}mm)`,
            seriesNumber: selection.seriesNumber,
          });
        }
      }
      if (blobs.length === 0) throw new Error('No slices matched the confirmed selection plan.');
      const exportEnd = performance.now();
      const sizes = blobs.map((blob) => `${Math.round(blob.size / 1024)}KB`);
      pipeline.value = pipeline.value && {
        ...pipeline.value, sliceCount: sourceSliceCount, totalSlices: seriesSliceCount, exportedSizes: sizes, sliceMappings: mappings,
        steps: updateStep(
          updateStep(pipeline.value.steps, 'select', { status: 'done', detail: `${sourceSliceCount} selected slices` }),
          'export', { status: 'done', detail: `${blobs.length} JPEG images`, durationMs: Math.round(exportEnd - exportStart) },
        ),
      };

      status.value = 'analyzing';
      const analysisStart = performance.now();
      updatePipeline((state) => ({ ...state, steps: updateStep(state.steps, 'analyze', { status: 'active', detail: `Sending ${blobs.length} images...` }) }));
      const response = await service.analyzeSlices(blobs, study, clinicalHint, plan, mappings.map((mapping) => mapping.label), surveyMode);
      if (request !== requestVersion) return;
      updatePipeline((state) => ({ ...state, steps: updateStep(state.steps, 'analyze', { status: 'done', detail: 'Response received', durationMs: Math.round(performance.now() - analysisStart) }) }));
      messages.value = [...messages.value, { id: makeId(), role: 'assistant', content: response, timestamp: Date.now() }];
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
      const response = await createLLMService(providerConfig.value).sendFollowUp(history, study);
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
