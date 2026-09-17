import type { AdditionalImageRequest, FindingEvidence, SeriesSelection, StructuredAnalysis } from './types';

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
    return {
      summary: asString(raw.summary, 'The model returned no summary.'),
      findings,
      limitations,
      additionalImageRequest: parseImageRequest(raw.additionalImageRequest),
    };
  } catch {
    return {
      summary: rawText.trim() || 'The model returned no analysis.',
      findings: [],
      limitations: ['The provider did not return the requested structured analysis format.'],
      additionalImageRequest: { needed: false, selections: [] },
    };
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

