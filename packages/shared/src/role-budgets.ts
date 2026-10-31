import type { JobType } from './types';

/**
 * Monthly budgets per model role (Settings → Model budgets). A role whose recorded spend this month has reached its
 * budget stops new jobs that use it (the worker refuses them before any request is sent); the other roles keep
 * working. 0 or absent = no role budget (the daily and monthly limits still apply).
 */
export const BUDGET_ROLES = ['reasoning', 'video', 'image', 'speech', 'transcription', 'music', 'narration'] as const;
export type BudgetRole = (typeof BUDGET_ROLES)[number];
export type RoleBudgets = Partial<Record<BudgetRole, number>>;

export const BUDGET_ROLE_LABELS: Record<BudgetRole, string> = {
  reasoning: 'Reasoning (planning, writing, reviews)',
  video: 'Video generation',
  image: 'Images',
  speech: 'Speech (guide audio, ad voices)',
  transcription: 'Transcription',
  music: 'Music',
  narration: 'Narrator voice',
};

/** The model roles a job can spend on. Jobs that only run FFmpeg or the renderer spend on none. */
export const JOB_ROLES: Record<JobType, readonly BudgetRole[]> = {
  'image.generate': ['image'],
  'video.generate': ['video'],
  'text.assist': ['reasoning'],
  'audio.analyze': ['reasoning'],
  'render.timeline': [],
  'quality.inspect': ['reasoning', 'transcription'],
  'speech.generate': ['speech'],
  'music.generate': ['music'],
  'lyrics.transcribe': ['transcription', 'reasoning'],
  'lyrics.align': ['transcription', 'reasoning'],
  'media.composite': [],
  'reference.pack': ['image'],
  'continuity.compare': ['reasoning'],
  'media.screen_replace': [],
  'media.color_match': [],
  'media.analyze_subjects': [],
  'lyrics.resync_audio': [],
  'final.inspect': ['reasoning', 'transcription'],
  'music.analyze': ['reasoning'],
  'music.arrange': [],
  'music.mix': [],
  'music.replace_section': ['music'],
  'audio.stems': [],
  'narration.transcribe': ['transcription'],
  'ad.validate': ['reasoning'],
  'video.lipsync': [],
  'lite.narration': ['speech', 'transcription'],
  'audio.ambience': [],
  'narrator.voice': ['narration'],
  'narrator.speak': ['narration'],
  'narrator.export': [],
  'narrator.direct': ['reasoning'],
  'linkad.run': ['reasoning', 'speech', 'transcription'],
};

/** This month's spend per role from the monthly aggregate's per-model totals. */
export function roleSpend(byModel: Record<string, number>, roleModels: Record<BudgetRole, readonly string[]>): Record<BudgetRole, number> {
  const out = Object.fromEntries(BUDGET_ROLES.map((r) => [r, 0])) as Record<BudgetRole, number>;
  for (const role of BUDGET_ROLES) {
    for (const id of roleModels[role]) out[role] += Number(byModel[id] ?? 0);
    out[role] = Math.round(out[role] * 1e6) / 1e6;
  }
  return out;
}

export interface RoleBudgetProblem {
  role: BudgetRole;
  budgetUsd: number;
  spentUsd: number;
  message: string;
}

/** The first role of `roles` whose budget is used up, or null. */
export function roleBudgetProblem(budgets: RoleBudgets | undefined, spent: Record<BudgetRole, number>, roles: readonly BudgetRole[]): RoleBudgetProblem | null {
  for (const role of roles) {
    const budget = budgets?.[role] ?? 0;
    if (!(budget > 0)) continue;
    if (spent[role] + 1e-9 >= budget) {
      return {
        role,
        budgetUsd: budget,
        spentUsd: spent[role],
        message: `The ${BUDGET_ROLE_LABELS[role].toLowerCase()} budget of $${budget.toFixed(2)} for this month is used up (≈ $${spent[role].toFixed(2)} spent). Raise it in Settings → Model budgets, or wait for next month.`,
      };
    }
  }
  return null;
}
