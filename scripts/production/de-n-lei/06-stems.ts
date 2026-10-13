import { col, loadState, patchState, say, getJob } from './common';
const st = loadState();
const job = await getJob(st.stemsJobId);
say(`stems ${job.status} ${job.stage}`);
if (job.status === 'completed') { patchState({ stems: (job.result as any)?.data?.stems }); console.log(JSON.stringify((job.result as any)?.data?.stems)); }
void col;
