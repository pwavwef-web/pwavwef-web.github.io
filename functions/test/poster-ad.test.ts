import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, allFacts, brandKitRequestSchema, isConfirmed, linkAdReadiness, linkAdRequestSchema, normalizeLinkAd, posterInputHash, todayKey, type BrandKitRequest, type LinkAdDoc, type LinkAdRequest } from '@az-studio/shared';
import { doc, resetFakes, store } from './fakes';

/**
 * Brand kits and the Motion Poster Ad on the Link to Ad backend, with the in-memory Firestore and fixture voice (no
 * request leaves this process): kit ownership and files, re-confirmation, revision conflicts, a poster ad filled from
 * a kit, the deterministic script, the poster save gate (hash, size, stale prices) and a kit applied to a Link to Ad.
 */

vi.mock('../src/lib/firebase', async () => import('./fakes'));
vi.mock('firebase-admin/functions', async () => {
  const f = await import('./fakes');
  return { getFunctions: () => ({ taskQueue: () => ({ enqueue: async (payload: never, opts?: { scheduleDelaySeconds?: number }) => void f.tasks.push({ payload, delaySec: opts?.scheduleDelaySeconds ?? 0 }) }) }) };
});
vi.mock('firebase-functions', async (orig) => ({ ...(await orig<typeof import('firebase-functions')>()), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/lib/media-proxy', () => ({ mediaInputUrl: async (p: string) => `https://signed.example/${p}` }));

vi.setConfig({ testTimeout: 120_000 });
process.env.AZS_LINKAD_FIXTURES = '1';
process.env.FUNCTIONS_EMULATOR = 'true';

const { linkAd } = await import('../src/api/linkad');
const { brandKits } = await import('../src/api/brand-kits');
const { runLinkAdJob } = await import('../src/workers/linkad');
const { claimJob } = await import('../src/lib/jobs');

const OWNER = { uid: 'owner1', email: 'owner@example.com' };
const OTHER = { uid: 'someone-else', email: 'x@example.com' };
const call = (p: Record<string, unknown>, o = OWNER) => linkAd(o, linkAdRequestSchema.parse(p) as LinkAdRequest) as Promise<any>;
const kits = (p: Record<string, unknown>, o = OWNER) => brandKits(o, brandKitRequestSchema.parse(p) as BrandKitRequest) as Promise<any>;
const getAd = (id: string): LinkAdDoc => normalizeLinkAd(doc(`projects/${id}`)!.linkad);
let n = 0;
const rid = (p: string) => `${p}-request-${++n}`;

const KIT = {
  name: 'Obaapaz',
  colours: { primary: '#B45309', background: '#1C1208', accent: '#F59E0B', text: '#FFFFFF' },
  logos: [{ assetId: 'logo1', label: 'Obaapaz logo' }],
  photos: [{ assetId: 'ph1', label: 'Honey bottles', product: 'Honey', real: true }],
  offers: [{ id: 'o1', item: 'Honey 1 litre', price: '120', currency: 'GH₵', confirmedOn: '2026-01-01', reviewBy: '2026-01-31' }],
  contacts: [{ id: 'c1', kind: 'whatsapp', value: '024 555 0142', confirmedOn: '2026-01-01', reviewBy: '2026-06-30' }],
};

function seedFiles(uid = OWNER.uid) {
  store.set('assets/logo1', { ownerUid: uid, kind: 'image', status: 'ready', title: 'logo.png', width: 800, height: 400, mimeType: 'image/png', sizeBytes: 1000 });
  store.set('assets/ph1', { ownerUid: uid, kind: 'image', status: 'ready', title: 'honey.jpg', width: 1600, height: 2000, mimeType: 'image/jpeg', sizeBytes: 5000 });
}

beforeEach(() => {
  resetFakes();
  seedFiles();
});

describe('brand kits', () => {
  it('saves a kit the owner reads, confirms new entries today and refuses files that are not the owner’s', async () => {
    const r = await kits({ op: 'save', kit: KIT });
    const stored = doc(`brandKits/${r.kitId}`)!;
    expect(stored).toMatchObject({ ownerUid: OWNER.uid, revision: 1, name: 'Obaapaz' });
    expect(stored.offers[0]).toMatchObject({ confirmedOn: todayKey(), reviewBy: addDays(todayKey(), 30) });
    store.set('assets/ph2', { ownerUid: OTHER.uid, kind: 'image', status: 'ready', title: 'not mine' });
    await expect(kits({ op: 'save', kit: { ...KIT, photos: [{ assetId: 'ph2' }] } })).rejects.toThrow(/not in your library/);
    await expect(kits({ op: 'save', kitId: r.kitId, revision: 0, kit: KIT })).rejects.toThrow(/changed somewhere else/);
    await expect(kits({ op: 'reconfirm', kitId: r.kitId, entryIds: ['o1'] }, OTHER)).rejects.toThrow(/not found/);
    await expect(kits({ op: 'save', kit: { ...KIT, offers: [...KIT.offers, { ...KIT.offers[0], id: 'o2' }] } })).rejects.toThrow(/listed twice/);
  });
});

describe('Motion Poster Ad', () => {
  /** A kit stored directly, so its dates are exactly the ones given (a save would confirm them today). */
  function storedKit(reviewBy: string) {
    store.set('brandKits/k1', { ...KIT, offers: [{ ...KIT.offers[0], reviewBy, unit: '', note: '', previousNames: [] }], contacts: [{ ...KIT.contacts[0], label: '', reviewBy: addDays(todayKey(), 100) }], ownerUid: OWNER.uid, revision: 3 });
    return 'k1';
  }

  it('is a poster_ad filled from a kit: real photos, prices and contacts, current prices confirmed', async () => {
    const kitId = storedKit(addDays(todayKey(), 20));
    const { projectId } = await call({ op: 'createPoster', requestId: rid('c'), template: 'product_hero', kitId, fixture: true });
    const p = doc(`projects/${projectId}`)!;
    expect(p.type).toBe('poster_ad');
    const d = getAd(projectId);
    expect(d.input.sourceKind).toBe('facts');
    expect(d.ad.brand).toMatchObject({ primary: '#B45309', background: '#1C1208' });
    expect(d.source.assets.find((a) => a.assetId === 'ph1')).toMatchObject({ real: true, rights: 'confirmed', role: 'image' });
    expect(d.brief.logoId).toBe(d.source.assets.find((a) => a.assetId === 'logo1')!.id);
    expect(d.poster!.prices[0]).toMatchObject({ item: 'Honey 1 litre', price: '120', kitEntryId: 'o1' });
    expect(d.poster!.photoIds).toHaveLength(1);
    const price = allFacts(d).find((f) => f.id.startsWith('pf_p_'))!;
    expect(isConfirmed(d, price)).toBe(true);
    await expect(call({ op: 'analyse', projectId, requestId: rid('a') })).rejects.toThrow(/facts form/);
    await expect(call({ op: 'createPoster', requestId: rid('c'), template: 'event', kitId }, OTHER)).rejects.toThrow(/not found/);
  });

  it('writes the script from the facts for free, keeps recordings of unchanged lines, and records the voice', async () => {
    const { projectId } = await call({ op: 'createPoster', requestId: rid('c'), template: 'product_hero', kitId: storedKit(addDays(todayKey(), 20)), fixture: true });
    const ed = await call({ op: 'edit', projectId, revision: getAd(projectId).revision, edit: { poster: { headline: 'Pure Obaapaz honey', cta: 'Order on WhatsApp' } } });
    await call({ op: 'buildScript', projectId, revision: ed.revision });
    let d = getAd(projectId);
    expect(d.stage).toBe('generating');
    expect(d.ad.scenes.map((s) => s.id)).toEqual(['ps_hook', 'ps_price_0', 'ps_cta']);
    expect(d.ad.scenes[1]!.narration).toMatch(/one hundred and twenty Ghana cedis/);
    expect(d.ad.closing.line).toBe('WhatsApp 024 555 0142');
    expect(d.briefApprovedAt).not.toBeNull();
    expect(d.spend.ledger).toEqual([]);

    const v = await call({ op: 'voice', projectId, requestId: rid('v') });
    const job = await claimJob(v.jobId);
    await runLinkAdJob(job!);
    d = getAd(projectId);
    expect(Object.keys(d.ad.takes).sort()).toEqual(['ps_cta', 'ps_hook', 'ps_price_0']);
    const hookTake = d.ad.takes.ps_hook!.assetId;
    // A change to the offer only: the hook keeps its recording.
    const e2 = await call({ op: 'edit', projectId, revision: d.revision, edit: { poster: { offer: 'Delivery in Accra' } } });
    await call({ op: 'buildScript', projectId, revision: e2.revision });
    d = getAd(projectId);
    expect(d.ad.takes.ps_hook!.assetId).toBe(hookTake);
    expect(d.ad.scenes.some((s) => s.id === 'ps_offer')).toBe(true);
  });

  it('saves a poster only for the current drawing, at the exact size, with no stale kit prices', async () => {
    const { projectId } = await call({ op: 'createPoster', requestId: rid('c'), template: 'product_hero', kitId: storedKit(addDays(todayKey(), 20)), fixture: true });
    const ed = await call({ op: 'edit', projectId, revision: getAd(projectId).revision, edit: { poster: { headline: 'Pure Obaapaz honey', cta: 'Order now' } } });
    expect(ed.revision).toBeGreaterThan(0);
    store.set('assets/png45', { ownerUid: OWNER.uid, kind: 'image', status: 'ready', width: 1080, height: 1350 });
    store.set('assets/pngbad', { ownerUid: OWNER.uid, kind: 'image', status: 'ready', width: 1000, height: 1250 });
    const hash = posterInputHash(getAd(projectId), '4:5');
    await expect(call({ op: 'savePoster', projectId, format: '4:5', assetId: 'png45', hash: 'stale' })).rejects.toThrow(/changed while it was being drawn/);
    await expect(call({ op: 'savePoster', projectId, format: '4:5', assetId: 'pngbad', hash })).rejects.toThrow(/exactly 1080×1350/);
    await call({ op: 'savePoster', projectId, format: '4:5', assetId: 'png45', hash });
    expect(getAd(projectId).poster!.exports['4:5']).toMatchObject({ assetId: 'png45', hash, width: 1080, height: 1350 });
    expect(doc(`projects/${projectId}`)!.coverAssetId).toBe('png45');

    // The kit's price is now past its review day: re-applying leaves it unconfirmed and the save refuses it.
    storedKit(addDays(todayKey(), -2));
    await call({ op: 'applyKit', projectId, kitId: 'k1' });
    await expect(call({ op: 'savePoster', projectId, format: '4:5', assetId: 'png45', hash: posterInputHash(getAd(projectId), '4:5') })).rejects.toThrow(/re-confirmation/);
    await call({ op: 'buildScript', projectId, revision: getAd(projectId).revision });
    const d = getAd(projectId);
    expect(linkAdReadiness(d, { final: true }).some((i) => i.severity === 'error' && /re-confirmation/.test(i.message))).toBe(true);
  });

  it('applies a kit to a Link to Ad as the director’s facts with their review days', async () => {
    const { projectId } = await call({ op: 'create', requestId: rid('la'), url: '', manualText: 'Raw honey from the Volta region, delivered in Accra.', fixture: true });
    await call({ op: 'applyKit', projectId, kitId: storedKit(addDays(todayKey(), 20)) });
    const d = getAd(projectId);
    const price = d.userFacts.find((f) => f.id === 'kit_o_o1')!;
    expect(price.kit).toMatchObject({ kitId: 'k1', entryId: 'o1' });
    expect(isConfirmed(d, allFacts(d).find((f) => f.id === 'kit_o_o1')!)).toBe(true);
    expect(d.userFacts.some((f) => f.id === 'kit_name' && f.kind === 'business_name')).toBe(true);
    expect(d.brandKit).toMatchObject({ kitId: 'k1', name: 'Obaapaz' });
    expect(doc(`projects/${projectId}`)!.type).toBe('link_ad');
  });
});
