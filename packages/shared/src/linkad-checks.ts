import { allFacts, isConfirmed, linkAdStatus, LINKAD_LIMITS, type FactView, type LinkAdDoc } from './linkad';

/**
 * Link to Ad: the rules that keep an ad honest and readable. Everything here is deterministic and shared by
 * the planner (which rejects unsupported model output), the editor (which shows the problems) and the export
 * gate (which refuses to render while a blocking problem remains).
 */

// ---------------------------------------------------------------------------
// Website text is data
// ---------------------------------------------------------------------------

const INSTRUCTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|messages?)/i,
  /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|system)?\s*(?:instructions?|prompts?|rules?)/i,
  /(?:reveal|print|show|output|leak|send)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?|secrets?|api\s*keys?|credentials?|tokens?)/i,
  /you\s+(?:are|must|should)\s+now\s+(?:act|behave|respond|be)\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\b(?:system|assistant|developer)\s*(?:prompt|message)\s*:/i,
  /<\/?\s*(?:system|assistant|instructions?)\s*>/i,
  /\b(?:as|being)\s+an?\s+(?:ai|language\s+model|llm|assistant)\b.{0,40}\b(?:must|should|will)\b/i,
  /\bdo\s+not\s+(?:tell|inform|mention\s+to)\s+the\s+user\b/i,
  /\b(?:call|invoke|run|execute)\s+(?:the\s+)?(?:tool|function|command)\b/i,
  /\bwhen\s+(?:an?\s+)?(?:ai|assistant|chatbot|llm|model)\b.{0,40}\b(?:summari[sz]es?|reads?|analy[sz]es?)\b/i,
];

/**
 * Drops lines that talk to an AI instead of to visitors. They are never part of the material the planner sees;
 * the director is told they were there. (The planner also treats everything on a page as data, so this is a
 * second layer, not the only one.)
 */
export function stripInstructionLines(textIn: string): { text: string; ignored: string[] } {
  const ignored: string[] = [];
  const kept: string[] = [];
  for (const raw of textIn.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && INSTRUCTION_PATTERNS.some((re) => re.test(line))) {
      if (ignored.length < 10) ignored.push(line.slice(0, 280));
      continue;
    }
    kept.push(raw);
  }
  return { text: kept.join('\n'), ignored };
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export type ClaimSeverity = 'error' | 'warning';
export interface ClaimIssue {
  severity: ClaimSeverity;
  kind: 'unsupported_figure' | 'unsupported_claim' | 'unconfirmed_fact' | 'unsupported_date';
  message: string;
  match: string;
}

const CURRENCY = '(?:GH[₵S]|₵|\\$|€|£|₦|USD|GHS|EUR|GBP|NGN|KES|ZAR)';
const MONEY_A = new RegExp(`${CURRENCY}\\s?\\d[\\d,]*(?:\\.\\d+)?`, 'gi');
const MONEY_B = /\d[\d,]*(?:\.\d+)?\s?(?:cedis?|dollars?|euros?|pounds?|naira|usd|ghs|eur|gbp)\b/gi;
const PERCENT = /\d+(?:\.\d+)?\s?%/g;
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_A = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'gi');
const DATE_B = /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b20\d{2}-\d{2}-\d{2}\b/g;

