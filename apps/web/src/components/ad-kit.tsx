import { toast } from 'sonner';
import { kitApprovedFacts, kitPhotosFirst, kitToAdBrand, mergeKitFacts, staleApprovedFacts, type AdAssetRef, type AdSpec } from '@az-studio/shared';
import { KitPicker } from './brand-kit-picker';
import { Card, Notice } from './ui';

/**
 * Short Ads: fills the brief's brand (colours, font, licensed font file, logo and where it came from), the approved
 * facts (the kit's prices and contacts, with their review-by days) and the asset list (the kit's real photos first)
 * from a brand kit. The draft is saved by the browser as usual; facts past their review day block export.
 */
export function AdKitCard({ ad, update }: { ad: AdSpec; update: (fn: (a: AdSpec) => AdSpec) => void }) {
  const stale = staleApprovedFacts(ad.facts);
  return (
    <Card className="space-y-3 p-5">
      <p className="eyebrow">Brand kit</p>
      <KitPicker
        appliedKitId={ad.brandKit?.kitId ?? null}
        hint="Fills the brand colours, font and logo, the approved facts (prices and contacts) and adds the client's real photos to your assets."
        onApply={(k) => {
          const kit = k.kit;
          update((a) => {
            const have = new Set(a.assets.map((x) => x.assetId));
            const add: AdAssetRef[] = [
              ...kit.logos.slice(0, 1).map((l) => ({ assetId: l.assetId, role: 'logo' as const, label: l.label || `${kit.name} logo`, note: `From the brand kit “${kit.name}”` })),
              ...kitPhotosFirst(kit).map((ph) => ({ assetId: ph.assetId, role: 'photo' as const, label: ph.label || ph.product || 'Photo', note: `From the brand kit “${kit.name}”${ph.real ? ' · real photo — use it instead of generating a picture' : ''}` })),
            ].filter((x) => !have.has(x.assetId));
            const website = kit.contacts.find((c) => c.kind === 'website');
            return {
              ...a,
              brand: kitToAdBrand(kit, a.brand),
              facts: mergeKitFacts(a.facts, kitApprovedFacts(kit)),
              assets: [...a.assets, ...add],
              brief: { ...a.brief, brand: a.brief.brand || kit.name, destinationUrl: a.brief.destinationUrl || (website ? (website.value.startsWith('http') ? website.value : `https://${website.value}`) : '') },
              brandKit: { kitId: k.id, name: kit.name, appliedAt: Date.now() },
            };
          });
          toast.success(`Applied “${kit.name}”`, { description: kit.photos.some((p) => p.real) ? 'Its real photos are in your assets — use photo scenes for them rather than generated pictures.' : 'Colours, font, logo and approved facts are filled in.' });
        }}
      />
      {stale.length > 0 && (
        <Notice tone="warning">
          {stale.length} approved fact{stale.length === 1 ? '' : 's'} from the kit {stale.length === 1 ? 'is' : 'are'} past the review day ({stale.map((f) => f.value).slice(0, 4).join(', ')}). Re-confirm in the kit and apply it again before exporting.
        </Notice>
      )}
    </Card>
  );
}
