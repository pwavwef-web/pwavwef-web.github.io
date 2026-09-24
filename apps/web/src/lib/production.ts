import { collection, doc, limit, orderBy, query, where } from 'firebase/firestore';
import type { CostEstimate, DurationPlan, ModelAvailability, ProductionAction, ProductionDoc, ProductionEvent, ProductionVersionDoc, QualityReportDoc, QualitySettings, VideoJobRequest } from '@az-studio/shared';
import { api } from './api';
import { db } from './firebase';
import { useDoc, useQuery, type WithId } from './data';
import { useUid } from './session';

export type Production = WithId<ProductionDoc>;
export type Version = WithId<ProductionVersionDoc>;
export type Report = WithId<QualityReportDoc>;

export interface ProductionOptions {
  requestedSec: number;
  uploadedAudio?: { lineIndex: number; assetId: string }[];
  identifyFromTakeId?: string | null;
  /** Review this existing take instead of generating a new one. */
  reviewTakeId?: string | null;
  settings?: Partial<QualitySettings>;
}

export interface ProductionEstimate {
  plan: DurationPlan;
  estimate: CostEstimate;
  confirmation: { required: boolean; reasons: string[] };
  limitProblem: string | null;
  quality: QualitySettings;
  audioMode: string;
  repairBudgetUsd: number;
  review: { takeId: string; label: string; durationSec: number | null } | null;
}

const opts = (o: ProductionOptions) => ({ requestedSec: o.requestedSec, uploadedAudio: o.uploadedAudio ?? [], identifyFromTakeId: o.identifyFromTakeId ?? null, reviewTakeId: o.reviewTakeId ?? null, ...(o.settings ? { settings: o.settings } : {}) });

export const estimateProduction = (projectId: string, shotId: string, job: VideoJobRequest, o: ProductionOptions) => api<ProductionEstimate, 'estimateProduction'>('estimateProduction', { projectId, shotId, job, options: opts(o) });

export const startProduction = (projectId: string, shotId: string, job: VideoJobRequest, o: ProductionOptions, confirmedUsd: number | null) =>
  api<{ productionId: string; plan: DurationPlan; estimate: CostEstimate }, 'startProduction'>('startProduction', { projectId, shotId, job, options: opts(o), confirmedUsd });

export const productionAction = (productionId: string, action: ProductionAction, extra: { versionId?: string | null; categories?: string[]; note?: string; instruction?: string; extendSec?: number | null; confirmedUsd?: number | null } = {}) =>
  api<Record<string, unknown>, 'productionAction'>('productionAction', { productionId, action, versionId: extra.versionId ?? null, categories: extra.categories ?? [], ...(extra.note ? { note: extra.note } : {}), ...(extra.instruction ? { instruction: extra.instruction } : {}), extendSec: extra.extendSec ?? null, confirmedUsd: extra.confirmedUsd ?? null });

export const modelStatus = (refresh = false) => api<{ models: ModelAvailability[]; checkedAt: number }, 'modelStatus'>('modelStatus', { refresh });

export const useProduction = (id: string | null | undefined) => useDoc<ProductionDoc>(id ? `productions/${id}` : null);

/** Every production of a shot, newest first. */
export function useShotProductions(projectId: string, shotId: string | null) {
  const uid = useUid();
  return useQuery<ProductionDoc>(() => (uid && shotId ? query(collection(db, 'productions'), where('ownerUid', '==', uid), where('shotId', '==', shotId), orderBy('createdAt', 'desc'), limit(10)) : null), [uid, projectId, shotId]);
}

export function useProjectProductions(projectId: string) {
  const uid = useUid();
  return useQuery<ProductionDoc>(() => (uid ? query(collection(db, 'productions'), where('ownerUid', '==', uid), where('projectId', '==', projectId), orderBy('updatedAt', 'desc'), limit(100)) : null), [uid, projectId]);
}

export function useVersions(productionId: string | null) {
  return useQuery<ProductionVersionDoc>(() => (productionId ? query(collection(db, 'productions', productionId, 'versions'), orderBy('index', 'asc')) : null), [productionId]);
}

export function useReport(productionId: string | null, reportId: string | null) {
  return useDoc<QualityReportDoc>(productionId && reportId ? `productions/${productionId}/reports/${reportId}` : null);
}

export function useEvents(productionId: string | null) {
  return useQuery<ProductionEvent>(() => (productionId ? query(collection(db, 'productions', productionId, 'events'), orderBy('at', 'desc'), limit(60)) : null), [productionId]);
}

export const productionRef = (id: string) => doc(db, 'productions', id);
