import type { StudyMetadata, SeriesMetadata } from '../dicom/types';
import type { AnalysisRequestContext, SelectionPlan, ViewportContext } from './types';
import type { AnalysisSettings } from './analysisConfig';

const DISCLAIMER =
  'IMPORTANT: This is a research/portfolio tool, NOT for clinical diagnosis. ' +
  'All findings are for educational and demonstration purposes only.';

function formatSeriesSummary(s: SeriesMetadata): string {
  const parts = [
    `Series #${s.seriesNumber}: "${s.seriesDescription || '(no description)'}"`,
    `Plane: ${s.anatomicalPlane}`,
    `${s.slices.length} slices (instance ${s.instanceNumberRange[0]}–${s.instanceNumberRange[1]})`,
  ];
  if (s.zCoverageInMm > 0) {
    parts.push(`z-coverage: ${s.zCoverageInMm.toFixed(1)}mm (z=${s.zMin.toFixed(1)} to ${s.zMax.toFixed(1)})`);
  }
  if (s.sliceThickness != null) parts.push(`thickness: ${s.sliceThickness}mm`);
  if (s.convolutionKernel) parts.push(`kernel: ${s.convolutionKernel}`);
  if (s.windowCenter != null && s.windowWidth != null) {
    parts.push(`preset W/L: W=${Math.round(s.windowWidth)} C=${Math.round(s.windowCenter)}`);
  }
  if (s.rows != null && s.columns != null) {
    let matrixStr = `matrix: ${s.rows}×${s.columns}`;
    if (s.pixelSpacing) matrixStr += ` @ ${s.pixelSpacing[0].toFixed(2)}×${s.pixelSpacing[1].toFixed(2)}mm`;
    parts.push(matrixStr);
  }
  if (s.estimatedWeighting) {
    let mriStr = s.estimatedWeighting;
    if (s.repetitionTime != null && s.echoTime != null) {
      mriStr += ` (TR:${Math.round(s.repetitionTime)} TE:${Math.round(s.echoTime)})`;
    }
    parts.push(mriStr);
  }
  if (s.kvp != null) {
    let ctStr = `${s.kvp}kV`;
    if (s.xrayTubeCurrent != null) ctStr += ` ${s.xrayTubeCurrent}mA`;
    parts.push(ctStr);
  }
  return parts.join(' | ');
}

