<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { StudyMetadata } from '../dicom/types';
import { buildSurveyHint, detectBodyPart, getChecklist } from '../llm/anatomyChecklists';
import type { SelectionPlan, ChatMessage } from '../llm/types';
import type { ChatStatus, PipelineState, SliceMapping } from '../llm/useLLMChat';
import PlanPreview from './PlanPreview.vue';

const props = defineProps<{
  messages: ChatMessage[];
  status: ChatStatus;
  statusText: string;
  error: string | null;
  pipeline: PipelineState | null;
  currentPlan: SelectionPlan | null;
  studyMetadata: StudyMetadata | null;
}>();
const emit = defineEmits<{
  close: [];
  clear: [];
  start: [hint: string, options?: { surveyMode?: boolean }];
  followUp: [text: string];
  confirm: [plan: SelectionPlan];
  cancel: [];
  navigate: [mapping: SliceMapping];
}>();
const input = ref<HTMLTextAreaElement | null>(null);
const text = ref('');
const scroll = ref<HTMLDivElement | null>(null);
const survey = ref(false);
const selected = ref<string[]>([]);
const bodyPart = computed(() => props.studyMetadata ? detectBodyPart(props.studyMetadata) : 'unknown');
const checklist = computed(() => getChecklist(bodyPart.value));
const busy = computed(() => !['idle', 'error', 'awaiting-confirmation'].includes(props.status));

watch(checklist, (value) => { selected.value = value.structures.filter((item) => item.defaultChecked).map((item) => item.id); }, { immediate: true });
watch(() => [props.messages.length, props.status, props.currentPlan] as const, async () => { await nextTick(); scroll.value?.scrollTo({ top: scroll.value.scrollHeight, behavior: 'smooth' }); });

function toggle(id: string): void { selected.value = selected.value.includes(id) ? selected.value.filter((value) => value !== id) : [...selected.value, id]; }
function send(): void {
  const content = text.value.trim();
  if (!content || busy.value) return;
  if (props.messages.length === 0) emit('start', content); else emit('followUp', content);
  text.value = '';
  void nextTick(resizeInput);
}
function keydown(event: KeyboardEvent): void { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }
function resizeInput(): void {
  const element = input.value;
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
}
function runSurvey(): void { if (selected.value.length) emit('start', buildSurveyHint(bodyPart.value, selected.value), { surveyMode: true }); }
function focusInput(): void { input.value?.focus(); }
defineExpose({ focusInput });
</script>

