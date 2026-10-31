/**
 * Daily model canaries: one tiny, cheap probe per model role, compared with the previous day's run. A change in
 * availability, in a refusal's wording or in a response's shape is reported before real jobs meet it (on 13 Oct a
 * reworded Lyria refusal made every music job fail instead of taking the Developer API route).
 */
export type CanaryOutcome = 'ok' | 'unavailable' | 'error' | 'skipped';

export interface CanaryProbe {
  role: string;
  modelId: string;
  /** Where the probe ran (vertex, developer-api, …). */
  surface: string;
  outcome: CanaryOutcome;
  /**
   * What is compared from day to day: the response shape for a success, the error class and normalised wording for
   * a refusal. Volatile parts (numbers, ids, quoted values) are removed by `normaliseCanaryText`.
   */
  signature: string;
  detail: string;
  latencyMs: number;
  costUsd: number;
}

export interface CanaryRun {
  day: string;
  at: number;
  probes: CanaryProbe[];
  costUsd: number;
}

export interface CanaryChange {
  role: string;
  modelId: string;
  kind: 'outcome' | 'signature' | 'new' | 'missing';
  before: string | null;
  after: string | null;
  /** True when the change makes the role worse (a success turned into a failure, or a new failure). */
  worse: boolean;
  message: string;
}

/** Lower-cases and removes the parts of a provider message that differ between identical failures. */
export function normaliseCanaryText(s: string): string {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/["'`“”‘’][^"'`“”‘’]{0,80}["'`“”‘’]/g, '<q>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<id>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** The shape of a JSON value as sorted keys and types, e.g. `{ok:boolean,sum:number}`. */
export function jsonShape(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length ? jsonShape(v[0]) : ''}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${k}:${jsonShape((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return v === null ? 'null' : typeof v;
}

const label = (p: CanaryProbe | undefined) => (p ? `${p.outcome} · ${p.signature}` : null);

export function compareCanaryRuns(previous: CanaryRun | null, next: CanaryRun): CanaryChange[] {
  const changes: CanaryChange[] = [];
  const before = new Map((previous?.probes ?? []).map((p) => [p.role, p]));
  for (const p of next.probes) {
    if (p.outcome === 'skipped') continue;
    const b = before.get(p.role);
    before.delete(p.role);
    if (!b || b.outcome === 'skipped') {
      if (p.outcome !== 'ok') changes.push({ role: p.role, modelId: p.modelId, kind: 'new', before: null, after: label(p), worse: true, message: `${p.role} (${p.modelId}) failed its first check: ${p.detail}` });
      continue;
    }
    if (b.modelId !== p.modelId || b.outcome !== p.outcome) {
      const worse = b.outcome === 'ok' && p.outcome !== 'ok';
      changes.push({
        role: p.role,
        modelId: p.modelId,
        kind: 'outcome',
        before: label(b),
        after: label(p),
        worse: worse || (p.outcome === 'error' && b.outcome !== 'error'),
        message: `${p.role} (${p.modelId}) changed from ${b.outcome} to ${p.outcome}: ${p.detail}`,
      });
    } else if (b.signature !== p.signature) {
      changes.push({
        role: p.role,
        modelId: p.modelId,
        kind: 'signature',
        before: label(b),
        after: label(p),
        worse: p.outcome !== 'ok',
        message:
          p.outcome === 'ok'
            ? `${p.role} (${p.modelId}) still answers, but its response shape changed (${b.signature} → ${p.signature}).`
            : `${p.role} (${p.modelId}) now fails with different wording — check that the studio still recognises it: ${p.detail}`,
      });
    }
  }
  for (const b of before.values()) {
    if (b.outcome === 'skipped') continue;
    changes.push({ role: b.role, modelId: b.modelId, kind: 'missing', before: label(b), after: null, worse: false, message: `${b.role} was not checked today.` });
  }
  return changes;
}