function formatMetadataSummary(metadata: StudyMetadata): string {
  const lines: string[] = [
    '=== STUDY INFORMATION ===',
    `Study: ${metadata.studyDescription}`,
    `Modality: ${metadata.modality}`,
  ];
  if (metadata.bodyPartExamined) lines.push(`Body Part: ${metadata.bodyPartExamined} (note: ~15% error rate on this tag)`);
  if (metadata.patientAge) lines.push(`Patient Age: ${metadata.patientAge}`);
  if (metadata.patientSex) lines.push(`Patient Sex: ${metadata.patientSex}`);
  if (metadata.studyDate) {
    const d = metadata.studyDate;
    lines.push(`Study Date: ${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
  }
  if (metadata.institutionName) lines.push(`Institution: ${metadata.institutionName}`);
  // Scanner line: compose from manufacturer, model, and field strength
  const scannerParts: string[] = [];
  if (metadata.manufacturer) scannerParts.push(metadata.manufacturer.trim());
  if (metadata.manufacturerModelName) scannerParts.push(metadata.manufacturerModelName.trim());
  const mrSeries = metadata.series.find((s) => s.modality === 'MR' && s.magneticFieldStrength);
  if (mrSeries?.magneticFieldStrength) scannerParts.push(`${mrSeries.magneticFieldStrength}T`);
  if (scannerParts.length > 0) lines.push(`Scanner: ${scannerParts.join(' ')}`);

  lines.push('', `=== AVAILABLE SERIES (${metadata.series.length}) ===`);
  for (const s of metadata.series) {
    lines.push(formatSeriesSummary(s));
  }

  return lines.join('\n');
}

export function buildSelectionSystemPrompt(settings?: AnalysisSettings): string {
  const imageBudget = settings?.maxImages ?? 20;
  return [
    'You are a medical imaging AI assistant that helps select the most relevant DICOM slices for clinical analysis.',
    DISCLAIMER,
    '',
    '## Clinical Series Selection Guide',
    '',
    'When selecting the PRIMARY series for analysis, reason about which orientation',
    'and weighting is diagnostically standard for the clinical question:',
    '',
    '**Knee MRI:**',
    '- ACL/PCL tears → Sagittal PD fat-sat (primary), Coronal PD fat-sat (supplementary)',
    '- Meniscal tears → Sagittal PD fat-sat (primary), Coronal for body/root tears',
    '- Cartilage → Sagittal PD fat-sat or T2 mapping',
    '- Bone marrow edema → Any plane with fat-sat (STIR or PD-FS)',
    '',
    '**Brain MRI:**',
    '- Stroke → DWI/ADC (primary), FLAIR (supplementary)',
    '- Tumor → T1 post-contrast (primary), FLAIR, T2',
    '',
    '**Spine MRI:**',
    '- Disc herniation → Sagittal T2 (primary), Axial T2 at level of interest',
    '- Cord compression → Sagittal T2 (primary)',
    '',
    '**CT (any body part):**',
    '- Soft tissue evaluation → Soft tissue kernel, W:400 C:40',
    '- Lung evaluation → Lung kernel, W:1500 C:-600',
    '- Bone evaluation → Bone kernel, W:2000 C:400',
    '- Liver/abdomen → Soft tissue, portal venous phase if available',
    '',
    '**General rules:**',
    '- Fat-suppressed sequences (FS, STIR) highlight pathology better than non-FS',
    '- Higher resolution series (smaller pixel spacing) are preferred when available',
    '- PD-weighted fat-sat is the workhorse for musculoskeletal pathology',
    '- T1 is best for anatomy, T2/PD-FS is best for pathology detection',
    '- Choose the series where the structure of interest is BEST visualized,',
    '  not necessarily the series with the most slices',
    '- If the clinical question doesn\'t clearly map to a specific orientation, prefer',
    '  the series with the most slices in a standard orientation (axial for CT,',
    '  sagittal for knee/spine MRI)',
    '',
    '## Slice Range Selection',
    '',
    'Do NOT default to selecting the entire series. Reason about WHERE in the series',
    'the relevant anatomy is located:',
    '- For sagittal knee views: The ACL, PCL, and central structures are in the',
    '  MIDDLE THIRD of slices (roughly slices 13-26 of a 39-slice series)',
    '- For axial views: Select the range covering the anatomical region of interest',
    '- For spine sagittal: Select slices centered on the relevant vertebral levels',
    '',
    'Use a two-part strategy: first keep enough evenly spaced overview slices to prove',
    'anatomical coverage; then assign denser focal slices only where the clinical',
    'question or a referenced current view warrants detail. The vision model analyzes',
    'each image — sending irrelevant slices dilutes the analysis quality.',
    '',
    'If you\'re unsure of the exact range, select the middle 50-70% of the series',
    'rather than the full range.',
    '',
    '## OUTPUT CONSTRAINTS (MANDATORY)',
    '',
    '- You may select 1 PRIMARY series and 0-2 SUPPLEMENTARY series',
    `- The total rendered images across ALL series and display windows MUST be ≤ ${imageBudget}`,
    '- If a range contains more slices than the budget, use a sampling strategy to reduce',
    '- The samplingParam in "uniform" mode means "select exactly this many slices',
    '  evenly spaced across the range"',
    '- NEVER set samplingStrategy to "all" if the range exceeds the per-series budget',
    '- Scout / localizer series (very few slices, large spacing) should NEVER be selected',
    '- Only add supplementary series when they provide genuinely different diagnostic',
    '  information (different plane, different weighting, different phase)',
    '- For CT, you may add a second display window only when it adds distinct information',
    '  (for example soft tissue plus lung or bone). Count each windowed rendering in the total budget.',
    '',
    '## Output Format',
    '',
    'Output a JSON object (no markdown fences) with these exact fields:',
    '- reasoning: string — explain: why these series, why these ranges, why this windowing',
    '- selections: array of objects, each with:',
    '    - seriesNumber: string — the Series Number (e.g. "3")',
    '    - role: "primary" | "supplementary"',
    '    - rationale: string — why this specific series is included',
    '    - sliceRange: [number, number] — inclusive instance number range [start, end]',
    '    - samplingStrategy: "uniform" | "every_nth" | "all"',
    '    - samplingParam: number — for "uniform": exact count. For "every_nth": step size. Omit for "all".',
    '    - windowCenter: number',
    '    - windowWidth: number',
    '    - coverageGoal: string — anatomy or diagnostic uncertainty this selection covers',
    '    - displayWindows: array of additional {label, windowCenter, windowWidth} renderings (use [] when none)',
    `- totalImages: number — sum of all rendered slices/windows (must be ≤ ${imageBudget})`,
    '',
    'The first element in selections MUST be the primary series (role: "primary").',
    'Output ONLY the JSON object, no other text.',
  ].join('\n');
}

const SPATIAL_KEYWORDS = [
  'this slice', 'current slice', 'current view', 'this view',
  'what am i looking at', 'what is this', 'this area', 'right here',
  'this structure', 'this region', 'where i am',
];

export function buildSelectionUserPrompt(metadata: StudyMetadata, clinicalHint: string, viewportContext?: ViewportContext): string {
  const lines = [
    formatMetadataSummary(metadata),
    '',
  ];

  // Only include viewport context when the user explicitly references their current view
  if (viewportContext) {
    const hintLower = clinicalHint.toLowerCase();
    const referencesViewport = SPATIAL_KEYWORDS.some((kw) => hintLower.includes(kw));
    if (referencesViewport) {
      lines.push('=== CURRENT VIEWPORT POSITION ===');
      lines.push(`The user is currently viewing Series #${viewportContext.seriesNumber}, slice #${viewportContext.currentInstanceNumber} of ${viewportContext.totalSlicesInSeries} (z=${viewportContext.currentZPosition.toFixed(1)}mm).`);
      lines.push('The user is referencing their current view — center your slice selection around this position.');
      lines.push('');
    }
  }

  lines.push('=== CLINICAL QUESTION ===');
  lines.push(clinicalHint);
  lines.push('');
  lines.push('Based on the available series and the clinical question, provide your slice selection plan as a JSON object.');

  return lines.join('\n');
}

