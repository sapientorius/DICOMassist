import type { ProviderConfig, ProviderProfile, ProviderType } from './types';
import type { AnalysisSettings } from './analysisConfig';
import { getProviderAnalysisSettings } from './analysisConfig';

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_LM_STUDIO_URL = 'http://localhost:1234/v1';

const DEFAULT_PROFILES: Partial<Record<ProviderType, ProviderProfile>> = {
  claude: {
    textModel: 'claude-sonnet-4-5-20250929',
    visionModel: 'claude-sonnet-4-5-20250929',
  },
  ollama: {
    baseUrl: DEFAULT_OLLAMA_URL,
    textModel: 'alibayram/medgemma:4b',
    visionModel: 'gemma3:4b',
  },
  lmstudio: {
    baseUrl: DEFAULT_LM_STUDIO_URL,
  },
};

export const PROVIDER_LABELS: Record<ProviderType, string> = {
  claude: 'Claude API',
  ollama: 'Ollama (Local)',
  lmstudio: 'LM Studio (Local)',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
};

export function createDefaultProviderConfig(): ProviderConfig {
  return {
    provider: 'ollama',
    profiles: {},
  };
}

export function getProviderProfile(
  config: ProviderConfig,
  provider = config.provider,
): ProviderProfile {
  return {
    ...DEFAULT_PROFILES[provider],
    ...config.profiles[provider],
  };
}

export function getProviderAnalysisConfig(
  config: ProviderConfig,
  provider = config.provider,
): AnalysisSettings {
  return getProviderAnalysisSettings(provider, getProviderProfile(config, provider).analysis);
}

export function updateProviderProfile(
  config: ProviderConfig,
  provider: ProviderType,
  update: Partial<ProviderProfile>,
): ProviderConfig {
  return {
    ...config,
    profiles: {
      ...config.profiles,
      [provider]: {
        ...getProviderProfile(config, provider),
        ...update,
      },
    },
  };
}

function isProviderType(value: unknown): value is ProviderType {
  return value === 'claude' || value === 'ollama' || value === 'lmstudio' || value === 'openrouter' || value === 'openai';
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Converts the previous flat localStorage shape without deleting its values.
 * Invalid stored values simply fall back to the established Ollama default.
 */
export function migrateProviderConfig(value: unknown): ProviderConfig {
  if (!value || typeof value !== 'object') return createDefaultProviderConfig();

  const raw = value as Record<string, unknown>;
  const provider = isProviderType(raw.provider) ? raw.provider : 'ollama';

  if (raw.profiles && typeof raw.profiles === 'object') {
    const profiles: ProviderConfig['profiles'] = {};
    for (const candidate of Object.keys(raw.profiles)) {
      if (!isProviderType(candidate)) continue;
      const profile = (raw.profiles as Record<string, unknown>)[candidate];
      if (!profile || typeof profile !== 'object') continue;
      const source = profile as Record<string, unknown>;
      profiles[candidate] = {
        apiKey: asNonEmptyString(source.apiKey),
        baseUrl: asNonEmptyString(source.baseUrl),
        textModel: asNonEmptyString(source.textModel),
        visionModel: asNonEmptyString(source.visionModel),
        analysis: source.analysis && typeof source.analysis === 'object'
          ? source.analysis as Partial<AnalysisSettings>
          : undefined,
      };
    }
    return { provider, profiles };
  }

  const claude: ProviderProfile = {
    apiKey: asNonEmptyString(raw.apiKey),
    textModel: asNonEmptyString(raw.claudeTextModel),
    visionModel: asNonEmptyString(raw.claudeVisionModel),
  };
  const ollama: ProviderProfile = {
    baseUrl: asNonEmptyString(raw.ollamaUrl),
    textModel: asNonEmptyString(raw.ollamaTextModel),
    visionModel: asNonEmptyString(raw.ollamaVisionModel),
  };

  return {
    provider,
    profiles: {
      ...(Object.values(claude).some(Boolean) ? { claude } : {}),
      ...(Object.values(ollama).some(Boolean) ? { ollama } : {}),
    },
  };
}
