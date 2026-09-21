import { useEffect, useState } from 'react';
import { Palette } from 'lucide-react';
import type { ProjectDoc, StyleBible } from '@az-studio/shared';
import { useDebounced, type WithId } from '../lib/data';
import { updateProject } from '../lib/studio';
import { Card, Field, Textarea } from './ui';

const LABELS: Record<keyof StyleBible, string> = {
  visualStyle: 'Visual style',
  palette: 'Colour palette',
  lighting: 'Lighting',
  cameraLanguage: 'Camera language',
  texture: 'Texture & grain',
  continuityNotes: 'Continuity rules',
};

/** Project-wide look that is compiled into every shot and image prompt (autosaves). */
export function StyleBibleEditor({ project }: { project: WithId<ProjectDoc> }) {
  const [style, setStyle] = useState<StyleBible>(project.styleBible ?? {});
  const deb = useDebounced(style, 1000);
  useEffect(() => {
    if (JSON.stringify(deb) !== JSON.stringify(project.styleBible ?? {})) void updateProject(project.id, { styleBible: deb });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deb]);
  return (
    <Card className="space-y-4 p-5">
      <p className="eyebrow flex items-center gap-1.5">
        <Palette className="size-3.5" /> Style bible — applied to every shot and image
      </p>
      {(Object.keys(LABELS) as (keyof StyleBible)[]).map((k) => (
        <Field key={k} label={LABELS[k]}>
          <Textarea rows={2} value={style[k] ?? ''} onChange={(e) => setStyle({ ...style, [k]: e.target.value })} />
        </Field>
      ))}
    </Card>
  );
}