export function buildStandardResponseFormat(): string[] {
  return [
    '## RESPONSE FORMAT',
    '',
    '# [Modality] [Body Part] Analysis — [Clinical Question]',
    '',
    'DISCLAIMER: This is an educational analysis only and NOT a clinical diagnosis.',
    'All findings must be verified by a board-certified radiologist before any',
    'clinical decision-making.',
    '',
    '---',
    '',
    'SUMMARY',
    '[2-3 sentences. State the main finding with confidence level. If no clear',
    'pathology is identified, say so directly. If findings are equivocal, say so.]',
    '',
    'Conclusion: [One sentence definitive statement]',
    '',
    '---',
    '',
    'FINDINGS',
    '',
    '### [Primary Clinical Question]',
    '- [Finding with slice reference and confidence level]',
    '',
    '### Additional Observations',
    '- [Only findings clearly visible on images]',
    '',
    '### Limitations',
    '- Analyzed [X] of [Y] total slices in this series',
    '- [Any structures not adequately visualized]',
    '- [Any additional series that would help clarify findings]',
    '',
    '---',
    'Not for clinical diagnosis',
  ];
}

export function buildSurveyResponseFormat(): string[] {
  return [
    '## RESPONSE FORMAT',
    '',
    '# [Modality] [Body Part] Systematic Survey',
    '',
    'DISCLAIMER: This is an educational analysis only and NOT a clinical diagnosis.',
    'All findings must be verified by a board-certified radiologist before any',
    'clinical decision-making.',
    '',
    '---',
    '',
    '## SUMMARY',
    '[2-3 sentences overview of overall impression. Highlight the most significant',
    'finding(s) if any, or state that no definite abnormality is identified.]',
    '',
    '---',
    '',
    '## STRUCTURE-BY-STRUCTURE ASSESSMENT',
    '',
    'For each structure requested in the clinical question, provide a subsection:',
    '',
    '### [Structure Name]',
    '**Assessment:** Normal / Abnormal / Not adequately visualized',
    '- [Detailed finding with slice reference and confidence level]',
    '- [If normal, briefly state what normal appearance was confirmed on which slices]',
    '- [If not visualized, explain why and what additional imaging would help]',
    '',
    '(Repeat for each structure in the clinical question)',
    '',
    '---',
    '',
    '## ADDITIONAL FINDINGS',
    '- [Any incidental findings not covered by the requested structures]',
    '- [If none, state "No additional findings noted on the provided images."]',
    '',
    '## LIMITATIONS',
    '- Analyzed [X] of [Y] total slices in this series',
    '- [Any structures not adequately visualized and why]',
    '- [Any additional series/sequences that would improve assessment]',
    '',
    '---',
    'Not for clinical diagnosis',
  ];
}

