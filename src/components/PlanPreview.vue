<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { StudyMetadata } from '../dicom/types';
import type { SelectionPlan, SeriesSelection } from '../llm/types';

const props = defineProps<{ plan: SelectionPlan; metadata: StudyMetadata }>();
const emit = defineEmits<{ accept: [plan: SelectionPlan]; cancel: [] }>();
const rows = ref<SeriesSelection[]>([]);

watch(() => props.plan, (plan) => { rows.value = plan.selections.map((selection) => ({ ...selection })); }, { immediate: true });
const imageCount = computed(() => rows.value.reduce((total, selection) => {
  const range = selection.sliceRange[1] - selection.sliceRange[0] + 1;
  return total + (selection.samplingStrategy === 'uniform' ? Math.min(range, selection.samplingParam ?? range) : range);
}, 0));

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
          <label class="text-neutral-500">Images<input type="number" min="1" max="20" :value="row.samplingParam ?? 1" class="mt-0.5 w-full rounded bg-neutral-950 p-1 text-neutral-100" @input="update(index, { samplingStrategy: 'uniform', samplingParam: Number(($event.target as HTMLInputElement).value) })"></label>
        </div>
      </div>
    </div>
    <p class="mt-2 text-[11px]" :class="imageCount > 20 ? 'text-red-300' : 'text-neutral-500'">{{ imageCount }} / 20 images</p>
    <div class="mt-3 flex justify-end gap-2">
      <button class="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800" @click="emit('cancel')">Cancel</button>
      <button class="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50" :disabled="imageCount > 20" @click="accept">Analyze images</button>
    </div>
  </section>
</template>
