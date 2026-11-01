import { describe, expect, it } from 'vitest';
import {
  adReadiness,
  approximateMeasure,
  allFacts,
  brandKitInputSchema,
  buildPosterScript,
  defaultAdSpec,
  defaultLinkAd,
  defaultPoster,
  factHash,
  kitApprovedFacts,
  kitToAdBrand,
  kitWarnings,
  layoutPoster,
  linkAdReadiness,
  linkAdStatus,
  mergeKitFacts,
  POSTER_FORMAT_IDS,
  POSTER_TEMPLATES,
  posterFormFacts,
  posterInputHash,
  posterReadiness,
  prepareKitSave,
  reconfirmKit,
  spokenPhone,
  spokenPrice,
  staleApprovedFacts,
  staleFactFindings,
  syncPosterFacts,
  type BrandKitInput,
  type LinkAdDoc,
  type PosterForm,
  type PosterItem,
} from '../src/index';

const kit = (over: Partial<BrandKitInput> = {}): BrandKitInput =>
  brandKitInputSchema.parse({
    name: 'Bright Consult',
    colours: { primary: '#1D4ED8', background: '#0B1530', accent: '#F4B84A', text: '#FFFFFF' },
    offers: [{ id: 'reg', item: 'Regular passport', price: '450', currency: 'GH₵', unit: '', confirmedOn: '2026-10-01', reviewBy: '2026-10-31' }],
    contacts: [{ id: 'ph', kind: 'phone', value: '054 216 1486', confirmedOn: '2026-10-01', reviewBy: '2027-03-30' }],
    ...over,
  });

const photo = (id: string, assetId: string) => ({ id, assetId, role: 'image' as const, origin: 'upload' as const, url: null, pageUrl: null, alt: '', width: 1600, height: 2000, bytes: 1, mime: 'image/jpeg', status: 'stored' as const, rejectReason: null, rights: 'confirmed' as const, needsReview: false, reviewed: false, selected: true, note: '', real: true });

function posterDoc(form: Partial<PosterForm> = {}): LinkAdDoc {
  const base = defaultLinkAd({ sourceKind: 'facts' });
  const d: LinkAdDoc = { ...base, source: { ...base.source, assets: [photo('a1', 'img1'), photo('a2', 'img2')] }, poster: { ...defaultPoster('product_hero'), headline: 'Pure Obaapaz honey', subhead: 'Raw and unfiltered', cta: 'Order now', prices: [{ id: 'p1', item: 'Honey 500 g', price: '60', currency: 'GH₵', unit: '', kitEntryId: null, reviewBy: null }], contacts: [{ id: 'c1', kind: 'phone', value: '024 123 4567', kitEntryId: null, reviewBy: null }], photoIds: ['a1', 'a2'], ...form } };
  return syncPosterFacts(d, 1000);
}

const confirmAll = (d: LinkAdDoc): LinkAdDoc => ({ ...d, confirmations: Object.fromEntries(allFacts(d).map((f) => [f.id, factHash(f)])) });

describe('brand kits', () => {
  it('re-confirms what an edit changes and keeps the history of a renamed price', () => {
    const prev = kit();
    const next = { ...prev, offers: [{ ...prev.offers[0]!, item: 'Standard passport' }] };
    const saved = prepareKitSave(next, prev, '2026-11-02');
    expect(saved.offers[0]).toMatchObject({ item: 'Standard passport', confirmedOn: '2026-11-02', reviewBy: '2026-12-02', previousNames: ['Regular passport'] });
    // Unchanged entries keep their dates.
    expect(saved.contacts[0]).toMatchObject({ confirmedOn: '2026-10-01', reviewBy: '2027-03-30' });
  });

  it('reports prices past their review day, and re-confirming clears them', () => {
    const w = kitWarnings(kit(), '2026-11-02');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ entryId: 'reg', state: 'overdue' });
    expect(w[0]!.message).toMatch(/2 days ago/);
    expect(kitWarnings(reconfirmKit(kit(), ['reg'], '2026-11-02'), '2026-11-02')).toEqual([]);
    expect(kitWarnings(kit(), '2026-10-26')[0]!.state).toBe('due_soon');
  });

  it('fills the Short Ads brand and approved facts, and stale kit facts block the export', () => {
    const k = kit();
    const brand = kitToAdBrand(k, defaultAdSpec().brand);
    expect(brand).toMatchObject({ primary: '#1D4ED8', background: '#0B1530', font: 'Inter' });
    const facts = mergeKitFacts([{ id: 'own', kind: 'url', value: 'example.com', label: '' }], kitApprovedFacts(k));
    expect(facts.map((f) => f.value)).toEqual(['example.com', 'GH₵450', '054 216 1486']);
    expect(staleApprovedFacts(facts, '2026-11-02').map((f) => f.value)).toEqual(['GH₵450']);
    expect(staleFactFindings(facts, '2026-11-02')[0]).toMatchObject({ check: 'fact_mismatch', severity: 'error' });
    const ad = { ...defaultAdSpec(), facts };
    const items = adReadiness({ ad, sheet: null, scenes: [] } as never);
    expect(items.some((i) => i.severity === 'error' && /re-confirmation/.test(i.message))).toBe(staleApprovedFacts(facts).length > 0);
  });
});

