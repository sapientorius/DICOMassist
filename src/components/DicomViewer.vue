<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';
import {
  Enums,
  RenderingEngine,
  getRenderingEngine,
  setVolumesForViewports,
  volumeLoader,
  type StackViewport,
} from '@cornerstonejs/core';
import {
  addTool,
  AngleTool,
  CrosshairsTool,
  EllipticalROITool,
  Enums as ToolsEnums,
  LengthTool,
  PanTool,
  PlanarRotateTool,
  StackScrollTool,
  ToolGroupManager,
  WindowLevelTool,
  ZoomTool,
} from '@cornerstonejs/tools';
import type { SeriesMetadata, StudyMetadata } from '../dicom/types';
import type { SelectionPlan, ViewportContext } from '../llm/types';

export type ViewerTool = 'WindowLevel' | 'Pan' | 'Zoom' | 'Length' | 'Angle' | 'EllipticalROI' | 'Crosshairs' | 'Rotate';
export type ViewerLayout = '1x1' | '1x2' | '2x1' | '2x2' | 'mpr';

const props = defineProps<{
  imageIds: string[];
  series: SeriesMetadata | null;
  studyMetadata: StudyMetadata | null;
  activeTool: ViewerTool;
  layout: ViewerLayout;
  invert: boolean;
  flipHorizontal: boolean;
  flipVertical: boolean;
  cineEnabled: boolean;
}>();

const emit = defineEmits<{ reset: [] }>();

const ENGINE_ID = 'dicomassist-rendering-engine';
const TOOL_GROUP_ID = 'dicomassist-tools';
const STACK_VIEWPORT_ID = 'DICOM_STACK';
const MPR_VIEWPORT_IDS = ['DICOM_AXIAL', 'DICOM_SAGITTAL', 'DICOM_CORONAL'] as const;
const gridElements = ref<Array<HTMLDivElement | null>>([]);
const singleElement = ref<HTMLDivElement | null>(null);
const mprElements = ref<Array<HTMLDivElement | null>>([]);
const currentSlice = ref(0);
const totalSlices = ref(0);
const ready = ref(false);
let generation = 0;
let toolsRegistered = false;
let cineTimer: number | undefined;

const gridCount = computed(() => props.layout === '2x2' ? 4 : 2);
const gridClass = computed(() => props.layout === '1x2' ? 'grid-cols-2' : props.layout === '2x1' ? 'grid-rows-2' : 'grid-cols-2 grid-rows-2');
const stackTools = [WindowLevelTool, PanTool, ZoomTool, StackScrollTool, LengthTool, AngleTool, EllipticalROITool, PlanarRotateTool];

function toolsForCurrentLayout() {
  return props.layout === 'mpr' ? [...stackTools, CrosshairsTool] : stackTools;
}

function registerTools(): void {
  if (toolsRegistered) return;
  [WindowLevelTool, PanTool, ZoomTool, StackScrollTool, LengthTool, AngleTool, EllipticalROITool, CrosshairsTool, PlanarRotateTool]
    .forEach((tool) => addTool(tool));
  toolsRegistered = true;
}

function setGridElement(index: number, element: Element | ComponentPublicInstance | null): void {
  gridElements.value[index] = element instanceof HTMLDivElement ? element : null;
}

function setMprElement(index: number, element: Element | ComponentPublicInstance | null): void {
  mprElements.value[index] = element instanceof HTMLDivElement ? element : null;
}

function destroyViewer(): void {
  if (cineTimer != null) window.clearInterval(cineTimer);
  cineTimer = undefined;
  ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
  getRenderingEngine(ENGINE_ID)?.destroy();
  ready.value = false;
}

function createToolGroup(viewportIds: string[], engine: RenderingEngine) {
  const group = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
  if (!group) throw new Error('Unable to create the Cornerstone tool group.');
  toolsForCurrentLayout().forEach((tool) => group.addTool(tool.toolName));
  viewportIds.forEach((viewportId) => group.addViewport(viewportId, engine.id));
  group.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: ToolsEnums.MouseBindings.Wheel }] });
  return group;
}

function activeToolName(): string {
  const names: Record<ViewerTool, string> = {
    WindowLevel: WindowLevelTool.toolName,
    Pan: PanTool.toolName,
    Zoom: ZoomTool.toolName,
    Length: LengthTool.toolName,
    Angle: AngleTool.toolName,
    EllipticalROI: EllipticalROITool.toolName,
    Crosshairs: CrosshairsTool.toolName,
    Rotate: PlanarRotateTool.toolName,
  };
  // Crosshairs synchronizes the intersection of multiple volume viewports.
  // It must not be added to a stack-only group: Cornerstone dispatches its
  // hover callback without annotations in that case.
  return props.activeTool === 'Crosshairs' && props.layout !== 'mpr'
    ? WindowLevelTool.toolName
    : names[props.activeTool];
}

