import type { StudyMetadata } from '../dicom/types';
import type { SelectionPlan, SeriesSelection, ChatMessage, ProviderConfig, ProviderProfile, ProviderType, LLMService, ViewportContext, StructuredAnalysis, AnalysisRequestContext, DisplayWindow } from './types';
import type { AnalysisSettings } from './analysisConfig';
import { parseStructuredAnalysis } from './analysisResults';
import { DEFAULT_LM_STUDIO_URL, DEFAULT_OLLAMA_URL, getProviderProfile, PROVIDER_LABELS } from './providerConfig';
import {
  buildSelectionSystemPrompt,
  buildSelectionUserPrompt,
  buildAnalysisSystemPrompt,
  buildAnalysisUserPrompt,
  buildFollowUpSystemPrompt,
} from './PromptBuilder';

export interface ProviderModelInfo {
  id: string;
  label: string;
  size?: number;
  /** Undefined means that the provider does not expose capability metadata. */
  supportsVision?: boolean;
}

export interface OllamaModelInfo {
  name: string;
  size: number;
  modified_at: string;
}

interface ChatMessagePayload {
  role: 'system' | 'user' | 'assistant';
  content: unknown;
}

interface ClaudeResponse {
  text: string;
  stopReason?: string | null;
}

interface ClaudeCallParams {
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  maxTokens: number;
  outputSchema?: Record<string, unknown>;
  adaptiveThinking?: boolean;
}

/**
 * The schema is deliberately limited to features supported by Anthropic's
 * structured-output grammar. Range and image-budget guardrails remain in
 * useLLMChat, where they can be checked against the actual study metadata.
 */
const SELECTION_PLAN_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    selections: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          seriesNumber: { type: 'string' },
          role: { type: 'string', enum: ['primary', 'supplementary'] },
          rationale: { type: 'string' },
          sliceRange: { type: 'array', items: { type: 'number' } },
          samplingStrategy: { type: 'string', enum: ['uniform', 'every_nth', 'all'] },
          samplingParam: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          windowCenter: { type: 'number' },
          windowWidth: { type: 'number' },
          coverageGoal: { type: 'string' },
          displayWindows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' }, windowCenter: { type: 'number' }, windowWidth: { type: 'number' },
              },
              required: ['label', 'windowCenter', 'windowWidth'],
              additionalProperties: false,
            },
          },
        },
        required: [
          'seriesNumber', 'role', 'rationale', 'sliceRange', 'samplingStrategy',
          'samplingParam', 'windowCenter', 'windowWidth', 'coverageGoal', 'displayWindows',
        ],
        additionalProperties: false,
      },
    },
    totalImages: { type: 'number' },
  },
  required: ['reasoning', 'selections', 'totalImages'],
  additionalProperties: false,
};

const ANALYSIS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    nextAction: { type: 'string', enum: ['request_images', 'complete'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          confidence: { type: 'string', enum: ['definite', 'probable', 'possible', 'indeterminate'] },
          imageIndices: { type: 'array', items: { type: 'number' } },
        },
        required: ['summary', 'confidence', 'imageIndices'],
        additionalProperties: false,
      },
    },
    limitations: { type: 'array', items: { type: 'string' } },
    imageRequest: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            reason: { type: 'string' },
            // The detailed retrieval instructions are parsed and validated locally.
            // Keeping them as JSON text avoids an exponentially large grammar from
            // the optional fields across the four request and rendering variants.
            requestsJson: { type: 'string' },
          },
          required: ['reason', 'requestsJson'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['nextAction', 'summary', 'findings', 'limitations', 'imageRequest'],
  additionalProperties: false,
};

