import { FileDown, FileText, Printer, Table } from 'lucide-react';
import { safeFileName, type ProjectDoc, type SceneDoc, type ScriptDoc, type ShotDoc } from '@az-studio/shared';
import type { WithId } from '../../lib/data';
import { useSub } from '../../lib/studio';
import { shotListCsv } from '../../lib/text-utils';
import { Button, Card, EmptyState } from '../../components/ui';

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}


export function ExportTab({ project }: { project: WithId<ProjectDoc> }) {
  const scripts = useSub<ScriptDoc>(project.id, 'scripts', 'updatedAt', 'desc');
  const scenes = useSub<SceneDoc>(project.id, 'scenes', 'order');
  const shots = useSub<ShotDoc>(project.id, 'shots', 'order');
  const script = scripts.data[0];
  const base = safeFileName(project.title || 'project');
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="space-y-3 p-5">
        <FileText className="size-5 text-accent-2" />
        <p className="display text-2xl">Screenplay</p>
        {script ? (
          <>
            <p className="text-sm text-dim">
              {script.title} · {script.pageCount} pages · v{script.version}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<FileDown className="size-3.5" />} onClick={() => download(`${base}.fountain`, script.content, 'text/plain;charset=utf-8')}>
                Fountain
              </Button>
              <a href={`/print/screenplay/${project.id}/${script.id}`} target="_blank" rel="noreferrer">
                <Button size="sm" variant="primary" icon={<Printer className="size-3.5" />}>
                  PDF (print)
                </Button>
              </a>
            </div>
          </>
        ) : (
          <EmptyState title="No screenplay" />
        )}
      </Card>
      <Card className="space-y-3 p-5">
        <Printer className="size-5 text-accent-2" />
        <p className="display text-2xl">Storyboard</p>
        <p className="text-sm text-dim">{shots.data.filter((s) => s.refs.storyboardAssetId).length} of {shots.data.length} shots have frames.</p>
        <a href={`/print/storyboard/${project.id}`} target="_blank" rel="noreferrer">
          <Button size="sm" variant="primary" icon={<Printer className="size-3.5" />} disabled={!shots.data.length}>
            Storyboard PDF (print)
          </Button>
        </a>
      </Card>
      <Card className="space-y-3 p-5">
        <Table className="size-5 text-accent-2" />
        <p className="display text-2xl">Shot list</p>
        <p className="text-sm text-dim">{shots.data.length} shots with lens, camera, lighting, performance and sound directions.</p>
        <Button size="sm" variant="primary" icon={<FileDown className="size-3.5" />} disabled={!shots.data.length} onClick={() => download(`${base}-shot-list.csv`, shotListCsv(scenes.data, shots.data), 'text/csv;charset=utf-8')}>
          CSV
        </Button>
      </Card>
    </div>
  );
}
