import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Dialog as RDialog, Slider as RSlider, Switch as RSwitch, Tabs as RTabs, Tooltip as RTooltip, Progress as RProgress } from 'radix-ui';
import { CircleAlert, LoaderCircle, X } from 'lucide-react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-gradient-to-b from-[#5b97ff] to-[#3a76f0] text-white shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_10px_30px_-10px_rgba(76,141,255,0.65)] hover:from-[#6ea3ff] hover:to-[#4583f7] disabled:from-[#2b3f66] disabled:to-[#253657] disabled:text-white/50 disabled:shadow-none',
  secondary: 'bg-white/[0.06] text-fg border border-line-strong hover:bg-white/[0.1] hover:border-white/25 disabled:opacity-50',
  ghost: 'text-dim hover:text-fg hover:bg-white/[0.06] disabled:opacity-40',
  danger: 'bg-danger/15 text-[#ff9b9b] border border-danger/30 hover:bg-danger/25 disabled:opacity-50',
  subtle: 'bg-accent/10 text-accent-2 border border-accent/25 hover:bg-accent/18 disabled:opacity-50',
};
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-[15px] gap-2.5 rounded-xl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx('inline-flex shrink-0 cursor-pointer items-center justify-center font-medium whitespace-nowrap transition-all duration-150 select-none disabled:cursor-not-allowed', VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, children, className, size = 'md', active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md'; active?: boolean }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        className={cx(
          'inline-flex cursor-pointer items-center justify-center rounded-lg text-dim transition-colors hover:bg-white/[0.07] hover:text-fg disabled:cursor-not-allowed disabled:opacity-40',
          size === 'sm' ? 'size-7' : 'size-9',
          active && 'bg-accent/15 text-accent-2',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tip>
  );
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

export function Tip({ label, children, side = 'top' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RTooltip.Root delayDuration={300}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} className="z-50 max-w-72 rounded-lg border border-line-strong bg-panel-2 px-2.5 py-1.5 text-xs text-fg shadow-xl animate-fade">
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

// ---------------------------------------------------------------------------
// Surfaces & feedback
// ---------------------------------------------------------------------------

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('card', className)} {...rest}>
      {children}
    </div>
  );
}

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'violet';
const TONES: Record<Tone, string> = {
  neutral: 'bg-white/[0.06] text-dim border-white/10',
  accent: 'bg-accent/12 text-accent-2 border-accent/25',
  success: 'bg-success/12 text-success border-success/25',
  warning: 'bg-warning/12 text-warning border-warning/25',
  danger: 'bg-danger/12 text-[#ff9b9b] border-danger/25',
  violet: 'bg-violet/12 text-violet border-violet/25',
};

