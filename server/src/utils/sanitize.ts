import sanitizeHtml from 'sanitize-html';

// Job descriptions come from the rich-text editor (slate) and from imports.
// Keep formatting only: no scripts, styles, event handlers, iframes or
// javascript: links. Links open in a new tab without access to the opener.
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'hr', 'a',
  ],
  allowedAttributes: { a: ['href', 'target', 'rel'], '*': ['dir', 'class'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }),
  },
};

export const sanitizeJobHtml = (html: string): string => sanitizeHtml(html ?? '', OPTIONS);
