<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { StudyMetadata } from '../dicom/types';
import type { AnalysisBudgetEstimate } from '../llm/analysisConfig';
import type { SelectionPlan, SeriesSelection } from '../llm/types';

const props = defineProps<{ plan: SelectionPlan; metadata: StudyMetadata; budget?: AnalysisBudgetEstimate | null }>();
const emit = defineEmits<{ accept: [plan: SelectionPlan]; cancel: [] }>();
const rows = ref<SeriesSelection[]>([]);

watch(() => props.plan, (plan) => { rows.value = plan.selections.map((selection) => ({ ...selection })); }, { immediate: true });
const imageCount = computed(() => rows.value.reduce((total, selection) => {
  const range = selection.sliceRange[1] - selection.sliceRange[0] + 1;
  const sliceCount = selection.samplingStrategy === 'uniform'
    ? Math.min(range, selection.samplingParam ?? range)
    : selection.samplingStrategy === 'every_nth'
      ? Math.ceil(range / Math.max(1, selection.samplingParam ?? 1))
      : range;
  return total + sliceCount * (1 + (selection.displayWindows?.length ?? 0));
}, 0));
const budgetLimit = computed(() => props.budget?.approvedImages ?? 20);

function update(index: number, update: Partial<SeriesSelection>): void {
  rows.value[index] = { ...rows.value[index], ...update };
}

function accept(): void {
  const primary = rows.value[0];
  emit('accept', {
    ...props.plan,
    selections: rows.value,
    totalImages: imageCount.value,
    targetSeries: primary.seriesNumber,
    sliceRange: primary.sliceRange,
    samplingStrategy: primary.samplingStrategy,
    samplingParam: primary.samplingParam,
    windowCenter: primary.windowCenter,
    windowWidth: primary.windowWidth,
  });
}
</script>

<template>
  <section class="rounded-lg border border-blue-800/70 bg-blue-950/20 p-3" aria-label="Selection plan">
    <h3 class="text-xs font-semibold text-blue-200">Review selection plan</h3>
    <p class="mt-1 text-[11px] text-neutral-400">{{ plan.reasoning }}</p>
    <div class="mt-3 space-y-2">
      <div v-for="(row, index) in rows" :key="`${row.seriesNumber}-${index}`" class="rounded border border-neutral-700 bg-neutral-900 p-2">
        <p class="mb-1 text-xs text-neutral-200">{{ row.role }} · #{{ row.seriesNumber }} {{ metadata.series.find((series) => String(series.seriesNumber) === row.seriesNumber)?.seriesDescription }}</p>
        <div class="grid grid-cols-3 gap-1 text-[11px]">
          <label class="text-neutral-500">Start<input type="number" :value="row.sliceRange[0]" class="mt-0.5 w-full rounded bg-neutral-950 p-1 text-neutral-100" @input="update(index, { sliceRange: [Number(($event.target as HTMLInputElement).value), row.sliceRange[1]] })"></label>
          <label class="text-neutral-500">End<input type="number" :value="row.sliceRange[1]" class="mt-0.5 w-full rounded bg-neutral-950 p-1 text-neutral-100" @input="update(index, { sliceRange: [row.sliceRange[0], Number(($event.target as HTMLInputElement).value)] })"></label>
          <label class="text-neutral-500">Images<input type="number" min="1" :max="budgetLimit" :value="row.samplingParam ?? 1" class="mt-0.5 w-full rounded bg-neutral-950 p-1 text-neutral-100" @input="update(index, { samplingStrategy: 'uniform', samplingParam: Number(($event.target as HTMLInputElement).value) })"></label>
          <label class="text-neutral-500">Window width<input type="number" min="1" :value="row.windowWidth" class="mt-0.5 w-full rounded bg-neutral-950 p-1 text-neutral-100" @input="update(index, { windowWidth: Number(($event.target as HTMLInputElement).value) })"></label>
          <label class="text-neutral-500">Window center<input type="number" :value="row.windowCenter" class="mt-0.5 w-full rounded bg-neutral-950 p-1 text-neutral-100" @input="update(index, { windowCenter: Number(($event.target as HTMLInputElement).value) })"></label>
          <label class="col-span-3 text-neutral-500">Coverage goal<input type="text" :value="row.coverageGoal ?? ''" class="mt-0.5 w-full rounded bg-neutral-950 p-1 text-neutral-100" placeholder="What should this selection cover?" @input="update(index, { coverageGoal: ($event.target as HTMLInputElement).value })"></label>
        </div>
        <p v-if="row.displayWindows?.length" class="mt-1 text-[10px] text-blue-300">Additional display: {{ row.displayWindows.map((window) => `${window.label} W:${window.windowWidth} C:${window.windowCenter}`).join(' · ') }}</p>
      </div>
    </div>
    <p class="mt-2 text-[11px]" :class="imageCount + plan.selections.length > budgetLimit ? 'text-red-300' : 'text-neutral-500'">{{ imageCount }} detail + {{ plan.selections.length }} overview / {{ budgetLimit }} images · ~{{ Math.round((budget?.estimatedInputTokens ?? 0) / 100) / 10 }}k estimated input tokens</p>
    <p v-for="warning in budget?.warnings" :key="warning" class="mt-1 text-[10px] text-amber-300">{{ warning }}</p>
    <div class="mt-3 flex justify-end gap-2">
      <button class="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800" @click="emit('cancel')">Cancel</button>
      <button class="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50" :disabled="imageCount + plan.selections.length > budgetLimit" @click="accept">Analyze images</button>
    </div>
  </section>
</template>
