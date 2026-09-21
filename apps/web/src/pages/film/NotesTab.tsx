import { useState } from 'react';
import { NotebookPen, Pin, Plus, Trash2 } from 'lucide-react';
import { relativeTime, toMillis, type NoteDoc, type ProjectDoc } from '@az-studio/shared';
import type { WithId } from '../../lib/data';
import { addNote, deleteSubDoc, updateSubDoc, useSub } from '../../lib/studio';
import { Badge, Button, Card, cx, EmptyState, IconButton, Input, Textarea } from '../../components/ui';

function NoteCard({ projectId, note }: { projectId: string; note: WithId<NoteDoc> }) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [tags, setTags] = useState(note.tags.join(', '));
  const save = () => void updateSubDoc(projectId, 'notes', note.id, { title, body, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), updatedAt: new Date() });
  return (
    <Card className={cx('space-y-2 p-4', note.pinned && 'border-accent/40')}>
      <div className="flex items-center gap-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={save} placeholder="Title" className="!border-transparent !bg-transparent !px-0 font-medium" aria-label="Note title" />
        <IconButton label={note.pinned ? 'Unpin' : 'Pin'} active={note.pinned} onClick={() => void updateSubDoc(projectId, 'notes', note.id, { pinned: !note.pinned })}>
          <Pin className="size-4" />
        </IconButton>
        <IconButton label="Delete note" onClick={() => void deleteSubDoc(projectId, 'notes', note.id)}>
          <Trash2 className="size-4" />
        </IconButton>
      </div>
      <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} onBlur={save} placeholder="Production note…" aria-label="Note body" />
      <div className="flex items-center gap-2">
        <Input value={tags} onChange={(e) => setTags(e.target.value)} onBlur={save} placeholder="tags, comma separated" className="!py-1 text-xs" aria-label="Tags" />
        <span className="shrink-0 text-[11px] text-faint">{relativeTime(toMillis(note.updatedAt ?? note.createdAt))}</span>
      </div>
      {note.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {note.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      )}
    </Card>
  );
}

export function NotesTab({ project }: { project: WithId<ProjectDoc> }) {
  const notes = useSub<NoteDoc>(project.id, 'notes', 'createdAt', 'desc');
  const sorted = [...notes.data].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  return (
    <div className="space-y-4">
      <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => void addNote(project.id, { title: 'New note' })}>
        New note
      </Button>
      {sorted.length === 0 ? (
        <EmptyState icon={<NotebookPen className="size-5" />} title="No production notes" body="Capture decisions, schedules, feedback and continuity reminders." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((n) => (
            <NoteCard key={n.id} projectId={project.id} note={n} />
          ))}
        </div>
      )}
    </div>
  );
}
