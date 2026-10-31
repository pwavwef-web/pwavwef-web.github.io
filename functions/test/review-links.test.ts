import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseReviewComment, parseReviewDecision, REVIEW_LIMITS, reviewRateStamps } from '@az-studio/shared';
import { resetFakes, store } from './fakes';

/** Client review links: the owner API and the public endpoint against the in-memory Firestore. */

vi.mock('../src/lib/firebase', async () => {
  const f = await import('./fakes');
  return { db: f.db, col: f.col, bucket: f.bucket, FieldValue: f.FieldValue, Timestamp: f.Timestamp, gsUri: f.gsUri, pathFromGsUri: f.pathFromGsUri };
});
vi.mock('../src/lib/storage', () => ({ signedReadUrl: async (p: string) => ({ url: `https://storage.example/${p}?sig=1`, expiresAt: 0 }) }));

const { reviewLinks } = await import('../src/api/review-links');
const { handlePublicReview } = await import('../src/public/review');

const owner = { uid: 'u1', email: 'owner@example.com' };
type Link = { url: string; token: string };
type Listed = { links: (Record<string, unknown> & { comments: Record<string, unknown>[] })[] };

function res() {
  const r = { code: 0, body: undefined as unknown, location: '', headers: {} as Record<string, string> };
  const api = {
    status(c: number) {
      r.code = c;
      return api;
    },
    set(k: string, v: string) {
      r.headers[k] = v;
      return api;
    },
    json(b: unknown) {
      r.body = b;
    },
    end() {},
    redirect(c: number, url: string) {
      r.code = c;
      r.location = url;
    },
  };
  return { r, api };
}

const call = async (method: string, path: string, body?: unknown, origin?: string) => {
  const { r, api } = res();
  await handlePublicReview({ method, path, headers: origin ? { origin } : {}, body }, api);
  return r;
};

beforeEach(() => {
  resetFakes();
  store.set('projects/p1', { ownerUid: 'u1', title: 'Passport advert' });
  store.set('renders/r1', { id: 'r1', ownerUid: 'u1', projectId: 'p1', status: 'completed', outputAssetId: 'a1', durationSec: 33, width: 1080, height: 1920 });
  store.set('assets/a1', { ownerUid: 'u1', status: 'ready', storagePath: 'users/u1/renders/a1.mp4', mimeType: 'video/mp4', durationSec: 33, width: 1080, height: 1920 });
});

describe('review link input', () => {
  it('validates comments and decisions', () => {
    expect(parseReviewComment({ atSec: 12.34, text: '  Rename Normal to Regular ', name: '' }, 33)).toEqual({ ok: true, value: { atSec: 12.3, text: 'Rename Normal to Regular', name: 'Client' } });
    expect(parseReviewComment({ atSec: 40, text: 'x' }, 33).ok).toBe(false);
    expect(parseReviewComment({ atSec: 1, text: '   ' }, 33).ok).toBe(false);
    expect(parseReviewDecision({ decision: 'changes_requested', note: '' }).ok).toBe(false);
    expect(parseReviewDecision({ decision: 'approved' })).toMatchObject({ ok: true, value: { decision: 'approved', name: 'Client' } });
  });

  it('rate-limits writes per link', () => {
    let stamps: number[] = [];
    for (let i = 0; i < REVIEW_LIMITS.perMinute; i++) stamps = reviewRateStamps(stamps, 1000 + i)!;
    expect(reviewRateStamps(stamps, 2000)).toBeNull();
    expect(reviewRateStamps(stamps, 70_000)).not.toBeNull();
  });
});

describe('review links', () => {
  it('shares a finished render, takes timed comments and a decision, and can be withdrawn', async () => {
    const { link } = (await reviewLinks(owner, { op: 'create', renderId: 'r1', versionLabel: 'Version 3', expiresInDays: 7 })) as { link: Link };
    expect(link.url).toMatch(/^\/review\/[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(link)).not.toContain('users/u1');
    const path = `/api/public${link.url.replace('/review/', '/review/')}`;

    const view = await call('GET', path);
    expect(view.code).toBe(200);
    expect(view.body).toMatchObject({ title: 'Passport advert', versionLabel: 'Version 3', durationSec: 33, status: 'open', comments: [] });
    expect(JSON.stringify(view.body)).not.toMatch(/ownerUid|storagePath|u1/);

    const media = await call('GET', `${path}/media`);
    expect(media.code).toBe(302);
    expect(media.location).toContain('users/u1/renders/a1.mp4');

    expect((await call('POST', `${path}/comments`, { atSec: 4.2, text: 'Rename Normal to Regular', name: 'Ama' }, 'https://evil.example')).code).toBe(403);
    const commented = await call('POST', `${path}/comments`, { atSec: 4.2, text: 'Rename Normal to Regular', name: 'Ama' }, 'https://az-studio.web.app');
    expect(commented.code).toBe(200);
    expect((commented.body as { comments: unknown[] }).comments).toHaveLength(1);

    const decided = await call('POST', `${path}/decision`, { decision: 'approved', name: 'Ama' });
    expect((decided.body as { status: string }).status).toBe('approved');

    const listed = (await reviewLinks(owner, { op: 'list' })) as unknown as Listed;
    expect(listed.links[0]).toMatchObject({ status: 'approved', commentCount: 1, state: 'open' });
    expect(listed.links[0]!.comments[0]).toMatchObject({ atSec: 4.2, text: 'Rename Normal to Regular', resolved: false });

    await reviewLinks(owner, { op: 'revoke', token: link.token });
    expect((await call('GET', path)).code).toBe(410);
    expect((await call('GET', `${path}/media`)).code).toBe(410);
  });

  it('refuses unfinished renders, other owners and expired links', async () => {
    store.set('renders/r2', { id: 'r2', ownerUid: 'u1', projectId: 'p1', status: 'rendering', outputAssetId: null });
    await expect(reviewLinks(owner, { op: 'create', renderId: 'r2' })).rejects.toThrow(/finished render/);
    await expect(reviewLinks({ uid: 'u2', email: 'x@example.com' }, { op: 'create', renderId: 'r1' })).rejects.toThrow(/not found/);
    const { link } = (await reviewLinks(owner, { op: 'create', renderId: 'r1', expiresInDays: 1 })) as { link: Link };
    const { r, api } = res();
    await handlePublicReview({ method: 'GET', path: `/api/public${link.url}`, headers: {} }, api, Date.now() + 2 * 86_400_000);
    expect(r.code).toBe(410);
    expect((await call('GET', '/api/public/review/short')).code).toBe(404);
  });
});
