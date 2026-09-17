<script setup lang="ts">
import type { ViewerLayout, ViewerTool } from './DicomViewer.vue';

defineProps<{
  activeTool: ViewerTool;
  layout: ViewerLayout;
  invert: boolean;
  flipHorizontal: boolean;
  flipVertical: boolean;
  cineEnabled: boolean;
  showSeries: boolean;
  showMetadata: boolean;
}>();

const emit = defineEmits<{
  'update:activeTool': [value: ViewerTool];
  'update:layout': [value: ViewerLayout];
  'update:invert': [value: boolean];
  'update:flipHorizontal': [value: boolean];
  'update:flipVertical': [value: boolean];
  'update:cineEnabled': [value: boolean];
  reset: [];
  analyze: [];
  settings: [];
  series: [];
  metadata: [];
}>();

const tools: Array<{ id: ViewerTool; label: string; mprOnly?: boolean }> = [
  { id: 'WindowLevel', label: 'W/L' }, { id: 'Zoom', label: 'Zoom' }, { id: 'Pan', label: 'Pan' },
  { id: 'Length', label: 'Length' }, { id: 'Angle', label: 'Angle' }, { id: 'EllipticalROI', label: 'ROI' },
  { id: 'Crosshairs', label: 'Crosshair', mprOnly: true }, { id: 'Rotate', label: 'Rotate' },
];
</script>

<template>
  <header class="flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-b border-neutral-700 bg-neutral-900 px-2 py-1.5">
    <div class="mr-2 text-xs font-semibold tracking-wide text-neutral-200">DICOMassist</div>
    <button
      v-for="tool in tools"
      :key="tool.id"
      class="rounded px-2 py-1 text-xs transition-colors"
      :class="activeTool === tool.id ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100'"
      :aria-pressed="activeTool === tool.id"
      :disabled="tool.mprOnly && layout !== 'mpr'"
      :title="tool.mprOnly && layout !== 'mpr' ? 'Available in MPR layout only' : undefined"
      @click="emit('update:activeTool', tool.id)"
    >{{ tool.label }}</button>
    <button class="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100" @click="emit('reset')">Reset</button>
    <button class="rounded px-2 py-1 text-xs" :class="invert ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:bg-neutral-800'" @click="emit('update:invert', !invert)">Invert</button>
    <button class="rounded px-2 py-1 text-xs" :class="flipHorizontal ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:bg-neutral-800'" @click="emit('update:flipHorizontal', !flipHorizontal)">Flip H</button>
    <button class="rounded px-2 py-1 text-xs" :class="flipVertical ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:bg-neutral-800'" @click="emit('update:flipVertical', !flipVertical)">Flip V</button>
    <button class="rounded px-2 py-1 text-xs" :class="cineEnabled ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:bg-neutral-800'" @click="emit('update:cineEnabled', !cineEnabled)">Cine</button>
    <select
      :value="layout"
      class="ml-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-200 outline-none"
      aria-label="Viewport layout"
      @change="emit('update:layout', ($event.target as HTMLSelectElement).value as ViewerLayout)"
    >
      <option value="1x1">1 × 1</option>
      <option value="1x2">1 × 2</option>
      <option value="2x1">2 × 1</option>
      <option value="2x2">2 × 2</option>
      <option value="mpr">MPR</option>
    </select>
    <div class="ml-auto flex items-center gap-1">
      <button class="rounded px-2 py-1 text-xs" :class="showSeries ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-800'" @click="emit('series')">Series</button>
      <button class="rounded px-2 py-1 text-xs" :class="showMetadata ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-800'" @click="emit('metadata')">Study info</button>
      <button class="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500" @click="emit('analyze')">Analyze</button>
      <button class="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100" aria-label="Open settings" @click="emit('settings')">Settings</button>
    </div>
  </header>
</template>