// --- Shared Helpers ---

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) return text.slice(braceStart, braceEnd + 1);
  return text.trim();
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function parseSeriesSelection(raw: Record<string, unknown>): SeriesSelection {
  const displayWindows = Array.isArray(raw.displayWindows)
    ? raw.displayWindows.map((window): DisplayWindow | null => {
      if (!window || typeof window !== 'object') return null;
      const value = window as Record<string, unknown>;
      const windowCenter = Number(value.windowCenter);
      const windowWidth = Number(value.windowWidth);
      return Number.isFinite(windowCenter) && Number.isFinite(windowWidth) && windowWidth > 0
        ? { label: String(value.label ?? 'Additional window'), windowCenter, windowWidth }
        : null;
    }).filter((window): window is DisplayWindow => window !== null)
    : [];
  return {
    seriesNumber: String(raw.seriesNumber),
    role: raw.role === 'supplementary' ? 'supplementary' : 'primary',
    rationale: String(raw.rationale ?? ''),
    sliceRange: [Number((raw.sliceRange as number[])[0]), Number((raw.sliceRange as number[])[1])],
    samplingStrategy: (raw.samplingStrategy as SeriesSelection['samplingStrategy']) ?? 'uniform',
    samplingParam: raw.samplingParam != null ? Number(raw.samplingParam) : undefined,
    windowWidth: Number(raw.windowWidth),
    windowCenter: Number(raw.windowCenter),
    coverageGoal: String(raw.coverageGoal ?? ''),
    displayWindows,
  };
}

function populateLegacyFields(selections: SeriesSelection[], reasoning: string, totalImages: number): SelectionPlan {
  const primary = selections[0];
  return {
    reasoning,
    selections,
    totalImages,
    targetSeries: primary.seriesNumber,
    sliceRange: primary.sliceRange,
    windowCenter: primary.windowCenter,
    windowWidth: primary.windowWidth,
    samplingStrategy: primary.samplingStrategy,
    samplingParam: primary.samplingParam,
  };
}

function parseSelectionPlan(raw: string): SelectionPlan {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(extractJson(raw));
  } catch {
    throw new Error(
      'The LLM did not return valid JSON. This can happen with smaller models. ' +
      'Try a more specific clinical prompt or select a stronger planning model.',
    );
  }

  if (Array.isArray(json.selections) && json.selections.length > 0) {
    const selections = (json.selections as Record<string, unknown>[]).map(parseSeriesSelection);
    return populateLegacyFields(selections, String(json.reasoning ?? ''), json.totalImages != null ? Number(json.totalImages) : 0);
  }

  if (!json.targetSeries || !json.sliceRange) {
    throw new Error(
      'The LLM response is missing required fields (targetSeries, sliceRange). ' +
      'Try a more specific clinical prompt or a stronger planning model.',
    );
  }

  const selection: SeriesSelection = {
    seriesNumber: String(json.targetSeries),
    role: 'primary',
    rationale: String(json.reasoning ?? ''),
    sliceRange: [Number((json.sliceRange as number[])[0]), Number((json.sliceRange as number[])[1])],
    samplingStrategy: (json.samplingStrategy as SeriesSelection['samplingStrategy']) ?? 'uniform',
    samplingParam: json.samplingParam != null ? Number(json.samplingParam) : undefined,
    windowCenter: Number(json.windowCenter),
    windowWidth: Number(json.windowWidth),
  };
  return populateLegacyFields([selection], selection.rationale, 0);
}

function normaliseApiBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function apiHeaders(apiKey?: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

function modelCatalogHeaders(apiKey?: string): HeadersInit {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function responseError(response: Response, providerLabel: string): Promise<Error> {
  const body = (await response.text()).replace(/\s+/g, ' ').trim();
  if (response.status === 401 || response.status === 403) {
    return new Error(`${providerLabel} rejected the API key. Check it in Settings.`);
  }
  return new Error(`${providerLabel} API error (${response.status})${body ? `: ${body.slice(0, 500)}` : ''}`);
}

function connectionError(error: unknown, providerLabel: string): Error {
  if (error instanceof Error && error.message.startsWith(`${providerLabel} API error`)) return error;
  if (error instanceof Error && error.message.includes('rejected the API key')) return error;
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new Error(`${providerLabel} request timed out. Try fewer slices or a smaller model.`);
  }
  return new Error(`Cannot connect to ${providerLabel}. Check its URL, server status, and browser CORS settings.`);
}

function isSchemaComplexityError(error: Error): boolean {
  return /schema (?:is )?too complex/i.test(error.message);
}

function requireApiKey(provider: ProviderType, profile: ProviderProfile): string {
  const environmentKey = provider === 'claude'
    ? import.meta.env.VITE_ANTHROPIC_API_KEY
    : provider === 'openrouter'
      ? import.meta.env.VITE_OPENROUTER_API_KEY
      : import.meta.env.VITE_OPENAI_API_KEY;
  const key = profile.apiKey || environmentKey;
  if (!key) throw new Error(`${PROVIDER_LABELS[provider]} API key is required. Enter it in Settings.`);
  return key;
}

function requireModel(provider: ProviderType, value: string | undefined, role: 'text' | 'vision'): string {
  if (!value?.trim()) {
    const label = role === 'text' ? 'planning' : 'vision';
    throw new Error(`Select a ${label} model for ${PROVIDER_LABELS[provider]} in Settings.`);
  }
  return value.trim();
}

export function getConfiguredModels(config: ProviderConfig): { providerLabel: string; textModel: string; visionModel: string } {
  const profile = getProviderProfile(config);
  return {
    providerLabel: PROVIDER_LABELS[config.provider],
    textModel: profile.textModel || 'model not selected',
    visionModel: profile.visionModel || 'model not selected',
  };
}

// --- Claude Service ---

class ClaudeService implements LLMService {
  private apiKey: string;
  private textModel: string;
  private visionModel: string;

  constructor(
    apiKey: string,
    textModel: string,
    visionModel: string,
  ) {
    this.apiKey = apiKey;
    this.textModel = textModel;
    this.visionModel = visionModel;
  }

  async getSelectionPlan(metadata: StudyMetadata, clinicalHint: string, viewportContext?: ViewportContext, settings?: AnalysisSettings): Promise<SelectionPlan> {
    const params: ClaudeCallParams = {
      system: buildSelectionSystemPrompt(settings),
      messages: [{ role: 'user', content: buildSelectionUserPrompt(metadata, clinicalHint, viewportContext) }],
      maxTokens: 4096,
      outputSchema: SELECTION_PLAN_OUTPUT_SCHEMA,
      adaptiveThinking: this.supportsAdaptiveThinking(this.textModel),
    };

    let response = await this.callClaude(this.textModel, params);
    if (response.stopReason === 'max_tokens') {
      response = await this.callClaude(this.textModel, { ...params, maxTokens: 8192 });
      if (response.stopReason === 'max_tokens') {
        throw new Error(
          `Claude model "${this.textModel}" truncated the selection plan at the 8,192-token limit. ` +
          'Try a shorter clinical prompt and run the analysis again.',
        );
      }
    }

    if (response.stopReason === 'refusal') {
      throw new Error(
        `Claude model "${this.textModel}" refused to create a selection plan. ` +
        'Rephrase the clinical prompt and try again.',
      );
    }

    if (!response.text.trim()) {
      throw new Error(
        `Claude model "${this.textModel}" returned no text for the selection plan ` +
        `(stop reason: ${response.stopReason ?? 'unknown'}).`,
      );
    }

    return parseSelectionPlan(response.text);
  }

  async analyzeSlices(
    images: Blob[], metadata: StudyMetadata, clinicalHint: string, plan: SelectionPlan, sliceLabels: string[], surveyMode?: boolean, context?: AnalysisRequestContext,
  ): Promise<StructuredAnalysis> {
    const imageContents = await Promise.all(images.map(async (blob, index) => [
      {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: await blobToBase64(blob) },
      },
      { type: 'text' as const, text: sliceLabels[index] ?? `Image ${index + 1}` },
    ]));
    const response = await this.callClaude(this.visionModel, {
      system: buildAnalysisSystemPrompt(surveyMode, context),
      messages: [{
        role: 'user',
        content: [...imageContents.flat(), { type: 'text' as const, text: buildAnalysisUserPrompt(metadata, clinicalHint, plan, sliceLabels, context) }],
      }],
      maxTokens: context?.settings.responseTokenBudget ?? 4096,
      outputSchema: ANALYSIS_OUTPUT_SCHEMA,
    });
    return parseStructuredAnalysis(response.text);
  }

  async sendFollowUp(conversationHistory: ChatMessage[], metadata: StudyMetadata, settings?: AnalysisSettings): Promise<string> {
    return (await this.callClaude(this.textModel, {
      system: `${buildFollowUpSystemPrompt()}\n\nStudy context: ${metadata.studyDescription}`,
      messages: conversationHistory.map((message) => ({ role: message.role, content: message.content })),
      maxTokens: settings?.responseTokenBudget ?? 4096,
    })).text;
  }

  private async callClaude(
    model: string,
    params: ClaudeCallParams,
    allowSchemaFallback = true,
  ): Promise<ClaudeResponse> {
    let response: Response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: params.maxTokens,
          ...(this.shouldOmitTemperature(model) ? {} : { temperature: 0 }),
          ...(params.adaptiveThinking ? { thinking: { type: 'adaptive' } } : {}),
          ...(params.outputSchema ? {
            output_config: {
              format: { type: 'json_schema', schema: params.outputSchema },
            },
          } : {}),
          system: params.system,
          messages: params.messages,
        }),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (error) {
      throw connectionError(error, PROVIDER_LABELS.claude);
    }
    if (!response.ok) {
      const error = await responseError(response, PROVIDER_LABELS.claude);
      // A provider-side grammar limit must not make image analysis unavailable.
      // The prompt still requires JSON and parseStructuredAnalysis validates it
      // before any image retrieval instruction can be acted upon.
      if (allowSchemaFallback && params.outputSchema && isSchemaComplexityError(error)) {
        return this.callClaude(model, { ...params, outputSchema: undefined }, false);
      }
      throw error;
    }
    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string | null;
    };
    return {
      text: data.content?.find((block) => block.type === 'text')?.text ?? '',
      stopReason: data.stop_reason,
    };
  }

  /** Claude Sonnet/Opus 5 support adaptive thinking; older models do not. */
  private supportsAdaptiveThinking(model: string): boolean {
    return /^claude-(?:sonnet|opus)-5(?:-|$)/i.test(model.trim());
  }

  /**
   * Newer Claude models reject non-default temperature values. Keep the
   * deterministic setting for older models that still support it.
   */
  private shouldOmitTemperature(model: string): boolean {
    const match = /^claude-(sonnet|opus)-(\d+)(?:-(\d+))?(?:-|$)/i.exec(model.trim());
    if (!match) return false;

    const [, family, majorText, minorText] = match;
    const major = Number(majorText);
    const minor = Number(minorText ?? 0);

    if (family.toLowerCase() === 'sonnet') return major >= 5;
    return major > 4 || (major === 4 && minor >= 7);
  }
}

