import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowRight, Clapperboard, Film, Image as ImageIcon, Music2, Scissors } from 'lucide-react';
import type { ProjectType } from '@az-studio/shared';
import { useCaps } from '../lib/session';
import { NewProjectDialog } from '../components/projects';
import { Badge, SectionHeader } from '../components/ui';

export default function Create() {
  const caps = useCaps();
  const [params] = useSearchParams();
  const preset = params.get('mode') as ProjectType | null;
  const [dialog, setDialog] = useState<ProjectType | null>(preset === 'film' || preset === 'music_video' ? preset : null);

  const modes = [
    { key: 'quick', title: 'Quick Video', body: 'A polished clip from text, first/last frames and image or video references. Refine it conversationally.', icon: Film, to: '/create/video', model: caps?.video.displayName },
    { key: 'music', title: 'Music Video Studio', body: 'Upload a finished song. Beats, sections and lyrics drive a treatment, storyboard, shot queue and final cut.', icon: Music2, onClick: () => setDialog('music_video'), model: `${caps?.reasoning.displayName ?? ''} · ${caps?.video.displayName ?? ''}` },
    { key: 'film', title: 'Film Studio', body: 'Idea → treatment → screenplay → breakdown → bibles → lookbook → storyboard → shots → timeline → export.', icon: Clapperboard, onClick: () => setDialog('film'), model: `${caps?.reasoning.displayName ?? ''} · ${caps?.image.displayName ?? ''}` },
    { key: 'image', title: 'Image Studio', body: 'Characters, turnarounds, costumes, sets, posters, thumbnails and storyboard frames — with iterative edits.', icon: ImageIcon, to: '/create/image', model: caps?.image.displayName },
    { key: 'remix', title: 'Video Remix & Edit', body: 'Upload a clip and change location, style, objects, time of day, action or camera — turn by turn.', icon: Scissors, to: '/create/remix', model: caps?.video.displayName },
  ];

  return (
    <div className="space-y-8">
      <SectionHeader eyebrow="Create" title={<span className="text-5xl">Choose a mode</span>} sub="Every result is saved to your library; studios keep full generation history." />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {modes.map((m, i) => {
          const inner = (
            <>
              <div className="flex items-start justify-between">
                <div className="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-accent/25 to-violet/15 text-accent-2">
                  <m.icon className="size-6" aria-hidden />
                </div>
                <ArrowRight className="size-5 text-faint transition-transform group-hover:translate-x-1 group-hover:text-accent-2" aria-hidden />
              </div>
              <h2 className="display mt-6 text-3xl text-fg">{m.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-dim">{m.body}</p>
              {m.model && <Badge className="mt-5">{m.model}</Badge>}
            </>
          );
          const cls = 'group card block cursor-pointer p-6 text-left transition-all hover:-translate-y-0.5 hover:border-accent/35 hover:shadow-[var(--shadow-glow)] animate-rise';
          return m.to ? (
            <Link key={m.key} to={m.to} className={cls} style={{ animationDelay: `${i * 40}ms` }}>
              {inner}
            </Link>
          ) : (
            <button key={m.key} type="button" onClick={m.onClick} className={cls} style={{ animationDelay: `${i * 40}ms` }}>
              {inner}
            </button>
          );
        })}
      </div>
      <NewProjectDialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)} defaultType={dialog ?? 'film'} key={dialog ?? 'none'} />
    </div>
  );
}
