import { describe, expect, it } from 'vitest';
import { JOB_TYPES } from '../src/types';
import { JOB_ROLES, roleBudgetProblem, roleSpend, type BudgetRole } from '../src/role-budgets';
import { compareCanaryRuns, jsonShape, normaliseCanaryText, type CanaryProbe, type CanaryRun } from '../src/canary';

const models: Record<BudgetRole, string[]> = { reasoning: ['argon'], video: ['omni'], image: ['banana'], speech: ['tts'], transcription: ['asr'], music: ['lyria'], narration: ['n1', 'n2'] };

describe('role budgets', () => {
  it('maps every job type', () => {
    for (const t of JOB_TYPES) expect(JOB_ROLES[t]).toBeDefined();
  });

  it('sums spend per role, including every allowed model', () => {
    const s = roleSpend({ argon: 1.25, n1: 0.5, n2: 0.25, other: 9 }, models);
    expect(s.reasoning).toBe(1.25);
    expect(s.narration).toBe(0.75);
    expect(s.video).toBe(0);
  });

  it('stops only the roles whose budget is used up', () => {
    const spent = roleSpend({ argon: 10 }, models);
    expect(roleBudgetProblem({ reasoning: 10 }, spent, JOB_ROLES['text.assist'])?.role).toBe('reasoning');
    expect(roleBudgetProblem({ reasoning: 10 }, spent, JOB_ROLES['image.generate'])).toBeNull();
    expect(roleBudgetProblem({ reasoning: 0 }, spent, JOB_ROLES['text.assist'])).toBeNull();
    expect(roleBudgetProblem({ reasoning: 12 }, spent, JOB_ROLES['linkad.run'])).toBeNull();
    expect(roleBudgetProblem(undefined, spent, JOB_ROLES['linkad.run'])).toBeNull();
  });
});

const probe = (p: Partial<CanaryProbe>): CanaryProbe => ({ role: 'music:vertex', modelId: 'lyria', surface: 'vertex', outcome: 'unavailable', signature: 'model_not_found|unsupported model interaction', detail: '', latencyMs: 1, costUsd: 0, ...p });
const run = (day: string, probes: CanaryProbe[]): CanaryRun => ({ day, at: 0, probes, costUsd: 0 });

describe('model canary', () => {
  it('normalises volatile parts of provider messages', () => {
    expect(normaliseCanaryText('400 Unsupported model interaction: "lyria-3.5" (request 9f8e7d6c5b4a)')).toBe(normaliseCanaryText('400 Unsupported model interaction: "lyria-3.6" (request 0123abcd4567)'));
    expect(jsonShape({ sum: 5, ok: true })).toBe('{ok:boolean,sum:number}');
  });

  it('reports nothing when the day repeats', () => {
    const a = run('2026-10-30', [probe({}), probe({ role: 'reasoning', modelId: 'argon', outcome: 'ok', signature: '{ok:boolean,sum:number}' })]);
    expect(compareCanaryRuns(a, { ...a, day: '2026-10-31' })).toEqual([]);
  });

  it('flags a reworded refusal and a lost role', () => {
    const before = run('2026-10-12', [probe({}), probe({ role: 'reasoning', modelId: 'argon', outcome: 'ok', signature: '{ok:boolean,sum:number}' })]);
    const after = run('2026-10-13', [probe({ outcome: 'error', signature: 'invalid_request|model lyria is not supported here' }), probe({ role: 'reasoning', modelId: 'argon', outcome: 'error', signature: 'unavailable|<n>' })]);
    const changes = compareCanaryRuns(before, after);
    expect(changes.map((c) => [c.role, c.kind, c.worse])).toEqual([
      ['music:vertex', 'outcome', true],
      ['reasoning', 'outcome', true],
    ]);
  });

  it('flags a changed response shape and a first failure', () => {
    const before = run('2026-10-12', [probe({ role: 'reasoning', modelId: 'argon', outcome: 'ok', signature: '{ok:boolean,sum:number}' })]);
    const after = run('2026-10-13', [probe({ role: 'reasoning', modelId: 'argon', outcome: 'ok', signature: '{ok:boolean,sum:string}' }), probe({ role: 'speech', modelId: 'tts', outcome: 'error', signature: 'x' })]);
    const changes = compareCanaryRuns(before, after);
    expect(changes.find((c) => c.role === 'reasoning')?.kind).toBe('signature');
    expect(changes.find((c) => c.role === 'speech')?.kind).toBe('new');
  });
});
