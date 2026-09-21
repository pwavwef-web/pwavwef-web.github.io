import type { JobStatus, JobType } from './types';

/** Allowed job status transitions. Terminal states never transition; a retry creates a new job. */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['validating', 'failed', 'cancelled'],
  validating: ['queued', 'generating', 'downloading', 'rendering', 'failed', 'cancelled'],
  // `queued` again only for automatic retries after transient, non-billed API errors (429/5xx).
  generating: ['queued', 'downloading', 'completed', 'failed', 'cancelled'],
  downloading: ['rendering', 'completed', 'failed', 'cancelled'],
  rendering: ['downloading', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];
export const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'validating', 'generating', 'downloading', 'rendering'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return true;
  return JOB_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal job transition ${from} → ${to}`);
  }
}

/** Jobs that call a paid generative model and therefore count toward the concurrency limit. */
export function isGenerativeJob(type: JobType): boolean {
  return type === 'image.generate' || type === 'video.generate' || type === 'text.assist' || type === 'audio.analyze';
}

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  validating: 'Validating',
  generating: 'Generating',
  downloading: 'Saving media',
  rendering: 'Rendering',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  'image.generate': 'Image',
  'video.generate': 'Video',
  'text.assist': 'Writing assist',
  'audio.analyze': 'Song analysis',
  'render.timeline': 'Render',
};
