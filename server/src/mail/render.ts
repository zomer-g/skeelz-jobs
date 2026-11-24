/* ============================================================================
 *  Templates → a finished email (subject, plain text, RTL HTML). Pure: no DB, no network.
 *
 *  Safety:
 *   - A template is checked before it is saved (validateTemplate): only the kind's own parameters, the required ones
 *     present, links only to https:// addresses or to a link parameter, sizes capped.
 *   - Parameter VALUES are never read as markup and are always escaped in the HTML: they are swapped in only after
 *     the template's own markup was turned into HTML. A name like "<b>x</b>" or "**x**" shows as typed.
 *   - A link parameter's value is used as a link only if it is an http(s) address; otherwise only its text shows.
 * ========================================================================== */
import { MailKind } from './catalog.js';

export const MAX_SUBJECT = 200;
export const MAX_BODY = 10_000;
const MAX_VALUE = 2_000;

const PARAM_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;
const BUTTON_RE = /^\[\[\s*(?:כפתור|button)\s*:\s*([^|\]]+?)\s*\|\s*([^\]\s]+)\s*\]\]$/i;
// Placeholders for parameter values inside the template while its markup is processed (never typed by a person).
const PH_OPEN = '\u0001';
const PH_CLOSE = '\u0002';

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const paramsIn = (s: string): string[] => [...new Set([...s.matchAll(PARAM_RE)].map((m) => m[1]))];

export type TemplateError =
  | 'subject_empty' | 'subject_too_long' | 'subject_multiline' | 'body_empty' | 'body_too_long'
  | `unknown_param:${string}` | `missing_required:${string}` | `bad_link:${string}` | 'control_chars';

const linkTargetOk = (k: MailKind, target: string): boolean => {
  const only = /^\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/.exec(target);
  if (only) return !!k.params.find((p) => p.name === only[1] && p.link);
  return /^https:\/\/[^\s"'<>]+$/i.test(target) && !target.includes('{{');
};

/** Problems that keep a template from being saved (an empty list = fine). */
export const validateTemplate = (k: MailKind, subject: unknown, body: unknown): TemplateError[] => {
  const errors: TemplateError[] = [];
  const s = typeof subject === 'string' ? subject : '';
  const b = typeof body === 'string' ? body : '';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s + b)) errors.push('control_chars');
  if (!s.trim()) errors.push('subject_empty');
  if (s.length > MAX_SUBJECT) errors.push('subject_too_long');
  if (/[\r\n]/.test(s)) errors.push('subject_multiline');
  if (!b.trim()) errors.push('body_empty');
  if (b.length > MAX_BODY) errors.push('body_too_long');
  const allowed = new Set(k.params.map((p) => p.name));
  for (const p of paramsIn(s + '\n' + b)) if (!allowed.has(p)) errors.push(`unknown_param:${p}`);
  const used = new Set(paramsIn(s + '\n' + b));
  for (const r of k.required ?? []) if (!used.has(r)) errors.push(`missing_required:${r}`);
  for (const m of b.matchAll(LINK_RE)) if (!linkTargetOk(k, m[2])) errors.push(`bad_link:${m[2].slice(0, 100)}`);
  for (const line of b.split('\n')) {
    const m = BUTTON_RE.exec(line.trim());
    if (m && !linkTargetOk(k, m[2])) errors.push(`bad_link:${m[2].slice(0, 100)}`);
  }
  return [...new Set(errors)];
};

const cleanValue = (v: unknown): string =>
  String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, MAX_VALUE);
const isHttpUrl = (v: string) => /^https?:\/\/[^\s"'<>]+$/i.test(v);

interface Swapped { text: string; values: string[] }
/** {{name}} → a placeholder holding the index of its value (unknown names → empty). */
const swapParams = (s: string, vars: Record<string, unknown>, values: string[]): string =>
  s.replace(PARAM_RE, (_m, name: string) => {
    values.push(cleanValue(vars[name]));
    return `${PH_OPEN}${values.length - 1}${PH_CLOSE}`;
  });
const PH_RE = new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'g');
const fillHtml = (s: string, values: string[]) => s.replace(PH_RE, (_m, i) => escapeHtml(values[Number(i)] ?? '').replace(/\n/g, '<br>'));
const fillText = (s: string, values: string[]) => s.replace(PH_RE, (_m, i) => values[Number(i)] ?? '');

