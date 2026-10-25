import '../../../tests/acceptance/setup';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PLANNER_SYSTEM, buildBriefPrompt, buildDirectionsPrompt, costFromUsage, defaultLinkAd, parseBrief, parseDirections, type LinkAdDoc } from '@az-studio/shared';
import { PRICING } from '../../../functions/src/config/pricing';
import { BRIEF_SCHEMA, DIRECTIONS_SCHEMA } from '../../../functions/src/lib/linkad-model';
import { applySiteRead, readSite } from '../../../functions/src/lib/linkad-site';
import { callReasoning } from '../../../functions/src/workers/text';

/**
 * LIVE check of Link to Ad's reading and planning against a real public page and the real planning model.
 * It reads the page through the studio's safe reader (real network), then asks the real reasoning model for the
 * brief and the three directions, and validates every answer with the same checks the product applies.
 *
 *   - It writes NOTHING to the studio's database, storage or billing records.
 *   - It never generates audio, images or video. The only billable calls are two text requests.
 *
 *   AZS_ACCEPTANCE=1 node --dns-result-order=ipv6first scripts/production/run.mjs scripts/production/link-ad/live-check.ts [url]
 */

const url = process.argv[2] ?? 'https://az-studio.web.app/';
const out = path.join(process.cwd(), 'exports', 'link-to-ad-sample');
mkdirSync(out, { recursive: true });
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

let doc: LinkAdDoc = defaultLinkAd({ url, maxPages: 3, rightsConfirmed: false });
const t0 = Date.now();
const read = await readSite(doc.input, {});
doc = { ...doc, source: applySiteRead(doc, read, Date.now()) };
log(`read ${read.pages.length} page(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${read.pages.map((p) => `${p.status} ${p.url}`).join(' | ')}`);
log(`facts ${doc.source.facts.length} (${[...new Set(doc.source.facts.map((f) => f.kind))].join(', ')}); pictures found ${doc.source.assets.length}; warnings ${doc.source.warnings.length}; conflicts ${doc.source.conflicts.length}`);
if (!doc.source.facts.length) throw new Error('nothing could be read from this page');

let usd = 0;
async function ask(prompt: string, schema: Record<string, unknown>, level: 'LOW' | 'MEDIUM') {
  const r = await callReasoning([{ text: prompt }], { systemInstruction: PLANNER_SYSTEM, responseJsonSchema: schema }, level);
  const u = r.res.usageMetadata;
  const cost = costFromUsage('text', { inputTokens: u?.promptTokenCount ?? 0, outputTokens: u?.candidatesTokenCount ?? 0, thoughtTokens: u?.thoughtsTokenCount ?? 0 }, PRICING, r.modelId);
  usd += cost;
  log(`${r.modelId}: ${u?.promptTokenCount ?? 0} in / ${u?.candidatesTokenCount ?? 0} out / ${u?.thoughtsTokenCount ?? 0} thoughts → ≈ $${cost.toFixed(4)} (${(r.latencyMs / 1000).toFixed(1)} s)`);
  return r.json;
}

const body = read.extracted.map((p) => `# ${p.title}\n${p.text}`).join('\n\n');
const briefJson = await ask(buildBriefPrompt(doc, body), BRIEF_SCHEMA, 'LOW');
const { brief, problems } = parseBrief(briefJson, doc);
doc = { ...doc, brief: { ...doc.brief, ...brief, audience: brief.audience ?? doc.brief.audience, benefit: brief.benefit ?? doc.brief.benefit, destination: brief.destination ?? doc.brief.destination } };
log(`brief: focus “${doc.brief.focus}” · audience (AI) “${doc.brief.audience.text}” · action “${doc.brief.action}” · destination ${doc.brief.destination.kind} ${doc.brief.destination.value} · uses ${doc.brief.usedFactIds.length} facts`);
if (problems.length) log(`brief notes: ${problems.join(' ')}`);

const dirJson = await ask(buildDirectionsPrompt(doc), DIRECTIONS_SCHEMA, 'MEDIUM');
const first = parseDirections(dirJson, doc);
log(`directions: ${first.directions.length} usable · checks asked for fixes: ${first.feedback.length}`);
for (const f of first.feedback) log(`  fix: ${f}`);
for (const d of first.directions) log(`  [${d.kind}] ${d.title} — hook “${d.hook}” — ${d.scenes.length} scenes, ${d.scenes.reduce((n, s) => n + s.narration.split(/\s+/).length, 0)} words`);

writeFileSync(path.join(out, 'live-check.json'), JSON.stringify({ url, readAt: new Date().toISOString(), pages: read.pages, factCount: doc.source.facts.length, facts: doc.source.facts.slice(0, 40), brief: doc.brief, briefNotes: problems, directions: first.directions, checkFeedback: first.feedback, costUsd: Math.round(usd * 1e5) / 1e5 }, null, 2));
log(`total model cost ≈ $${usd.toFixed(4)} (published list prices). Wrote exports/link-to-ad-sample/live-check.json`);
