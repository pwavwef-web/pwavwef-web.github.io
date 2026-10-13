import './common';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { col, loadState, say, WORK } from './common';

// Usage: 04-inspection.ts <v1..v4>   prints the final-inspection findings of the latest final render
const key = process.argv[2]!;
const st = loadState();
const renderId = st.renders[key] as string;
const r = (await col.renders().doc(renderId).get()).data() as { finalInspection?: { id: string; score?: number; readiness?: string } };
const fi = r.finalInspection!;
const d = (await col.projects().doc(st.projects[key]).collection('finalInspections').doc(fi.id).get()).data() as Record<string, unknown>;
writeFileSync(path.join(WORK, 'renders', `${key}-final-inspection.json`), JSON.stringify(d, null, 1));
say(`score ${fi.score} readiness ${fi.readiness}`);
const findings = (d.findings as Record<string, unknown>[]) ?? [];
for (const f of findings) say(`${String(f.severity).padEnd(8)} ${String(f.category ?? f.kind ?? '')} | t=${JSON.stringify(f.timeSec ?? f.time ?? f.at ?? '')} | ${String(f.message ?? f.summary ?? f.detail ?? JSON.stringify(f)).slice(0, 420)}`);
process.exit(0);