/** Phrases that sell a claim the website must itself make before an ad may. */
const CLAIM_PATTERNS: { re: RegExp; label: string; severity: ClaimSeverity }[] = [
  { re: /\b(?:number\s*(?:one|1)|no\.?\s*1|#\s?1|(?:the\s+)?(?:best|finest|greatest)\s+(?:in|of|on)\b|best[- ]in[- ]class|world[- ]class|leading|top[- ]rated|top[- ]ranked|most\s+(?:popular|trusted|loved|affordable)|unbeat\w+|unrivall?ed)/i, label: 'a ranking or superlative', severity: 'error' },
  { re: /\b(?:award[- ]winning|awarded|winner\s+of|certified|accredited|licensed|official(?:ly)?\s+(?:partner|supplier|dealer))\b/i, label: 'an award, certification or official status', severity: 'error' },
  { re: /\b(?:guarantee[ds]?|money[- ]back|risk[- ]free|no\s+risk|warranty|lifetime)\b/i, label: 'a guarantee', severity: 'error' },
  { re: /\b(?:limited[- ]time|limited\s+offer|while\s+(?:stocks?|supplies)\s+last|hurry|last\s+chance|ends\s+(?:soon|today|tonight)|only\s+\d+\s+(?:left|remaining|rooms?|spots?|seats?)|selling\s+fast|almost\s+gone|sold\s+out)\b/i, label: 'scarcity or urgency', severity: 'error' },
  { re: /\b(?:\d(?:\.\d)?\s*(?:\/\s*5|stars?)|five[- ]star|5[- ]star|rated\b|reviews?\s+say|customers\s+(?:say|love)|guests\s+(?:say|love)|testimonials?|trusted\s+by|loved\s+by)\b/i, label: 'a rating, review or customer claim', severity: 'error' },
  { re: /\b(?:\d[\d,.]*\s*\+?\s*(?:happy\s+)?(?:customers|clients|guests|users|students|families|members))\b/i, label: 'a customer count', severity: 'error' },
  { re: /\b(?:free|complimentary|discounts?|on\s+sale|sale\b|cheapest|lowest\s+price|best\s+price|cut\s+price|promo(?:tion)?|special\s+offer|deal\b)\b/i, label: 'a price promise', severity: 'warning' },
];

const norm = (s: string) => s.toLowerCase().replace(/[\s,]+/g, ' ').trim();
const digits = (s: string) => s.replace(/[^\d.]/g, '').replace(/^0+(?=\d)/, '');

/** Facts that may support wording in an ad: those from the page or the director, in their current text. */
function supportText(facts: FactView[]): string {
  return norm(facts.map((f) => [f.text, f.value ?? '', f.qualifier ?? '', f.excerpt ?? ''].join(' ')).join(' | '));
}

/**
 * Checks ad wording against the available facts. A figure (price, percentage, date) must appear in a fact; one that
 * needs confirmation must also be confirmed. Ranking, award, guarantee, rating and scarcity wording is accepted only
 * when a fact (page or director) already uses that wording. `confirmedFor` says whether a fact is confirmed.
 */
export function checkClaims(textIn: string, facts: FactView[], confirmedFor: (f: FactView) => boolean): ClaimIssue[] {
  const out: ClaimIssue[] = [];
  const t = textIn.replace(/\s+/g, ' ').trim();
  if (!t) return out;
  const support = supportText(facts);

  const figure = (re: RegExp, kinds: FactView['kind'][], what: string, kind: ClaimIssue['kind']) => {
    for (const m of t.matchAll(re)) {
      const raw = m[0]!;
      const d = digits(raw);
      if (!d) continue;
      const holders = facts.filter((f) => digits([f.value ?? '', f.text].join(' ')).includes(d) || norm([f.text, f.value ?? ''].join(' ')).includes(norm(raw)));
      if (!holders.length) {
        out.push({ severity: 'error', kind, message: `“${raw}” (${what}) is not in the website or your own facts. Remove it or add the fact yourself.`, match: raw });
        continue;
      }
      const risky = holders.filter((f) => f.needsConfirmation || kinds.includes(f.kind));
      if (risky.length && !risky.some((f) => confirmedFor(f))) out.push({ severity: 'error', kind: 'unconfirmed_fact', message: `“${raw}” comes from ${risky[0]!.origin === 'user' ? 'your own note' : 'the website'} and has not been confirmed. Confirm it is current, or leave it out.`, match: raw });
    }
  };
  figure(MONEY_A, ['price'], 'a price', 'unsupported_figure');
  figure(MONEY_B, ['price'], 'a price', 'unsupported_figure');
  figure(PERCENT, ['offer', 'price'], 'a percentage', 'unsupported_figure');
  figure(DATE_A, ['date', 'offer'], 'a date', 'unsupported_date');
  figure(DATE_B, ['date', 'offer'], 'a date', 'unsupported_date');

  for (const c of CLAIM_PATTERNS) {
    const m = c.re.exec(t);
    if (!m) continue;
    const phrase = m[0]!;
    if (support.includes(norm(phrase))) continue; // the site itself says it
    out.push({ severity: c.severity, kind: 'unsupported_claim', message: `“${phrase}” is ${c.label}. The website you gave does not say it, so the ad should not either.`, match: phrase });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Colour and layout
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}

/** White or near-black text, whichever reads better on the colour. */
export function readableOn(bg: string): string {
  return contrastRatio('#FFFFFF', bg) >= contrastRatio('#101010', bg) ? '#FFFFFF' : '#101010';
}

function hslOf(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hexOf(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

/** A readable brand palette from the colours found on the site: the main colour, a deep ground made from it, light text and an accent. */
export function deriveBrand(colours: string[]): { primary: string; background: string; text: string; accent: string } {
  const primary = colours[0] && /^#[0-9a-f]{6}$/i.test(colours[0]) ? colours[0].toUpperCase() : '#1F6F5B';
  const [h, s] = hslOf(primary);
  const background = hexOf(h, Math.min(0.55, Math.max(0.25, s)), 0.11);
  const accent = colours[1] && /^#[0-9a-f]{6}$/i.test(colours[1]) && contrastRatio(colours[1], background) >= 4.5 ? colours[1].toUpperCase() : contrastRatio('#F4B84A', background) >= 4.5 ? '#F4B84A' : '#FFFFFF';
  return { primary, background, text: readableOn(background), accent };
}

/** Vertical zones of the 9:16 frame (fractions of its height from the top) so nothing collides. */
export const VERTICAL_ZONES = {
  platformTop: { from: 0, to: 0.08 },
  overlayUpper: { from: 0.1, to: 0.3 },
  logoCta: { from: 0.2, to: 0.34 },
  overlayMiddle: { from: 0.4, to: 0.54 },
  closingHeadline: { from: 0.38, to: 0.52 },
  closingLine: { from: 0.54, to: 0.62 },
  overlayLower: { from: 0.5, to: 0.64 },
  captions: { from: 0.66, to: 0.83 },
  platformBottom: { from: 0.83, to: 1 },
} as const;

/** The pairs that must never overlap in the 9:16 layout. Returned for tests and the editor's layout check. */
export function zoneCollisions(): string[] {
  const z = VERTICAL_ZONES;
  const pairs: [keyof typeof z, keyof typeof z][] = [
    ['overlayUpper', 'captions'],
    ['overlayMiddle', 'captions'],
    ['overlayLower', 'captions'],
    ['closingHeadline', 'captions'],
    ['closingLine', 'captions'],
    ['logoCta', 'closingHeadline'],
    ['closingHeadline', 'closingLine'],
    ['overlayUpper', 'platformTop'],
    ['captions', 'platformBottom'],
  ];
  return pairs.filter(([a, b]) => z[a].from < z[b].to - 1e-9 && z[b].from < z[a].to - 1e-9).map(([a, b]) => `${a} overlaps ${b}`);
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type ReadyArea = 'brief' | 'script' | 'pictures' | 'voice' | 'captions' | 'music' | 'rights';
export interface ReadyIssue {
  severity: 'error' | 'warning';
  area: ReadyArea;
  message: string;
  sceneId: string | null;
}

/** Everything that blocks (errors) or deserves a look (warnings) before an MP4 is rendered. */
export function linkAdReadiness(doc: LinkAdDoc, opts: { final: boolean }): ReadyIssue[] {
  const out: ReadyIssue[] = [];
  const { ad, brief } = doc;
  const add = (severity: ReadyIssue['severity'], area: ReadyArea, message: string, sceneId: string | null = null) => out.push({ severity, area, message, sceneId });
  const facts = allFacts(doc);
  const confirmedFor = (f: FactView) => isConfirmed(doc, f);

  if (!ad.scenes.length) {
    add('error', 'script', 'Choose a direction first — there is no script yet.');
    return out;
  }
  const status = linkAdStatus(doc);

  // Figures and claims in anything the viewer reads or hears.
  const seen = new Set<string>();
  const check = (label: string, text: string, sceneId: string | null) => {
    for (const c of checkClaims(text, facts, confirmedFor)) {
      const key = `${c.kind}|${c.match}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add(c.severity, 'script', `${label}: ${c.message}`, sceneId);
    }
  };
  ad.scenes.forEach((s, i) => {
    check(`Scene ${i + 1} words`, s.narration, s.id);
    check(`Scene ${i + 1} text`, s.overlay, s.id);
    if (s.review) add('warning', 'script', `Scene ${i + 1}: ${s.review}`, s.id);
    if (!s.narration.trim()) add('warning', 'script', `Scene ${i + 1} has no narration.`, s.id);
  });
  check('Closing', `${ad.closing.headline} ${ad.closing.line}`, null);
  check('Destination', brief.destination.value, null);

  // Prices, dates and offers the brief relies on must be confirmed or dropped.
  for (const fid of brief.usedFactIds) {
    const f = facts.find((x) => x.id === fid);
    if (f && f.needsConfirmation && !confirmedFor(f)) add(opts.final ? 'error' : 'warning', 'brief', `“${f.text.slice(0, 80)}” is a ${f.kind} that has not been confirmed. Confirm it is current, or remove it from the ad.`);
  }
  if (!brief.destination.value.trim()) add('warning', 'brief', 'The ad has no website or contact detail for people to act on.');
  if (!ad.closing.headline.trim() && !ad.closing.line.trim()) add('warning', 'script', 'The ad has no closing call to action.');

  // Pictures: stored, with the right to use them, and reviewed when they could mislead.
  const byId = new Map(doc.source.assets.map((a) => [a.id, a]));
  const usedAssets = new Set<string>();
  ad.scenes.forEach((s, i) => {
    if (!s.assetId) return;
    const a = byId.get(s.assetId);
    if (!a || a.status !== 'stored' || !a.assetId) {
      add('error', 'pictures', `Scene ${i + 1} uses a picture that is not available. Choose another.`, s.id);
      return;
    }
    usedAssets.add(a.id);
    if (a.rights !== 'confirmed') add('error', 'rights', `Scene ${i + 1}'s picture needs your confirmation that you may use it. Public availability is not a licence.`, s.id);
    if (a.needsReview && !a.reviewed) add('error', 'pictures', `Scene ${i + 1}'s picture was generated or changed by AI. Look at it and mark it reviewed before export.`, s.id);
    if (a.width && a.height && Math.max(a.width, a.height) < 640) add('warning', 'pictures', `Scene ${i + 1}'s picture is small (${a.width}×${a.height}) and will look soft. Use a larger one or a text-led scene.`, s.id);
  });
  if (!ad.scenes.some((s) => s.assetId)) add('warning', 'pictures', 'No scene has a picture, so the ad is text-led. That works, but real pictures sell better.');
  const logo = brief.logoId ? byId.get(brief.logoId) : null;
  if (ad.closing.showLogo && logo && logo.status === 'stored' && logo.rights !== 'confirmed') add('error', 'rights', 'The logo needs your confirmation that you may use it.');
  if (ad.closing.showLogo && !logo) add('warning', 'pictures', 'No logo is selected, so the closing shows the name in type only.');

  // Voice, length, captions.
  if (!status.voiceComplete) add('error', 'voice', status.scenesNeedingVoice.length ? `The voice is missing or out of date for ${status.scenesNeedingVoice.length} scene${status.scenesNeedingVoice.length === 1 ? '' : 's'}. Make the voice first.` : 'There is no narration to record.');
  if (status.lengthProblem) add(status.totalSec > LINKAD_LIMITS.durationMax + 0.25 || status.totalSec < LINKAD_LIMITS.durationMin - 0.25 ? 'error' : 'warning', 'script', status.lengthProblem);
  for (const [sid, take] of Object.entries(ad.takes)) {
    if (take.alignment === 'estimated' && ad.scenes.some((s) => s.id === sid)) add('warning', 'captions', 'Some caption timing is estimated, not measured from the audio. Check it by ear.', sid);
    for (const flag of take.flags) if (flag.startsWith('missing_words') || flag.startsWith('extra_words')) add('warning', 'voice', `Scene voice: ${flag.replace(/^[a-z_]+:\s*/, '')}`, sid);
  }
  if (ad.captions.enabled) {
    const box = ad.captions.preset === 'boxed';
    const ratio = contrastRatio(ad.captions.color, box ? '#000000' : '#000000');
    if (ratio < 4.5) add('error', 'captions', `The caption colour is too dark to read (contrast ${ratio}:1). Choose a lighter colour.`);
    if (ad.captions.sizePct < 2.6) add('warning', 'captions', 'Captions are small for a phone screen.');
  }
  const bgContrast = contrastRatio(ad.brand.text, ad.brand.background);
  if (bgContrast < 4.5) add('error', 'captions', `Text colour on the brand colour is hard to read (contrast ${bgContrast}:1).`);

  // Music: only what the director may use.
  if (ad.music.assetId && !ad.music.rightsConfirmed) add('error', 'music', 'Confirm you may use the chosen music in an advert, or remove it.');

  return out;
}
