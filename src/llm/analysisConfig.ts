import type { ProviderType } from './types';

export type AnalysisProfileId = 'fast' | 'standard' | 'deep' | 'custom';

export interface AnalysisSettings {
  /** A named preset stays visible even when values are saved per provider. */
  profile: AnalysisProfileId;
  /** Total rendered images, including alternate window renderings. */
  maxImages: number;
  /** Maximum pixel count for one rendered image. */
  maxImagePixels: number;
  /** Number of planner/vision refinement rounds after the initial analysis. */
  maxRefinementRounds: number;
  /** Hard response-token ceiling for analysis and follow-up requests. */
  responseTokenBudget: number;
  /** The actual context window allocated to the selected model/server. */
  contextWindowTokens: number;
}

export interface AnalysisBudgetEstimate {
  requestedImages: number;
  approvedImages: number;
  sourcePixelsPerImage: number;
  pixelsPerImage: number;
  estimatedImageTokens: number;
  estimatedInputTokens: number;
  availableInputTokens: number;
  wasAdjusted: boolean;
  warnings: string[];
}

const MIN_IMAGES = 1;
const MAX_IMAGES = 40;
const MIN_IMAGE_PIXELS = 256 * 256;
const MAX_IMAGE_PIXELS = 1_150_000;
const MIN_CONTEXT_TOKENS = 4_096;
const MAX_CONTEXT_TOKENS = 1_000_000;
const MIN_RESPONSE_TOKENS = 512;
const MAX_RESPONSE_TOKENS = 16_384;
const SYSTEM_AND_METADATA_RESERVE = 2_048;

const PROFILE_DEFAULTS: Record<Exclude<AnalysisProfileId, 'custom'>, Omit<AnalysisSettings, 'profile'>> = {
  fast: {
    maxImages: 8,
    maxImagePixels: 786_432,
    maxRefinementRounds: 0,
    responseTokenBudget: 2_048,
    contextWindowTokens: 16_384,
  },
  standard: {
    maxImages: 16,
    maxImagePixels: MAX_IMAGE_PIXELS,
    maxRefinementRounds: 1,
    responseTokenBudget: 4_096,
    contextWindowTokens: 32_768,
  },
  deep: {
    maxImages: 32,
    maxImagePixels: 786_432,
    maxRefinementRounds: 2,
    responseTokenBudget: 6_144,
    contextWindowTokens: 65_536,
  },
};

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(numberValue)));
}

export function getAnalysisProfileDefaults(profile: Exclude<AnalysisProfileId, 'custom'>): AnalysisSettings {
  return { profile, ...PROFILE_DEFAULTS[profile] };
}

/**
 * Keep values within a portable range. Context capacity remains a user/server
 * declaration because local inference servers cannot expose it consistently.
 */
export function normaliseAnalysisSettings(value: Partial<AnalysisSettings> | undefined): AnalysisSettings {
  const requestedProfile = value?.profile;
  const profile: AnalysisProfileId = requestedProfile === 'fast' || requestedProfile === 'deep' || requestedProfile === 'custom'
    ? requestedProfile
    : 'standard';
  const defaults = getAnalysisProfileDefaults(profile === 'custom' ? 'standard' : profile);
  const contextWindowTokens = clampInteger(value?.contextWindowTokens, defaults.contextWindowTokens, MIN_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS);
  // Keep enough input capacity for the system prompt and one minimum-size image.
  const largestUsableResponse = Math.max(MIN_RESPONSE_TOKENS, contextWindowTokens - SYSTEM_AND_METADATA_RESERVE - Math.ceil((MIN_IMAGE_PIXELS / 750) / 0.8));
  return {
    profile,
    maxImages: clampInteger(value?.maxImages, defaults.maxImages, MIN_IMAGES, MAX_IMAGES),
    maxImagePixels: clampInteger(value?.maxImagePixels, defaults.maxImagePixels, MIN_IMAGE_PIXELS, MAX_IMAGE_PIXELS),
    maxRefinementRounds: clampInteger(value?.maxRefinementRounds, defaults.maxRefinementRounds, 0, 2),
    responseTokenBudget: clampInteger(value?.responseTokenBudget, defaults.responseTokenBudget, MIN_RESPONSE_TOKENS, Math.min(MAX_RESPONSE_TOKENS, largestUsableResponse)),
    contextWindowTokens,
  };
}

/** Provider defaults are intentionally conservative for unknown/local models. */
export function getProviderAnalysisSettings(provider: ProviderType, value?: Partial<AnalysisSettings>): AnalysisSettings {
  const fallback = provider === 'claude'
    ? { ...getAnalysisProfileDefaults('standard'), contextWindowTokens: 200_000 }
    : getAnalysisProfileDefaults('standard');
  return normaliseAnalysisSettings({ ...fallback, ...value });
}

/**
 * Vision tokenisation differs by provider. pixels / 750 is a deliberately
 * conservative public-model approximation and a safe cross-provider budget
 * heuristic; the actual API usage is collected separately when available.
 */
export function estimateAnalysisBudget(
  settingsInput: Partial<AnalysisSettings> | undefined,
  requestedImages: number,
  sourcePixelsPerImage = MAX_IMAGE_PIXELS,
): AnalysisBudgetEstimate {
  const settings = normaliseAnalysisSettings(settingsInput);
  const requested = Math.max(0, Math.round(requestedImages));
  const sourcePixels = Math.max(MIN_IMAGE_PIXELS, Math.round(sourcePixelsPerImage));
  const availableInputTokens = Math.max(0, settings.contextWindowTokens - settings.responseTokenBudget - SYSTEM_AND_METADATA_RESERVE);
  const safeImageTokens = Math.floor(availableInputTokens * 0.8);
  let approvedImages = Math.min(requested, settings.maxImages);
  let pixelsPerImage = Math.min(sourcePixels, settings.maxImagePixels);
  const warnings: string[] = [];

  if (requested > settings.maxImages) {
    warnings.push(`Image budget limited the request from ${requested} to ${settings.maxImages} images.`);
  }

  if (approvedImages > 0 && approvedImages * Math.ceil(pixelsPerImage / 750) > safeImageTokens) {
    pixelsPerImage = Math.floor((safeImageTokens * 750) / approvedImages);
    if (pixelsPerImage < MIN_IMAGE_PIXELS) {
      pixelsPerImage = MIN_IMAGE_PIXELS;
      approvedImages = Math.max(0, Math.floor(safeImageTokens / Math.ceil(pixelsPerImage / 750)));
      warnings.push('Context capacity required fewer images at the minimum usable resolution.');
    } else {
      warnings.push('Context capacity required a smaller image resolution.');
    }
  }

  pixelsPerImage = Math.min(MAX_IMAGE_PIXELS, Math.max(MIN_IMAGE_PIXELS, pixelsPerImage));
  const estimatedImageTokens = approvedImages * Math.ceil(pixelsPerImage / 750);
  return {
    requestedImages: requested,
    approvedImages,
    sourcePixelsPerImage: sourcePixels,
    pixelsPerImage,
    estimatedImageTokens,
    estimatedInputTokens: estimatedImageTokens + SYSTEM_AND_METADATA_RESERVE,
    availableInputTokens,
    wasAdjusted: approvedImages !== requested || pixelsPerImage !== Math.min(sourcePixels, settings.maxImagePixels),
    warnings,
  };
}

export function describeAnalysisProfile(profile: AnalysisProfileId): string {
  return profile === 'fast' ? 'Fast' : profile === 'deep' ? 'Deep analysis' : profile === 'custom' ? 'Custom' : 'Standard';
}