// --- Ollama Service ---

class OllamaService implements LLMService {
  private textModel: string;
  private visionModel: string;
  private baseUrl: string;

  constructor(textModel: string, visionModel: string, baseUrl: string) {
    this.textModel = textModel;
    this.visionModel = visionModel;
    this.baseUrl = baseUrl;
  }

  async getSelectionPlan(metadata: StudyMetadata, clinicalHint: string, viewportContext?: ViewportContext, settings?: AnalysisSettings): Promise<SelectionPlan> {
    const response = await this.callOllama({
      model: this.textModel, system: buildSelectionSystemPrompt(settings), userContent: buildSelectionUserPrompt(metadata, clinicalHint, viewportContext), settings,
    });
    return parseSelectionPlan(response);
  }

  async analyzeSlices(
    images: Blob[], metadata: StudyMetadata, clinicalHint: string, plan: SelectionPlan, sliceLabels: string[], surveyMode?: boolean, context?: AnalysisRequestContext,
  ): Promise<StructuredAnalysis> {
    const base64Images = await Promise.all(images.map(blobToBase64));
    const manifest = sliceLabels.map((label, index) => `  ${index + 1}. ${label}`).join('\n');
    return this.callOllama({
      model: this.visionModel, system: buildAnalysisSystemPrompt(surveyMode, context), images: base64Images, settings: context?.settings,
      userContent: `IMAGE MANIFEST (${sliceLabels.length} images, in sequential order):\n${manifest}\n\nThe images are provided in the exact order listed above.\n\n${buildAnalysisUserPrompt(metadata, clinicalHint, plan, sliceLabels, context)}`,
    }).then(parseStructuredAnalysis);
  }