/** A link target after the swap: a lone parameter placeholder (its value must be an http(s) address) or https text. */
const resolveHref = (target: string, values: string[]): string | null => {
  const lone = new RegExp(`^${PH_OPEN}(\\d+)${PH_CLOSE}$`).exec(target);
  if (lone) { const v = values[Number(lone[1])] ?? ''; return isHttpUrl(v) ? v : null; }
  if (target.includes(PH_OPEN)) return null;
  return /^https:\/\/[^\s"'<>]+$/i.test(target) ? target : null;
};

const COLORS = { text: '#222', link: '#0b57d0', button: '#5b2be0', muted: '#666' };

const inlineHtml = (rawForLinks: string, values: string[]): string => {
  // Links are found on the raw line (so their targets are exact), then the line is rebuilt piece by piece.
  let out = '';
  let last = 0;
  for (const m of rawForLinks.matchAll(LINK_RE)) {
    out += boldHtml(escapeHtml(rawForLinks.slice(last, m.index)), values);
    const href = resolveHref(m[2], values);
    const label = boldHtml(escapeHtml(m[1]), values);
    out += href ? `<a href="${escapeHtml(href)}" style="color:${COLORS.link}">${label}</a>` : label;
    last = (m.index ?? 0) + m[0].length;
  }
  out += boldHtml(escapeHtml(rawForLinks.slice(last)), values);
  return out;
};
const boldHtml = (escaped: string, values: string[]) => fillHtml(escaped.replace(BOLD_RE, '<strong>$1</strong>'), values);

const inlineText = (raw: string, values: string[]): string =>
  fillText(raw.replace(LINK_RE, (_m, label: string, target: string) => {
    const href = resolveHref(target, values);
    return href ? `${label} (${href})` : label;
  }).replace(BOLD_RE, '$1'), values);

type Block = { type: 'p'; lines: string[] } | { type: 'h'; line: string } | { type: 'ul'; items: string[] } | { type: 'btn'; label: string; target: string };

const blocksOf = (body: string): Block[] => {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', lines: para });
    if (list.length) blocks.push({ type: 'ul', items: list });
    para = []; list = [];
  };
  for (const rawLine of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    const t = line.trim();
    if (!t) { flush(); continue; }
    const btn = BUTTON_RE.exec(t);
    if (btn) { flush(); blocks.push({ type: 'btn', label: btn[1], target: btn[2] }); continue; }
    if (t.startsWith('# ')) { flush(); blocks.push({ type: 'h', line: t.slice(2).trim() }); continue; }
    if (t.startsWith('- ')) { if (para.length) { blocks.push({ type: 'p', lines: para }); para = []; } list.push(t.slice(2).trim()); continue; }
    if (list.length) { blocks.push({ type: 'ul', items: list }); list = []; }
    para.push(t);
  }
  flush();
  return blocks;
};

export interface RenderedMail { subject: string; text: string; html: string }

/** Renders a template with the given values. Missing values render empty (validation already refused unknown ones). */
export const renderTemplate = (subjectTpl: string, bodyTpl: string, vars: Record<string, unknown>, opts: { isRtl?: boolean; footer?: string } = {}): RenderedMail => {
  const isRtl = opts.isRtl !== false;
  const values: string[] = [];
  const subject = fillText(swapParams(subjectTpl, vars, values), values).replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  const swappedBody = swapParams(bodyTpl, vars, values);
  const blocks = blocksOf(swappedBody);

  const textParts: string[] = [];
  const htmlParts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'p') {
      textParts.push(b.lines.map((l) => inlineText(l, values)).join('\n'));
      htmlParts.push(`<p style="margin:0 0 14px">${b.lines.map((l) => inlineHtml(l, values)).join('<br>')}</p>`);
    } else if (b.type === 'h') {
      textParts.push(inlineText(b.line, values));
      htmlParts.push(`<p style="margin:0 0 14px;font-size:24px;font-weight:bold;letter-spacing:1px">${inlineHtml(b.line, values)}</p>`);
    } else if (b.type === 'ul') {
      textParts.push(b.items.map((i) => `• ${inlineText(i, values)}`).join('\n'));
      htmlParts.push(`<ul style="margin:0 0 14px;padding-${isRtl ? 'right' : 'left'}:20px">${b.items.map((i) => `<li>${inlineHtml(i, values)}</li>`).join('')}</ul>`);
    } else {
      const href = resolveHref(b.target, values);
      const label = fillText(b.label, values);
      textParts.push(href ? `${label}: ${href}` : label);
      htmlParts.push(href
        ? `<p style="margin:6px 0 18px"><a href="${escapeHtml(href)}" style="display:inline-block;background:${COLORS.button};color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:bold">${escapeHtml(label)}</a></p>`
        : `<p style="margin:0 0 14px">${escapeHtml(label)}</p>`);
    }
  }
  const footer = opts.footer ?? '';
  const dir = isRtl ? 'rtl' : 'ltr';
  const align = isRtl ? 'right' : 'left';
  const html = `<!doctype html><html lang="${isRtl ? 'he' : 'en'}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>`
    + `<body dir="${dir}" style="margin:0;padding:24px;background:#f6f6f6">`
    + `<div dir="${dir}" style="max-width:560px;margin:0 auto;background:#fff;padding:24px;border-radius:12px;`
    + `font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:${COLORS.text};text-align:${align}">${htmlParts.join('')}`
    + (footer ? `<p style="margin:18px 0 0;font-size:12px;color:${COLORS.muted}">${escapeHtml(footer)}</p>` : '')
    + `</div></body></html>`;
  const text = textParts.join('\n\n') + (footer ? `\n\n—\n${footer}` : '');
  return { subject, text, html };
};

/** The line under every service email (not marketing). */
export const SERVICE_FOOTER = 'זו הודעת שירות מלוח המשרות של SKEELZ, שקשורה לשימוש שלך באתר.';