function applyActiveTool(): void {
  const group = ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
  if (!group) return;
  const active = activeToolName();
  toolsForCurrentLayout().filter((tool) => tool !== StackScrollTool).forEach((tool) => {
    if (tool.toolName !== active) group.setToolPassive(tool.toolName);
  });
  group.setToolActive(active, { bindings: [{ mouseButton: ToolsEnums.MouseBindings.Primary }] });
  if (active !== ZoomTool.toolName) group.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: ToolsEnums.MouseBindings.Secondary }] });
  if (active !== PanTool.toolName) group.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: ToolsEnums.MouseBindings.Auxiliary }] });
}

function applyCameraToggles(): void {
  const engine = getRenderingEngine(ENGINE_ID);
  if (!engine) return;
  engine.getViewports().forEach((viewport) => {
    viewport.setCamera({ ...viewport.getCamera(), flipHorizontal: props.flipHorizontal, flipVertical: props.flipVertical });
    viewport.render();
  });
}

function syncCine(): void {
  if (cineTimer != null) window.clearInterval(cineTimer);
  cineTimer = undefined;
  if (!props.cineEnabled || props.layout === 'mpr') return;
  cineTimer = window.setInterval(() => {
    const viewport = primaryViewport();
    if (!viewport || viewport.getImageIds().length < 2) return;
    const next = (viewport.getCurrentImageIdIndex() + 1) % viewport.getImageIds().length;
    void viewport.setImageIdIndex(next).then(() => {
      viewport.render();
      updateSliceInfo();
    });
  }, 125);
}

function primaryViewport(): StackViewport | null {
  const engine = getRenderingEngine(ENGINE_ID);
  if (!engine) return null;
  const id = props.layout === 'mpr' ? MPR_VIEWPORT_IDS[0] : props.layout === '1x1' ? STACK_VIEWPORT_ID : 'DICOM_GRID_0';
  const viewport = engine.getViewport(id);
  return viewport && 'setStack' in viewport ? viewport as StackViewport : null;
}

function updateSliceInfo(): void {
  const viewport = primaryViewport();
  if (!viewport) return;
  currentSlice.value = viewport.getCurrentImageIdIndex() + 1;
  totalSlices.value = viewport.getImageIds().length;
}

async function configureStack(engine: RenderingEngine, elements: HTMLDivElement[], viewportIds: string[]): Promise<void> {
  viewportIds.forEach((viewportId, index) => engine.enableElement({
    viewportId,
    element: elements[index],
    type: Enums.ViewportType.STACK,
  }));
  createToolGroup(viewportIds, engine);
  await Promise.all(viewportIds.map(async (viewportId, index) => {
    const viewport = engine.getViewport(viewportId) as StackViewport;
    await viewport.setStack(props.imageIds, 0);
    viewport.setProperties({ invert: props.invert });
    viewport.resetCamera();
    viewport.render();
    if (index === 0) updateSliceInfo();
  }));
}

async function configureMpr(engine: RenderingEngine, elements: HTMLDivElement[]): Promise<void> {
  engine.setViewports(MPR_VIEWPORT_IDS.map((viewportId, index) => ({
    viewportId,
    element: elements[index],
    type: Enums.ViewportType.ORTHOGRAPHIC,
    defaultOptions: { orientation: [Enums.OrientationAxis.AXIAL, Enums.OrientationAxis.SAGITTAL, Enums.OrientationAxis.CORONAL][index] },
  })));
  createToolGroup([...MPR_VIEWPORT_IDS], engine);
  const volumeId = `dicomassist-volume-${generation}`;
  const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds: props.imageIds });
  volume.load();
  await setVolumesForViewports(engine, [{ volumeId }], [...MPR_VIEWPORT_IDS]);
  engine.resize();
  engine.renderViewports([...MPR_VIEWPORT_IDS]);
  currentSlice.value = 1;
  totalSlices.value = props.imageIds.length;
}

