import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizeLinkAd,
  type JobDoc,
  type LinkAdDoc,
  type LinkAdEdit,
  type LinkAdRequestInput,
  type ProjectDoc,
} from '@az-studio/shared';
import { api, ApiError, errorMessage } from './api';
import { useDoc, type WithId } from './data';

/**
 * Link to Ad in the browser. The ad lives in `project.linkad` and is written by the API only; edits go through
 * one `edit` call (sections of the document that changed, with the revision they were made against), while
 * everything the server does — reading the site, planning, recording, rendering — reaches the page through the
 * same live document, so a refresh or a second tab shows exactly what happened.
 */

export function linkAdCall<T = unknown>(payload: LinkAdRequestInput): Promise<T> {
  return api<T, 'linkAd'>('linkAd', payload as never);
}

/** A fresh idempotency key for a paid or long step. Reuse the key to retry the same request safely. */
export function newRequestId(): string {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return `r${[...a].map((b) => b.toString(36).padStart(2, '0')).join('')}`;
}

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

export function useLinkAdDoc(project: WithId<ProjectDoc>): LinkAdDoc {
  return useMemo(() => normalizeLinkAd(project.linkad), [project.linkad]);
}

type Sections = Pick<LinkAdDoc, 'input' | 'brief' | 'userFacts'> & { ad: Pick<LinkAdDoc['ad'], 'title' | 'scenes' | 'closing' | 'brand' | 'captions' | 'voiceGainDb' | 'music'>; capUsd: number };

const sectionsOf = (d: LinkAdDoc): Sections => ({ input: d.input, brief: d.brief, userFacts: d.userFacts, ad: { title: d.ad.title, scenes: d.ad.scenes, closing: d.ad.closing, brand: d.ad.brand, captions: d.ad.captions, voiceGainDb: d.ad.voiceGainDb, music: d.ad.music }, capUsd: d.spend.capUsd });

/** What changed between the server's copy and the local draft, in the shape the `edit` call takes. */
export function buildEdit(server: LinkAdDoc, draft: LinkAdDoc): LinkAdEdit {
  const a = sectionsOf(server);
  const b = sectionsOf(draft);
  const differs = (x: unknown, y: unknown) => JSON.stringify(x) !== JSON.stringify(y);
  const edit: LinkAdEdit = {};
  if (differs(a.input, b.input)) edit.input = b.input;
  if (differs(a.brief, b.brief)) edit.brief = b.brief;
  if (differs(a.userFacts, b.userFacts)) edit.userFacts = b.userFacts;
  const ad: NonNullable<LinkAdEdit['ad']> = {};
  for (const k of ['title', 'scenes', 'closing', 'brand', 'captions', 'voiceGainDb', 'music'] as const) if (differs(a.ad[k], b.ad[k])) (ad as Record<string, unknown>)[k] = b.ad[k];
  if (Object.keys(ad).length) edit.ad = ad;
  if (a.capUsd !== b.capUsd) edit.spendCapUsd = b.capUsd;
  return edit;
}

/** The draft keeps the director's unsaved edits and adopts everything else the server has since written. */
function mergeDraft(server: LinkAdDoc, draft: LinkAdDoc): LinkAdDoc {
  return { ...server, input: draft.input, brief: draft.brief, userFacts: draft.userFacts, spend: { ...server.spend, capUsd: draft.spend.capUsd }, ad: { ...server.ad, title: draft.ad.title, scenes: draft.ad.scenes, closing: draft.ad.closing, brand: draft.ad.brand, captions: draft.ad.captions, voiceGainDb: draft.ad.voiceGainDb, music: draft.ad.music } };
}

export interface LinkAdEditor {
  doc: LinkAdDoc;
  server: LinkAdDoc;
  status: SaveStatus;
  update: (fn: (d: LinkAdDoc) => LinkAdDoc) => void;
  /** Saves pending edits now and resolves when they are stored. */
  flush: () => Promise<void>;
  /** An immediate change that depends on server-side hashing (confirmations, fact wording, picture rights). */
  commit: (edit: LinkAdEdit) => Promise<void>;
  /** The latest revision the editor knows of (for calls that take one). */
  revision: () => number;
}

export function useLinkAdEditor(projectId: string, server: LinkAdDoc, onError: (m: string) => void): LinkAdEditor {
  const [draft, setDraft] = useState<LinkAdDoc>(server);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revision = useRef(server.revision);
  const serverRef = useRef(server);
  const draftRef = useRef(draft);
  const queue = useRef<Promise<void>>(Promise.resolve());
  draftRef.current = draft;
  serverRef.current = server;

  useEffect(() => {
    revision.current = Math.max(revision.current, server.revision);
    setDraft((cur) => (dirty.current ? mergeDraft(server, cur) : server));
  }, [server]);

  const send = useCallback(
    async (edit: LinkAdEdit) => {
      let attempts = 0;
      for (;;) {
        try {
          const r = await linkAdCall<{ revision: number }>({ op: 'edit', projectId, revision: revision.current, edit });
          revision.current = r.revision;
          return;
        } catch (e) {
          // The server also changes the ad (a step finished); that moves the revision without touching the sections edited here.
          const d = e instanceof ApiError ? (e.details as { reason?: string; revision?: number } | null) : null;
          if (d?.reason === 'revision_conflict' && typeof d.revision === 'number' && attempts++ < 2) {
            revision.current = d.revision;
            continue;
          }
          throw e;
        }
      }
    },
    [projectId],
  );

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const run = queue.current.then(async () => {
      if (!dirty.current) return;
      const edit = buildEdit(serverRef.current, draftRef.current);
      dirty.current = false;
      if (!Object.keys(edit).length) {
        setStatus('saved');
        return;
      }
      setStatus('saving');
      try {
        await send(edit);
        setStatus(dirty.current ? 'unsaved' : 'saved');
      } catch (e) {
        dirty.current = true;
        setStatus('error');
        onError(errorMessage(e));
      }
    });
    queue.current = run.catch(() => undefined);
    await run;
  }, [send, onError]);

  const update = useCallback(
    (fn: (d: LinkAdDoc) => LinkAdDoc) => {
      dirty.current = true;
      setStatus('unsaved');
      setDraft((cur) => fn(cur));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 800);
    },
    [flush],
  );

  const commit = useCallback(
    async (edit: LinkAdEdit) => {
      await flush();
      const run = queue.current.then(() => send(edit));
      queue.current = run.catch(() => undefined);
      try {
        await run;
      } catch (e) {
        onError(errorMessage(e));
        throw e;
      }
    },
    [flush, send, onError],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (dirty.current) void flush();
    },
    [flush],
  );

  return { doc: draft, server, status, update, flush, commit, revision: () => revision.current };
}

/** The job doing the ad's current step, live (its stage text is the backend's own wording). */
export function useActiveJob(doc: LinkAdDoc) {
  return useDoc<JobDoc>(doc.activeJobId ? `jobs/${doc.activeJobId}` : null);
}

/** While something runs, ask the server to bring the ad up to date (finished renders, collected pictures). */
export function useRefreshWhileBusy(projectId: string, doc: LinkAdDoc) {
  const busy = doc.stage === 'composing' || doc.exports.some((e) => e.status === 'queued' || e.status === 'rendering') || Boolean(doc.activeJobId);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void linkAdCall({ op: 'refresh', projectId }).catch(() => undefined), 7000);
    return () => clearInterval(t);
  }, [busy, projectId]);
}