export function buildAnalysisSystemPrompt(
  surveyMode?: boolean,
  refinement?: Pick<AnalysisRequestContext, 'refinementRound' | 'remainingRefinementRounds' | 'remainingImageBudget' | 'maxNewImages'>,
): string {
  return [
    'You are a medical imaging AI assistant analyzing DICOM images.',
    DISCLAIMER,
    '',
    'Analyze the provided images in the context of the clinical question and study metadata.',
    '',
    '## USER-FACING, STANDALONE SYNTHESIS',
    'Your response may be the ONLY analysis the user sees from a multi-round image-retrieval workflow.',
    'Treat EVERY image in the delivered image manifest as one cumulative image set and write a complete, standalone',
    'assessment of that set. Restate all material findings, relevant negative findings, and limitations directly.',
    'Do NOT refer to a "previous response", "previous round", "earlier assessment", "prior evaluation",',
    '"additional images", "newly added images", or findings being "unchanged" or "confirmed". The user cannot see',
    'intermediate model responses. Do not imply that the reader has seen them either.',
    'If different renderings or targeted slices corroborate a finding, state the final finding and cite the relevant',
    'images; do not describe the internal retrieval sequence. For example, write "Focal signal alteration is visible…",',
    'not "Additional images confirm the prior finding".',
    '',
    '## CRITICAL ANALYSIS RULES',
    '',
    '1. ONLY report findings you can clearly visualize on the provided images.',
    '   If you cannot see a structure clearly, say "not adequately visualized"',
    '   rather than guessing.',
    '',
    '2. For each finding, you MUST reference the specific slice(s) where you',
    '   see the finding. If you cannot point to a specific slice, do not',
    '   report the finding.',
    '',
    '3. Distinguish between definite, probable, and possible findings:',
    '   - DEFINITE: Clearly visible on images (e.g., "Complete fiber discontinuity',
    '     visible on slices 17-20")',
    '   - PROBABLE: Likely present but not unambiguous (e.g., "Probable partial',
    '     tear — signal abnormality on slice 18, but limited by slice sampling")',
    '   - POSSIBLE: Cannot confirm or exclude (e.g., "Possible meniscal tear —',
    '     cannot adequately assess on provided slices")',
    '',
    '4. If the provided slices do not adequately cover a structure, state this',
    '   explicitly rather than making assumptions. Example: "The lateral meniscus',
    '   is not well-visualized on the provided sagittal slices — coronal images',
    '   would be needed for adequate assessment."',
    '',
    '5. Always include a LIMITATIONS section noting:',
    '   - How many slices were analyzed out of the total series',
    '   - Any structures that could not be adequately assessed',
    '   - That this is a sample of the full dataset',
    '',
    '6. Do NOT fabricate normal findings just to be thorough. If you only',
    '   see the ACL clearly, only comment on the ACL. Don\'t add "PCL appears',
    '   intact" unless you can actually see it on the provided slices.',
    '',
    '7. When in doubt, err on the side of "cannot determine" rather than',
    '   making a definitive call. False confidence is worse than admitted',
    '   uncertainty.',
    '',
    ...(surveyMode ? [
      'Perform the requested structure-by-structure survey, but only for structures',
      'that are actually visible in the supplied images.',
    ] : []),
    '',
    '## OUTPUT FORMAT (MANDATORY)',
    'Return ONLY a JSON object with these fields:',
    '- nextAction: "request_images" | "complete"',
    '- summary: string',
    '- findings: array of {summary, confidence: "definite"|"probable"|"possible"|"indeterminate", imageIndices: number[]}',
    '- limitations: string[]',
    '- imageRequest: null when nextAction is "complete"; otherwise {reason, requestsJson}.',
    '- requestsJson is a JSON-encoded string containing the requests array (no markdown or prose inside the string).',
    'Each request has a kind, renderings, and optional priority. Supported kinds are:',
    '- instances: seriesInstanceUID plus instanceNumbers or sliceRange, with optional samplingStrategy and samplingParam.',
    '- neighbours: sourceImageIndex plus before and after counts.',
    '- crop: sourceImageIndex plus rect [left,top,width,height] in 0–1 image coordinates.',
    '- cross-plane: sourceImageIndex plus targetSeriesInstanceUID and optional neighbours.',
    'renderings is one or more of: dicom-default; window-level with windowCenter/windowWidth;',
    'series-percentile with lowPercentile/highPercentile; or relative-display with brightness',
    '(darker/default/brighter) and contrast (lower/default/higher). Every rendering counts against the image budget.',
    '',
    '## FINALITY GATE — APPLY BEFORE CHOOSING nextAction',
    'Choosing "complete" is a positive assertion that the delivered images are sufficient to answer the clinical question',
    'at the level supported by this study. It is NOT a fallback simply because you can write a cautious or limited report.',
    'Before choosing "complete", verify ALL of the following:',
    '- The clinically relevant anatomy and any suspected abnormality have adequate image coverage.',
    '- You can determine whether an apparent finding continues, resolves, or is an artefact on adjacent slices.',
    '- No available alternate plane, sequence, series, crop, or display rendering is needed to answer a material uncertainty.',
    '- Every remaining limitation is inherent to the acquired study, not caused by sparse sampling or missing delivered images.',
    'If ANY check fails and image slots/rounds remain, you MUST set nextAction to "request_images".',
    'Do not put "too few images", "limited by sampling", "not adequately visualized", "cannot assess",',
    '"would need coronal/axial/adjacent images", or an equivalent coverage limitation in limitations together with',
    'nextAction "complete" when the local series catalog contains a plausible image request and capacity remains.',
    'Instead, state the uncertainty briefly in summary and issue the smallest targeted request that resolves it.',
    '',
    '## HOW TO REQUEST IMAGES',
    'Use a concrete, executable request — never merely describe the images you wish you had.',
    '- To establish continuity or exclude an artefact, use neighbours with the 1-based sourceImageIndex from the delivered image manifest.',
    '- To broaden coverage, use instances with a seriesInstanceUID from the full local series catalog and an exact instanceNumbers list or sliceRange.',
    '- To inspect a small ambiguous region, use crop with the 1-based sourceImageIndex and a normalized rect.',
    '- To confirm a finding in another orientation/sequence, use cross-plane with the sourceImageIndex and targetSeriesInstanceUID.',
    '- Include at least one rendering for every request; use dicom-default unless a specific window/level or display change is required.',
    'Example imageRequest: {"reason":"Confirm whether the focal opacity persists across adjacent sections.","requestsJson":"[{\\\"kind\\\":\\\"neighbours\\\",\\\"sourceImageIndex\\\":7,\\\"before\\\":2,\\\"after\\\":2,\\\"renderings\\\":[{\\\"mode\\\":\\\"dicom-default\\\"}]}]"}.',
    'The client retrieves the requested images locally and sends them back to you in the next round, together with all images already delivered.',
    refinement
      ? refinement.remainingRefinementRounds > 0 && (refinement.remainingImageBudget ?? 0) > 0
        ? `This is refinement round ${refinement.refinementRound}. ${refinement.remainingRefinementRounds} round(s), ${refinement.remainingImageBudget ?? 0} total image slot(s), and ${refinement.maxNewImages ?? 0} new image slot(s) are available now. Request only what fits in this round. The image budget is reserved for resolving material visual uncertainty; use it when the finality gate fails.`
        : 'No additional image rounds or image slots remain. Set nextAction to complete.'
      : 'Request additional images only when a specific visual blind spot remains.',
  ].join('\n');
}

