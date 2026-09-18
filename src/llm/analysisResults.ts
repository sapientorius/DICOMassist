import type {
  AdaptiveImageRequest,
  AdaptiveImageRequestSet,
  AdditionalImageRequest,
  EvidenceLedger,
  EvidenceLedgerEntry,
  FinalAnalysis,
  FindingEvidence,
  RenderSpec,
  SeriesSelection,
  StructuredAnalysis,
} from './types';

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text.trim();
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function parseSelection(value: unknown): SeriesSelection | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const range = Array.isArray(raw.sliceRange) ? raw.sliceRange : [];
  const start = Number(range[0]);
  const end = Number(range[1]);
  if (!raw.seriesNumber || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  return {
    seriesNumber: String(raw.seriesNumber),
    role: raw.role === 'supplementary' ? 'supplementary' : 'primary',
    rationale: asString(raw.rationale),
    sliceRange: [start, end],
    samplingStrategy: raw.samplingStrategy === 'every_nth' || raw.samplingStrategy === 'all' ? raw.samplingStrategy : 'uniform',
    samplingParam: Number.isFinite(Number(raw.samplingParam)) ? Number(raw.samplingParam) : undefined,
    windowCenter: Number.isFinite(Number(raw.windowCenter)) ? Number(raw.windowCenter) : 40,
    windowWidth: Number.isFinite(Number(raw.windowWidth)) && Number(raw.windowWidth) > 0 ? Number(raw.windowWidth) : 400,
    coverageGoal: asString(raw.coverageGoal),
  };
}

function parseImageRequest(value: unknown): AdditionalImageRequest {
  if (!value || typeof value !== 'object') return { needed: false, selections: [] };
  const raw = value as Record<string, unknown>;
  const selections = Array.isArray(raw.selections)
    ? raw.selections.map(parseSelection).filter((selection): selection is SeriesSelection => selection !== null)
    : [];
  return {
    needed: raw.needed === true && selections.length > 0,
    reason: asString(raw.reason),
    selections,
  };
}

function parseRenderSpec(value: unknown): RenderSpec | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const label = asString(raw.label) || undefined;
  if (raw.mode === 'dicom-default') return { mode: 'dicom-default', label };
  if (raw.mode === 'window-level') {
    const windowCenter = Number(raw.windowCenter);
    const windowWidth = Number(raw.windowWidth);
    return Number.isFinite(windowCenter) && Number.isFinite(windowWidth) && windowWidth > 0
      ? { mode: 'window-level', windowCenter, windowWidth, label }
      : null;
  }
  if (raw.mode === 'series-percentile') {
    const lowPercentile = Number(raw.lowPercentile);
    const highPercentile = Number(raw.highPercentile);
    return Number.isFinite(lowPercentile) && Number.isFinite(highPercentile) && lowPercentile >= 0 && highPercentile <= 100 && lowPercentile < highPercentile
      ? { mode: 'series-percentile', lowPercentile, highPercentile, label }
      : null;
  }
  if (raw.mode === 'relative-display') {
    const brightness = raw.brightness;
    const contrast = raw.contrast;
    if (!['darker', 'default', 'brighter'].includes(String(brightness)) || !['lower', 'default', 'higher'].includes(String(contrast))) return null;
    return {
      mode: 'relative-display',
      brightness: brightness as 'darker' | 'default' | 'brighter',
      contrast: contrast as 'lower' | 'default' | 'higher',
      label,
    };
  }
  return null;
}

