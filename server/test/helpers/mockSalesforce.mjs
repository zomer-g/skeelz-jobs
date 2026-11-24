// A mock Salesforce org for tests (never a real Salesforce): Client Credentials token + revoke, REST describe,
// SOQL for the few query shapes the site uses, sobject create / update, ContentVersion / ContentDocumentLink,
// /limits and the versions list. Records live in memory; tests read them through `mock.records`.
//
//   const sf = await startMockSalesforce({ port: 3198 });
//   sf.url                       → SALESFORCE_LOGIN_URL (DEV_MODE only)
//   sf.records.Contact           → Map id -> fields
//   sf.failNext(n, status, code, object?) → the next n writes (to that object) answer this error (503, or 400 'REQUIRED_FIELD_MISSING')
//   sf.seen                      → { tokens, revokes, writes: [{ method, object, id, autoAssign }] } (autoAssign = the Sforce-Auto-Assign header)
//   sf.seed(object, fields)      → a record made by someone else (the existing site, the team): returns its Id
//   sf.touch(object, id, fields) → changes it as someone else would (LastModifiedDate moves on)
//   sf.denyEdit(id) / allowEdit(id) → the integration user may not edit that record (PATCH → INSUFFICIENT_ACCESS_OR_READONLY)
//   sf.seedFile(recordId, { title, ext, bytes }) → a file on a record (ContentVersion + ContentDocumentLink): { versionId, documentId }
//   SOQL on ContentDocumentLink may select ContentDocument.Title / FileExtension / LatestPublishedVersionId / ContentModifiedDate;
//   GET sobjects/ContentVersion/<id>[?fields=…] and …/<id>/VersionData (the bytes) are served; seen.fileReads counts the latter.
//   Every record has CreatedDate / LastModifiedDate. SOQL: AND, (… OR …), =, !=, >, <, LIKE 'x%', IN, null, true/false,
//   ORDER BY, LIMIT; answers in pages of `pageSize` rows (nextRecordsUrl), like a real org.
//   Accounts: the three configured ones exist; an employer's company Account is created like any record.
import http from 'node:http';
import crypto from 'node:crypto';

export const MOCK_CLIENT_ID = 'e2e-sf-client';
export const MOCK_CLIENT_SECRET = 'e2e-sf-secret-not-real';
export const MOCK_IDS = {
  contactsAccount: '001000000000AAAAAA',
  applicationsAccount: '001000000000BBBBBB',
  jobsAccount: '001000000000CCCCCC',
  employerAccountRecordType: '012000000000OrgAAA',
  applicationsRecordType: '012000000000AppAAA',
  jobsRecordType: '012000000000JobAAA',
};

const PREFIX = { Account: '001', Contact: '003', Case: '500', ContentVersion: '068', ContentDocument: '069', ContentDocumentLink: '06A' };
const newId = (object) => `${PREFIX[object]}${crypto.randomBytes(8).toString('hex').slice(0, 12)}AAA`;

const CONTACT_FIELDS = ['Id', 'Beta__c', 'FirstName', 'LastName', 'Email', 'Phone', 'MobilePhone', 'MailingCity', 'Birthdate', 'AccountId', 'Department', 'Title', 'Description',
  'dateOfBirth_cambium__c', 'email_cambium__c', 'firstName_cambium__c', 'lastName_cambium__c', 'gender_cambium__c', 'ID_cambium__c',
  'citySymbol_cambium__c', 'phoneNumber_cambium__c', 'skills_cambium__c', 'CV_link_cambium__c'];
const CASE_FIELDS = ['Id', 'Beta__c', 'AccountId', 'RecordTypeId', 'ContactId', 'isSponserd_cambium__c', 'isMarked_cambium__c', 'isSelfApply_cambium__c',
  'company_cambium__c', 'Position_cambium__c', 'PLocation_cambium__c', 'citySymbol_cambium__c', 'PTime_cambium__c', 'PSkills_cambium__c',
  'PDescription_cambium__c', 'PComments_cambium__c', 'PFullName_cambium__c', 'PPhone_cambium__c', 'PEmail_cambium__c', 'PID_cambium__c',
  'PLink_cambium__c', 'PStatus__c', 'PCreatedDate_cambium__c', 'PModifiedDate_cambium__c', 'A_ID_cambium__c', 'A_PID_cambium__c', 'A_CID_cambium__c',
  // Threshold condition (תנאי סף): the three fields the owner creates (docs/salesforce.md); removable with dropFields().
  'Threshold_Condition__c', 'Threshold_Confirmed__c', 'Threshold_Confirmed_At__c'];
