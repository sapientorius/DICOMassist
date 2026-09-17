import type { StudyMetadata } from '../dicom/types';
import type { AnalysisSettings } from './analysisConfig';

export interface DisplayWindow {
  label: string;
  windowCenter: number;
  windowWidth: number;
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
  additionalImageRequest: AdditionalImageRequest;
}

export interface AnalysisRequestContext {
  settings: AnalysisSettings;
  refinementRound: number;
  remainingRefinementRounds: number;
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
