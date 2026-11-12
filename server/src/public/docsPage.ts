/** Short HTML docs page for the public API (GET /api/public/v1/). Static: no input is echoed. */
import { PUBLIC_LIMITS } from './publicParams.js';
import { PUBLIC_SITE_URL } from './publicJob.js';

export const docsPage = () => {
  const base = `${PUBLIC_SITE_URL}/api/public/v1`;
  const ex = (path: string) => `<li><a href="${encodeURI(base + path)}"><code>GET ${path}</code></a></li>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SKEELZ Jobs public API</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.55 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px}
code,pre{font-family:ui-monospace,Consolas,monospace;font-size:.92em}
pre{background:rgba(127,127,127,.12);padding:12px;border-radius:6px;overflow-x:auto}
h1{font-size:1.5rem}h2{font-size:1.15rem;margin-top:1.8em}
</style></head><body>
<h1>SKEELZ Jobs — public API</h1>
<p>Read-only access to the jobs published on <a href="${PUBLIC_SITE_URL}">${PUBLIC_SITE_URL.replace(/^https?:\/\//, '')}</a>:
active jobs, locations, skills and a map search. No key, no sign-in. Only <code>GET</code>; every other method gets 405.
The data is exactly what the public job pages show — never applications, candidates or internal notes.</p>
<p dir="rtl" lang="he">ממשק קריאה בלבד למשרות הפעילות המפורסמות בלוח, לערים ולכישורים. בלי הרשמה. רק מה שמופיע ממילא באתר.</p>

<h2>Endpoints</h2>
<ul>
${ex('/jobs?q=developer&limit=10')}
${ex('/jobs?location=חיפה&scope=FullTime')}
${ex('/jobs/near?lat=32.0853&lng=34.7818&radiusKm=15')}
<li><code>GET /jobs/{id}</code> — id (24 hex) or job number</li>
${ex('/locations')}
${ex('/skills')}
${ex('/openapi.json')}
</ul>
<p>Lists return <code>{ data, page, limit, total }</code>; at most ${PUBLIC_LIMITS.maxPageSize} items a page.
Responses carry <code>ETag</code> and <code>Cache-Control</code>; CORS is open (<code>*</code>, no credentials).
Limit: ${PUBLIC_LIMITS.restPerMinute} requests a minute per IP (429 after that).</p>

<h2>Example</h2>
<pre>curl '${base}/jobs?q=data&amp;limit=5'</pre>

<h2>MCP server</h2>
<p>The same data as tools for AI assistants (Claude, MCP Inspector…), Streamable HTTP, no auth:
<code>${PUBLIC_SITE_URL}/mcp</code>. Tools: <code>search_jobs</code>, <code>get_job</code>, <code>jobs_near</code>,
<code>list_locations</code>, <code>list_skills</code> — all read-only.</p>
<p><a href="${PUBLIC_SITE_URL}/privacy">Privacy</a></p>
</body></html>`;
};
