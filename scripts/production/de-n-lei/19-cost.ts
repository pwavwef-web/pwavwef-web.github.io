import { col, loadState, say } from './common';
const st = loadState();
const p = (await col.projects().doc(st.projectId).get()).data()!;
say(`project usage: ${JSON.stringify(p.usage)}`);
const jobs = await col.jobs().where('projectId', '==', st.projectId).get();
const byType: Record<string, { n: number; usd: number }> = {};
for (const d of jobs.docs) { const t = String(d.get('type')); const c = Number(d.get('costUsd') ?? d.get('cost')?.usd ?? 0); byType[t] = { n: (byType[t]?.n ?? 0) + 1, usd: +((byType[t]?.usd ?? 0) + c).toFixed(3) }; }
console.log(JSON.stringify(byType));
