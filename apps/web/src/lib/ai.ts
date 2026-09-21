import { useState } from 'react';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { toast } from 'sonner';
import type { AiRunDoc, JobDoc, JobTarget, TextTask } from '@az-studio/shared';
import { db } from './firebase';
import { useJobSubmitter } from '../components/jobs';

/** Resolves with the persisted output of a text.assist / audio.analyze job once it completes. */
export function waitForJobOutput<T>(jobId: string, projectId: string | null, timeoutMs = 15 * 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('The writing assistant is taking longer than expected; the result will appear in the project history when ready.'));
    }, timeoutMs);
    const unsub = onSnapshot(
      doc(db, 'jobs', jobId),
      async (snap) => {
        const job = snap.data() as JobDoc | undefined;
        if (!job) return;
        if (job.status === 'completed') {
          clearTimeout(timer);
          unsub();
          const runId = job.result?.aiRunId;
          if (!runId) return reject(new Error('The job finished without output.'));
          const run = await getDoc(projectId ? doc(db, 'projects', projectId, 'aiRuns', runId) : doc(db, 'aiRuns', runId));
          resolve((run.data() as AiRunDoc | undefined)?.output as T);
        } else if (job.status === 'failed' || job.status === 'cancelled') {
          clearTimeout(timer);
          unsub();
          reject(new Error(job.error?.message ?? `The job was ${job.status}.`));
        }
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Runs a Gemini Pro writing task as a durable job and awaits its structured output. */
export function useAiRun(projectId: string | null) {
  const { submit, busy: submitting, dialog } = useJobSubmitter();
  const [waiting, setWaiting] = useState(false);
  const run = async <T,>(task: TextTask, input: Record<string, unknown>, label?: string, target?: JobTarget): Promise<T | null> => {
    const ids = await submit([{ type: 'text.assist', projectId, task, input, ...(label ? { label } : {}), ...(target ? { target } : {}) }], label ? { label } : {});
    const id = ids?.[0];
    if (!id) return null;
    setWaiting(true);
    try {
      return await waitForJobOutput<T>(id, projectId);
    } catch (e) {
      toast.error('The writing assistant could not finish', { description: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      setWaiting(false);
    }
  };
  return { run, busy: submitting || waiting, dialog };
}
