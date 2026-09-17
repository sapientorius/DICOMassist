export type AnatomicalPlane = 'axial' | 'sagittal' | 'coronal' | 'oblique';

export type DirectionCosines = [number, number, number, number, number, number];

/** Returns the normalized slice normal derived from Image Orientation (Patient). */
export function sliceNormalFromOrientation(iop: DirectionCosines): [number, number, number] {
  const [rowX, rowY, rowZ, colX, colY, colZ] = iop;
  const normal: [number, number, number] = [
    rowY * colZ - rowZ * colY,
    rowZ * colX - rowX * colZ,
    rowX * colY - rowY * colX,
  ];
  const length = Math.hypot(...normal);
  return length > 0 ? [normal[0] / length, normal[1] / length, normal[2] / length] : [0, 0, 1];
}

export function positionAlongNormal(position: [number, number, number], normal: [number, number, number]): number {
  return position[0] * normal[0] + position[1] * normal[1] + position[2] * normal[2];
}

/**
 * Detect the acquisition plane from Image Orientation Patient (0020,0037).
 *
 * The tag contains 6 direction cosines: [rowX, rowY, rowZ, colX, colY, colZ].
 * The cross product of the row and column vectors gives the slice normal.
 * - Normal mostly along Z → Axial
 * - Normal mostly along X → Sagittal
 * - Normal mostly along Y → Coronal
 */
export function detectPlaneFromOrientation(iop: string | undefined): AnatomicalPlane {
  if (!iop) return 'oblique';

  const parts = iop.split('\\').map(Number);
  if (parts.length < 6 || parts.some(Number.isNaN)) return 'oblique';
  const [nx, ny, nz] = sliceNormalFromOrientation(parts.slice(0, 6) as DirectionCosines).map(Math.abs);
  const dominant = Math.max(nx, ny, nz);

  // A 10° tolerance avoids claiming an anatomical cardinal plane for oblique acquisitions.
  if (dominant < 0.985) return 'oblique';

  if (nz >= nx && nz >= ny) return 'axial';
  if (nx >= ny && nx >= nz) return 'sagittal';
  return 'coronal';
}
