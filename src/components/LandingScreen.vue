<script setup lang="ts">
import { ref } from 'vue';
import { filesFromDrop, useDicomStudyLoader, type LoadResult } from '../composables/useDicomStudyLoader';
import { loadSampleData } from '../utils/sampleDataLoader';

const emit = defineEmits<{ loaded: [result: LoadResult] }>();
const input = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const sampleLoading = ref(false);
const { loading, phase, progress, error, loadFiles } = useDicomStudyLoader();

async function load(files: File[]): Promise<void> {
  const result = await loadFiles(files);
  if (result) emit('loaded', result);
}
async function drop(event: DragEvent): Promise<void> {
  event.preventDefault();
  dragging.value = false;
  if (event.dataTransfer) await load(await filesFromDrop(event.dataTransfer));
}
async function select(event: Event): Promise<void> {
  const files = Array.from((event.target as HTMLInputElement).files ?? []);
  await load(files);
  if (input.value) input.value.value = '';
}
async function sample(): Promise<void> {
  sampleLoading.value = true;
  try {
    await load(await loadSampleData());
  } finally {
    sampleLoading.value = false;
  }
}
</script>

<template>
  <main class="flex h-full items-center justify-center p-6">
    <section
      class="w-full max-w-2xl rounded-2xl border-2 border-dashed p-10 text-center transition-colors"
      :class="dragging ? 'border-blue-500 bg-blue-500/10' : 'border-neutral-700 bg-neutral-900/60'"
      data-testid="dicom-drop-zone"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop="drop"
    >
      <p class="text-lg font-medium text-neutral-100">Open a DICOM study</p>
      <p class="mt-2 text-sm text-neutral-400">Drop DICOM files or a folder here. Files are processed locally in this browser.</p>
      <input ref="input" class="hidden" type="file" multiple webkitdirectory="" @change="select">
      <div class="mt-6 flex flex-wrap justify-center gap-3">
        <button class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50" :disabled="loading || sampleLoading" @click="input?.click()">Browse folder</button>
        <button class="rounded-lg bg-neutral-800 px-4 py-2 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-50" :disabled="loading || sampleLoading" @click="sample">Try sample knee MRI</button>
      </div>
      <div v-if="loading" class="mt-6">
        <p class="text-xs text-neutral-400">{{ phase === 'sorting' ? 'Organizing image series…' : `Reading headers… ${progress.loaded}/${progress.total}` }}</p>
        <div class="mx-auto mt-2 h-1.5 max-w-xs overflow-hidden rounded bg-neutral-800"><div class="h-full bg-blue-500" :style="{ width: `${progress.total ? (progress.loaded / progress.total) * 100 : 0}%` }" /></div>
      </div>
      <p v-if="error" class="mt-4 text-sm text-red-300" role="alert">{{ error }}</p>
      <p class="mt-6 text-[11px] text-neutral-600">Educational and research use only — not for clinical diagnosis.</p>
    </section>
  </main>
</template>