function parseAdaptiveRequest(value: unknown): AdaptiveImageRequest | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const renderings = Array.isArray(raw.renderings) ? raw.renderings.map(parseRenderSpec).filter((rendering): rendering is RenderSpec => rendering !== null) : [];
  if (!renderings.length) return null;
  const priority = Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : undefined;
  if (raw.kind === 'instances') {
    const instanceNumbers = Array.isArray(raw.instanceNumbers)
      ? raw.instanceNumbers.map(Number).filter((number) => Number.isInteger(number))
      : undefined;
    const range = Array.isArray(raw.sliceRange) ? raw.sliceRange.map(Number) : [];
    const sliceRange = Number.isInteger(range[0]) && Number.isInteger(range[1]) ? [range[0], range[1]] as [number, number] : undefined;
    if (!asString(raw.seriesInstanceUID) || (!instanceNumbers?.length && !sliceRange)) return null;
    const samplingStrategy = raw.samplingStrategy === 'every_nth' || raw.samplingStrategy === 'all' ? raw.samplingStrategy : 'uniform';
    const samplingParam = Number.isFinite(Number(raw.samplingParam)) ? Number(raw.samplingParam) : undefined;
    return { kind: 'instances', seriesInstanceUID: asString(raw.seriesInstanceUID), instanceNumbers, sliceRange, samplingStrategy, samplingParam, renderings, priority };
  }
  if (raw.kind === 'neighbours') {
    const sourceImageIndex = Number(raw.sourceImageIndex);
    const before = Number(raw.before);
    const after = Number(raw.after);
    return Number.isInteger(sourceImageIndex) && sourceImageIndex > 0 && Number.isInteger(before) && before >= 0 && Number.isInteger(after) && after >= 0
      ? { kind: 'neighbours', sourceImageIndex, before, after, renderings, priority }
      : null;
  }
  if (raw.kind === 'crop') {
    const sourceImageIndex = Number(raw.sourceImageIndex);
    const rect = Array.isArray(raw.rect) ? raw.rect.map(Number) : [];
    const [left, top, width, height] = rect;
    return Number.isInteger(sourceImageIndex) && sourceImageIndex > 0 && [left, top, width, height].every(Number.isFinite) && left >= 0 && top >= 0 && width > 0 && height > 0 && left + width <= 1 && top + height <= 1
      ? { kind: 'crop', sourceImageIndex, rect: [left, top, width, height], renderings, priority }
      : null;
  }
  if (raw.kind === 'cross-plane') {
    const sourceImageIndex = Number(raw.sourceImageIndex);
    const neighbours = raw.neighbours == null ? undefined : Number(raw.neighbours);
    return Number.isInteger(sourceImageIndex) && sourceImageIndex > 0 && asString(raw.targetSeriesInstanceUID) && (neighbours == null || (Number.isInteger(neighbours) && neighbours >= 0))
      ? { kind: 'cross-plane', sourceImageIndex, targetSeriesInstanceUID: asString(raw.targetSeriesInstanceUID), neighbours, renderings, priority }
      : null;
  }
  return null;
}

function parseAdaptiveRequestSet(value: unknown): AdaptiveImageRequestSet | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  let rawRequests: unknown[] = [];
  if (Array.isArray(raw.requests)) {
    rawRequests = raw.requests;
  } else if (typeof raw.requestsJson === 'string') {
    try {
      const parsed = JSON.parse(raw.requestsJson);
      if (Array.isArray(parsed)) rawRequests = parsed;
    } catch {
      // A malformed deferred request is ignored; it can never trigger retrieval.
    }
  }
  const requests = rawRequests
    .map(parseAdaptiveRequest).filter((request): request is AdaptiveImageRequest => request !== null)
  return requests.length ? { reason: asString(raw.reason, 'Additional image information requested.'), requests } : undefined;
}

function parseFinding(value: unknown): FindingEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const imageIndices = Array.isArray(raw.imageIndices)
    ? raw.imageIndices.map(Number).filter((index) => Number.isInteger(index) && index > 0)
    : [];
  const confidence = raw.confidence === 'definite' || raw.confidence === 'probable' || raw.confidence === 'possible'
    ? raw.confidence
    : 'indeterminate';
  const summary = asString(raw.summary);
  return summary ? { summary, confidence, imageIndices } : null;
}

const MAX_LEDGER_ENTRIES = 12;
const MAX_EVIDENCE_ASSETS_PER_ENTRY = 4;

function parseLedgerEntry(value: unknown): EvidenceLedgerEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = asString(raw.id);
  const summary = asString(raw.summary);
  if (!id || !summary) return null;
  const status = raw.status === 'resolved' || raw.status === 'ruled_out' ? raw.status : 'active';
  const confidence = raw.confidence === 'definite' || raw.confidence === 'probable' || raw.confidence === 'possible'
    ? raw.confidence
    : 'indeterminate';
  const assetIds = Array.isArray(raw.assetIds)
    ? [...new Set(raw.assetIds.map((assetId) => asString(assetId)).filter(Boolean))].slice(0, MAX_EVIDENCE_ASSETS_PER_ENTRY)
    : [];
  return { id, status, summary, confidence, assetIds, openQuestion: asString(raw.openQuestion) || undefined };
}