const TYPES = { Beta__c: 'boolean', Threshold_Confirmed__c: 'boolean', Threshold_Condition__c: 'textarea', Threshold_Confirmed_At__c: 'datetime' };
const ACCOUNT_FIELDS = ['Id', 'Beta__c', 'Name', 'RecordTypeId', 'Description', 'SKEELZ_Employer_Id__c'];
const CV_FIELDS = ['Id', 'Title', 'PathOnClient', 'VersionData', 'Description', 'ContentDocumentId', 'FileExtension', 'ContentSize'];
const LINK_FIELDS = ['Id', 'ContentDocumentId', 'LinkedEntityId', 'ShareType', 'Visibility'];

export const MOCK_USER_ID = '005000000000IntAAA';
const sfNow = () => new Date().toISOString().replace('Z', '+0000');

/** Top-level split on a keyword, outside parentheses and quotes. */
const splitTop = (str, word) => {
  const parts = []; let depth = 0; let q = false; let last = 0;
  const re = new RegExp(`^\\s+${word}\\s+`, 'i');
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && str[i - 1] !== '\\') q = !q;
    if (q) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0) {
      const m = re.exec(str.slice(i));
      if (m) { parts.push(str.slice(last, i)); i += m[0].length - 1; last = i + 1; }
    }
  }
  parts.push(str.slice(last));
  return parts.map((x) => x.trim()).filter(Boolean);
};
const literal = (v) => {
  const t = v.trim();
  if (/^'.*'$/s.test(t)) return t.slice(1, -1).replace(/\\(.)/g, '$1');
  if (/^null$/i.test(t)) return null;
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  return t; // a number or a datetime literal
};
const cmp = (a, b) => {
  const da = Date.parse(a), db = Date.parse(b);
  if (!Number.isNaN(da) && !Number.isNaN(db) && /\d{4}-\d{2}-\d{2}T/.test(String(a)) && /\d{4}-\d{2}-\d{2}T/.test(String(b))) return da - db;
  return String(a ?? '').localeCompare(String(b ?? ''));
};
/** One condition → a predicate over a record. Text equality is case-insensitive, as in SOQL. */
const condition = (c) => {
  let t = c.trim();
  while (/^\(.*\)$/s.test(t) && splitTop(t.slice(1, -1), 'OR').length >= 1 && balanced(t.slice(1, -1))) {
    const inner = t.slice(1, -1);
    const ors = splitTop(inner, 'OR');
    if (ors.length > 1) { const fs = ors.map(condition); return (r) => fs.some((f) => f(r)); }
    const ands = splitTop(inner, 'AND');
    if (ands.length > 1) { const fs = ands.map(condition); return (r) => fs.every((f) => f(r)); }
    t = inner.trim();
  }
  const like = /^(\w+)\s+LIKE\s+'([^']*)%'$/i.exec(t);
  if (like) {
    if (like[1] === 'Description') throw Object.assign(new Error('INVALID_FIELD'), { status: 400 }); // long text
    return (r) => String(r[like[1]] ?? '').startsWith(like[2]);
  }
  const inm = /^(\w+)\s+IN\s*\((.*)\)$/is.exec(t);
  if (inm) { const vals = [...inm[2].matchAll(/'([^']*)'/g)].map((x) => x[1]); return (r) => vals.includes(String(r[inm[1]] ?? '')); }
  const op = /^(\w+)\s*(!=|=|>=|<=|>|<)\s*(.+)$/s.exec(t);
  if (!op) throw Object.assign(new Error('MALFORMED_QUERY'), { status: 400 });
  const [, f, o, raw] = op;
  const v = literal(raw);
  return (r) => {
    const x = r[f];
    if (v === null) return o === '=' ? x === null || x === undefined || x === '' : x !== null && x !== undefined && x !== '';
    if (typeof v === 'boolean') { const xb = x === true || x === 'true'; return o === '=' ? xb === v : xb !== v; }
    const eq = String(x ?? '').toLowerCase() === String(v).toLowerCase();
    if (o === '=') return eq;
    if (o === '!=') return !eq;
    const d = cmp(x, v);
    return o === '>' ? d > 0 : o === '<' ? d < 0 : o === '>=' ? d >= 0 : d <= 0;
  };
};
const balanced = (str) => { let d = 0; let q = false; for (let i = 0; i < str.length; i++) { const ch = str[i]; if (ch === "'" && str[i - 1] !== '\\') q = !q; if (q) continue; if (ch === '(') d++; if (ch === ')') d--; if (d < 0) return false; } return d === 0; };

