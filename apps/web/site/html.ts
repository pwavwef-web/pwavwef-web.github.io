/**
 * A tiny HTML template helper for the build-time public pages: interpolated values are escaped unless they are
 * already `Html` (another template, or `raw()` for trusted markup such as inline SVG written in this folder).
 */
export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

type Part = Html | string | number | null | undefined | false | Part[];

function render(v: Part): string {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(render).join('');
  if (v instanceof Html) return v.value;
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => (out += render(v) + strings[i + 1]!));
  return new Html(out);
}

/** Trusted markup only (never visitor input — the public pages have none). */
export const raw = (s: string) => new Html(s);
