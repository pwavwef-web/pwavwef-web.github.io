/**
 * Brand safety before generation. Image and video models draw real brands on the objects that usually carry them
 * (a motorbike gets a manufacturer's name on its tank, a phone gets a maker's logo), and another brand must never
 * appear in an advert or film. The linter finds brand-prone objects and brand names in a brief, proposes safer
 * wording ("plain unbranded motorbike, no logos or lettering") for the director to accept, and compiles the
 * matching no-logo clause that generation prompts carry automatically.
 */

export interface BrandRiskGroup {
  id: string;
  label: string;
  /** Matches the object as a whole word or phrase. */
  pattern: RegExp;
  /** What to keep plain, in the no-logo clause. */
  plain: string;
}

export const BRAND_RISK_GROUPS: readonly BrandRiskGroup[] = [
  { id: 'vehicle', label: 'vehicles', pattern: /\b(?:cars?|vehicles?|trucks?|lorr(?:y|ies)|buses|bus|taxis?|vans?|pick-?ups?|suvs?|tro-?tros?|motorbikes?|motorcycles?|scooters?|okadas?|bicycles?|bikes?|tractors?)\b/gi, plain: 'vehicles with no badges, emblems, model names or lettering' },
  { id: 'phone', label: 'phones and devices', pattern: /\b(?:(?:smart|mobile |cell)?phones?|iphones?|smartphones?|cellphones?|laptops?|computers?|tablets?|ipads?|macbooks?|headphones?|earbuds?|earphones?|game consoles?|smart ?watch(?:es)?|wristwatch(?:es)?)\b/gi, plain: 'devices with no maker logos, app icons or lettering' },
  { id: 'screen', label: 'screens', pattern: /\b(?:tvs?|televisions?|monitors?|screens?|displays?)\b/gi, plain: 'screens showing no logos, app interfaces or readable text' },
  { id: 'footwear', label: 'shoes', pattern: /\b(?:shoes?|sneakers?|trainers?|boots?|sandals?|slippers?|footwear)\b/gi, plain: 'footwear with no swooshes, stripes, logos or lettering' },
  { id: 'clothing', label: 'branded clothing', pattern: /\b(?:t-?shirts?|tees?|hoodies?|sweatshirts?|jerseys?|caps?|baseball caps?|tracksuits?|sportswear|football kits?|sports kits?|kits?|uniforms?|jackets?|backpacks?|bags?)\b/gi, plain: 'clothing and bags with no logos, prints of brands or lettering' },
  { id: 'drink', label: 'drinks', pattern: /\b(?:cans?|soda|soft drinks?|fizzy drinks?|bottles?|beers?|drinks?|juice boxes?|juices?|water bottles?|sachets?|cups? of coffee|coffee cups?|energy drinks?)\b/gi, plain: 'drink containers that are plain, with no labels, logos or lettering' },
  { id: 'food', label: 'packaged food', pattern: /\b(?:packaged food|snacks?|chips|crisps|biscuits?|cereal(?: box(?:es)?)?|packets?|wrappers?|cartons?|tins?|takeaway boxes?|fast food|groceries|products? on shelves|shelves)\b/gi, plain: 'packaging that is plain, with no labels, logos or lettering' },
  { id: 'sports', label: 'sports kit', pattern: /\b(?:footballs?|soccer balls?|basketballs?|rackets?|gym equipment|jersey numbers?)\b/gi, plain: 'sports equipment with no brand marks' },
  { id: 'signage', label: 'signs', pattern: /\b(?:signs?|signage|billboards?|shop ?fronts?|storefronts?|posters?|banners?|storefront signs?|menus?|price tags?|labels?|stickers?|newspapers?|magazines?|books?)\b/gi, plain: 'signs and printed surfaces that are blank or show only unreadable shapes' },
];