export function Badge({ tone = 'neutral', children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', TONES[tone], className)}>{icon}{children}</span>;
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return <LoaderCircle className={cx('size-5 animate-spin text-accent-2', className)} role="status" aria-label={label} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton rounded-lg', className)} aria-hidden />;
}

export function EmptyState({ icon, title, body, action, className }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong px-6 py-12 text-center', className)}>
      {icon && <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-accent/10 text-accent-2">{icon}</div>}
      <p className="display text-2xl text-fg">{title}</p>
      {body && <div className="mt-1.5 max-w-md text-sm text-dim">{body}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', error, onRetry, className }: { title?: string; error: unknown; onRetry?: () => void; className?: string }) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    <div role="alert" className={cx('flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/[0.07] p-4 text-sm', className)}>
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-[#ffb3b3]">{title}</p>
        {message && <p className="mt-0.5 break-words text-dim">{message}</p>}
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = 'accent', icon, children, className }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] leading-relaxed', TONES[tone], className)}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function ProgressBar({ value, className, tone = 'accent', label }: { value: number; className?: string; tone?: 'accent' | 'success' | 'danger'; label?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = tone === 'success' ? 'bg-success' : tone === 'danger' ? 'bg-danger' : 'bg-gradient-to-r from-accent to-accent-2';
  return (
    <RProgress.Root value={pct} aria-label={label ?? 'Progress'} className={cx('relative h-1.5 overflow-hidden rounded-full bg-white/[0.07]', className)}>
      <RProgress.Indicator className={cx('h-full rounded-full transition-[width] duration-500', color)} style={{ width: `${pct}%` }} />
    </RProgress.Root>
  );
}

export function SectionHeader({ eyebrow, title, action, className, sub }: { eyebrow?: string; title: ReactNode; action?: ReactNode; className?: string; sub?: ReactNode }) {
  return (
    <div className={cx('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
        <h2 className="display text-[26px] leading-tight text-fg">{title}</h2>
        {sub && <p className="mt-1 text-sm text-dim">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-dim">{children}</kbd>;
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export function Field({ label, hint, error, children, className, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-dim">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs text-[#ff9b9b]">{error}</p> : hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx('field', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx('field min-h-24 resize-y leading-relaxed', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx('field appearance-none bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%239eabc2%27 stroke-width=%272%27%3E%3Cpath d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E")] bg-[position:right_0.7rem_center] bg-no-repeat pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className, size = 'md', label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[]; className?: string; size?: 'sm' | 'md'; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cx('inline-flex flex-wrap gap-1 rounded-xl border border-line bg-black/30 p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'cursor-pointer rounded-lg font-medium transition-all disabled:cursor-not-allowed disabled:opacity-35',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-[13px]',
            value === o.value ? 'bg-accent/20 text-fg shadow-[inset_0_0_0_1px_rgba(76,141,255,0.45)]' : 'text-dim hover:bg-white/[0.06] hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-faint">{description}</span>}
      </label>
      <RSwitch.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full border border-line-strong bg-white/10 transition-colors data-[state=checked]:border-accent/60 data-[state=checked]:bg-accent/70 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <RSwitch.Thumb className="block size-[18px] translate-x-[3px] rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[21px]" />
      </RSwitch.Root>
    </div>
  );
}

export function Slider({ value, onChange, min, max, step, label, className, onCommit }: { value: number; onChange: (v: number) => void; onCommit?: (v: number) => void; min: number; max: number; step: number; label: string; className?: string }) {
  return (
    <RSlider.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(v[0] ?? min)}
      onValueCommit={(v) => onCommit?.(v[0] ?? min)}
      aria-label={label}
      className={cx('relative flex h-5 w-full touch-none items-center select-none', className)}
    >
      <RSlider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-white/10">
        <RSlider.Range className="absolute h-full bg-gradient-to-r from-accent to-accent-2" />
      </RSlider.Track>
      <RSlider.Thumb className="block size-4 cursor-grab rounded-full border-2 border-white bg-accent shadow-[0_0_0_4px_rgba(76,141,255,0.2)] focus:outline-none focus-visible:shadow-[0_0_0_5px_rgba(76,141,255,0.45)]" />
    </RSlider.Root>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export function Tabs({ value, onValueChange, tabs, className, children }: { value: string; onValueChange: (v: string) => void; tabs: { value: string; label: ReactNode; icon?: ReactNode }[]; className?: string; children?: ReactNode }) {
  return (
    <RTabs.Root value={value} onValueChange={onValueChange} className={className}>
      <RTabs.List aria-label="Sections" className="scroll-x flex gap-1 border-b border-line pb-px">
        {tabs.map((t) => (
          <RTabs.Trigger
            key={t.value}
            value={t.value}
            className="relative inline-flex shrink-0 cursor-pointer items-center gap-1.5 px-3 py-2.5 text-[13px] font-medium text-dim transition-colors hover:text-fg data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent"
          >
            {t.icon}
            {t.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {children}
    </RTabs.Root>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm animate-fade" />
        <RDialog.Content
          className={cx(
            'glass fixed top-1/2 left-1/2 z-50 flex max-h-[min(90dvh,900px)] w-[calc(100vw-1.5rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl shadow-[var(--shadow-float)] animate-rise focus:outline-none',
            widths[size],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <RDialog.Title className="display text-2xl leading-tight text-fg">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-1 text-sm text-dim">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</RDialog.Description>}
            </div>
            <RDialog.Close asChild>
              <button type="button" aria-label="Close" className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-dim hover:bg-white/10 hover:text-fg">
                <X className="size-4" />
              </button>
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel = 'Confirm',
  danger,
  loading,
  onConfirm,
  children,
  confirmDisabled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
  confirmDisabled?: boolean;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body && <div className="text-sm leading-relaxed text-dim">{body}</div>}
      {children}
    </Modal>
  );
}
