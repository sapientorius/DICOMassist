<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { StudyMetadata } from './dicom/types';
import { initCornerstone } from './viewer/CornerstoneInit';
import { createDefaultProviderConfig, migrateProviderConfig } from './llm/providerConfig';
import type { ProviderConfig, ViewportContext } from './llm/types';
import { useLLMChat, type SliceMapping } from './llm/useLLMChat';
import type { LoadResult } from './composables/useDicomStudyLoader';
import LandingScreen from './components/LandingScreen.vue';
import type { ViewerLayout, ViewerTool } from './components/DicomViewer.vue';
import ToolbarPanel from './components/ToolbarPanel.vue';
import MetadataPanel from './components/MetadataPanel.vue';
import ChatSidebar from './components/ChatSidebar.vue';
import SettingsPanel from './components/SettingsPanel.vue';

const STORAGE_KEY = 'dicomassist-llm-config';
const DicomViewer = defineAsyncComponent(() => import('./components/DicomViewer.vue'));
interface DicomViewerHandle {
  applyPlan: (plan: import('./llm/types').SelectionPlan) => void;
  getViewportContext: () => ViewportContext | undefined;
  reset: () => void;
  scrollToInstance: (instanceNumber: number) => void;
}
function loadConfig(): ProviderConfig {
  try { return migrateProviderConfig(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')); }
  catch { return createDefaultProviderConfig(); }
}

const ready = ref(false);
const initError = ref<string | null>(null);
const studyMetadata = ref<StudyMetadata | null>(null);
const imageIds = ref<string[]>([]);
const activeSeriesUID = ref('');
const activeTool = ref<ViewerTool>('WindowLevel');
const layout = ref<ViewerLayout>('1x1');
const invert = ref(false);
const flipHorizontal = ref(false);
const flipVertical = ref(false);
const cineEnabled = ref(false);
const showChat = ref(false);
const showMetadata = ref(false);
const showSeries = ref(false);
const showSettings = ref(false);
const providerConfig = ref<ProviderConfig>(loadConfig());
const viewer = ref<DicomViewerHandle | null>(null);
const chat = ref<InstanceType<typeof ChatSidebar> | null>(null);
const activeSeries = computed(() => studyMetadata.value?.series.find((series) => series.seriesInstanceUID === activeSeriesUID.value) ?? null);
const { messages, status, statusText, error, currentPlan, pipeline, startAnalysis, confirmPlan, cancelPlan, sendFollowUp, clearChat } = useLLMChat(studyMetadata, providerConfig);

function saveConfig(config: ProviderConfig): void {
  providerConfig.value = config;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
async function handleLoaded(result: LoadResult): Promise<void> {
  try {
    await initCornerstone();
    ready.value = true;
  } catch (cause) {
    initError.value = cause instanceof Error ? cause.message : 'The DICOM viewer could not initialize.';
    return;
  }
  studyMetadata.value = result.studyMetadata;
  imageIds.value = result.imageIds;
  activeSeriesUID.value = result.studyMetadata.primarySeriesUID;
  layout.value = '1x1';
  invert.value = false;
  flipHorizontal.value = false;
  flipVertical.value = false;
  cineEnabled.value = false;
}
function selectSeries(uid: string): void {
  const selected = studyMetadata.value?.series.find((series) => series.seriesInstanceUID === uid);
  if (!selected) return;
  activeSeriesUID.value = uid;
  imageIds.value = selected.slices.map((slice) => slice.imageId);
  layout.value = '1x1';
}
function openChat(): void {
  showChat.value = true;
  showMetadata.value = false;
  void nextTick(() => chat.value?.focusInput());
}
function startWithContext(hint: string, options?: { surveyMode?: boolean }): void {
  const context: ViewportContext | undefined = viewer.value?.getViewportContext();
  void startAnalysis(hint, context, options);
}
async function navigate(mapping: SliceMapping): Promise<void> {
  if (mapping.kind !== 'slice' || mapping.instanceNumber == null) return;
  const series = studyMetadata.value?.series.find((candidate) => String(candidate.seriesNumber) === mapping.seriesNumber);
  if (!series) return;
  if (series.seriesInstanceUID !== activeSeriesUID.value) selectSeries(series.seriesInstanceUID);
  await nextTick();
  viewer.value?.scrollToInstance(mapping.instanceNumber);
}

watch(currentPlan, async (plan) => {
  if (!plan || !studyMetadata.value) return;
  const target = studyMetadata.value.series.find((series) => String(series.seriesNumber) === plan.targetSeries);
  if (target && target.seriesInstanceUID !== activeSeriesUID.value) selectSeries(target.seriesInstanceUID);
  await nextTick();
  viewer.value?.applyPlan(plan);
});
watch(status, (value) => { if (value === 'awaiting-confirmation' || (value === 'idle' && messages.value.length > 0)) showChat.value = true; });

function handleKeydown(event: KeyboardEvent): void {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === 'k' && imageIds.value.length) { event.preventDefault(); openChat(); }
  if (modifier && event.key.toLowerCase() === 'b') { event.preventDefault(); showChat.value = !showChat.value; }
  if (event.key === 'Escape') {
    if (status.value === 'awaiting-confirmation') cancelPlan();
    else if (showSettings.value) showSettings.value = false;
    else if (showChat.value) showChat.value = false;
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown);
});
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <div class="h-full bg-neutral-950 text-neutral-100">
    <main v-if="initError" class="flex h-full items-center justify-center p-6"><p class="max-w-md rounded border border-red-800 bg-red-950/30 p-4 text-sm text-red-200">{{ initError }}</p></main>
    <LandingScreen v-else-if="imageIds.length === 0" @loaded="handleLoaded" />
    <main v-else-if="!ready" class="flex h-full items-center justify-center"><p class="text-sm text-neutral-500">Initializing DICOM viewer…</p></main>
    <div v-else class="flex h-full flex-col">
      <ToolbarPanel v-model:active-tool="activeTool" v-model:layout="layout" v-model:invert="invert" v-model:flip-horizontal="flipHorizontal" v-model:flip-vertical="flipVertical" v-model:cine-enabled="cineEnabled" :show-series="showSeries" :show-metadata="showMetadata" @reset="viewer?.reset()" @analyze="openChat" @settings="showSettings = true" @series="showSeries = !showSeries" @metadata="showMetadata = !showMetadata; showChat = false" />
      <div class="flex min-h-0 flex-1 overflow-hidden">
        <aside v-if="showSeries && studyMetadata" class="w-72 shrink-0 overflow-y-auto border-r border-neutral-700 bg-neutral-900 p-3"><div class="mb-3 flex justify-between"><h2 class="text-sm font-medium">Series</h2><button class="text-xs text-neutral-500 hover:text-white" @click="showSeries = false">Close</button></div><button v-for="series in studyMetadata.series" :key="series.seriesInstanceUID" class="mb-1 w-full rounded p-2 text-left text-xs" :class="series.seriesInstanceUID === activeSeriesUID ? 'bg-blue-600/30 text-blue-100' : 'text-neutral-400 hover:bg-neutral-800'" @click="selectSeries(series.seriesInstanceUID)"><span class="font-medium">#{{ series.seriesNumber }}</span> {{ series.seriesDescription || 'Unnamed series' }}<small class="mt-0.5 block text-neutral-500">{{ series.anatomicalPlane }} · {{ series.slices.length }} slices</small></button></aside>
        <DicomViewer ref="viewer" class="min-w-0 flex-1" :image-ids="imageIds" :series="activeSeries" :study-metadata="studyMetadata" :active-tool="activeTool" :layout="layout" :invert="invert" :flip-horizontal="flipHorizontal" :flip-vertical="flipVertical" :cine-enabled="cineEnabled" />
        <MetadataPanel v-if="showMetadata && studyMetadata" :metadata="studyMetadata" @close="showMetadata = false" />
        <ChatSidebar v-if="showChat" ref="chat" :messages="messages" :status="status" :status-text="statusText" :error="error" :pipeline="pipeline" :current-plan="currentPlan" :study-metadata="studyMetadata" @close="showChat = false" @clear="clearChat" @start="startWithContext" @follow-up="(text) => sendFollowUp(text)" @confirm="(plan) => confirmPlan(plan)" @cancel="cancelPlan" @navigate="navigate" />
      </div>
      <footer class="shrink-0 border-t border-neutral-800 px-3 py-1 text-center text-[10px] text-neutral-600">Educational and research use only · Not for clinical diagnosis</footer>
      <SettingsPanel :open="showSettings" :config="providerConfig" @close="showSettings = false" @change="saveConfig" />
    </div>
  </div>
</template>