/** Well-known brand names a brief should not ask for. */
const BRANDS = /\b(?:nike|adidas|puma|reebok|apple|iphone|samsung|tecno|infinix|huawei|xiaomi|google pixel|sony|lg|dell|hp|lenovo|toyota|honda|nissan|kia|hyundai|mercedes(?:-benz)?|bmw|audi|volkswagen|vw|ford|yamaha|suzuki|bajaj|tvs|coca-?cola|coke|pepsi|fanta|sprite|red bull|guinness|heineken|star beer|club beer|milo|nestl[eé]|indomie|kfc|mcdonald'?s|starbucks|mtn|vodafone|airteltigo|telecel|shell|total(?:energies)?|rolex|casio|gucci|louis vuitton|chanel|playstation|xbox|nintendo|netflix|youtube|facebook|instagram|tiktok|whatsapp)\b/gi;

/** Already safe: the brief says plain, unbranded or no logos near the object. */
const SAFE_NEAR = /\b(?:plain|unbranded|generic|unlabell?ed|blank|no (?:logos?|labels?|branding|lettering|text)|without (?:logos?|labels?|branding|lettering))\b/i;

export interface BrandRisk {
  group: string;
  label: string;
  /** The words matched in the brief. */
  match: string;
  index: number;
  /** Proposed replacement for the matched words. */
  suggestion: string;
}

export interface BrandLint {
  risks: BrandRisk[];
  /** Brand names in the brief (always a problem: describe the object instead). */
  brands: string[];
  /** One sentence per problem, for the editor. */
  warnings: string[];
  /** The brief with every risky object made plain (brand names replaced by "unbranded"). */
  saferText: string;
}

/** Finds brand-prone objects and brand names in a brief and proposes safer wording. */
export function lintBrief(text: string): BrandLint {
  const risks: BrandRisk[] = [];
  const brands = [...new Set([...text.matchAll(BRANDS)].map((m) => m[0]))];
  for (const g of BRAND_RISK_GROUPS) {
    for (const m of text.matchAll(g.pattern)) {
      const i = m.index ?? 0;
      const around = text.slice(Math.max(0, i - 40), i + m[0].length + 40);
      if (SAFE_NEAR.test(around)) continue;
      if (risks.some((r) => r.index === i)) continue;
      risks.push({ group: g.id, label: g.label, match: m[0], index: i, suggestion: `plain unbranded ${m[0]}, no logos or lettering` });
    }
  }
  risks.sort((a, b) => a.index - b.index);
  let saferText = text;
  for (const r of [...risks].sort((a, b) => b.index - a.index)) saferText = `${saferText.slice(0, r.index)}plain unbranded ${r.match}${saferText.slice(r.index + r.match.length)}`;
  for (const b of brands) saferText = saferText.replace(new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), 'unbranded');
  if (risks.length && !/no logos or lettering/i.test(saferText)) saferText = `${saferText.replace(/[\s.]+$/, '')}. No logos, brand names or lettering on anything.`;
  const warnings = [
    ...brands.map((b) => `“${b}” is a real brand: describe the object instead (the generator draws its logo).`),
    ...[...new Set(risks.map((r) => r.group))].map((id) => {
      const list = risks.filter((r) => r.group === id).map((r) => `“${r.match}”`);
      const g = BRAND_RISK_GROUPS.find((x) => x.id === id)!;
      return `${[...new Set(list)].join(', ')}: ${g.label} are often drawn with a real brand — say “plain unbranded …, no logos or lettering”.`;
    }),
  ];
  return { risks, brands, warnings, saferText };
}

/**
 * The no-logo clause for a compiled generation prompt: names what the brief's brand-prone objects must look like.
 * Empty when the brief has none (prompts stay unchanged, so their input hashes do too).
 */
export function noLogoClause(text: string): string {
  const lint = lintBrief(text);
  const groups = [...new Set(lint.risks.map((r) => r.group))].map((id) => BRAND_RISK_GROUPS.find((g) => g.id === id)!);
  if (!groups.length && !lint.brands.length) return '';
  const parts = groups.map((g) => g.plain);
  return `Brand safety: every object is generic and unbranded — ${[...parts, 'no real brand names, logos, emblems or watermarks anywhere'].join('; ')}.`;
}
