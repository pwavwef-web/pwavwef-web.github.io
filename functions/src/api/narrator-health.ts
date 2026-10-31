import {
  DEFAULT_PLAYER_THEME,
  azStudioEmbedHtml,
  compareEmbed,
  playerUrl,
  publicationExportState,
  readPlayerBlock,
  type EmbedProblem,
  type NarratorEditionDoc,
  type NarratorExportDoc,
  type NarratorPublicationDoc,
  type NarratorRequest,
  type PlayerBlock,
  type PublicationExportState,
} from '@az-studio/shared';
import { ImportError, fetchAllowedPage } from '../lib/narrator-import';
import { ncol } from '../lib/narrator-store';
import type { Owner } from '../lib/owner';
import { assertRateLimit } from '../lib/usage';

type Req = Extract<NarratorRequest, { op: 'publicationHealth' }>;

export type PostCheck =
  | { status: 'current'; url: string; block: PlayerBlock; problems: [] }
  | { status: 'outdated' | 'missing'; url: string; block: PlayerBlock; problems: EmbedProblem[] }
  | { status: 'unreachable'; url: string; message: string }
  | { status: 'unchecked'; url: string | null; message: string };

export interface PublicationHealthRow {
  publicId: string;
  editionId: string;
  title: string;
  revision: number;
  liveExportVersion: number | null;
  publishedAt: number | null;
  /** The edition's record of what is published agrees with the publication (it should, always). */
  consistent: boolean;
  exports: PublicationExportState;
  post: PostCheck;
  listenUrl: string;
  /** Today's post markup, with the theme the live post asks for (or the default). */
  markup: string;
}

/** Posts are fetched a few at a time; each fetch has the importer's own time and size caps. */
const CONCURRENCY = 3;

async function checkPost(url: string | null, publicId: string): Promise<PostCheck> {
  if (!url) return { status: 'unchecked', url: null, message: 'This edition has no article link.' };
  try {
    const page = await fetchAllowedPage(url);
    const block = readPlayerBlock(page.html, publicId);
    const problems = compareEmbed(block, publicId);
    if (!problems.length) return { status: 'current', url: page.url, block, problems: [] };
    return { status: block.found ? 'outdated' : 'missing', url: page.url, block, problems };
  } catch (e) {
    return { status: e instanceof ImportError && /Only articles on/.test(e.message) ? 'unchecked' : 'unreachable', url, message: e instanceof ImportError ? e.message : 'The post could not be read.' };
  }
}

/**
 * Every published paper: the live revision and the export it plays, a newer export of the same edition waiting to be
 * published, and whether the live post's player block matches today's markup. Read-only: nothing is published,
 * changed or sent anywhere; posts are read with the article importer's protections.
 */
export async function publicationHealth(owner: Owner, p: Req): Promise<{ checkedAt: number; rows: PublicationHealthRow[] }> {
  await assertRateLimit(owner.uid, 1, p.checkPosts ? 6 : 30);
  const want = p.publicIds?.length ? new Set(p.publicIds) : null;
  const pubs = (await ncol.publications().where('ownerUid', '==', owner.uid).get()).docs
    .map((d) => ({ id: d.id, pub: d.data() as NarratorPublicationDoc }))
    .filter((x) => x.pub.status === 'published' && x.pub.current && (!want || want.has(x.id)))
    .slice(0, 50);
  const rows: PublicationHealthRow[] = new Array(pubs.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < pubs.length; i = next++) {
      const { id, pub } = pubs[i]!;
      const edSnap = await ncol.editions().doc(pub.editionId).get();
      const edition = edSnap.exists ? (edSnap.data() as NarratorEditionDoc) : null;
      const exports = (await ncol.exports(pub.editionId).get()).docs.map((d) => ({ ...(d.data() as NarratorExportDoc), id: d.id }));
      const post = p.checkPosts ? await checkPost(pub.current!.articleUrl ?? edition?.sourceUrl ?? null, id) : { status: 'unchecked' as const, url: pub.current!.articleUrl, message: 'Not checked.' };
      const theme = 'block' in post ? post.block.theme : null;
      const title = edition?.title ?? pub.current!.title;
      rows[i] = {
        publicId: id,
        editionId: pub.editionId,
        title,
        revision: pub.revision,
        liveExportVersion: pub.current!.exportVersion,
        publishedAt: pub.current!.publishedAt,
        consistent: Boolean(edition?.publication && edition.publication.publicId === id && edition.publication.exportId === pub.current!.exportId && edition.publication.revision === pub.revision),
        exports: publicationExportState(pub, exports.filter((e) => e.ownerUid === owner.uid)),
        post,
        listenUrl: playerUrl(id),
        markup: azStudioEmbedHtml(id, title, { theme: theme ?? DEFAULT_PLAYER_THEME }),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pubs.length) }, worker));
  rows.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  return { checkedAt: Date.now(), rows };
}
