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
  return !['render.timeline', 'media.composite', 'media.color_match', 'music.arrange', 'music.mix', 'audio.stems', 'lyrics.resync_audio'].includes(type);
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
  'quality.inspect': 'Quality review',
  'speech.generate': 'Dialogue audio',
  'music.generate': 'Music',
  'lyrics.transcribe': 'Lyrics extraction',
  'lyrics.align': 'Lyrics sync',
  'media.composite': 'Scene repair edit',
  'reference.pack': 'Set reference pack',
  'continuity.compare': 'Continuity comparison',
  'media.screen_replace': 'Screen replacement',
  'media.color_match': 'Colour match',
  'media.analyze_subjects': 'Face & object tracking',
  'lyrics.resync_audio': 'Lyric re-sync',
  'final.inspect': 'Final-film inspection',
  'music.analyze': 'Music analysis',
  'music.arrange': 'Arrangement',
  'music.mix': 'Mixdown',
  'music.replace_section': 'Replacement passage',
  'audio.stems': 'Stem separation',
};

/** The nine states AZ Studio shows for background work (derived from the durable job status). */
export type DisplayJobStatus = 'Queued' | 'Preparing' | 'Processing' | 'Inspecting' | 'Repairing' | 'Rendering' | 'Completed' | 'Failed' | 'Cancelled';

const INSPECTING_TYPES: readonly JobType[] = ['quality.inspect', 'final.inspect', 'continuity.compare'];
const REPAIR_TYPES_: readonly JobType[] = ['media.composite', 'media.screen_replace', 'media.color_match'];
const RENDER_TYPES: readonly JobType[] = ['render.timeline', 'music.mix', 'music.arrange'];

export function displayJobStatus(job: { status: JobStatus; type: JobType; productionId?: string | null }): DisplayJobStatus {
  switch (job.status) {
    case 'queued':
      return 'Queued';
    case 'validating':
      return 'Preparing';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'rendering':
      return REPAIR_TYPES_.includes(job.type) && job.productionId ? 'Repairing' : 'Rendering';
    default:
      if (INSPECTING_TYPES.includes(job.type)) return 'Inspecting';
      if (REPAIR_TYPES_.includes(job.type) && job.productionId) return 'Repairing';
      if (RENDER_TYPES.includes(job.type)) return 'Rendering';
      return 'Processing';
  }
}
