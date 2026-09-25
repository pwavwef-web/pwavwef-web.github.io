import { useState } from 'react';
import { toast } from 'sonner';
import { Ban, Settings2 } from 'lucide-react';
import { formatUsd, type ProjectDoc } from '@az-studio/shared';
import { errorMessage } from '../lib/api';
import { cancelQueued } from '../lib/continuity';
import type { WithId } from '../lib/data';
import { useBoot } from '../lib/session';
import { updateProject } from '../lib/studio';
import { Badge, Button, Card, Field, IconButton, Input, Modal, Segmented, Slider, Toggle } from './ui';

/** Share of the project budget already used (null without a budget). */
export function budgetUse(project: Pick<ProjectDoc, 'budget' | 'usage'>): { spent: number; limit: number; pct: number; warn: boolean } | null {
  const limit = project.budget?.limitUsd;
  if (!limit || limit <= 0) return null;
  const spent = project.usage?.costUsd ?? 0;
  const pct = (spent / limit) * 100;
  return { spent, limit, pct, warn: pct >= (project.budget?.warnAtPct ?? 80) };
}

function SettingsDialog({ project, onClose }: { project: WithId<ProjectDoc>; onClose: () => void }) {
  const boot = useBoot();
  const [quality, setQuality] = useState<'draft' | 'final'>(project.productionQuality ?? 'final');
  const [limited, setLimited] = useState(Boolean(project.budget?.limitUsd));
  const [limit, setLimit] = useState(String(project.budget?.limitUsd ?? 25));
  const [warnAt, setWarnAt] = useState(project.budget?.warnAtPct ?? 80);
  const [advanced, setAdvanced] = useState(Boolean(project.continuity?.advanced));
  const [busy, setBusy] = useState<string | null>(null);
  const spent = project.usage?.costUsd ?? 0;
  const limitNum = Number(limit);
  const valid = !limited || (Number.isFinite(limitNum) && limitNum > 0 && limitNum <= 100000);
  const save = async () => {
    setBusy('save');
    try {
      await updateProject(project.id, {
        productionQuality: quality,
        budget: limited ? { limitUsd: Math.round(limitNum * 100) / 100, warnAtPct: Math.round(warnAt) } : null,
        continuity: { advanced },
      });
      toast.success('Project settings saved');
      onClose();
    } catch (e) {
      toast.error('Could not save', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const cancel = async () => {
    setBusy('cancel');
    try {
      const r = await cancelQueued(project.id);
      toast.success(`${r.cancelled} queued job${r.cancelled === 1 ? '' : 's'} cancelled`, { description: `${r.productions} production${r.productions === 1 ? '' : 's'} stopped before spending · ${r.stillRunning} job${r.stillRunning === 1 ? '' : 's'} already running (cancel them in Jobs).` });
    } catch (e) {
      toast.error('Could not cancel', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const lowest = boot?.capabilities.video.resolutions[0];
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Project settings"
      description="Cost controls and how much of the Continuity Director this project shows."
      footer={
        <Button variant="primary" loading={busy === 'save'} disabled={!valid} onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <Card className="space-y-2 p-3">
          <p className="eyebrow">Generation quality</p>
          <Segmented
            label="Generation quality"
            value={quality}
            onChange={setQuality}
            options={[
              { value: 'draft', label: `Draft${lowest ? ` (${lowest})` : ''}` },
              { value: 'final', label: 'Final (each shot’s resolution)' },
            ]}
          />
          <p className="text-xs text-faint">Draft generates new shots at the lowest resolution while you explore; switch to Final for delivery. Estimates follow the setting.</p>
        </Card>
        <Card className="space-y-3 p-3">
          <Toggle checked={limited} onChange={setLimited} label="Limit this project’s spending" description="Work that would take the project past its budget (recorded usage + running jobs + the new job) is refused before anything is charged." />
          {limited && (
            <>
              <Field label="Project budget (USD)" error={valid ? null : 'Enter an amount above zero.'}>
                <Input type="number" min={1} step={1} value={limit} onChange={(e) => setLimit(e.target.value)} className="w-40" />
              </Field>
              <Slider label={`Warn at ${Math.round(warnAt)}% used`} min={50} max={100} step={5} value={warnAt} onChange={setWarnAt} />
            </>
          )}
          <p className="text-xs text-dim">
            Spent on this project so far: <span className="text-fg">≈ {formatUsd(spent)}</span>
            {limited && valid ? ` · remaining ≈ ${formatUsd(Math.max(0, limitNum - spent))}` : ''} (estimates from Google’s published list prices)
          </p>
        </Card>
        {(project.type === 'film' || project.type === 'music_video') && (
          <Card className="space-y-2 p-3">
            <Toggle checked={advanced} onChange={setAdvanced} label="Show the advanced continuity workspaces" description="Blocking (stage plans, the 180° line, occlusion checks) and the Continuity workspace (prop ledger, protected screens, cross-shot comparison, coverage). Continuity planning runs either way." />
          </Card>
        )}
        <Card className="flex flex-wrap items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg">Cancel queued work</p>
            <p className="text-xs text-faint">Queued jobs and productions that have not started are cancelled with no charge.</p>
          </div>
          <Button variant="danger" loading={busy === 'cancel'} icon={<Ban className="size-4" />} onClick={() => void cancel()}>
            Cancel queued
          </Button>
        </Card>
      </div>
    </Modal>
  );
}

/** Settings button for the project header, with a budget warning when the project is close to its limit. */
export function ProjectSettingsButton({ project }: { project: WithId<ProjectDoc> }) {
  const [open, setOpen] = useState(false);
  const use = budgetUse(project);
  return (
    <>
      {use && <Badge tone={use.pct >= 100 ? 'danger' : use.warn ? 'warning' : 'neutral'}>Budget {Math.min(999, Math.round(use.pct))}% used</Badge>}
      <IconButton label="Project settings" onClick={() => setOpen(true)}>
        <Settings2 className="size-4" />
      </IconButton>
      {open && <SettingsDialog project={project} onClose={() => setOpen(false)} />}
    </>
  );
}