export function parseEvidenceLedger(value: unknown): EvidenceLedger {
  if (!value || typeof value !== 'object') return { entries: [] };
  const raw = value as Record<string, unknown>;
  let entries: unknown[] = [];
  if (Array.isArray(raw.entries)) entries = raw.entries;
  else if (typeof raw.entriesJson === 'string') {
    try {
      const parsed = JSON.parse(raw.entriesJson);
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      // Invalid model-owned ledger state is ignored rather than becoming trusted state.
    }
  }
  const seen = new Set<string>();
  return {
    entries: entries
      .map(parseLedgerEntry)
      .filter((entry): entry is EvidenceLedgerEntry => entry !== null)
      .filter((entry) => !seen.has(entry.id) && Boolean(seen.add(entry.id)))
      .slice(0, MAX_LEDGER_ENTRIES),
  };
}

/** Parse provider JSON defensively; a plain-text response is preserved as a limitation, never discarded. */
export function parseStructuredAnalysis(rawText: string): StructuredAnalysis {
  try {
    const raw = JSON.parse(extractJson(rawText)) as Record<string, unknown>;
    const findings = Array.isArray(raw.findings)
      ? raw.findings.map(parseFinding).filter((finding): finding is FindingEvidence => finding !== null)
      : [];
    const limitations = Array.isArray(raw.limitations)
      ? raw.limitations.map((value) => asString(value)).filter(Boolean)
      : [];
    const imageRequest = parseAdaptiveRequestSet(raw.imageRequest);
    const legacy = parseImageRequest(raw.additionalImageRequest);
    const evidenceLedger = parseEvidenceLedger(raw.evidenceLedger);
    const nextAction = raw.nextAction === 'request_images' && imageRequest ? 'request_images' : 'complete';
    return {
      summary: asString(raw.summary, 'The model returned no summary.'),
      findings,
      limitations,
      evidenceLedger,
      nextAction,
      imageRequest,
      additionalImageRequest: legacy,
    };
  } catch {
    return {
      summary: rawText.trim() || 'The model returned no analysis.',
      findings: [],
      limitations: ['The provider did not return the requested structured analysis format.'],
      evidenceLedger: { entries: [] },
      nextAction: 'complete',
      additionalImageRequest: { needed: false, selections: [] },
    };
  }
}

/** Final synthesis deliberately omits retrieval controls and ledger state. */
export function parseFinalAnalysis(rawText: string): FinalAnalysis {
  try {
    const raw = JSON.parse(extractJson(rawText)) as Record<string, unknown>;
    const findings = Array.isArray(raw.findings)
      ? raw.findings.map(parseFinding).filter((finding): finding is FindingEvidence => finding !== null)
      : [];
    const limitations = Array.isArray(raw.limitations)
      ? raw.limitations.map((value) => asString(value)).filter(Boolean)
      : [];
    return { summary: asString(raw.summary, 'The model returned no summary.'), findings, limitations };
  } catch {
    throw new Error('The provider did not return the requested structured final analysis format.');
  }
}

export function formatStructuredAnalysis(analysis: StructuredAnalysis, imageLabels: string[]): string {
  const lines = ['## Analysis', '', analysis.summary];
  if (analysis.findings.length) {
    lines.push('', '### Findings');
    for (const finding of analysis.findings) {
      const references = finding.imageIndices
        .map((index) => imageLabels[index - 1] ? `Image ${index} (${imageLabels[index - 1]})` : `Image ${index}`)
        .join('; ');
      lines.push(`- **${finding.confidence}** — ${finding.summary}${references ? ` _[${references}]_` : ''}`);
    }
  }
  if (analysis.limitations.length) {
    lines.push('', '### Limitations');
    for (const limitation of analysis.limitations) lines.push(`- ${limitation}`);
  }
  lines.push('', 'Not for clinical diagnosis');
  return lines.join('\n');
}

export function formatFinalAnalysis(analysis: FinalAnalysis, imageLabels: string[]): string {
  return formatStructuredAnalysis({
    ...analysis,
    evidenceLedger: { entries: [] },
    nextAction: 'complete',
    additionalImageRequest: { needed: false, selections: [] },
  }, imageLabels);
}
