import { describe, expect, it } from 'vitest';
import { makeSeries, makeStudy } from '../test/fixtures/study';
import { resolveAdaptiveImageRequests } from './adaptiveRetrieval';

const renderings = [{ mode: 'dicom-default' as const }];

describe('adaptive image retrieval', () => {
  it('resolves explicit instances, neighbouring slices, crops, and native cross-plane requests', () => {
    const primary = makeSeries({ seriesInstanceUID: 'primary', seriesNumber: 1 });
    const target = makeSeries({ seriesInstanceUID: 'target', seriesNumber: 2 });
    const study = makeStudy([primary, target]);
    const sources = [{ imageIndex: 1, kind: 'slice' as const, imageId: 'image-11', instanceNumber: 11, seriesInstanceUID: 'primary', patientPoint: [0, 0, 10] as [number, number, number] }];

    const resolved = resolveAdaptiveImageRequests(study, [
      { kind: 'instances', seriesInstanceUID: 'primary', instanceNumbers: [2, 4], renderings },
      { kind: 'neighbours', sourceImageIndex: 1, before: 1, after: 1, renderings },
      { kind: 'crop', sourceImageIndex: 1, rect: [0.1, 0.2, 0.5, 0.5], renderings },
      { kind: 'cross-plane', sourceImageIndex: 1, targetSeriesInstanceUID: 'target', neighbours: 1, renderings },
    ], sources);

    expect(resolved.filter((item) => item.requestKind === 'instances').map((item) => item.slice.instanceNumber)).toEqual([2, 4]);
    expect(resolved.filter((item) => item.requestKind === 'neighbours').map((item) => item.slice.instanceNumber)).toEqual([10, 11, 12]);
    expect(resolved.find((item) => item.requestKind === 'crop')?.crop).toEqual({ rect: [0.1, 0.2, 0.5, 0.5] });
    expect(resolved.filter((item) => item.requestKind === 'cross-plane').map((item) => item.slice.instanceNumber)).toEqual([10, 11, 12]);
  });

  it('ignores unknown series, montages, and invalid source references', () => {
    const study = makeStudy();
    const resolved = resolveAdaptiveImageRequests(study, [
      { kind: 'instances', seriesInstanceUID: 'missing', instanceNumbers: [1], renderings },
      { kind: 'crop', sourceImageIndex: 1, rect: [0, 0, 1, 1], renderings },
    ], [{ imageIndex: 1, kind: 'montage' }]);
    expect(resolved).toEqual([]);
  });
});
