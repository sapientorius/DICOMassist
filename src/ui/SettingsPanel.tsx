import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, ChevronDown, Download, Loader2, RefreshCw, X, XCircle } from 'lucide-react';
import type { ProviderConfig, ProviderProfile, ProviderType } from '../llm/types';
import { DEFAULT_LM_STUDIO_URL, DEFAULT_OLLAMA_URL, getProviderProfile, PROVIDER_LABELS, updateProviderProfile } from '../llm/providerConfig';
import { fetchProviderModels, pullOllamaModel, type ProviderModelInfo } from '../llm/LLMServiceFactory';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  config: ProviderConfig;
  onConfigChange: (config: ProviderConfig) => void;
}

interface RecommendedModel {
  name: string;
  label: string;
  desc: string;
  role: 'text' | 'vision' | 'both';
}

const PROVIDERS: ProviderType[] = ['claude', 'ollama', 'lmstudio', 'openrouter', 'openai'];

const RECOMMENDED_OLLAMA_MODELS: RecommendedModel[] = [
  { name: 'alibayram/medgemma:4b', label: 'MedGemma 4B', desc: 'Medical text planning, no vision (2.5GB)', role: 'text' },
  { name: 'gemma3:4b', label: 'Gemma 3 4B', desc: 'Text + vision (3.3GB)', role: 'both' },
  { name: 'llava:7b', label: 'LLaVA 7B', desc: 'Vision support (4.7GB)', role: 'vision' },
  { name: 'llama3.2:latest', label: 'Llama 3.2 3B', desc: 'Fast general text (2GB)', role: 'text' },
];

