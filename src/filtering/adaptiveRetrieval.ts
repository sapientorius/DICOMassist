import type { SeriesMetadata, SliceMetadata, StudyMetadata } from '../dicom/types';
import type { AdaptiveImageRequest, NormalizedCrop, RenderSpec } from '../llm/types';
import type { SelectedSlice } from './types';

export interface AdaptiveSourceImage {
  imageIndex: number;
  kind: 'slice' | 'montage';
  imageId?: string;
  instanceNumber?: number;
  seriesInstanceUID?: string;
  patientPoint?: [number, number, number];
}

export interface ResolvedAdaptiveImage {
  series: SeriesMetadata;
  slice: SelectedSlice;
  renderings: RenderSpec[];
  crop?: NormalizedCrop;
  requestKind: AdaptiveImageRequest['kind'];
}

function asSelected(slice: SliceMetadata, series: SeriesMetadata): SelectedSlice {
  return {
    imageId: slice.imageId,
    instanceNumber: slice.instanceNumber,
    sliceLocation: slice.sliceLocation,
    zPosition: slice.positionAlongNormal ?? slice.imagePositionPatient[series.anatomicalPlane === 'sagittal' ? 0 : series.anatomicalPlane === 'coronal' ? 1 : 2],
  };
}

function ordered(series: SeriesMetadata): SliceMetadata[] {
  return [...series.slices].sort((left, right) => (left.positionAlongNormal ?? left.instanceNumber) - (right.positionAlongNormal ?? right.instanceNumber));
}

function sample(slices: SliceMetadata[], strategy: 'every_nth' | 'uniform' | 'all' = 'all', param?: number): SliceMetadata[] {
  if (strategy === 'all' || slices.length < 2) return slices;
  if (strategy === 'every_nth') return slices.filter((_, index) => index % Math.max(1, Math.round(param ?? 1)) === 0);
  const count = Math.min(slices.length, Math.max(1, Math.round(param ?? slices.length)));
  if (count >= slices.length) return slices;
  return Array.from({ length: count }, (_, index) => slices[Math.round((index * (slices.length - 1)) / Math.max(1, count - 1))]);
}

function sourceSlice(study: StudyMetadata, source: AdaptiveSourceImage): { series: SeriesMetadata; slice: SliceMetadata } | null {
  if (source.kind !== 'slice' || !source.imageId || !source.seriesInstanceUID) return null;
  const series = study.series.find((candidate) => candidate.seriesInstanceUID === source.seriesInstanceUID);
  const slice = series?.slices.find((candidate) => candidate.imageId === source.imageId || candidate.instanceNumber === source.instanceNumber);
  return series && slice ? { series, slice } : null;
}

function nearestCrossPlaneSlices(series: SeriesMetadata, point: [number, number, number], neighbours: number): SliceMetadata[] {
  const slices = ordered(series);
  if (!slices.length) return [];
  const normal = series.sliceNormal;
  const projectedPoint = point[0] * normal[0] + point[1] * normal[1] + point[2] * normal[2];
  let nearest = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  slices.forEach((slice, index) => {
    const position = slice.positionAlongNormal ?? (slice.imagePositionPatient[0] * normal[0] + slice.imagePositionPatient[1] * normal[1] + slice.imagePositionPatient[2] * normal[2]);
    const distance = Math.abs(position - projectedPoint);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  });
  return slices.slice(Math.max(0, nearest - neighbours), Math.min(slices.length, nearest + neighbours + 1));
}

/** Resolve untrusted model requests against locally loaded study geometry. */
export function resolveAdaptiveImageRequests(
  study: StudyMetadata,
  requests: AdaptiveImageRequest[],
  sources: AdaptiveSourceImage[],
): ResolvedAdaptiveImage[] {
  const sourceByIndex = new Map(sources.map((source) => [source.imageIndex, source]));
  const resolved: ResolvedAdaptiveImage[] = [];
  const prioritized = [...requests].sort((left, right) => (left.priority ?? 100) - (right.priority ?? 100));

  for (const request of prioritized) {
    if (request.kind === 'instances') {
      const series = study.series.find((candidate) => candidate.seriesInstanceUID === request.seriesInstanceUID);
      if (!series || series.isScout) continue;
      const candidates = request.instanceNumbers?.length
        ? ordered(series).filter((slice) => request.instanceNumbers?.includes(slice.instanceNumber))
        : ordered(series).filter((slice) => {
          const [start, end] = request.sliceRange ?? series.instanceNumberRange;
          return slice.instanceNumber >= Math.min(start, end) && slice.instanceNumber <= Math.max(start, end);
        });
      for (const slice of sample(candidates, request.samplingStrategy, request.samplingParam)) {
        resolved.push({ series, slice: asSelected(slice, series), renderings: request.renderings, requestKind: request.kind });
      }
      continue;
    }

    const source = sourceByIndex.get(request.sourceImageIndex);
    const resolvedSource = source ? sourceSlice(study, source) : null;
    if (!source || !resolvedSource) continue;
    if (request.kind === 'neighbours') {
      const slices = ordered(resolvedSource.series);
      const sourceIndex = slices.findIndex((slice) => slice.imageId === resolvedSource.slice.imageId);
      if (sourceIndex < 0) continue;
      for (const slice of slices.slice(Math.max(0, sourceIndex - request.before), Math.min(slices.length, sourceIndex + request.after + 1))) {
        resolved.push({ series: resolvedSource.series, slice: asSelected(slice, resolvedSource.series), renderings: request.renderings, requestKind: request.kind });
      }
      continue;
    }
    if (request.kind === 'crop') {
      resolved.push({ series: resolvedSource.series, slice: asSelected(resolvedSource.slice, resolvedSource.series), renderings: request.renderings, crop: { rect: request.rect }, requestKind: request.kind });
      continue;
    }
    const target = study.series.find((candidate) => candidate.seriesInstanceUID === request.targetSeriesInstanceUID);
    if (!target || target.isScout || !source.patientPoint) continue;
    for (const slice of nearestCrossPlaneSlices(target, source.patientPoint, Math.max(0, request.neighbours ?? 0))) {
      resolved.push({ series: target, slice: asSelected(slice, target), renderings: request.renderings, requestKind: request.kind });
    }
  }
  return resolved;
}

