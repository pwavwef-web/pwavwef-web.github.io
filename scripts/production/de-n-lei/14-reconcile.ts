import { col, loadState, say } from './common';
const st = loadState();
const known = new Set([...Object.values(st.genJobs ?? {}), ...Object.values(st.supersededJobs ?? {})] as string[]);
const snap = await col.jobs().where('projectId', '==', st.projectId).get();
const orphans = snap.docs.filter((d) => d.get('type') === 'video.generate' && !known.has(d.id) && /De N Lei · \d\d/.test(String(d.get('label'))));
for (const d of orphans) console.log('ORPHAN', d.id, d.get('status'), d.get('label'));
say(`${snap.size} jobs in project, ${orphans.length} unrecorded video jobs`);
