import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/dom';
import { renderSitePages } from '../build';

const page = renderSitePages()['early-access.html']!;
const fetchMock = vi.fn();

beforeAll(async () => {
  const doc = new DOMParser().parseFromString(page, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollIntoView = () => undefined; // not implemented by jsdom
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
  await import('./main');
});
afterEach(() => fetchMock.mockReset());

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const form = () => $<HTMLFormElement>('#early-access-form');
const fill = (email: string, { name = '', consent = true } = {}) => {
  fireEvent.input($<HTMLInputElement>('#ea-email'), { target: { value: email } });
  fireEvent.input($<HTMLInputElement>('#ea-name'), { target: { value: name } });
  $<HTMLInputElement>('#ea-consent').checked = consent;
};
const reply = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const resetToForm = () => {
  if (!$('#ea-success').hidden) fireEvent.click($('[data-reset]'));
};

beforeEach(() => resetToForm());

describe('early-access form', () => {
  it('enables the submit button once the script runs and marks the page as scripted', () => {
    expect($<HTMLButtonElement>('[data-submit]').disabled).toBe(false);
    expect(document.documentElement.classList.contains('js')).toBe(true);
  });

  it('shows inline errors, focuses the first invalid field and sends nothing', async () => {
    fill('not-an-address', { consent: false });
    fireEvent.submit(form());
    expect(fetchMock).not.toHaveBeenCalled();
    expect($('#ea-email-error').hidden).toBe(false);
    expect($('#ea-consent-error').hidden).toBe(false);
    expect($('#ea-email').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe($('#ea-email'));
  });

  it('confirms only after the server says the registration was stored', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (resolve = r)));
    fill('Ama@Example.com', { name: 'Ama' });
    fireEvent.submit(form());
    const button = $<HTMLButtonElement>('[data-submit]');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect($('#ea-success').hidden).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/public/early-access');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ email: 'Ama@Example.com', name: 'Ama', interest: '', consent: true, noticeVersion: '2026-10-24', website: '' });
    resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await waitFor(() => expect($('#ea-success').hidden).toBe(false));
    expect($('#ea-success-title').textContent).toBe('You’re on the list');
    expect($('#ea-success-body').textContent).toContain('ama@example.com has been saved');
    expect(document.activeElement).toBe($('#ea-success'));
  });

  it('recognises a second submission of the same address from this page without calling the server', async () => {
    fill('ama@example.com');
    fireEvent.submit(form());
    expect(fetchMock).not.toHaveBeenCalled();
    expect($('#ea-success-title').textContent).toBe('You’re already on the list');
  });

  it('shows server field errors, limits and outages without claiming success', async () => {
    reply(400, { error: 'invalid', fields: { email: 'Enter a valid email address, like name@example.com.' } });
    fill('kojo@example.com');
    fireEvent.submit(form());
    await waitFor(() => expect($('#ea-email-error').hidden).toBe(false));
    expect($('#ea-success').hidden).toBe(true);

    reply(429, { error: 'rate_limited', message: 'Too many registrations from this network. Please try again in an hour.' });
    fireEvent.submit(form());
    await waitFor(() => expect($('#ea-form-error').textContent).toContain('Too many registrations'));

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.submit(form());
    await waitFor(() => expect($('#ea-form-error').textContent).toContain('nothing was saved'));
    expect($('#ea-success').hidden).toBe(true);
    expect($<HTMLButtonElement>('[data-submit]').disabled).toBe(false);
  });
});
