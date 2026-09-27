// Deploys the Dashboard Builder POC into ThingsBoard. Run in a logged-in TENANT ADMIN page's console
// after window.__dbbLib (library code) and window.__dbbGlue (per-widget glue) are set.
// Idempotent: finds everything by name / fqn and updates it in place. Only touches POC-marked items.
// Usage: await DBB_DEPLOY({ customerTitle: 'ITHENA', storeName: 'DBB-STORE-ITHENA', userEmails: [...] })
window.DBB_DEPLOY = async function (opts) {
  const o = Object.assign(
    {
      customerTitle: 'ITHENA',
      storeName: 'DBB-STORE-ITHENA',
      appTitle: 'iMEX App (POC)',
      appName: 'iMEX · ITHENA',
      bundleTitle: 'iMEX Self-Service (POC)',
      llmModel: 'claude-sonnet-5',
      profileKeys: {},
      userEmails: [],
    },
    opts || {},
  );
  const MARK = '[poc=true]';
  const log = [];
  const say = (m) => (log.push(m), console.log('[DBB deploy] ' + m));
  const h = () => ({ 'X-Authorization': 'Bearer ' + localStorage.getItem('jwt_token'), 'Content-Type': 'application/json' });
  const api = async (method, path, body, allow404) => {
    const r = await fetch(path, { method, headers: h(), body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    if (r.status === 404 && allow404) return null;
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${t.slice(0, 300)}`);
    return t ? JSON.parse(t) : null;
  };
  const all = async (path) => {
    const out = [];
    for (let p = 0; ; p++) {
      const r = await api('GET', `${path}${path.includes('?') ? '&' : '?'}pageSize=100&page=${p}`);
      out.push(...r.data);
      if (!r.hasNext) return out;
    }
  };
  if (!window.__dbbLib || !window.__dbbGlue) throw new Error('library not loaded');

  // --- customer
  const customer = await api('GET', `/api/tenant/customers?customerTitle=${encodeURIComponent(o.customerTitle)}`);
  const cid = customer.id.id;

  // --- rule chain for chat relay
  const rcName = 'DBB Chat relay (POC)';
  let rc = (await all(`/api/ruleChains?textSearch=${encodeURIComponent(rcName)}`)).find((x) => x.name === rcName);
  if (!rc) rc = await api('POST', '/api/ruleChain', { name: rcName, type: 'CORE', debugMode: false, configuration: { description: `${MARK} Relays Dashboard Builder chat requests to the LLM. Paste the API key into the "Call LLM" node.` } });
  const existingMeta = await api('GET', `/api/ruleChain/${rc.id.id}/metadata`);
  const oldRest = (existingMeta.nodes || []).find((n) => n.name === 'Call LLM');
  const keepHeaders = oldRest && oldRest.configuration && oldRest.configuration.headers;
  const filterScript = "return msgType == 'ATTRIBUTES_UPDATED' && msg.dbb_chat_req != null && msg.dbb_chat_req.body != null;";
  const buildScript = [
    'var req = msg.dbb_chat_req;',
    'var b = req.body;',
    'metadata.reqId = "" + req.reqId;',
    'metadata.userId = "" + req.userId;',
    `var body = {model: '${o.llmModel}', max_tokens: 2048, system: b.system, messages: b.messages, tools: b.tools, tool_choice: b.tool_choice};`,
    'return {msg: body, metadata: metadata, msgType: msgType};',
  ].join('\n');
  // NB: TBEL does not allow ternaries inside map literals (the ':' is parsed as a key separator).
  const parseScript = [
    'var tool = null;',
    'if (msg.content != null) { for (var i = 0; i < msg.content.size(); i++) { var c = msg.content[i]; if (c.type == "tool_use") { tool = c.input; } } }',
    'var ok = tool != null;',
    'var errText = "";',
    'if (!ok) { errText = "The model returned no dashboard operations."; }',
    'var resp = {reqId: metadata.reqId, ok: ok, toolInput: tool, usage: msg.usage, error: errText};',
    'var out = {};',
    'out["dbb_chat_resp_" + metadata.userId] = resp;',
    'var md = {reqId: "" + metadata.reqId, userId: "" + metadata.userId};',
    'return {msg: out, metadata: md, msgType: "POST_ATTRIBUTES_REQUEST"};',
  ].join('\n');
  const errScript = [
    'var err = "LLM call failed";',
    'if (metadata.error != null) { err = "" + metadata.error; }',
    'if (err.contains("401") || err.contains("authentication")) { err = "The LLM API key in the DBB Chat relay rule chain is missing or invalid."; }',
    'if (err.length() > 300) { err = err.substring(0, 300); }',
    'var resp = {reqId: metadata.reqId, ok: false, status: "" + metadata.status, error: err};',
    'var out = {};',
    'out["dbb_chat_resp_" + metadata.userId] = resp;',
    'var md = {reqId: "" + metadata.reqId, userId: "" + metadata.userId};',
    'return {msg: out, metadata: md, msgType: "POST_ATTRIBUTES_REQUEST"};',
  ].join('\n');
  const tbel = (s) => ({ scriptLang: 'TBEL', tbelScript: s, jsScript: 'return msg;' });
  const nodes = [
    { type: 'org.thingsboard.rule.engine.filter.TbJsFilterNode', name: 'Is chat request', configuration: { scriptLang: 'TBEL', tbelScript: filterScript, jsScript: 'return false;' }, additionalInfo: { layoutX: 300, layoutY: 150 } },
    { type: 'org.thingsboard.rule.engine.transform.TbTransformMsgNode', name: 'Build LLM request', configuration: tbel(buildScript), additionalInfo: { layoutX: 550, layoutY: 150 } },
    {
      type: 'org.thingsboard.rule.engine.rest.TbRestApiCallNode',
      name: 'Call LLM',
      configurationVersion: 3,
      configuration: {
        restEndpointUrlPattern: 'https://api.anthropic.com/v1/messages',
        requestMethod: 'POST',
        headers: keepHeaders || { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'PASTE_ANTHROPIC_API_KEY_HERE' },
        useSimpleClientHttpFactory: false,
        readTimeoutMs: 28000,
        maxParallelRequestsCount: 4,
        parseToPlainText: false,
        enableProxy: false,
        useSystemProxyProperties: false,
        proxyHost: null,
        proxyPort: 0,
        proxyUser: null,
        proxyPassword: null,
        proxyScheme: null,
        credentials: { type: 'anonymous' },
        ignoreRequestBody: false,
        maxInMemoryBufferSizeInKb: 512,
      },
      additionalInfo: { layoutX: 800, layoutY: 150 },
    },
    { type: 'org.thingsboard.rule.engine.transform.TbTransformMsgNode', name: 'Parse LLM reply', configuration: tbel(parseScript), additionalInfo: { layoutX: 1050, layoutY: 100 } },
    { type: 'org.thingsboard.rule.engine.transform.TbTransformMsgNode', name: 'Error reply', configuration: tbel(errScript), additionalInfo: { layoutX: 1050, layoutY: 250 } },
    {
      type: 'org.thingsboard.rule.engine.telemetry.TbMsgAttributesNode',
      name: 'Save reply attribute',
      configurationVersion: 3,
      configuration: { processingSettings: { type: 'ON_EVERY_MESSAGE' }, scope: 'SERVER_SCOPE', notifyDevice: false, sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: false },
      additionalInfo: { layoutX: 1300, layoutY: 150 },
    },
  ];
  await api('POST', '/api/ruleChain/metadata', {
    ruleChainId: rc.id,
    version: existingMeta.version,
    firstNodeIndex: 0,
    nodes,
    connections: [
      { fromIndex: 0, toIndex: 1, type: 'True' },
      { fromIndex: 1, toIndex: 2, type: 'Success' },
      { fromIndex: 2, toIndex: 3, type: 'Success' },
      { fromIndex: 2, toIndex: 4, type: 'Failure' },
      { fromIndex: 1, toIndex: 4, type: 'Failure' },
      { fromIndex: 3, toIndex: 5, type: 'Success' },
      { fromIndex: 4, toIndex: 5, type: 'Success' },
    ],
    ruleChainConnections: null,
  });
  say(`rule chain "${rcName}" ${keepHeaders ? 'updated (existing API key kept)' : 'written (paste the API key into "Call LLM")'}`);

  // --- asset profile + store asset
  const apName = 'DashboardStore';
  let ap = (await all(`/api/assetProfiles?textSearch=${apName}`)).find((x) => x.name === apName);
  if (ap && !String(ap.description || '').includes(MARK)) throw new Error('Asset profile DashboardStore exists without the POC marker');
  if (!ap) ap = await api('POST', '/api/assetProfile', { name: apName, description: `${MARK} Dashboard Builder store (one asset per customer)` });
  ap = await api('GET', `/api/assetProfile/${ap.id.id}`);
  ap.defaultRuleChainId = rc.id;
  await api('POST', '/api/assetProfile', ap);
  say('asset profile DashboardStore → chat relay rule chain');

  let store = await api('GET', `/api/tenant/assets?assetName=${encodeURIComponent(o.storeName)}`, undefined, true);
  if (!store) {
    store = await api('POST', '/api/asset', { name: o.storeName, label: 'Dashboard store', assetProfileId: ap.id });
    say('store asset created');
  }
  if (!store.customerId || store.customerId.id !== cid) await api('POST', `/api/customer/${cid}/asset/${store.id.id}`);
  await api('POST', `/api/plugins/telemetry/ASSET/${store.id.id}/attributes/SERVER_SCOPE`, { poc: true, dbb_profile_keys: o.profileKeys });
  say('store asset assigned to ' + o.customerTitle + ', profile keys written');

  // --- widget bundle + types
  const bundles = await all('/api/widgetsBundles?tenantOnly=true');
  let bundle = bundles.find((b) => b.title === o.bundleTitle);
  if (!bundle) bundle = await api('POST', '/api/widgetsBundle', { title: o.bundleTitle, alias: 'imex_dbb', description: `${MARK} iMEX Dashboard Builder POC widgets` });
  const settingsSchemas = {
    launcher: {
      schema: {
        type: 'object',
        properties: {
          label: { title: 'Edit icon tooltip', type: 'string', default: 'Edit dashboards' },
          adminOnly: { title: 'Show the edit icon to admins only (Role = Admin)', type: 'boolean', default: true },
          homeState: { title: 'Home (map) state id', type: 'string', default: 'default' },
          homeLabel: { title: 'Home link label', type: 'string', default: 'Map page' },
          listingState: { title: 'Listing state id', type: 'string', default: 'listing' },
          listingLabel: { title: 'Listing link label', type: 'string', default: 'Listing page' },
          machineState: { title: 'Machine state id', type: 'string', default: 'machine' },
          machineLabel: { title: 'Machine state label', type: 'string', default: 'Machine page' },
          customerId: { title: 'Customer id to show when a tenant admin opens the app', type: 'string', default: '' },
          navbar: { title: 'Render as full navbar (stand-in app)', type: 'boolean', default: false },
          appName: { title: 'App name (navbar mode)', type: 'string', default: 'iMEX' },
          lightStyle: { title: 'Light icon button (for light headers)', type: 'boolean', default: false },
          chatEnabled: { title: 'Enable chat', type: 'boolean', default: true },
          chatEnabledRoles: { title: 'Chat only for roles (comma separated, empty = all)', type: 'string', default: '' },
          hideForRoles: { title: 'Hide the edit icon for roles (comma separated)', type: 'string', default: '' },
        },
      },
      form: ['label', 'adminOnly', 'navbar', 'appName', 'homeState', 'homeLabel', 'listingState', 'listingLabel', 'machineState', 'machineLabel', 'customerId', 'lightStyle', 'chatEnabled', 'chatEnabledRoles', 'hideForRoles'],
    },
    renderer: {
      schema: { type: 'object', properties: { refreshSeconds: { title: 'Refresh every (s)', type: 'number', default: 10 }, chatEnabled: { title: 'Enable chat in builder', type: 'boolean', default: true }, customerId: { title: 'Customer id for tenant admins', type: 'string', default: '' } } },
      form: ['refreshSeconds', 'chatEnabled', 'customerId'],
    },
    listing: {
      schema: {
        type: 'object',
        properties: {
          mode: { title: "Mode ('listing' or 'map')", type: 'string', default: 'listing' },
          machineState: { title: 'Machine state id', type: 'string', default: 'machine' },
          dashboardState: { title: 'Standalone dashboard state id', type: 'string', default: 'dashboard' },
          title: { title: 'Map mode: title', type: 'string', default: 'Map page' },
          buttonLabel: { title: 'Map mode: button label', type: 'string', default: 'Go to machine listing' },
          listingState: { title: 'Map mode: listing state id', type: 'string', default: 'listing' },
          siteProfile: { title: 'Map mode: asset profile of the site nodes', type: 'string', default: 'Site' },
          customerId: { title: 'Customer id for tenant admins', type: 'string', default: '' },
        },
      },
      form: ['mode', 'machineState', 'dashboardState', 'title', 'buttonLabel', 'listingState', 'siteProfile', 'customerId'],
    },
  };
  const names = { launcher: 'iMEX Navbar / edit menu', renderer: 'iMEX Machine dashboard', listing: 'iMEX Listing / Map page (stand-in)' };
  const sizes = { launcher: [6, 1], renderer: [24, 12], listing: [24, 12] };
  const fqns = [];
  for (const k of ['launcher', 'renderer', 'listing']) {
    const fqn = `imex_dbb_${k}`;
    let wt = await api('GET', `/api/widgetType?fqn=tenant.${fqn}`, undefined, true);
    const descriptor = {
      type: 'static',
      sizeX: sizes[k][0],
      sizeY: sizes[k][1],
      resources: [],
      templateHtml: '',
      templateCss: '',
      controllerScript: window.__dbbLib + '\n' + window.__dbbGlue[k],
      settingsSchema: JSON.stringify(settingsSchemas[k]),
      dataKeySettingsSchema: '{}',
      defaultConfig: JSON.stringify({ datasources: [], showTitle: false, backgroundColor: 'rgba(0,0,0,0)', color: 'rgba(0,0,0,0.87)', padding: '0px', settings: {}, title: names[k], dropShadow: false, enableFullscreen: false }),
    };
    const body = Object.assign(wt || {}, { fqn, name: names[k], descriptor, description: `${MARK} built ${window.IMEX_DBB_VERSION || ''}`, deprecated: false, scada: false });
    wt = await api('POST', '/api/widgetType', body);
    fqns.push(wt.fqn);
    say(`widget type ${fqn} saved (${Math.round(descriptor.controllerScript.length / 1024)} KB)`);
  }
  await api('POST', `/api/widgetsBundle/${bundle.id.id}/widgetTypeFqns`, fqns);

  // --- stand-in app dashboard
  const wid = (n) => `dbb-${n}-0000-0000-000000000000`.slice(0, 36);
  const W = {
    nav: { key: 'nav', fqn: 'tenant.imex_dbb_launcher', settings: { navbar: true, appName: o.appName, label: 'Edit dashboards', adminOnly: true, homeState: 'default', homeLabel: 'Map page', listingState: 'listing', listingLabel: 'Listing page', machineState: 'machine', machineLabel: 'Machine page', customerId: cid }, bg: '#0a2458' },
    map: { key: 'map', fqn: 'tenant.imex_dbb_listing', settings: { mode: 'map', title: 'Map page', buttonLabel: 'Go to machine listing', listingState: 'listing', siteProfile: 'Site', customerId: cid }, bg: '#f6f6f4' },
    list: { key: 'list', fqn: 'tenant.imex_dbb_listing', settings: { machineState: 'machine', dashboardState: '', customerId: cid }, bg: '#f6f6f4' },
    mach: { key: 'mach', fqn: 'tenant.imex_dbb_renderer', settings: { refreshSeconds: 10, customerId: cid }, bg: '#f6f6f4' },
  };
  const ids = { nav: 'a1b2c3d4-0001-4000-8000-000000000001', list: 'a1b2c3d4-0002-4000-8000-000000000002', mach: 'a1b2c3d4-0003-4000-8000-000000000003', map: 'a1b2c3d4-0005-4000-8000-000000000005' };
  void wid;
  const widgets = {};
  for (const [k, w] of Object.entries(W))
    widgets[ids[k]] = {
      id: ids[k],
      typeFullFqn: w.fqn,
      type: 'static',
      sizeX: 24,
      sizeY: k === 'nav' ? 1 : 14,
      config: { datasources: [], showTitle: false, backgroundColor: w.bg, color: 'rgba(0,0,0,0.87)', padding: '0px', margin: '0px', settings: w.settings, title: k, dropShadow: false, enableFullscreen: false, borderRadius: '0px', actions: {} },
      row: 0,
      col: 0,
    };
  const grid = { layoutType: 'default', backgroundColor: '#f6f6f4', columns: 24, margin: 0, outerMargin: false, backgroundSizeMode: '100%', autoFillHeight: true, mobileAutoFillHeight: true, mobileRowHeight: 70 };
  const layout = (body) => ({ main: { widgets: { [ids.nav]: { sizeX: 24, sizeY: 1, row: 0, col: 0 }, [ids[body]]: { sizeX: 24, sizeY: 14, row: 1, col: 0 } }, gridSettings: grid } });
  const configuration = {
    description: `${MARK} Stand-in for the production app, 3 states: Map page (sites) → Listing page (hierarchy + cards) → Machine page. Navbar shows the current state and an admin-only Dashboard Builder button`,
    widgets,
    states: {
      default: { name: 'Map page', root: true, layouts: layout('map') },
      listing: { name: 'Listing page', root: false, layouts: layout('list') },
      machine: { name: 'Machine page', root: false, layouts: layout('mach') },
    },
    entityAliases: {},
    filters: {},
    timewindow: { realtime: { realtimeType: 1, timewindowMs: 86400000, interval: 60000 }, aggregation: { type: 'NONE', limit: 200 } },
    settings: { stateControllerId: 'entity', showTitle: false, showDashboardsSelect: false, showEntitiesSelect: false, showDashboardTimewindow: false, showDashboardExport: false, showDashboardLogo: false, toolbarAlwaysOpen: false, hideToolbar: true, showFilters: false, showUpdateDashboardImage: false },
  };
  let dash = (await all(`/api/tenant/dashboards?textSearch=${encodeURIComponent(o.appTitle)}`)).find((d) => d.title === o.appTitle);
  if (dash) {
    const full = await api('GET', `/api/dashboard/${dash.id.id}`);
    dash = await api('POST', '/api/dashboard', Object.assign(full, { configuration }));
  } else dash = await api('POST', '/api/dashboard', { title: o.appTitle, configuration });
  await api('POST', `/api/customer/${cid}/dashboard/${dash.id.id}`);
  say(`dashboard "${o.appTitle}" saved and assigned`);

  // --- home dashboard for the POC users
  const users = await all(`/api/customer/${cid}/users`);
  for (const u of users.filter((x) => o.userEmails.includes(x.email))) {
    const full = await api('GET', `/api/user/${u.id.id}`);
    full.additionalInfo = Object.assign(full.additionalInfo || {}, { defaultDashboardId: dash.id.id, defaultDashboardFullscreen: true, homeDashboardId: dash.id.id, homeDashboardHideToolbar: true });
    await api('POST', '/api/user?sendActivationMail=false', full);
  }
  say(`home dashboard set for ${o.userEmails.length} users`);
  return { log, dashboardId: dash.id.id, storeId: store.id.id, ruleChainId: rc.id.id, bundleId: bundle.id.id };
};
'deploy script loaded';
