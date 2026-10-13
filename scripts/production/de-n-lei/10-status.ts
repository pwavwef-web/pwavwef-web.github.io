import { loadState, getJob, say } from './common';
const st = loadState();
const rows: string[] = [];
let spent = 0;
for (const [k, id] of Object.entries(st.genJobs ?? {}) as [string, string][]) {
  const j: any = await getJob(id);
  rows.push(`${k.padEnd(14)} ${String(j.status).padEnd(11)} ${(j.stage ?? '').slice(0, 60)} ${j.result?.assetIds?.[0] ?? j.error?.message?.slice(0, 80) ?? ''}`);
  spent += j.costUsd ?? j.cost?.usd ?? 0;
}
console.log(rows.join('\n'));
say(`${rows.length} jobs`);