export const startMockSalesforce = async ({ port = 0, host = '127.0.0.1', employerFields = true, contactLengths = {}, pageSize = 2000 } = {}) => {
  const records = { Account: new Map(), Contact: new Map(), Case: new Map(), ContentVersion: new Map(), ContentDocumentLink: new Map() };
  for (const k of ['contactsAccount', 'applicationsAccount', 'jobsAccount']) records.Account.set(MOCK_IDS[k], { Id: MOCK_IDS[k], Name: k });
  const seen = { tokens: 0, revokes: 0, writes: [], badLogins: 0, deletes: 0, failed: 0, queries: [], fileReads: 0 };
  const denied = new Set();
  const cursors = new Map();
  let cursorSeq = 0;
  const tokens = new Set();
  let failures = [];
  let base = '';
  const fields = { Contact: [...CONTACT_FIELDS, ...(employerFields ? ['SKEELZ_Employer_Id__c', 'Is_SKEELZ_Employer__c'] : [])],
    Account: employerFields ? ACCOUNT_FIELDS : ACCOUNT_FIELDS.filter((f) => f !== 'SKEELZ_Employer_Id__c'), Case: CASE_FIELDS, ContentVersion: CV_FIELDS, ContentDocumentLink: LINK_FIELDS };
  const lengthOf = (object, f) => (object === 'Contact' && contactLengths[f]) || (/Description|PDescription/.test(f) ? 32000 : f === 'Threshold_Condition__c' ? 1000 : 255);

  const describe = (object) => ({
    name: object, createable: true, updateable: object !== 'ContentDocumentLink',
    fields: fields[object].map((f) => {
      const system = f === 'Id' || (object === 'ContentVersion' && f === 'ContentDocumentId');
      // Long text (Description) can't be filtered in SOQL, as in a real org.
      return { name: f, type: TYPES[f] || 'string', length: lengthOf(object, f), createable: !system, updateable: !system,
        filterable: f !== 'Description' && TYPES[f] !== 'textarea', externalId: f === 'SKEELZ_Employer_Id__c' };
    }),
    ...(object === 'Case' ? { recordTypeInfos: [
      { recordTypeId: MOCK_IDS.applicationsRecordType, available: true, active: true, developerName: 'RecordType2' },
      { recordTypeId: MOCK_IDS.jobsRecordType, available: true, active: true, developerName: 'Position' },
    ] } : object === 'Account' ? { recordTypeInfos: [
      { recordTypeId: MOCK_IDS.employerAccountRecordType, available: true, active: true, developerName: 'Organization' },
    ] } : {}),
  });

  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });

  /** The SOQL shapes this site sends (see the header). */
  const runSoql = (soql) => {
    seen.queries.push(soql);
    let m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY (\w+)(?: (ASC|DESC))?)?(?: LIMIT (\d+))?$/is.exec(soql.trim());
    if (!m) throw Object.assign(new Error('MALFORMED_QUERY'), { status: 400 });
    const [, select, object, where = '', orderBy, dir, limit] = m;
    const cols = select.split(',').map((s) => s.trim());
    let rows;
    if (object === 'Account' && /^Id IN /i.test(where)) {
      const ids = [...where.matchAll(/'([^']+)'/g)].map((x) => x[1]);
      rows = ids.filter((id) => records.Account.has(id)).map((Id) => ({ Id }));
    } else if (object === 'RecordType') {
      const ids = [...where.matchAll(/'([^']+)'/g)].map((x) => x[1]);
      rows = ids.flatMap((id) => (id === MOCK_IDS.applicationsRecordType ? [{ Id: id, SobjectType: 'Case', IsActive: true, DeveloperName: 'RecordType2' }]
        : id === MOCK_IDS.jobsRecordType ? [{ Id: id, SobjectType: 'Case', IsActive: true, DeveloperName: 'Position' }]
        : id === MOCK_IDS.employerAccountRecordType ? [{ Id: id, SobjectType: 'Account', IsActive: true, DeveloperName: 'Organization' }] : []));
    } else if (object === 'UserRecordAccess') {
      const rid = /RecordId\s*=\s*'([^']+)'/i.exec(where)?.[1];
      const uid = /UserId\s*=\s*'([^']+)'/i.exec(where)?.[1];
      rows = rid && uid === MOCK_USER_ID ? [{ RecordId: rid, HasEditAccess: !denied.has(rid) }] : [];
    } else {
      const store = records[object];
      if (!store) throw Object.assign(new Error('INVALID_TYPE'), { status: 400 });
      const conds = where ? splitTop(where, 'AND').map(condition) : [];
      rows = [...store.values()].filter((r) => conds.every((f) => f(r)));
      if (orderBy) rows.sort((a, b) => cmp(a[orderBy], b[orderBy]) * (String(dir).toUpperCase() === 'DESC' ? -1 : 1));
      if (limit) rows = rows.slice(0, Number(limit));
    }
    // ContentDocumentLink → its document, as the newest ContentVersion of it (Title, extension, version id, date).
    const docOf = (r) => {
      const vs = [...records.ContentVersion.values()].filter((v) => v.ContentDocumentId === r.ContentDocumentId)
        .sort((a, b) => cmp(b.LastModifiedDate, a.LastModifiedDate));
      const v = vs[0];
      if (!v) return null;
      return { Title: v.Title, FileExtension: extOf(v), LatestPublishedVersionId: v.Id, ContentModifiedDate: v.LastModifiedDate };
    };
    return rows.map((r) => {
      const out = {};
      for (const c of cols) {
        const rel = /^ContentDocument\.(\w+)$/.exec(c);
        if (rel && object === 'ContentDocumentLink') { const d = docOf(r); out.ContentDocument = { ...(out.ContentDocument ?? {}), [rel[1]]: d?.[rel[1]] ?? null }; }
        else out[c] = r[c];
      }
      return out;
    });
  };
  const extOf = (v) => v.FileExtension || String(v.PathOnClient ?? '').split('.').pop()?.toLowerCase() || '';
  const page = (version, all) => {
    if (all.length <= pageSize) return { totalSize: all.length, done: true, records: all };
    const id = `01gMOCK${++cursorSeq}`;
    cursors.set(id, all);
    return { totalSize: all.length, done: false, records: all.slice(0, pageSize), nextRecordsUrl: `/services/data/v${version}/query/${id}-${pageSize}` };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    const raw = await readBody(req);
    try {
      if (url.pathname === '/services/oauth2/token' && req.method === 'POST') {
        const p = new URLSearchParams(raw);
        if (url.search) return json(400, { error: 'invalid_request', error_description: 'credentials must be in the body' });
        if (p.get('grant_type') !== 'client_credentials' || p.get('client_id') !== MOCK_CLIENT_ID || p.get('client_secret') !== MOCK_CLIENT_SECRET) {
          seen.badLogins++;
          return json(400, { error: 'invalid_client', error_description: 'invalid client credentials' });
        }
        const t = `mock-${crypto.randomBytes(12).toString('hex')}`;
        tokens.add(t); seen.tokens++;
        return json(200, { access_token: t, instance_url: base, token_type: 'Bearer' });
      }
      if (url.pathname === '/services/oauth2/revoke') { tokens.delete(new URLSearchParams(raw).get('token')); seen.revokes++; return json(200, {}); }

      const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!tokens.has(auth)) return json(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]);

      if (url.pathname === '/services/oauth2/userinfo') return json(200, { user_id: MOCK_USER_ID, organization_id: '00D000000000MockAAA' });
      if (url.pathname === '/services/data/' || url.pathname === '/services/data') return json(200, [{ version: '61.0' }, { version: '62.0' }]);
      const m = /^\/services\/data\/v(\d+\.0)\/(.*)$/.exec(url.pathname);
      if (!m) return json(404, [{ errorCode: 'NOT_FOUND' }]);
      const rest = m[2];
      if (rest === 'limits') return json(200, { DailyApiRequests: { Max: 15000, Remaining: 14990 } });
      if (rest === 'query' || rest === 'query/') return json(200, page(m[1], runSoql(url.searchParams.get('q') || '')));
      const more = /^query\/(01gMOCK\d+)-(\d+)$/.exec(rest);
      if (more) {
        const all = cursors.get(more[1]);
        if (!all) return json(404, [{ errorCode: 'INVALID_QUERY_LOCATOR' }]);
        const from = Number(more[2]);
        const chunk = all.slice(from, from + pageSize);
        const done = from + pageSize >= all.length;
        return json(200, { totalSize: all.length, done, records: chunk, ...(done ? {} : { nextRecordsUrl: `/services/data/v${m[1]}/query/${more[1]}-${from + pageSize}` }) });
      }
      const bytes = /^sobjects\/ContentVersion\/(\w+)\/VersionData$/.exec(rest);
      if (bytes && req.method === 'GET') {
        const v = records.ContentVersion.get(bytes[1]);
        if (!v) return json(404, [{ errorCode: 'NOT_FOUND' }]);
        seen.fileReads++;
        const buf = Buffer.from(String(v.VersionData ?? ''), 'base64');
        res.writeHead(200, { 'Content-Type': 'application/octetstream', 'Content-Length': String(buf.length) });
        return res.end(buf);
      }
      let d = /^sobjects\/(\w+)\/describe$/.exec(rest);
      if (d) return fields[d[1]] ? json(200, describe(d[1])) : json(404, [{ errorCode: 'NOT_FOUND' }]);
      d = /^sobjects\/(\w+)\/?(\w*)$/.exec(rest);
      if (d && records[d[1]]) {
        const [, object, id] = d;
        const body = raw ? JSON.parse(raw) : {};
        if (req.method === 'DELETE') { seen.deletes++; return json(400, [{ errorCode: 'MOCK_REFUSES_DELETE' }]); }
        if (req.method === 'GET' && id) {
          const rec = records[object].get(id);
          if (!rec) return json(404, [{ errorCode: 'NOT_FOUND' }]);
          const out = { ...rec };
          delete out.VersionData;
          if (object === 'ContentVersion') { out.FileExtension = extOf(rec); out.ContentSize = Buffer.from(String(rec.VersionData ?? ''), 'base64').length; }
          return json(200, out);
        }
        const fi = req.method !== 'GET' ? failures.findIndex((f) => !f.object || f.object === object) : -1;
        if (fi >= 0) {
          const [f] = failures.splice(fi, 1);
          seen.failed++;
          return json(f.status, [{ errorCode: f.code ?? 'SERVER_ERROR', message: 'mock failure a@b.example' }]);
        }
        const unknown = Object.keys(body).filter((k) => !fields[object].includes(k) && k !== 'VersionData');
        if (unknown.length) return json(400, [{ errorCode: 'INVALID_FIELD', message: `No such column '${unknown[0]}'` }]);
        for (const [k, v] of Object.entries(body)) {
          // A field the org doesn't have refuses the whole record, as in a real org.
          if (fields[object] && k !== 'VersionData' && !fields[object].includes(k)) return json(400, [{ errorCode: 'INVALID_FIELD', message: k }]);
          if (typeof v === 'string' && k !== 'VersionData' && v.length > lengthOf(object, k)) return json(400, [{ errorCode: 'STRING_TOO_LONG', message: k }]);
        }
        if (req.method === 'POST' && !id) {
          if (object === 'Contact' && !body.LastName) return json(400, [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'LastName' }]);
          if (object === 'ContentDocumentLink') {
            const dup = [...records.ContentDocumentLink.values()].some((l) => l.ContentDocumentId === body.ContentDocumentId && l.LinkedEntityId === body.LinkedEntityId);
            if (dup) return json(400, [{ errorCode: 'DUPLICATE_VALUE', message: 'duplicate' }]);
          }
          const newRecordId = newId(object);
          const rec = { ...body, Id: newRecordId, CreatedDate: sfNow(), LastModifiedDate: sfNow() };
          if (object === 'ContentVersion') rec.ContentDocumentId = newId('ContentDocument');
          records[object].set(newRecordId, rec);
          seen.writes.push({ method: 'POST', object, id: newRecordId, autoAssign: req.headers['sforce-auto-assign'], fields: Object.keys(body ?? {}) });
          return json(201, { id: newRecordId, success: true, errors: [] });
        }
        if (req.method === 'PATCH' && id) {
          const rec = records[object].get(id);
          if (!rec) return json(404, [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]);
          if (denied.has(id)) return json(400, [{ errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY', message: 'insufficient access rights on object id' }]);
          Object.assign(rec, body, { LastModifiedDate: sfNow() });
          seen.writes.push({ method: 'PATCH', object, id, autoAssign: req.headers['sforce-auto-assign'], fields: Object.keys(body ?? {}) });
          return json(204);
        }
      }
      return json(404, [{ errorCode: 'NOT_FOUND' }]);
    } catch (e) {
      return json(e.status || 500, [{ errorCode: e.message || 'ERROR' }]);
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  base = `http://${host}:${server.address().port}`;
  return {
    url: base, records, seen,
    failNext: (n, status = 503, code = 'SERVER_UNAVAILABLE', object = undefined) => { for (let i = 0; i < n; i++) failures.push({ status, code, object }); },
    clearFailures: () => { failures = []; },
    expireTokens: () => tokens.clear(),
    /** Removes fields from an object's describe (as if the owner never created them, or the user can't see them). */
    dropFields: (object, names) => { fields[object] = fields[object].filter((f) => !names.includes(f)); },
    /** Adds custom fields to an object's describe (as if the owner created them): [{ name, type }]. */
    addFields: (object, list) => { for (const f of list) { if (!fields[object].includes(f.name)) fields[object].push(f.name); TYPES[f.name] = f.type || 'string'; } },
    seed: (object, body) => {
      const id = newId(object);
      records[object].set(id, { CreatedDate: sfNow(), LastModifiedDate: sfNow(), ...body, Id: id });
      return id;
    },
    touch: (object, id, body) => { const r = records[object].get(id); if (r) Object.assign(r, body, { LastModifiedDate: sfNow() }); return r; },
    seedFile: (recordId, { title = 'CV', ext = 'pdf', bytes = Buffer.from('%PDF-1.4 mock') } = {}) => {
      const versionId = newId('ContentVersion');
      const documentId = newId('ContentDocument');
      records.ContentVersion.set(versionId, { Id: versionId, Title: title, PathOnClient: `${title}.${ext}`, VersionData: Buffer.from(bytes).toString('base64'),
        ContentDocumentId: documentId, CreatedDate: sfNow(), LastModifiedDate: sfNow() });
      const linkId = newId('ContentDocumentLink');
      records.ContentDocumentLink.set(linkId, { Id: linkId, ContentDocumentId: documentId, LinkedEntityId: recordId, CreatedDate: sfNow(), LastModifiedDate: sfNow() });
      return { versionId, documentId };
    },
    denyEdit: (id) => denied.add(id),
    allowEdit: (id) => denied.delete(id),
    restoreFields: (object, names) => { for (const n of names) if (!fields[object].includes(n)) fields[object].push(n); },
    close: () => new Promise((r) => server.close(r)),
  };
};