describe('Motion Poster Ad: facts and script', () => {
  it('says figures in words', () => {
    expect(spokenPrice('450', 'GH₵')).toBe('four hundred and fifty Ghana cedis');
    expect(spokenPrice('12.50', '$')).toBe('twelve dollars fifty');
    expect(spokenPhone('054 216 1486')).toBe('zero five four, two one six, one four eight six');
    expect(spokenPhone('+233 24')).toBe('plus two three three, two four');
  });

  it('turns the form into facts with stable ids; editing a price takes its confirmation away', () => {
    const d = confirmAll(posterDoc());
    expect(posterFormFacts(d.poster!, null).map((f) => f.id)).toEqual(['pf_headline', 'pf_subhead', 'pf_p_p1', 'pf_c_c1']);
    const edited = syncPosterFacts({ ...d, poster: { ...d.poster!, prices: [{ ...d.poster!.prices[0]!, price: '65' }] } });
    const price = allFacts(edited).find((f) => f.id === 'pf_p_p1')!;
    expect(price.text).toBe('Honey 500 g GH₵65');
    expect(edited.confirmations.pf_p_p1).toBe(d.confirmations.pf_p_p1);
    expect(edited.confirmations.pf_p_p1).not.toBe(factHash(price));
  });

  it('writes a script on the real photos, figures in words, no colons, a text-led call to action and a length in range', () => {
    for (const template of POSTER_TEMPLATES) {
      const d = posterDoc({ template, date: '14 November', place: 'Accra Mall', offer: 'Delivery in Accra' });
      const s = buildPosterScript(d);
      expect(s.scenes[0]!.id).toBe('ps_hook');
      expect(s.scenes[0]!.assetId).toBe('a1');
      expect(s.scenes.at(-1)).toMatchObject({ id: 'ps_cta', assetId: null });
      expect(s.scenes.every((x) => !x.narration.includes(':'))).toBe(true);
      const said = s.scenes.map((x) => x.narration).join(' ');
      expect(said).not.toMatch(/GH₵|\b60\b|\b024\b/);
      expect(said).toMatch(/sixty Ghana cedis/);
      expect(said).toMatch(/zero two four, one two three, four five six seven/);
      expect(s.closing.line).toBe('Call 024 123 4567');
      const st = linkAdStatus({ ...d, ad: { ...d.ad, scenes: s.scenes, closing: s.closing } });
      expect(st.totalSec).toBeGreaterThan(8);
      expect(st.totalSec).toBeLessThan(30);
    }
  });
});

