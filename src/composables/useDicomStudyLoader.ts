import { ref } from 'vue';
import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';
import dicomParser from 'dicom-parser';
import type { AnatomicalPlane } from '../dicom/orientationUtils';
import { buildStudyMetadata, extractFileMetadata, type RawFileRecord } from '../dicom/MetadataExtractor';
import type { StudyMetadata } from '../dicom/types';

export interface LoadResult {
  imageIds: string[];
  primaryAxis: AnatomicalPlane | 'oblique';
  studyMetadata: StudyMetadata;
}

interface FileEntry {
  isFile: boolean;
  isDirectory: boolean;
  file?: (successCallback: (file: File) => void, errorCallback?: (error: DOMException) => void) => void;
  createReader?: () => { readEntries: (successCallback: (entries: FileEntry[]) => void, errorCallback?: (error: DOMException) => void) => void };
}

const PARSE_BATCH_SIZE = 20;

function looksLikeDicom(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.dcm') || !name.includes('.');
}

function hasDicomPreamble(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 132) return false;
  const view = new Uint8Array(buffer, 128, 4);
  return view[0] === 0x44 && view[1] === 0x49 && view[2] === 0x43 && view[3] === 0x4d;
}

async function entryFile(entry: FileEntry): Promise<File> {
  if (!entry.file) throw new Error('The browser could not read this dropped file.');
  return new Promise<File>((resolve, reject) => entry.file?.(resolve, reject));
}

async function readDirectory(entry: FileEntry): Promise<FileEntry[]> {
  if (!entry.createReader) return [];
  const reader = entry.createReader();
  const entries: FileEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

export async function filesFromDrop(dataTransfer: DataTransfer): Promise<File[]> {
  const roots: FileEntry[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry as unknown as FileEntry);
  }
  if (roots.length === 0) return Array.from(dataTransfer.files).filter(looksLikeDicom);

  const files: File[] = [];
  async function visit(entry: FileEntry): Promise<void> {
    if (entry.isFile) {
      const file = await entryFile(entry);
      if (looksLikeDicom(file)) files.push(file);
      return;
    }
    if (entry.isDirectory) {
      for (const child of await readDirectory(entry)) await visit(child);
    }
  }
  for (const root of roots) await visit(root);
  return files;
}

async function parseFile(file: File): Promise<{ file: File; meta: Omit<RawFileRecord, 'imageId'> } | null> {
  try {
    const header = await file.slice(0, 131_072).arrayBuffer();
    if (!file.name.toLowerCase().endsWith('.dcm') && !hasDicomPreamble(header)) return null;
    const dataSet = dicomParser.parseDicom(new Uint8Array(header), { untilTag: 'x7fe00010' });
    return { file, meta: extractFileMetadata(dataSet) };
  } catch {
    try {
      const contents = await file.arrayBuffer();
      if (!file.name.toLowerCase().endsWith('.dcm') && !hasDicomPreamble(contents)) return null;
      const dataSet = dicomParser.parseDicom(new Uint8Array(contents), { untilTag: 'x7fe00010' });
      return { file, meta: extractFileMetadata(dataSet) };
    } catch {
      return null;
    }
  }
}

export function useDicomStudyLoader() {
  const loading = ref(false);
  const phase = ref<'idle' | 'reading' | 'sorting' | 'error'>('idle');
  const progress = ref({ loaded: 0, total: 0 });
  const error = ref<string | null>(null);

  async function loadFiles(files: File[]): Promise<LoadResult | null> {
    if (files.length === 0) return null;
    loading.value = true;
    phase.value = 'reading';
    error.value = null;
    progress.value = { loaded: 0, total: files.length };
    try {
      const parsed: Array<{ file: File; meta: Omit<RawFileRecord, 'imageId'> }> = [];
      for (let start = 0; start < files.length; start += PARSE_BATCH_SIZE) {
        const batch = await Promise.all(files.slice(start, start + PARSE_BATCH_SIZE).map(parseFile));
        parsed.push(...batch.filter((result): result is { file: File; meta: Omit<RawFileRecord, 'imageId'> } => result !== null));
        progress.value = { loaded: Math.min(start + PARSE_BATCH_SIZE, files.length), total: files.length };
      }
      if (parsed.length === 0) throw new Error('No readable DICOM image files were found.');
      phase.value = 'sorting';
      const records: RawFileRecord[] = parsed.map(({ file, meta }) => ({
        ...meta,
        imageId: cornerstoneDICOMImageLoader.wadouri.fileManager.add(file),
      }));
      const studyMetadata = buildStudyMetadata(records);
      const primary = studyMetadata.series.find((series) => series.seriesInstanceUID === studyMetadata.primarySeriesUID);
      if (!primary) throw new Error('No renderable image series was found in the selected files.');
      return {
        imageIds: primary.slices.map((slice) => slice.imageId),
        primaryAxis: primary.anatomicalPlane,
        studyMetadata,
      };
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Unable to load the selected files.';
      phase.value = 'error';
      return null;
    } finally {
      loading.value = false;
      if (phase.value !== 'error') phase.value = 'idle';
    }
  }

  return { loading, phase, progress, error, loadFiles };
}
