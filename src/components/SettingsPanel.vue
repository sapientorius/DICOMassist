<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ProviderConfig, ProviderProfile, ProviderType } from '../llm/types';
import { DEFAULT_LM_STUDIO_URL, DEFAULT_OLLAMA_URL, getProviderProfile, PROVIDER_LABELS, updateProviderProfile } from '../llm/providerConfig';
import { fetchProviderModels, type ProviderModelInfo } from '../llm/LLMServiceFactory';

const props = defineProps<{ open: boolean; config: ProviderConfig }>();
const emit = defineEmits<{ close: []; change: [config: ProviderConfig] }>();
const models = ref<ProviderModelInfo[]>([]);
const catalogError = ref<string | null>(null);
const loading = ref(false);
const provider = computed(() => props.config.provider);
const profile = computed(() => getProviderProfile(props.config));
const remote = computed(() => ['claude', 'openrouter', 'openai'].includes(provider.value));
const providers: ProviderType[] = ['claude', 'ollama', 'lmstudio', 'openrouter', 'openai'];

watch(() => props.open, (open) => { if (!open) { models.value = []; catalogError.value = null; } });
function choose(next: ProviderType): void { emit('change', { ...props.config, provider: next }); }
function update(update: Partial<ProviderProfile>): void { emit('change', updateProviderProfile(props.config, provider.value, update)); }
async function refresh(): Promise<void> {
  loading.value = true; catalogError.value = null;
  try { models.value = (await fetchProviderModels(provider.value, profile.value)).sort((left, right) => left.label.localeCompare(right.label)); }
  catch (cause) { catalogError.value = cause instanceof Error ? cause.message : 'Could not load the model catalogue.'; }
  finally { loading.value = false; }
}
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50" @click.self="emit('close')">
    <section class="absolute right-4 top-14 flex max-h-[80vh] w-[min(32rem,calc(100vw-2rem))] flex-col overflow-y-auto rounded-xl border border-neutral-600 bg-neutral-800 shadow-2xl" aria-label="LLM settings">
      <header class="flex items-center justify-between border-b border-neutral-700 px-4 py-3"><div><h2 class="text-sm font-medium text-neutral-100">LLM settings</h2><p class="text-[10px] text-neutral-500">Provider settings stay in this browser.</p></div><button class="text-neutral-400 hover:text-white" @click="emit('close')">Close</button></header>
      <div class="space-y-4 p-4">
        <div class="grid grid-cols-2 gap-1"><button v-for="candidate in providers" :key="candidate" class="rounded px-2 py-2 text-xs" :class="candidate === provider ? 'bg-blue-600 text-white' : 'bg-neutral-900 text-neutral-400'" @click="choose(candidate)">{{ PROVIDER_LABELS[candidate] }}</button></div>
        <label v-if="remote || provider === 'lmstudio'" class="block text-xs text-neutral-400">API key<input type="password" :value="profile.apiKey ?? ''" class="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-sm text-neutral-100" @input="update({ apiKey: ($event.target as HTMLInputElement).value })"></label>
        <label v-if="provider === 'ollama' || provider === 'lmstudio'" class="block text-xs text-neutral-400">Server URL<input type="url" :value="profile.baseUrl || (provider === 'ollama' ? DEFAULT_OLLAMA_URL : DEFAULT_LM_STUDIO_URL)" class="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-sm text-neutral-100" @input="update({ baseUrl: ($event.target as HTMLInputElement).value })"></label>
        <p v-if="remote" class="rounded border border-amber-900 bg-amber-950/30 p-2 text-[11px] text-amber-200">Rendered slices and prompts are sent directly to the selected provider when analysis runs.</p>
        <div class="border-t border-neutral-700 pt-3"><div class="flex items-center justify-between"><p class="text-xs text-neutral-400">Available models</p><button class="rounded bg-neutral-700 px-2 py-1 text-xs text-neutral-200 disabled:opacity-50" :disabled="loading" @click="refresh">{{ loading ? 'Loading…' : 'Refresh' }}</button></div><p v-if="catalogError" class="mt-2 text-xs text-red-300">{{ catalogError }}</p></div>
        <label class="block text-xs text-neutral-400">Planning model<input list="planning-models" :value="profile.textModel ?? ''" class="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-sm text-neutral-100" @input="update({ textModel: ($event.target as HTMLInputElement).value })"><datalist id="planning-models"><option v-for="model in models" :key="model.id" :value="model.id">{{ model.label }}</option></datalist></label>
        <label class="block text-xs text-neutral-400">Vision model<input list="vision-models" :value="profile.visionModel ?? ''" class="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-sm text-neutral-100" @input="update({ visionModel: ($event.target as HTMLInputElement).value })"><datalist id="vision-models"><option v-for="model in models.filter((model) => model.supportsVision !== false)" :key="model.id" :value="model.id">{{ model.label }}</option></datalist></label>
      </div>
    </section>
  </div>
</template>