describe('Motion Poster Ad: layout', () => {
  const overlap = (a: PosterItem, b: PosterItem) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;

  it('lays every template out in every format inside the frame, with no text over other text', () => {
    for (const template of POSTER_TEMPLATES) {
      for (const format of POSTER_FORMAT_IDS) {
        const d = posterDoc({ template, date: '14 November', place: 'Accra Mall', prices: [1, 2, 3].map((i) => ({ id: `p${i}`, item: `Item ${i}`, price: `${i}0`, currency: 'GH₵', unit: '', kitEntryId: null, reviewBy: null })) });
        const L = layoutPoster({ poster: d.poster!, brand: d.ad.brand, format, photoAssetIds: ['img1'], logoAssetId: 'logo1', measure: approximateMeasure });
        expect(L.issues.filter((i) => i.severity === 'error'), `${template} ${format}`).toEqual([]);
        for (const it of L.items) {
          expect(it.x).toBeGreaterThanOrEqual(-0.5);
          expect(it.y).toBeGreaterThanOrEqual(-0.5);
          expect(it.x + it.w).toBeLessThanOrEqual(L.width + 0.5);
          expect(it.y + it.h).toBeLessThanOrEqual(L.height + 0.5);
        }
        // Text blocks never overlap one another (a price and its item share a row by design).
        const texts = L.items.filter((i) => i.kind === 'text' && !/^price_|^badge_/.test(i.id));
        for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) expect(overlap(texts[i]!, texts[j]!), `${template} ${format}: ${texts[i]!.id} / ${texts[j]!.id}`).toBe(false);
        expect(L.texts.join(' ')).toContain('Pure Obaapaz honey');
      }
    }
  });

  it('reports a headline that cannot fit instead of cutting it', () => {
    const d = posterDoc({ headline: 'Supercalifragilisticexpialidocious '.repeat(2).trim() });
    const L = layoutPoster({ poster: d.poster!, brand: d.ad.brand, format: '4:5', photoAssetIds: ['img1'], logoAssetId: null, measure: approximateMeasure });
    expect(L.issues.some((i) => i.severity === 'error' && i.field === 'headline')).toBe(true);
  });

  it('a saved poster goes out of date when a price changes', () => {
    const d = posterDoc();
    const h = posterInputHash(d, '4:5');
    expect(posterInputHash(d, '9:16')).not.toBe(h);
    expect(posterInputHash({ ...d, poster: { ...d.poster!, prices: [{ ...d.poster!.prices[0]!, price: '65' }] } }, '4:5')).not.toBe(h);
  });
});

describe('Motion Poster Ad: checks before export', () => {
  it('needs prices confirmed, refuses unsupported claims, and flags stale kit entries', () => {
    const d = posterDoc({ headline: 'Number one honey in Accra' });
    const issues = posterReadiness(d, '2026-11-02');
    expect(issues.some((i) => /Confirm “Honey 500 g GH₵60”/.test(i.message))).toBe(true);
    expect(issues.some((i) => /Headline/.test(i.message) && /number one/i.test(i.message))).toBe(true);
    const ok = confirmAll(posterDoc());
    expect(posterReadiness(ok, '2026-11-02').filter((i) => i.severity === 'error')).toEqual([]);
    const fromKit = confirmAll(syncPosterFacts({ ...ok, brandKit: { kitId: 'k1', name: 'Obaapaz', appliedAt: 1 }, poster: { ...ok.poster!, prices: [{ ...ok.poster!.prices[0]!, kitEntryId: 'o1', reviewBy: '2026-10-30' }] } }));
    expect(posterReadiness(fromKit, '2026-11-02').some((i) => i.severity === 'error' && /re-confirmation on 2026-10-30/.test(i.message))).toBe(true);
    expect(linkAdReadiness({ ...fromKit, ad: { ...fromKit.ad, scenes: buildPosterScript(fromKit).scenes } }, { final: true, today: '2026-11-02' }).some((i) => i.severity === 'error' && /2026-10-30/.test(i.message))).toBe(true);
  });

  it('catches a price the voice said wrong', () => {
    const d = confirmAll(posterDoc());
    const s = buildPosterScript(d);
    const price = s.scenes.find((x) => x.id.startsWith('ps_price'))!;
    const words = 'Honey 500 g, seventy Ghana cedis.'.split(' ').map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.3, confidence: 0.9 }));
    const doc: LinkAdDoc = { ...d, ad: { ...d.ad, scenes: s.scenes, closing: s.closing, takes: { [price.id]: { hash: 'x', assetId: 'v1', jobId: null, fileSec: 3, speechStart: 0, speechEnd: 2.5, words, alignment: 'aligned', coverage: 1, flags: [], source: 'generated', voice: 'Kore', createdAt: 1 } } } };
    const issues = linkAdReadiness(doc, { final: true });
    expect(issues.some((i) => i.severity === 'error' && /70|seventy/.test(i.message) && /GH₵60/.test(i.message))).toBe(true);
  });
});
