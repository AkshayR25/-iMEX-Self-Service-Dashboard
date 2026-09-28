// Draft generator for the property catalogue `dbb_profile_keys` (see README / DEVELOPER_GUIDE, D-013).
//
// Run in the browser console of a ThingsBoard page, logged in as TENANT ADMIN (uses that page's JWT;
// nothing is typed or stored). Lists every device profile with the telemetry keys its devices actually
// report, as a catalogue skeleton, and copies the JSON to the clipboard.
//
// Then, per key: set displayName, unit, decimals, min, max (take them from the existing hand-built
// machine states); delete internal/debug keys admins should not see; for on/off keys add
// "type": "boolean" and "states": {"1": "Running", "0": "Stopped"}; for coded numbers add "states"
// ({"0": "Idle", "1": "Run", "2": "Fault"}); for text keys add "type": "string".
//
// Keep the finished file in the repo (e.g. config/profile-keys.json): it is the master copy, because
// widgets/deploy/deploy-browser.js overwrites the stored attribute whenever `profileKeys` is passed.
// Store it as SERVER_SCOPE attribute `dbb_profile_keys` (type JSON) on each customer's DashboardStore
// asset, or pass it to DBB_DEPLOY({ profileKeys: ... }).
//
// Endpoints (ThingsBoard 3.6+ / 4.x): GET /api/deviceProfileInfos, GET /api/deviceProfile/devices/keys/timeseries.
// Tested on demo.thingsboard.io (CE 4.3), 27 Sep 2026.
(async () => {
  const h = { 'X-Authorization': 'Bearer ' + localStorage.getItem('jwt_token') };
  const profiles = (await fetch('/api/deviceProfileInfos?pageSize=100&page=0', { headers: h }).then((r) => r.json())).data;
  const out = {};
  for (const p of profiles) {
    const keys = await fetch(`/api/deviceProfile/devices/keys/timeseries?deviceProfileId=${p.id.id}`, { headers: h }).then((r) => r.json());
    if (keys.length) out[p.name] = keys.map((k) => ({ key: k, displayName: k, unit: '', decimals: 1, min: 0, max: 100 }));
  }
  const json = JSON.stringify(out, null, 2);
  try {
    copy(json); // DevTools console helper
    console.log(`dbb_profile_keys draft for ${Object.keys(out).length} device profiles copied to the clipboard`);
  } catch {
    console.log(json);
  }
  return out;
})();
