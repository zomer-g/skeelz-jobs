import DOMPurify from 'dompurify';

// Job descriptions/comments are HTML from the editor. The server sanitizes on
// save; this is a second line of defence at render time.
export const safeHtml = (html?: string): string =>
  DOMPurify.sanitize(html ?? '', { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['style'] });
