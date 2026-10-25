/**
 * The public website's only script: the mobile menu and the early-access form (reveal motion is CSS only).
 * No Firebase, no studio code, no third parties, no cookies or storage.
 */
import '@fontsource-variable/inter';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './site.css';
import { validateEarlyAccess, type EarlyAccessField } from '@az-studio/shared/early-access';

const root = document.documentElement;
root.classList.remove('no-js');
root.classList.add('js');

function setupMenu() {
  const button = document.querySelector<HTMLButtonElement>('[data-menu-button]');
  const header = document.querySelector<HTMLElement>('.site-header');
  if (!button || !header) return;
  const set = (open: boolean) => {
    button.setAttribute('aria-expanded', String(open));
    header.toggleAttribute('data-open', open);
  };
  button.addEventListener('click', () => set(button.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && header.hasAttribute('data-open')) {
      set(false);
      button.focus();
    }
  });
  header.querySelectorAll('.site-nav a').forEach((a) => a.addEventListener('click', () => set(false)));
  window.matchMedia('(min-width: 860px)').addEventListener('change', (e) => e.matches && set(false));
}

const MESSAGES = {
  network: 'We couldn’t reach AZ Studio, so nothing was saved. Check your connection and try again.',
  generic: 'Your registration couldn’t be saved. Please try again in a moment.',
};

function setupEarlyAccess() {
  const form = document.querySelector<HTMLFormElement>('#early-access-form');
  const success = document.querySelector<HTMLElement>('#ea-success');
  if (!form || !success) return;
  const submit = form.querySelector<HTMLButtonElement>('[data-submit]')!;
  const formError = form.querySelector<HTMLElement>('#ea-form-error')!;
  const status = form.querySelector<HTMLElement>('#ea-status')!;
  const successTitle = success.querySelector<HTMLElement>('#ea-success-title')!;
  const successBody = success.querySelector<HTMLElement>('#ea-success-body')!;
  const endpoint = form.dataset.endpoint!;
  const noticeVersion = form.dataset.noticeVersion!;
  const fields: Record<Exclude<EarlyAccessField, 'form'>, HTMLInputElement | HTMLSelectElement> = {
    email: form.querySelector('#ea-email')!,
    name: form.querySelector('#ea-name')!,
    interest: form.querySelector('#ea-interest')!,
    consent: form.querySelector('#ea-consent')!,
  };
  const website = form.querySelector<HTMLInputElement>('#ea-website')!;
  /** Addresses saved from this page view (memory only), so a second press shows "already on the list". */
  const saved = new Set<string>();
  const label = submit.textContent ?? 'Join the early-access list';
  submit.disabled = false;

  const showFieldError = (name: Exclude<EarlyAccessField, 'form'>, message: string | undefined) => {
    const input = fields[name];
    const el = form.querySelector<HTMLElement>(`#ea-${name}-error`)!;
    el.textContent = message ?? '';
    el.hidden = !message;
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };
  const showFormError = (message: string | null) => {
    formError.textContent = message ?? '';
    formError.hidden = !message;
  };
  const clearErrors = () => {
    (Object.keys(fields) as (keyof typeof fields)[]).forEach((k) => showFieldError(k, undefined));
    showFormError(null);
  };
  const applyErrors = (errors: Partial<Record<EarlyAccessField, string>>) => {
    let first: HTMLElement | null = null;
    (Object.keys(fields) as (keyof typeof fields)[]).forEach((k) => {
      showFieldError(k, errors[k]);
      if (errors[k] && !first) first = fields[k];
    });
    if (errors.form) showFormError(errors.form);
    const target: HTMLElement | null = first ?? (errors.form ? formError : null);
    if (target) {
      // Centre it so the sticky header never covers the field and its label.
      target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      target.focus({ preventScroll: true });
    }
  };
  const busy = (on: boolean) => {
    submit.disabled = on;
    submit.setAttribute('aria-busy', String(on));
    submit.textContent = on ? 'Saving your registration…' : label;
    status.textContent = on ? 'Saving your registration…' : '';
  };
  const showSuccess = (email: string, name: string | null, repeat: boolean) => {
    successTitle.textContent = repeat ? 'You’re already on the list' : 'You’re on the list';
    successBody.textContent = repeat
      ? `${email} was already registered from this page — there’s nothing more to do.`
      : `${name ? `Thank you, ${name}. ` : 'Thank you. '}${email} has been saved to the early-access list.`;
    form.hidden = true;
    success.hidden = false;
    success.focus();
  };

  Object.values(fields).forEach((input) => {
    input.addEventListener('input', () => showFieldError(input.name as keyof typeof fields, undefined));
    input.addEventListener('change', () => showFieldError(input.name as keyof typeof fields, undefined));
  });

  success.querySelector<HTMLButtonElement>('[data-reset]')?.addEventListener('click', () => {
    form.reset();
    clearErrors();
    success.hidden = true;
    form.hidden = false;
    fields.email.focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    clearErrors();
    const payload = {
      email: fields.email.value,
      name: fields.name.value,
      interest: fields.interest.value,
      consent: (fields.consent as HTMLInputElement).checked,
      noticeVersion,
      website: website.value,
    };
    const check = validateEarlyAccess(payload);
    if (!check.ok) return applyErrors(check.errors);
    const { email, name } = check.value;
    if (saved.has(email)) return showSuccess(email, name, true);

    busy(true);
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), 20_000);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abort.signal,
        credentials: 'omit',
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string; fields?: Partial<Record<EarlyAccessField, string>> };
      if (res.ok && body.ok) {
        saved.add(email);
        showSuccess(email, name, false);
      } else if (res.status === 400 && body.fields) {
        applyErrors(body.fields);
      } else {
        applyErrors({ form: body.message ?? MESSAGES.generic });
      }
    } catch {
      applyErrors({ form: MESSAGES.network });
    } finally {
      window.clearTimeout(timer);
      busy(false);
    }
  });
}

setupMenu();
setupEarlyAccess();