<template>
  <aside class="flex h-full w-96 shrink-0 flex-col overflow-hidden border-l border-neutral-700 bg-neutral-900" aria-label="Analysis chat">
    <header class="flex items-center justify-between border-b border-neutral-700 px-3 py-2"><h2 class="text-sm font-medium text-neutral-100">Analysis chat</h2><div class="flex gap-1"><button v-if="messages.length" class="text-xs text-neutral-500 hover:text-white" @click="emit('clear')">Clear</button><button class="text-xs text-neutral-500 hover:text-white" @click="emit('close')">Close</button></div></header>
    <div ref="scroll" class="flex-1 space-y-3 overflow-y-auto p-3">
      <div v-if="messages.length === 0 && !pipeline && studyMetadata" class="space-y-3">
        <div class="grid grid-cols-2 rounded bg-neutral-800 p-1"><button class="rounded py-1.5 text-xs" :class="!survey ? 'bg-neutral-700 text-white' : 'text-neutral-400'" @click="survey = false">Free text</button><button class="rounded py-1.5 text-xs" :class="survey ? 'bg-neutral-700 text-white' : 'text-neutral-400'" @click="survey = true">Guided survey</button></div>
        <template v-if="survey"><p class="text-xs text-neutral-400">Detected: <span class="font-medium text-neutral-200">{{ checklist.displayName }}</span></p><label v-for="item in checklist.structures" :key="item.id" class="flex cursor-pointer items-center gap-2 text-xs text-neutral-300"><input type="checkbox" :checked="selected.includes(item.id)" @change="toggle(item.id)">{{ item.label }}</label><button class="w-full rounded bg-blue-600 py-2 text-xs font-medium text-white disabled:opacity-50" :disabled="!selected.length" @click="runSurvey">Run survey ({{ selected.length }})</button></template>
        <p v-else class="text-center text-xs text-neutral-500">Describe the clinical context below to begin.</p>
      </div>
      <template v-for="message in messages" :key="message.id">
        <div v-if="message.role === 'user'" class="ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-blue-600 px-3 py-2 text-sm text-white">{{ message.content }}</div>
        <article v-else class="rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-sm whitespace-pre-wrap text-neutral-200">{{ message.content }}<div v-if="pipeline?.sliceMappings.some((mapping) => mapping.kind === 'slice')" class="mt-3 flex flex-wrap gap-1"><button v-for="mapping in pipeline.sliceMappings.filter((candidate) => candidate.kind === 'slice')" :key="`${mapping.imageIndex}-${mapping.imageId}`" class="rounded bg-neutral-800 px-1.5 py-1 text-[10px] text-blue-300 hover:bg-neutral-700" @click="emit('navigate', mapping)">#{{ mapping.seriesNumber }} · {{ mapping.instanceNumber }}</button></div></article>
      </template>
      <div v-if="pipeline" class="rounded border border-neutral-800 p-2 text-xs"><div v-for="step in pipeline.steps" :key="step.id" class="flex justify-between py-0.5" :class="step.status === 'error' ? 'text-red-300' : step.status === 'done' ? 'text-green-300' : step.status === 'active' ? 'text-blue-300' : 'text-neutral-500'"><span>{{ step.label }}</span><span>{{ step.detail || step.status }}</span></div></div>
      <div v-if="pipeline?.budget" class="rounded border border-neutral-800 p-2 text-[11px] text-neutral-400"><p class="font-medium text-neutral-200">Budget preflight</p><p>{{ pipeline.budget.approvedImages }} images · {{ Math.round(pipeline.budget.pixelsPerImage / 1000) }}k pixels/image · ~{{ Math.round(pipeline.budget.estimatedInputTokens / 100) / 10 }}k input tokens</p><p v-for="warning in pipeline.budget.warnings" :key="warning" class="text-amber-300">{{ warning }}</p></div>
      <div v-if="pipeline?.qualityWarnings.length" class="rounded border border-amber-900/70 bg-amber-950/20 p-2 text-[11px] text-amber-200"><p class="font-medium">Image quality notices</p><p v-for="warning in pipeline.qualityWarnings" :key="`${warning.code}-${warning.seriesNumber}`">{{ warning.message }}</p></div>
      <details v-if="pipeline" class="rounded border border-neutral-800 p-2 text-[10px] text-neutral-500"><summary class="cursor-pointer text-neutral-300">Run comparison log</summary><p>{{ pipeline.comparisonLog.provider }} · plan: {{ pipeline.comparisonLog.planningModel }} · vision: {{ pipeline.comparisonLog.visionModel }}</p><p>Profile: {{ pipeline.comparisonLog.settings.profile }} · {{ pipeline.comparisonLog.settings.contextWindowTokens }} context tokens · {{ pipeline.comparisonLog.settings.responseTokenBudget }} response tokens</p><p v-for="round in pipeline.comparisonLog.rounds" :key="round.round">Round {{ round.round + 1 }}: {{ round.imageCount }} images · {{ round.durationMs ?? 0 }}ms{{ round.requestedAdditionalImages ? ' · requested targeted images' : '' }}</p></details>
      <PlanPreview v-if="status === 'awaiting-confirmation' && currentPlan && studyMetadata" :plan="currentPlan" :metadata="studyMetadata" :budget="pipeline?.budget" @accept="emit('confirm', $event)" @cancel="emit('cancel')" />
      <p v-if="busy && statusText" class="text-xs text-blue-300">{{ statusText }}</p>
    </div>
    <p v-if="error" class="mx-3 mb-2 rounded border border-red-800 bg-red-950/30 p-2 text-xs text-red-300" role="alert">{{ error }}</p>
    <footer class="border-t border-neutral-800 p-3"><p class="mb-1 text-center text-[10px] text-neutral-600">Not for clinical diagnosis</p><div class="flex items-end gap-2 rounded-lg bg-neutral-800 px-3 py-2"><textarea ref="input" v-model="text" rows="2" class="min-h-10 max-h-40 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent text-sm leading-5 text-neutral-100 outline-none placeholder:text-neutral-500" :disabled="busy" :placeholder="messages.length ? 'Ask a follow-up…' : 'Describe clinical context…'" @input="resizeInput" @keydown="keydown"></textarea><button class="text-xs font-medium text-blue-300 disabled:opacity-40" :disabled="busy || !text.trim()" @click="send">Send</button></div></footer>
  </aside>
</template>
