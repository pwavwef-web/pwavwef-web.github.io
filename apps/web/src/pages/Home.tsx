import { useState } from 'react';
import { Link } from 'react-router';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { ArrowRight, Clapperboard, Film, HardDrive, Image as ImageIcon, Music2, Scissors, Sparkles, Star } from 'lucide-react';
import { formatBytes, formatUsd, type AssetDoc, type JobDoc, type UsageAggregate } from '@az-studio/shared';
import { db } from '../lib/firebase';
import { useDoc, useQuery } from '../lib/data';
import { useBoot, useUid } from '../lib/session';
import { useProjects } from '../lib/studio';
import { useActiveJobs } from '../components/shell';
import { JobCard } from '../components/jobs';
import { AssetThumb } from '../components/media';
import { NewProjectDialog, ProjectCard } from '../components/projects';
import { Button, Card, EmptyState, ErrorState, ProgressBar, SectionHeader, Skeleton } from '../components/ui';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const QUICK = [
  { to: '/create/video', label: 'Quick Video', body: 'Text, image or reference to a finished clip', icon: Film },
  { to: '/create?mode=music_video', label: 'Music Video', body: 'Build a video around a finished song', icon: Music2 },
  { to: '/create?mode=film', label: 'Film', body: 'Idea → screenplay → shots → final cut', icon: Clapperboard },
  { to: '/create/image', label: 'Image Studio', body: 'Characters, locations, posters, frames', icon: ImageIcon },
  { to: '/create/remix', label: 'Video Remix', body: 'Edit an existing clip conversationally', icon: Scissors },
];

