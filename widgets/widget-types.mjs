// ThingsBoard widget-type definitions (names, sizes, settings forms). Used by build.mjs to write one
// importable widget-type JSON per widget into widgets/dist/widget-types/. Keep in sync with deploy/deploy-browser.js.
export const settingsSchemas = {
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
export const names = { launcher: 'iMEX Navbar / edit menu', renderer: 'iMEX Machine dashboard', listing: 'iMEX Listing / Map page (stand-in)' };
export const sizes = { launcher: [6, 1], renderer: [24, 12], listing: [24, 12] };
