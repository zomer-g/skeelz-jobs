// Regenerates docs/analytics/gtm-container.json from client/src/utils/analyticsPolicy.ts.
// Run from server/:  npx tsx ../docs/analytics/build-gtm-container.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENTS, CONTEXT_KEYS, GA_COOKIE_EXPIRES_SECONDS } from '../../client/src/utils/analyticsPolicy.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const A = '0', C = '0';
const T = (key: string, value: string) => ({ type: 'TEMPLATE', key, value });
const row = (k: string, v: string) => ({ type: 'MAP', map: [T('parameter', k), T('parameterValue', v)] });
const names = Object.keys(EVENTS);
const params = [...new Set(Object.values(EVENTS).flat())].sort();
const dlv = (k: string) => `DLV - ${k}`;

let id = 1;
const variable = [
  { accountId: A, containerId: C, variableId: String(id++), name: 'GA4 Measurement ID', type: 'c', parameter: [T('value', 'G-XXXXXXXXXX')] },
  ...[...CONTEXT_KEYS, ...params].map((k) => ({
    accountId: A, containerId: C, variableId: String(id++), name: dlv(k), type: 'v',
    parameter: [{ type: 'INTEGER', key: 'dataLayerVersion', value: '2' }, { type: 'BOOLEAN', key: 'setDefaultValue', value: 'false' }, T('name', k)],
  })),
];

const funnelTrigger = {
  accountId: A, containerId: C, triggerId: '100', name: 'CE - SKEELZ funnel events', type: 'CUSTOM_EVENT',
  customEventFilter: [{ type: 'MATCH_REGEX', parameter: [T('arg0', '{{_event}}'), T('arg1', `^(${names.join('|')})$`)] }],
};
const consent = { consentStatus: 'NEEDED', consentType: { type: 'LIST', list: [{ type: 'TEMPLATE', value: 'analytics_storage' }] } };
const INIT_ALL_PAGES = '2147479573';

const tag = [
  {
    accountId: A, containerId: C, tagId: '1', name: 'Google tag - GA4 (SKEELZ)', type: 'googtag',
    parameter: [T('tagId', '{{GA4 Measurement ID}}'), {
      type: 'LIST', key: 'configSettingsTable', list: [
        row('send_page_view', 'false'),
        row('cookie_expires', String(GA_COOKIE_EXPIRES_SECONDS)),
        row('page_location', `{{${dlv('page_location')}}}`),
        row('page_referrer', `{{${dlv('page_referrer')}}}`),
      ],
    }],
    firingTriggerId: [INIT_ALL_PAGES, funnelTrigger.triggerId], tagFiringOption: 'ONCE_PER_LOAD', consentSettings: consent,
  },
  {
    accountId: A, containerId: C, tagId: '2', name: 'GA4 Event - SKEELZ funnel (all events)', type: 'gaawe',
    parameter: [
      T('eventName', '{{Event}}'),
      T('measurementIdOverride', '{{GA4 Measurement ID}}'),
      { type: 'BOOLEAN', key: 'sendEcommerceData', value: 'false' },
      { type: 'LIST', key: 'eventSettingsTable', list: [...CONTEXT_KEYS.filter((k) => k.startsWith('utm_') || k === 'language' || k === 'page_path' || k === 'page_location'), ...params].map((k) => row(k, `{{${dlv(k)}}}`)) },
    ],
    firingTriggerId: [funnelTrigger.triggerId], tagFiringOption: 'ONCE_PER_EVENT', consentSettings: consent,
  },
];

const container = {
  exportFormatVersion: 2,
  exportTime: '2026-11-11 00:00:00',
  containerVersion: {
    accountId: A, containerId: C, containerVersionId: '0', name: 'SKEELZ jobs funnel (generated)',
    container: { accountId: A, containerId: C, name: 'jobs.skeelz.co.il', publicId: 'GTM-XXXXXXX', usageContext: ['WEB'] },
    tag, trigger: [funnelTrigger], variable,
    builtInVariable: [{ accountId: A, containerId: C, type: 'EVENT', name: 'Event' }],
  },
};
fs.writeFileSync(path.join(here, 'gtm-container.json'), JSON.stringify(container, null, 2) + '\n');
// The same container with the live property's measurement ID (docs/analytics.md §0), ready to import into
// GTM-WXQW5LTX with "Merge → Overwrite conflicting". A measurement ID is public (it is in every page that loads GA).
const LIVE_MEASUREMENT_ID = 'G-RPMX021BL3';
fs.writeFileSync(path.join(here, 'gtm-container.skeelz-live.json'),
  JSON.stringify(container, null, 2).replace('"G-XXXXXXXXXX"', `"${LIVE_MEASUREMENT_ID}"`) + '\n');
console.log(`events ${names.length}, params ${params.length}, variables ${variable.length}`);