async function rebuild(): Promise<void> {
  const version = ++generation;
  destroyViewer();
  if (props.imageIds.length === 0) return;
  await nextTick();
  if (version !== generation) return;
  const engine = new RenderingEngine(ENGINE_ID);
  try {
    if (props.layout === 'mpr') {
      const elements = mprElements.value.slice(0, 3);
      if (elements.some((element) => !element)) throw new Error('MPR viewport elements are unavailable.');
      await configureMpr(engine, elements as HTMLDivElement[]);
    } else if (props.layout === '1x1') {
      if (!singleElement.value) throw new Error('Viewport element is unavailable.');
      await configureStack(engine, [singleElement.value], [STACK_VIEWPORT_ID]);
    } else {
      const elements = gridElements.value.slice(0, gridCount.value);
      if (elements.some((element) => !element)) throw new Error('Grid viewport elements are unavailable.');
      await configureStack(engine, elements as HTMLDivElement[], elements.map((_, index) => `DICOM_GRID_${index}`));
    }
    if (version !== generation) return;
    applyActiveTool();
    applyCameraToggles();
    syncCine();
    ready.value = true;
  } catch (error) {
    engine.destroy();
    throw error;
  }
}

function reset(): void {
  const engine = getRenderingEngine(ENGINE_ID);
  if (!engine) return;
  engine.getViewports().forEach((viewport) => {
    viewport.resetCamera();
    viewport.render();
  });
  updateSliceInfo();
  emit('reset');
}

function scrollToInstance(instanceNumber: number): void {
  const viewport = primaryViewport();
  const series = props.series;
  if (!viewport || !series) return;
  const index = series.slices.findIndex((slice) => slice.instanceNumber === instanceNumber);
  if (index < 0) return;
  void viewport.setImageIdIndex(index).then(() => {
    viewport.render();
    updateSliceInfo();
  });
}

function applyPlan(plan: SelectionPlan): void {
  const viewport = primaryViewport();
  if (!viewport) return;
  viewport.setProperties({ voiRange: { lower: plan.windowCenter - plan.windowWidth / 2, upper: plan.windowCenter + plan.windowWidth / 2 } });
  scrollToInstance(Math.round((plan.sliceRange[0] + plan.sliceRange[1]) / 2));
  viewport.render();
}

function getViewportContext(): ViewportContext | undefined {
  const viewport = primaryViewport();
  const series = props.series;
  if (!viewport || !series) return undefined;
  const index = viewport.getCurrentImageIdIndex();
  const slice = series.slices[index];
  if (!slice) return undefined;
  return {
    currentInstanceNumber: slice.instanceNumber,
    currentZPosition: slice.imagePositionPatient[2],
    seriesNumber: String(series.seriesNumber),
    totalSlicesInSeries: series.slices.length,
  };
}

onMounted(async () => {
  registerTools();
  await rebuild();
});
onBeforeUnmount(() => {
  generation++;
  destroyViewer();
});
watch(() => [props.imageIds, props.layout] as const, () => { void rebuild(); }, { deep: true });
watch(() => props.activeTool, applyActiveTool);
watch(() => props.invert, (invert) => {
  const viewport = primaryViewport();
  if (viewport) {
    viewport.setProperties({ invert });
    viewport.render();
  }
});
watch(() => [props.flipHorizontal, props.flipVertical] as const, applyCameraToggles);
watch(() => props.cineEnabled, syncCine);

defineExpose({ applyPlan, getViewportContext, reset, scrollToInstance });
</script>

<template>
  <section class="relative h-full w-full overflow-hidden bg-black" aria-label="DICOM viewer">
    <div v-if="!ready" class="absolute inset-0 z-10 flex items-center justify-center bg-neutral-950 text-sm text-neutral-500">
      Initializing viewport…
    </div>
    <div v-if="layout === 'mpr'" class="grid h-full grid-cols-2 grid-rows-2 gap-px bg-neutral-800">
      <div v-for="(_, index) in 3" :key="index" class="relative min-h-0 bg-black">
        <div :ref="(element) => setMprElement(index, element)" class="absolute inset-0" />
        <span class="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-neutral-400">{{ ['Axial', 'Sagittal', 'Coronal'][index] }}</span>
      </div>
      <div class="flex items-center justify-center text-xs text-neutral-600">3D reconstruction</div>
    </div>
    <div v-else-if="layout === '1x1'" class="relative h-full">
      <div ref="singleElement" class="absolute inset-0" />
    </div>
    <div v-else :class="['grid h-full gap-px bg-neutral-800', gridClass]">
      <div v-for="(_, index) in gridCount" :key="index" class="relative min-h-0 bg-black">
        <div :ref="(element) => setGridElement(index, element)" class="absolute inset-0" />
      </div>
    </div>
    <div v-if="ready" class="pointer-events-none absolute bottom-2 left-2 rounded bg-black/65 px-2 py-1 text-[10px] text-neutral-400">
      {{ series?.seriesDescription || 'DICOM series' }} · Slice {{ currentSlice }}/{{ totalSlices }}
    </div>
  </section>
</template>