function UsageCard() {
  const boot = useBoot();
  const uid = useUid();
  const day = new Date().toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const today = useDoc<UsageAggregate>(uid ? `usageDaily/${uid}_${day}` : null);
  const mon = useDoc<UsageAggregate>(uid ? `usageMonthly/${uid}_${month}` : null);
  const settings = boot?.settings;
  const t = today.data?.costUsd ?? 0;
  const m = mon.data?.costUsd ?? 0;
  const byModel = Object.entries(mon.data?.byModel ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return (
    <Card className="p-5">
      <p className="eyebrow">Vertex usage estimate</p>
      <div className="mt-3 grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-faint">Today</p>
          <p className="display text-3xl">{formatUsd(t)}</p>
          <ProgressBar value={settings?.dailyLimitUsd ? t / settings.dailyLimitUsd : 0} className="mt-2" label="Daily limit used" />
          <p className="mt-1 text-[11px] text-faint">of {formatUsd(settings?.dailyLimitUsd ?? 0)} daily limit</p>
        </div>
        <div>
          <p className="text-xs text-faint">This month</p>
          <p className="display text-3xl">{formatUsd(m)}</p>
          <ProgressBar value={settings?.monthlyLimitUsd ? m / settings.monthlyLimitUsd : 0} className="mt-2" label="Monthly limit used" />
          <p className="mt-1 text-[11px] text-faint">of {formatUsd(settings?.monthlyLimitUsd ?? 0)} monthly limit</p>
        </div>
      </div>
      {byModel.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t border-line pt-3 text-xs">
          {byModel.map(([model, usd]) => (
            <li key={model} className="flex justify-between gap-2">
              <span className="truncate text-dim">{model}</span>
              <span className="timecode text-fg">{formatUsd(usd)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-faint">Estimated from recorded token usage at Google’s published list prices ({boot?.pricing.version}). Check Cloud Billing for invoiced amounts.</p>
    </Card>
  );
}

function StorageCard() {
  const uid = useUid();
  const user = useDoc<{ stats?: { storageBytes?: number; assetCount?: number } }>(uid ? `users/${uid}` : null);
  const bytes = user.data?.stats?.storageBytes ?? 0;
  return (
    <Card className="p-5">
      <p className="eyebrow">Storage</p>
      <div className="mt-3 flex items-center gap-3">
        <div className="grid size-11 place-items-center rounded-xl bg-accent/10 text-accent-2">
          <HardDrive className="size-5" />
        </div>
        <div>
          <p className="display text-3xl">{formatBytes(bytes)}</p>
          <p className="text-xs text-faint">{user.data?.stats?.assetCount ?? 0} media files in the private bucket</p>
        </div>
      </div>
    </Card>
  );
}

export default function Home() {
  const uid = useUid();
  const projects = useProjects({ status: 'active' });
  const active = useActiveJobs();
  const recentDone = useQuery<JobDoc>(() => (uid ? query(collection(db, 'jobs'), where('ownerUid', '==', uid), orderBy('createdAt', 'desc'), limit(4)) : null), [uid]);
  const favourites = useQuery<AssetDoc>(() => (uid ? query(collection(db, 'assets'), where('ownerUid', '==', uid), where('favorite', '==', true), orderBy('createdAt', 'desc'), limit(8)) : null), [uid]);
  const [newOpen, setNewOpen] = useState(false);
  const jobs = active.data.length ? active.data : recentDone.data;

  return (
    <div className="space-y-12">
      <section className="relative overflow-hidden rounded-[28px] border border-line bg-gradient-to-br from-[#0f1d38] via-[#0a1120] to-[#06080d] px-6 py-9 sm:px-10 sm:py-12">
        <div className="pointer-events-none absolute -top-24 -right-24 size-[420px] rounded-full bg-[radial-gradient(circle,rgba(76,141,255,0.25),transparent_65%)]" aria-hidden />
        <p className="eyebrow">AZ Studio</p>
        <h1 className="display mt-3 max-w-3xl text-[44px] leading-[1.02] sm:text-6xl">
          {greeting()}. <span className="text-dim italic">What are we shooting?</span>
        </h1>
        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {QUICK.map((q) => (
            <Link key={q.to} to={q.to} className="group glass rounded-2xl p-4 transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-[var(--shadow-glow)]">
              <q.icon className="size-5 text-accent-2" aria-hidden />
              <p className="mt-3 text-sm font-semibold text-fg">{q.label}</p>
              <p className="mt-0.5 text-xs leading-snug text-dim">{q.body}</p>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-12">
          <section>
            <SectionHeader
              eyebrow="Projects"
              title="Recent work"
              action={
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setNewOpen(true)} icon={<Sparkles className="size-4" />}>
                    New project
                  </Button>
                  <Link to="/projects" className="inline-flex items-center gap-1 text-sm text-accent-2 hover:underline">
                    All projects <ArrowRight className="size-4" />
                  </Link>
                </div>
              }
            />
            <div className="mt-5">
              {projects.error ? (
                <ErrorState error={projects.error} />
              ) : projects.loading ? (
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  {Array.from({ length: 3 }, (_, i) => (
                    <Skeleton key={i} className="aspect-[16/10] rounded-2xl" />
                  ))}
                </div>
              ) : projects.data.length === 0 ? (
                <EmptyState icon={<Clapperboard className="size-5" />} title="Your slate is empty" body="Start a film, a music video or a quick clip. Everything you make is saved here." action={<Button variant="primary" onClick={() => setNewOpen(true)}>Create your first project</Button>} />
              ) : (
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  {projects.data.slice(0, 6).map((p) => (
                    <ProjectCard key={p.id} project={p} />
                  ))}
                </div>
              )}
            </div>
          </section>

          <section>
            <SectionHeader eyebrow="Library" title="Favourite assets" action={<Link to="/assets" className="inline-flex items-center gap-1 text-sm text-accent-2 hover:underline">Open library <ArrowRight className="size-4" /></Link>} />
            <div className="mt-5">
              {favourites.error ? (
                <ErrorState error={favourites.error} />
              ) : favourites.loading ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {Array.from({ length: 4 }, (_, i) => (
                    <Skeleton key={i} className="aspect-video" />
                  ))}
                </div>
              ) : favourites.data.length === 0 ? (
                <EmptyState icon={<Star className="size-5" />} title="No favourites yet" body="Star images, clips and renders in the library to keep them close." />
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {favourites.data.map((a) => (
                    <AssetThumb key={a.id} asset={a} />
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="space-y-6">
          <section>
            <SectionHeader eyebrow="Jobs" title={active.data.length ? 'Generating now' : 'Latest jobs'} action={<Link to="/jobs" className="text-sm text-accent-2 hover:underline">All jobs</Link>} />
            <div className="mt-4 space-y-3">
              {active.error ? <ErrorState error={active.error} /> : jobs.length === 0 ? <p className="rounded-xl border border-dashed border-line-strong p-5 text-center text-sm text-faint">Nothing has been generated yet.</p> : jobs.map((j) => <JobCard key={j.id} job={j} compact showProject />)}
            </div>
          </section>
          <UsageCard />
          <StorageCard />
        </aside>
      </div>
      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
