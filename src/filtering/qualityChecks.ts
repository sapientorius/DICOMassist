import type { StudyMetadata } from '../dicom/types';
import type { SelectionPlan } from '../llm/types';
import type { ExportedSlice } from './SliceExporter';

export interface QualityWarning {
  code: 'scout' | 'duplicate-position' | 'invalid-geometry' | 'low-contrast' | 'fallback-render' | 'limited-coverage';
  severity: 'info' | 'warning';
  message: string;
  seriesNumber?: string;
}

export function inspectPlanQuality(metadata: StudyMetadata, plan: SelectionPlan): QualityWarning[] {
  const warnings: QualityWarning[] = [];
  for (const selection of plan.selections) {
    const series = metadata.series.find((candidate) => String(candidate.seriesNumber) === selection.seriesNumber);
    if (!series) continue;
    if (series.isScout) warnings.push({ code: 'scout', severity: 'warning', seriesNumber: selection.seriesNumber, message: `Series #${selection.seriesNumber} is marked as a scout/localizer.` });
    if (!series.slices.every((slice) => slice.imageId && Number.isFinite(slice.positionAlongNormal ?? slice.imagePositionPatient[2]))) {
      warnings.push({ code: 'invalid-geometry', severity: 'warning', seriesNumber: selection.seriesNumber, message: `Series #${selection.seriesNumber} has incomplete image or position metadata.` });
    }
    const positions = new Set(series.slices.map((slice) => (slice.positionAlongNormal ?? slice.imagePositionPatient[2]).toFixed(3)));
    if (positions.size < series.slices.length) {
      warnings.push({ code: 'duplicate-position', severity: 'warning', seriesNumber: selection.seriesNumber, message: `Series #${selection.seriesNumber} contains duplicate slice positions.` });
    }
    const selectedRange = selection.sliceRange[1] - selection.sliceRange[0] + 1;
    if (selectedRange < Math.ceil(series.slices.length * 0.15) && !selection.coverageGoal) {
      warnings.push({ code: 'limited-coverage', severity: 'info', seriesNumber: selection.seriesNumber, message: `Series #${selection.seriesNumber} covers a narrow range without a stated coverage goal.` });
    }
  }
  return warnings;
}

export function inspectExportQuality(frames: ExportedSlice[]): QualityWarning[] {
  const warnings: QualityWarning[] = [];
  if (frames.some((frame) => frame.contrast < 12)) {
    warnings.push({ code: 'low-contrast', severity: 'warning', message: 'One or more exported images have very low grayscale contrast.' });
  }
  if (frames.some((frame) => frame.renderPath === 'fallback')) {
    warnings.push({ code: 'fallback-render', severity: 'info', message: 'At least one image used the portable display fallback instead of Cornerstone rendering.' });
  }
  return warnings;
}

