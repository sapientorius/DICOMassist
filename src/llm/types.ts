import type { StudyMetadata } from '../dicom/types';
import type { AnalysisSettings } from './analysisConfig';

export interface DisplayWindow {
  label: string;
  windowCenter: number;
  windowWidth: number;
}

/** A display instruction applied locally to the original DICOM pixels. */
export type RenderSpec =
  | { mode: 'dicom-default'; label?: string }
  | { mode: 'window-level'; windowCenter: number; windowWidth: number; label?: string }
  | { mode: 'series-percentile'; lowPercentile: number; highPercentile: number; label?: string }
  | { mode: 'relative-display'; brightness: 'darker' | 'default' | 'brighter'; contrast: 'lower' | 'default' | 'higher'; label?: string };

export interface NormalizedCrop {
  /** [left, top, width, height], all in the inclusive 0–1 image coordinate space. */
  rect: [number, number, number, number];
}

export interface InstanceImageRequest {
  kind: 'instances';
  seriesInstanceUID: string;
  instanceNumbers?: number[];
  sliceRange?: [number, number];
  samplingStrategy?: 'every_nth' | 'uniform' | 'all';
  samplingParam?: number;
  renderings: RenderSpec[];
  priority?: number;
}

export interface NeighbourImageRequest {
  kind: 'neighbours';
  sourceImageIndex: number;
  before: number;
  after: number;
  renderings: RenderSpec[];
  priority?: number;
}

export interface CropImageRequest extends NormalizedCrop {
  kind: 'crop';
  sourceImageIndex: number;
  renderings: RenderSpec[];
  priority?: number;
}

export interface CrossPlaneImageRequest {
  kind: 'cross-plane';
  sourceImageIndex: number;
  targetSeriesInstanceUID: string;
  /** Number of native slices on either side of the nearest corresponding plane. */
  neighbours?: number;
  renderings: RenderSpec[];
  priority?: number;
}

export type AdaptiveImageRequest = InstanceImageRequest | NeighbourImageRequest | CropImageRequest | CrossPlaneImageRequest;

export interface AdaptiveImageRequestSet {
  reason: string;
  requests: AdaptiveImageRequest[];
}

export interface SeriesSelection {
  seriesNumber: string;
  role: 'primary' | 'supplementary';
  rationale: string;
  sliceRange: [number, number];
  samplingStrategy: 'every_nth' | 'uniform' | 'all';
  samplingParam?: number;
  windowWidth: number;
  windowCenter: number;
  /** Additional display windows for the same selected slices (mostly CT). */
  displayWindows?: DisplayWindow[];
  /** What anatomical coverage this selection is expected to provide. */
  coverageGoal?: string;
}

export interface SelectionPlan {
  reasoning: string;
  selections: SeriesSelection[];
  totalImages: number;
  // Compatibility shortcuts from selections[0] — used by viewport navigation.
  targetSeries: string;
  sliceRange: [number, number];
  windowCenter: number;
  windowWidth: number;
  samplingStrategy: 'every_nth' | 'uniform' | 'all';
  samplingParam?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export type ProviderType = 'claude' | 'ollama' | 'lmstudio' | 'openrouter' | 'openai';

export interface ProviderProfile {
  /** Runtime credential. It is optional for local providers. */
  apiKey?: string;
  /** OpenAI-compatible API root, used by local providers. */
  baseUrl?: string;
  /** Call 1 and text-only follow-up model. */
  textModel?: string;
  /** Call 2 model. It must support image input. */
  visionModel?: string;
  /** Analysis limits and model context declaration, retained per provider. */
  analysis?: Partial<AnalysisSettings>;
}

export interface AdditionalImageRequest {
  needed: boolean;
  reason?: string;
  selections: SeriesSelection[];
}

export interface FindingEvidence {
  summary: string;
  confidence: 'definite' | 'probable' | 'possible' | 'indeterminate';
  imageIndices: number[];
}

export interface StructuredAnalysis {
  summary: string;
  findings: FindingEvidence[];
  limitations: string[];
  /** The only state transition that may trigger another vision round. */
  nextAction: 'request_images' | 'complete';
  imageRequest?: AdaptiveImageRequestSet;
  /** Retained only to parse output from pre-adaptive local models. */
  additionalImageRequest: AdditionalImageRequest;
}

export interface AnalysisRequestContext {
  settings: AnalysisSettings;
  refinementRound: number;
  remainingRefinementRounds: number;
  remainingImageBudget?: number;
  maxNewImages?: number;
  imageManifest?: string;
  seriesCatalog?: string;
}

/**
 * Settings are retained per provider so switching providers never discards a
 * previously configured API key, endpoint, or model pair.
 */
export interface ProviderConfig {
  provider: ProviderType;
  profiles: Partial<Record<ProviderType, ProviderProfile>>;
}

export interface ViewportContext {
  currentInstanceNumber: number;
  currentZPosition: number;
  seriesNumber: string;
  totalSlicesInSeries: number;
}

export interface LLMService {
  getSelectionPlan(metadata: StudyMetadata, clinicalHint: string, viewportContext?: ViewportContext, settings?: AnalysisSettings): Promise<SelectionPlan>;
  analyzeSlices(
    images: Blob[],
    metadata: StudyMetadata,
    clinicalHint: string,
    plan: SelectionPlan,
    sliceLabels: string[],
    surveyMode?: boolean,
    context?: AnalysisRequestContext,
  ): Promise<StructuredAnalysis>;
  sendFollowUp(
    conversationHistory: ChatMessage[],
    metadata: StudyMetadata,
    settings?: AnalysisSettings,
  ): Promise<string>;
}