  async sendFollowUp(conversationHistory: ChatMessage[], metadata: StudyMetadata, settings?: AnalysisSettings): Promise<string> {
    return this.callOllama({
      model: this.textModel, system: '', userContent: '',
      messages: [
        { role: 'system', content: `${buildFollowUpSystemPrompt()}\n\nStudy context: ${metadata.studyDescription}` },
        ...conversationHistory.map((message) => ({ role: message.role, content: message.content })),
      ], settings,
    });
  }

  private async callOllama(params: {
    model: string; system: string; userContent: string; images?: string[]; messages?: Array<{ role: string; content: string }>; settings?: AnalysisSettings;
  }): Promise<string> {
    const messages = params.messages ?? [
      { role: 'system', content: params.system },
      { role: 'user', content: params.userContent, ...(params.images?.length ? { images: params.images } : {}) },
    ];
    let response: Response;
    try {
      response = await fetch(`${normaliseApiBase(this.baseUrl)}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: params.model, messages, stream: false, options: {
          temperature: 0,
          ...(params.settings ? { num_ctx: params.settings.contextWindowTokens, num_predict: params.settings.responseTokenBudget } : {}),
        } }), signal: AbortSignal.timeout(300_000),
      });
    } catch (error) {
      throw connectionError(error, PROVIDER_LABELS.ollama);
    }
    if (!response.ok) throw await responseError(response, PROVIDER_LABELS.ollama);
    const data = await response.json() as { message?: { content?: string } };
    return data.message?.content ?? '';
  }
}

// --- OpenAI-compatible Service (OpenAI, OpenRouter, LM Studio) ---

class OpenAICompatibleService implements LLMService {
  private provider: Exclude<ProviderType, 'claude' | 'ollama'>;
  private baseUrl: string;
  private textModel: string;
  private visionModel: string;
  private apiKey?: string;

  constructor(
    provider: Exclude<ProviderType, 'claude' | 'ollama'>,
    baseUrl: string,
    textModel: string,
    visionModel: string,
    apiKey?: string,
  ) {
    this.provider = provider;
    this.baseUrl = baseUrl;
    this.textModel = textModel;
    this.visionModel = visionModel;
    this.apiKey = apiKey;
  }

  async getSelectionPlan(metadata: StudyMetadata, clinicalHint: string, viewportContext?: ViewportContext, settings?: AnalysisSettings): Promise<SelectionPlan> {
    const response = await this.callChat(this.textModel, [
      { role: 'system', content: buildSelectionSystemPrompt(settings) },
      { role: 'user', content: buildSelectionUserPrompt(metadata, clinicalHint, viewportContext) },
    ], Math.min(settings?.responseTokenBudget ?? 1024, 4096));
    return parseSelectionPlan(response);
  }

  async analyzeSlices(
    images: Blob[], metadata: StudyMetadata, clinicalHint: string, plan: SelectionPlan, sliceLabels: string[], surveyMode?: boolean, context?: AnalysisRequestContext,
  ): Promise<StructuredAnalysis> {
    const content: Array<Record<string, unknown>> = [];
    for (let index = 0; index < images.length; index++) {
      content.push(
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${await blobToBase64(images[index])}` } },
        { type: 'text', text: sliceLabels[index] ?? `Image ${index + 1}` },
      );
    }
    content.push({ type: 'text', text: buildAnalysisUserPrompt(metadata, clinicalHint, plan, sliceLabels, context) });
    return this.callChat(this.visionModel, [
      { role: 'system', content: buildAnalysisSystemPrompt(surveyMode, context) },
      { role: 'user', content },
    ], context?.settings.responseTokenBudget ?? 4096).then(parseStructuredAnalysis);
  }

  async sendFollowUp(conversationHistory: ChatMessage[], metadata: StudyMetadata, settings?: AnalysisSettings): Promise<string> {
    return this.callChat(this.textModel, [
      { role: 'system', content: `${buildFollowUpSystemPrompt()}\n\nStudy context: ${metadata.studyDescription}` },
      ...conversationHistory.map((message) => ({ role: message.role, content: message.content })),
    ], settings?.responseTokenBudget ?? 4096);
  }

  private async callChat(model: string, messages: ChatMessagePayload[], maxTokens: number): Promise<string> {
    const providerLabel = PROVIDER_LABELS[this.provider];
    let response: Response;
    try {
      response = await fetch(`${normaliseApiBase(this.baseUrl)}/chat/completions`, {
        method: 'POST', headers: apiHeaders(this.apiKey),
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens }), signal: AbortSignal.timeout(300_000),
      });
    } catch (error) {
      throw connectionError(error, providerLabel);
    }
    if (!response.ok) throw await responseError(response, providerLabel);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('');
    throw new Error(`${providerLabel} returned an empty response.`);
  }
}