function formatSize(bytes?: number): string | null {
  if (bytes == null || bytes <= 0) return null;
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

function profileWithDefaultUrl(provider: ProviderType, profile: ProviderProfile): ProviderProfile {
  if (provider === 'ollama') return { ...profile, baseUrl: profile.baseUrl || DEFAULT_OLLAMA_URL };
  if (provider === 'lmstudio') return { ...profile, baseUrl: profile.baseUrl || DEFAULT_LM_STUDIO_URL };
  return profile;
}

export default function SettingsPanel({ open, onClose, config, onConfigChange }: SettingsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [models, setModels] = useState<ProviderModelInfo[]>([]);
  const [catalogState, setCatalogState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [pulling, setPulling] = useState<{ model: string; status: string; percent: number | null } | null>(null);

  const provider = config.provider;
  const profile = profileWithDefaultUrl(provider, getProviderProfile(config));
  const isRemote = provider === 'claude' || provider === 'openrouter' || provider === 'openai';

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose]);

  const updateProfile = useCallback((update: Partial<ProviderProfile>) => {
    onConfigChange(updateProviderProfile(config, provider, update));
  }, [config, onConfigChange, provider]);

  const refreshModels = useCallback(async () => {
    setCatalogState('loading');
    setCatalogError(null);
    try {
      const available = await fetchProviderModels(provider, profile);
      setModels(available.sort((left, right) => left.label.localeCompare(right.label)));
      setCatalogState('loaded');
    } catch (error) {
      setModels([]);
      setCatalogState('error');
      setCatalogError(error instanceof Error ? error.message : 'Could not load the model catalogue.');
    }
  }, [profile, provider]);

  const selectProvider = (nextProvider: ProviderType) => {
    onConfigChange({ ...config, provider: nextProvider });
    setModels([]);
    setCatalogState('idle');
    setCatalogError(null);
    setPulling(null);
  };

  const handlePull = async (modelName: string) => {
    setPulling({ model: modelName, status: 'Starting...', percent: null });
    const success = await pullOllamaModel(
      modelName,
      (status, percent) => setPulling({ model: modelName, status, percent }),
      profile.baseUrl || DEFAULT_OLLAMA_URL,
    );
    if (success) await refreshModels();
    window.setTimeout(() => setPulling(null), 1_500);
  };

  if (!open) return null;

  const installed = (name: string) => models.some((model) => model.id === name || model.id === name.replace(':latest', '') || `${model.id}:latest` === name);

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div
        ref={panelRef}
        className="absolute top-12 right-4 w-[calc(100vw-2rem)] max-w-md max-h-[82vh] bg-neutral-800 border border-neutral-600 rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 shrink-0">
          <div>
            <span className="text-sm font-medium text-neutral-200">LLM Settings</span>
            <p className="text-[10px] text-neutral-500">Each provider keeps its own API key and model pair.</p>
          </div>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200" aria-label="Close settings">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-4">
          <div>
            <label className="text-xs text-neutral-400 block mb-1.5">Provider</label>
            <div className="grid grid-cols-2 gap-1.5">
              {PROVIDERS.map((candidate) => (
                <button
                  key={candidate}
                  onClick={() => selectProvider(candidate)}
                  className={`rounded-lg px-2 py-2 text-xs font-medium transition-colors ${
                    candidate === provider ? 'bg-blue-600 text-white' : 'bg-neutral-900 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700'
                  }`}
                >
                  {PROVIDER_LABELS[candidate]}
                </button>
              ))}
            </div>
          </div>

          {provider === 'ollama' && (
            <ConnectionField
              label="Ollama URL"
              value={profile.baseUrl || DEFAULT_OLLAMA_URL}
              onChange={(baseUrl) => updateProfile({ baseUrl })}
              placeholder={DEFAULT_OLLAMA_URL}
            />
          )}

          {provider === 'lmstudio' && (
            <>
              <ConnectionField
                label="LM Studio Server URL"
                value={profile.baseUrl || DEFAULT_LM_STUDIO_URL}
                onChange={(baseUrl) => updateProfile({ baseUrl })}
                placeholder={DEFAULT_LM_STUDIO_URL}
              />
              <CredentialField
                label="Server token"
                value={profile.apiKey ?? ''}
                onChange={(apiKey) => updateProfile({ apiKey })}
                placeholder="Optional"
                hint="Only required when the LM Studio server is configured with authentication."
              />
            </>
          )}

          {isRemote && (
            <CredentialField
              label={provider === 'claude' ? 'Claude API key' : provider === 'openrouter' ? 'OpenRouter API key' : 'OpenAI API key'}
              value={profile.apiKey ?? ''}
              onChange={(apiKey) => updateProfile({ apiKey })}
              placeholder={provider === 'claude' ? 'sk-ant-...' : 'sk-...'}
              hint="Stored in localStorage only; never sent to DICOMassist servers."
            />
          )}

          {isRemote && (
            <div className="flex gap-2 rounded-lg border border-amber-900/70 bg-amber-950/30 px-3 py-2.5 text-[11px] text-amber-200">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>Rendered slices and the clinical prompt are sent directly to the selected external LLM provider when analysis runs.</span>
            </div>
          )}

          <div className="space-y-3 border-t border-neutral-700 pt-4">
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <p className="text-xs text-neutral-300">Model catalogue</p>
                <p className="text-[10px] text-neutral-500">Refresh to load available models. You may also enter any model ID manually.</p>
              </div>
              <button
                onClick={refreshModels}
                disabled={catalogState === 'loading'}
                className="flex items-center gap-1.5 rounded bg-neutral-700 hover:bg-neutral-600 px-2.5 py-1.5 text-xs text-neutral-200 disabled:opacity-50"
              >
                {catalogState === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Refresh
              </button>
            </div>

            {catalogState === 'loaded' && (
              <div className="flex items-center gap-1.5 text-[11px] text-green-400">
                <CheckCircle className="w-3.5 h-3.5" /> {models.length} model{models.length === 1 ? '' : 's'} available
              </div>
            )}
            {catalogState === 'error' && (
              <div className="flex gap-1.5 text-[11px] text-red-400">
                <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span>{catalogError}</span>
              </div>
            )}

            <ModelPicker
              label="Planning model"
              hint="Call 1: slice planning and text-only follow-ups"
              value={profile.textModel ?? ''}
              models={models}
              provider={provider}
              onChange={(textModel) => updateProfile({ textModel })}
            />
            <ModelPicker
              label="Vision model"
              hint="Call 2: image analysis; select a model that accepts image input"
              value={profile.visionModel ?? ''}
              models={models}
              provider={provider}
              visionOnly
              onChange={(visionModel) => updateProfile({ visionModel })}
            />
          </div>

          {provider === 'ollama' && (
            <OllamaRecommendations
              installed={installed}
              pulling={pulling}
              textModel={profile.textModel ?? ''}
              visionModel={profile.visionModel ?? ''}
              onPull={handlePull}
              onUseText={(textModel) => updateProfile({ textModel })}
              onUseVision={(visionModel) => updateProfile({ visionModel })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function CredentialField({ label, value, onChange, placeholder, hint }: {
  label: string; value: string; onChange: (value: string) => void; placeholder: string; hint: string;
}) {
  return (
    <div>
      <label className="text-xs text-neutral-400 block mb-1.5">{label}</label>
      <input
        type="password" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder}
        className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-blue-500"
      />
      <p className="text-[10px] text-neutral-500 mt-1">{hint}</p>
    </div>
  );
}

function ConnectionField({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (value: string) => void; placeholder: string;
}) {
  return (
    <div>
      <label className="text-xs text-neutral-400 block mb-1.5">{label}</label>
      <input
        type="url" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder}
        className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-blue-500"
      />
    </div>
  );
}

function ModelPicker({ label, hint, value, models, provider, visionOnly = false, onChange }: {
  label: string;
  hint: string;
  value: string;
  models: ProviderModelInfo[];
  provider: ProviderType;
  visionOnly?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const candidates = visionOnly && provider === 'openrouter'
    ? models.filter((model) => model.supportsVision)
    : models;
  const normalizedFilter = filter.trim().toLowerCase();
  const matches = candidates.filter((model) => !normalizedFilter || model.label.toLowerCase().includes(normalizedFilter) || model.id.toLowerCase().includes(normalizedFilter)).slice(0, 80);

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <label className="text-xs text-neutral-400 block mb-1.5">
        {label} <span className="text-neutral-600">({hint})</span>
      </label>
      <div className="relative">
        <input
          value={value}
          onFocus={() => {
            setFilter('');
            setOpen(true);
          }}
          onChange={(event) => {
            setFilter(event.target.value);
            onChange(event.target.value);
            setOpen(true);
          }}
          placeholder="Choose or enter a model ID"
          className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 pr-9 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-blue-500"
        />
        <ChevronDown className="absolute right-3 top-2.5 w-4 h-4 text-neutral-500 pointer-events-none" />
      </div>
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-800 shadow-xl py-1">
          {matches.map((model) => (
            <button
              key={model.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(model.id);
                setFilter('');
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-neutral-700 ${value === model.id ? 'bg-blue-600/20 text-blue-300' : 'text-neutral-300'}`}
            >
              <span className="truncate">{model.label}</span>
              <span className="shrink-0 text-[10px] text-neutral-500">{formatSize(model.size) ?? (model.supportsVision ? 'vision' : '')}</span>
            </button>
          ))}
          {matches.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500">
              {visionOnly && provider === 'openrouter' ? 'No image-capable model matches. Enter an ID manually if needed.' : 'No matching model. Enter an ID manually.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OllamaRecommendations({
  installed, pulling, textModel, visionModel, onPull, onUseText, onUseVision,
}: {
  installed: (name: string) => boolean;
  pulling: { model: string; status: string; percent: number | null } | null;
  textModel: string;
  visionModel: string;
  onPull: (name: string) => void;
  onUseText: (name: string) => void;
  onUseVision: (name: string) => void;
}) {
  return (
    <div className="border-t border-neutral-700 pt-4 space-y-2">
      <p className="text-xs text-neutral-400">Recommended Ollama models</p>
      {RECOMMENDED_OLLAMA_MODELS.map((model) => {
        const isInstalled = installed(model.name);
        const isPulling = pulling?.model === model.name;
        return (
          <div key={model.name} className="flex items-center gap-2 rounded-lg bg-neutral-900 px-3 py-2 text-xs">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-neutral-200 truncate">{model.label}{isInstalled && <CheckCircle className="ml-1 inline w-3 h-3 text-green-500" />}</p>
              <p className="text-[10px] text-neutral-500">{model.desc}</p>
            </div>
            {!isInstalled && !isPulling && (
              <button onClick={() => onPull(model.name)} disabled={Boolean(pulling)} className="flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-blue-500 disabled:opacity-40">
                <Download className="w-3 h-3" /> Pull
              </button>
            )}
            {isPulling && <span className="text-[10px] text-blue-400">{pulling.percent != null ? `${pulling.percent}%` : pulling.status}</span>}
            {isInstalled && !isPulling && (
              <div className="flex gap-1">
                {(model.role === 'text' || model.role === 'both') && <button onClick={() => onUseText(model.name)} className={`rounded px-1.5 py-0.5 text-[10px] ${textModel === model.name ? 'bg-purple-600 text-white' : 'bg-neutral-700 text-neutral-300'}`}>Text</button>}
                {(model.role === 'vision' || model.role === 'both') && <button onClick={() => onUseVision(model.name)} className={`rounded px-1.5 py-0.5 text-[10px] ${visionModel === model.name ? 'bg-teal-600 text-white' : 'bg-neutral-700 text-neutral-300'}`}>Vision</button>}
              </div>
            )}
          </div>
        );
      })}
      {pulling?.percent != null && (
        <div className="h-1 overflow-hidden rounded-full bg-neutral-700">
          <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${pulling.percent}%` }} />
        </div>
      )}
    </div>
  );
}
