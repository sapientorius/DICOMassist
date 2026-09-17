import type { SeriesMetadata, StudyMetadata } from '../../dicom/types';

export function makeSeries(overrides: Partial<SeriesMetadata> = {}): SeriesMetadata {
  const slices = overrides.slices ?? Array.from({ length: 30 }, (_, index) => ({
    instanceNumber: index + 1,
    imagePositionPatient: [0, 0, index] as [number, number, number],
    imageOrientationPatient: [1, 0, 0, 0, 1, 0] as [number, number, number, number, number, number],
    positionAlongNormal: index,
    imageId: `image-${index + 1}`,
  }));
  return {
    seriesInstanceUID: 'series-1', seriesNumber: 1, seriesDescription: 'Axial soft tissue', modality: 'CT',
    anatomicalPlane: 'axial', sliceNormal: [0, 0, 1], isScout: false, priorityScore: 10,
    zMin: 0, zMax: slices.length - 1, zCoverageInMm: slices.length - 1,
    instanceNumberRange: [slices[0].instanceNumber, slices.at(-1)?.instanceNumber ?? slices[0].instanceNumber],
    slices,
    ...overrides,
  };
}

export function makeStudy(series: SeriesMetadata[] = [makeSeries()]): StudyMetadata {
  return { studyDescription: 'Test study', modality: 'CT', primarySeriesUID: series[0].seriesInstanceUID, series };
}