export function buildAnalysisUserPrompt(
  metadata: StudyMetadata,
  clinicalHint: string,
  plan: SelectionPlan,
  sliceLabels: string[],
  context?: Pick<AnalysisRequestContext, 'imageManifest' | 'seriesCatalog'>,
): string {
  const lines = [
    `Analyze ONLY the following ${sliceLabels.length} images.`,
    '',
    `Clinical question: ${clinicalHint}`,
    '',
    'Remember: Only report what you can clearly see. Reference specific slices for every finding. State limitations honestly.',
    '',
    `Study: ${metadata.studyDescription} | ${metadata.modality}`,
  ];
  if (metadata.patientAge) lines.push(`Patient: ${metadata.patientAge} ${metadata.patientSex ?? ''}`);
  lines.push('');

  // Describe each series in the plan
  for (const sel of plan.selections) {
    const series = metadata.series.find((s) => String(s.seriesNumber) === sel.seriesNumber);
    const seriesDesc = series?.seriesDescription || `Series #${sel.seriesNumber}`;
    const totalSlices = series?.slices.length ?? 0;
    const samplingDesc = `${sel.samplingStrategy}${sel.samplingParam ? ` (${sel.samplingParam})` : ''}`;

    lines.push(`--- ${sel.role.toUpperCase()} SERIES: #${sel.seriesNumber} "${seriesDesc}" ---`);
    if (series) {
      lines.push(`Plane: ${series.anatomicalPlane} | Kernel: ${series.convolutionKernel ?? 'N/A'}`);
      lines.push(`Total slices in series: ${totalSlices} (instance #${series.instanceNumberRange[0]}–#${series.instanceNumberRange[1]})`);
      if (series.zCoverageInMm > 0) {
        lines.push(`Full z-coverage: ${series.zCoverageInMm.toFixed(1)}mm (z=${series.zMin.toFixed(1)} to ${series.zMax.toFixed(1)})`);
      }
      if (series.sliceThickness != null) {
        lines.push(`Slice thickness: ${series.sliceThickness}mm`);
      }
      if (series.pixelSpacing) {
        lines.push(`In-plane resolution: ${series.pixelSpacing[0].toFixed(2)}×${series.pixelSpacing[1].toFixed(2)}mm`);
      }
      if (series.estimatedWeighting) {
        let weightLine = `MRI weighting: ${series.estimatedWeighting}`;
        if (series.repetitionTime != null && series.echoTime != null) {
          weightLine += ` (TR:${Math.round(series.repetitionTime)}ms TE:${Math.round(series.echoTime)}ms)`;
        }
        lines.push(weightLine);
      }
    }
    lines.push(`Window: W=${sel.windowWidth} C=${sel.windowCenter}`);
    lines.push(`Slice selection: instances #${sel.sliceRange[0]}–#${sel.sliceRange[1]}, ${samplingDesc}`);
    lines.push(`Rationale: ${sel.rationale}`);
    lines.push('');
  }

  lines.push(`Selection reasoning: ${plan.reasoning}`);
  lines.push('');
  lines.push(`IMPORTANT CONTEXT: You are viewing ${sliceLabels.length} sampled slices from ${plan.selections.length} series. There are gaps between the images you see. A finding visible in one image may span more slices than shown. Account for this sampling when describing extent and when noting limitations.`);
  if (plan.selections.length > 1) {
    lines.push('Cross-reference findings across series when possible (e.g., confirm a sagittal finding on coronal images).');
  }
  lines.push('');
  lines.push(`You are provided EXACTLY ${sliceLabels.length} images. Each image is labeled with its series name, slice number, and z-position.`);
  lines.push(`The images in order are:\n${sliceLabels.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}`);
  lines.push('');
  lines.push('When referencing findings, cite the series and slice number (e.g., "Series #3 Slice 45/187") so the reader can navigate to it in the viewer.');
  lines.push('IMPORTANT: Only reference slice numbers from the list above. Do NOT invent or guess slice numbers that were not provided.');
  if (context?.seriesCatalog) {
    lines.push('', '=== FULL LOCAL SERIES CATALOG ===', context.seriesCatalog);
  }
  if (context?.imageManifest) {
    lines.push('', '=== DELIVERED IMAGE MANIFEST ===', context.imageManifest);
  }

  return lines.join('\n');
}

export function buildFollowUpSystemPrompt(): string {
  return [
    'You are a medical imaging AI assistant continuing a conversation about DICOM image analysis.',
    DISCLAIMER,
    '',
    'You previously analyzed medical images and provided findings.',
    'Continue the conversation by answering follow-up questions based on your prior analysis.',
    'You do not have access to the images anymore — rely on your prior observations.',
    'Be concise and helpful. If asked something outside the scope of your analysis, say so.',
  ].join('\n');
}
