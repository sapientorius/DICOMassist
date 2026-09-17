<script setup lang="ts">
import type { StudyMetadata } from '../dicom/types';

defineProps<{ metadata: StudyMetadata }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <aside class="h-full w-80 shrink-0 overflow-y-auto border-l border-neutral-700 bg-neutral-900 p-3" aria-label="Study metadata">
    <div class="mb-3 flex items-center justify-between">
      <h2 class="text-sm font-medium text-neutral-100">Study information</h2>
      <button class="text-xs text-neutral-500 hover:text-neutral-200" @click="emit('close')">Close</button>
    </div>
    <dl class="space-y-2 text-xs">
      <div><dt class="text-neutral-500">Study</dt><dd class="break-words text-neutral-200">{{ metadata.studyDescription || 'Unnamed study' }}</dd></div>
      <div><dt class="text-neutral-500">Modality</dt><dd class="text-neutral-200">{{ metadata.modality }}</dd></div>
      <div v-if="metadata.bodyPartExamined"><dt class="text-neutral-500">Body part</dt><dd class="text-neutral-200">{{ metadata.bodyPartExamined }}</dd></div>
      <div v-if="metadata.patientAge || metadata.patientSex"><dt class="text-neutral-500">Patient context</dt><dd class="text-neutral-200">{{ metadata.patientAge }} {{ metadata.patientSex }}</dd></div>
    </dl>
    <h3 class="mt-5 text-xs font-medium uppercase tracking-wide text-neutral-500">Series ({{ metadata.series.length }})</h3>
    <ul class="mt-2 space-y-2">
      <li v-for="series in metadata.series" :key="series.seriesInstanceUID" class="rounded border border-neutral-800 bg-neutral-950 p-2 text-xs">
        <p class="font-medium text-neutral-200">#{{ series.seriesNumber }} {{ series.seriesDescription || 'Unnamed series' }}</p>
        <p class="mt-1 text-neutral-500">{{ series.anatomicalPlane }} · {{ series.slices.length }} slices · {{ series.sliceThickness ?? '–' }} mm</p>
        <p v-if="series.estimatedWeighting || series.convolutionKernel" class="text-neutral-500">{{ series.estimatedWeighting || series.convolutionKernel }}</p>
      </li>
    </ul>
  </aside>
</template>