// --- Factory ---

export function createLLMService(config: ProviderConfig): LLMService {
  const profile = getProviderProfile(config);
  const textModel = requireModel(config.provider, profile.textModel, 'text');
  const visionModel = requireModel(config.provider, profile.visionModel, 'vision');
  switch (config.provider) {
    case 'claude':
      return new ClaudeService(requireApiKey('claude', profile), textModel, visionModel);
    case 'ollama':
      return new OllamaService(textModel, visionModel, profile.baseUrl || DEFAULT_OLLAMA_URL);
    case 'lmstudio':
      return new OpenAICompatibleService('lmstudio', profile.baseUrl || DEFAULT_LM_STUDIO_URL, textModel, visionModel, profile.apiKey);
    case 'openrouter':
      return new OpenAICompatibleService('openrouter', 'https://openrouter.ai/api/v1', textModel, visionModel, requireApiKey('openrouter', profile));
    case 'openai':
      return new OpenAICompatibleService('openai', 'https://api.openai.com/v1', textModel, visionModel, requireApiKey('openai', profile));
  }
}

// --- Provider model catalogues ---

async function fetchOpenAICompatibleModels(baseUrl: string, providerLabel: string, apiKey?: string): Promise<ProviderModelInfo[]> {
  const response = await fetch(`${normaliseApiBase(baseUrl)}/models`, { headers: modelCatalogHeaders(apiKey), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw await responseError(response, providerLabel);
  const data = await response.json() as {
    data?: Array<{ id?: string; name?: string; size?: number; architecture?: { input_modalities?: string[] } }>;
  };
  return (data.data ?? [])
    .filter((model): model is Required<Pick<typeof model, 'id'>> & typeof model => Boolean(model.id))
    .map((model) => ({
      id: model.id,
      label: model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id,
      size: model.size,
      supportsVision: model.architecture?.input_modalities ? model.architecture.input_modalities.includes('image') : undefined,
    }));
}

async function fetchClaudeModels(apiKey: string): Promise<ProviderModelInfo[]> {
  const response = await fetch('https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await responseError(response, PROVIDER_LABELS.claude);
  const data = await response.json() as {
    data?: Array<{ id?: string; display_name?: string; capabilities?: { input_modalities?: string[] } }>;
  };
  return (data.data ?? [])
    .filter((model): model is Required<Pick<typeof model, 'id'>> & typeof model => Boolean(model.id))
    .map((model) => ({
      id: model.id,
      label: model.display_name && model.display_name !== model.id ? `${model.display_name} (${model.id})` : model.id,
      supportsVision: model.capabilities?.input_modalities ? model.capabilities.input_modalities.includes('image') : undefined,
    }));
}

export async function fetchProviderModels(provider: ProviderType, profile: ProviderProfile): Promise<ProviderModelInfo[]> {
  try {
    switch (provider) {
      case 'claude':
        return await fetchClaudeModels(requireApiKey('claude', profile));
      case 'ollama': {
        const baseUrl = profile.baseUrl || DEFAULT_OLLAMA_URL;
        if (!await pingOllama(baseUrl)) throw new Error('Ollama is not running. Start it and try again.');
        return (await fetchOllamaModels(baseUrl)).map((model) => ({ id: model.name, label: model.name, size: model.size }));
      }
      case 'lmstudio':
        return await fetchOpenAICompatibleModels(profile.baseUrl || DEFAULT_LM_STUDIO_URL, PROVIDER_LABELS.lmstudio, profile.apiKey);
      case 'openrouter':
        return await fetchOpenAICompatibleModels('https://openrouter.ai/api/v1', PROVIDER_LABELS.openrouter, requireApiKey('openrouter', profile));
      case 'openai':
        return await fetchOpenAICompatibleModels('https://api.openai.com/v1', PROVIDER_LABELS.openai, requireApiKey('openai', profile));
    }
  } catch (error) {
    if (error instanceof Error && (
      error.message.includes('API key is required') ||
      error.message.includes('rejected the API key') ||
      error.message.includes('API error') ||
      error.message.startsWith('Ollama is not running')
    )) {
      throw error;
    }
    throw new Error(`Cannot load the ${PROVIDER_LABELS[provider]} model catalogue. Check the connection and try again.`);
  }
}

export async function pingOpenAICompatible(baseUrl: string, apiKey?: string): Promise<boolean> {
  try {
    const response = await fetch(`${normaliseApiBase(baseUrl)}/models`, { headers: modelCatalogHeaders(apiKey), signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

// --- Ollama management API ---

export async function fetchOllamaModels(baseUrl = DEFAULT_OLLAMA_URL): Promise<OllamaModelInfo[]> {
  try {
    const response = await fetch(`${normaliseApiBase(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return [];
    const data = await response.json() as { models?: OllamaModelInfo[] };
    return data.models ?? [];
  } catch {
    return [];
  }
}

export async function pingOllama(baseUrl = DEFAULT_OLLAMA_URL): Promise<boolean> {
  try {
    const response = await fetch(`${normaliseApiBase(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function pullOllamaModel(
  modelName: string,
  onProgress: (status: string, percent: number | null) => void,
  baseUrl = DEFAULT_OLLAMA_URL,
): Promise<boolean> {
  try {
    const response = await fetch(`${normaliseApiBase(baseUrl)}/api/pull`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: modelName, stream: true }),
    });
    if (!response.ok || !response.body) {
      onProgress('Failed to start download', null);
      return false;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line) as { error?: string; total?: number; completed?: number; status?: string };
          if (data.error) {
            onProgress(`Error: ${data.error}`, null);
            return false;
          }
          const percent = data.total ? Math.round(((data.completed ?? 0) / data.total) * 100) : null;
          onProgress(data.status ?? 'Downloading...', percent);
        } catch { /* Ignore a malformed streamed line. */ }
      }
    }
    onProgress('Complete', 100);
    return true;
  } catch {
    onProgress('Connection failed', null);
    return false;
  }
}
