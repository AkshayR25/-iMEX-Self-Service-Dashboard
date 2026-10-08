// Adds the machine values that the realistic simulators send (iMEX AIML simulation/simmodel.js, live since 6 Oct 2026)
// but the property catalogue (dbb_profile_keys) does not list yet, with readable names, units and limits. The same
// catalogue is used by the Dashboard Builder (asset DashboardStore) and by Self-Service Reports (CATALOGUE_STORE_ASSET);
// ITHENA ORG holds a third copy. All three get the same additions. Existing entries are never changed; keys already
// listed are skipped, so running it again changes nothing. The previous value of each copy is saved to backups/ first.
//   node scripts/catalogue-extend.mjs          dry run: what would be added
//   node scripts/catalogue-extend.mjs --go     write (LOCAL; the server tenant gets it with migrate-target.mjs)
import { mkdirSync, writeFileSync } from 'node:fs';
import { targetClient } from './mirror/clients.mjs';

const GO = process.argv.includes('--go');
const ASSETS = ['DashboardStore', 'CATALOGUE_STORE_ASSET', 'ITHENA ORG'];
const n = (key, displayName, unit, decimals, min, max) => ({ key, displayName, unit, decimals, min, max });
const flag = (key, displayName, off, on) => ({ key, displayName, unit: '', decimals: 0, min: 0, max: 1, type: 'boolean', states: { 0: off, 1: on } });
// units follow the catalogue: machine temperatures °F, pressures psig / psi, vibration in/s; weather values metric
const ADD = {
  Compressor: [
    n('Main_Motor_Vibration', 'Main Motor Vibration', 'in/s', 2, 0, 1),
    n('Main_Motor_Bearing_Temperature', 'Main Motor Bearing Temperature', '°F', 1, 0, 300),
    n('Cooling_Water_Inlet_Temperature', 'Cooling Water Inlet Temperature', '°F', 1, 0, 200),
    n('Cooling_Water_Outlet_Temperature', 'Cooling Water Outlet Temperature', '°F', 1, 0, 200),
    n('Main_Motor_Current', 'Main Motor Current', 'A', 1, 0, 600),
    n('Main_Motor_Power', 'Main Motor Power', 'kW', 1, 0, 400),
    n('Energy_Consumption', 'Energy Consumption', 'kWh', 0, 0, 5000000),
  ],
  Dryer: [
    n('Air_Flow_Rate', 'Air Flow Rate', 'CFM', 1, 0, 2000),
    n('Inlet_Relative_Humidity', 'Inlet Relative Humidity', '%', 1, 0, 100),
    n('Outlet_Relative_Humidity', 'Outlet Relative Humidity', '%', 1, 0, 100),
    n('Refrigerant_Suction_Pressure', 'Refrigerant Suction Pressure', 'psig', 1, 0, 200),
    n('Refrigerant_Discharge_Pressure', 'Refrigerant Discharge Pressure', 'psig', 1, 0, 400),
    n('Refrigerant_Compressor_Current', 'Refrigerant Compressor Current', 'A', 1, 0, 100),
    n('Dryer_Power', 'Dryer Power', 'kW', 2, 0, 50),
    n('Hot_Gas_Bypass_Valve_Position', 'Hot Gas Bypass Valve Position', '%', 1, 0, 100),
    n('Heat_Exchanger_Approach_Temperature', 'Heat Exchanger Approach Temperature', '°F', 1, 0, 50),
    n('Filter_Differential_Pressure', 'Filter Differential Pressure', 'psi', 2, 0, 15),
    flag('Condenser_Fan_Status', 'Condenser Fan Status', 'Off', 'On'),
    n('Condenser_Fan_Speed', 'Condenser Fan Speed', 'RPM', 0, 0, 2000),
    flag('High_Refrigerant_Pressure_Alarm', 'High Refrigerant Pressure Alarm', 'Normal', 'Alarm'),
    n('Energy_Consumption', 'Energy Consumption', 'kWh', 0, 0, 5000000),
    n('Drain_Valve_Cycle_Count', 'Drain Valve Cycle Count', 'cycles', 0, 0, 1000000),
  ],
  Blower: [
    n('Ambient_Temperature', 'Ambient Temperature', '°F', 1, -20, 130),
    n('Motor_Voltage', 'Motor Voltage', 'V', 1, 0, 600),
    n('Power_Factor', 'Power Factor', '', 2, 0, 1),
    n('Inlet_Vacuum_Pressure', 'Inlet Vacuum Pressure', 'inH₂O', 2, 0, 10),
    n('Blower_Efficiency', 'Blower Efficiency', '%', 1, 0, 100),
    n('Oil_Sump_Temperature', 'Oil Sump Temperature', '°F', 1, 0, 250),
    n('Oil_Level', 'Oil Level', '%', 1, 0, 100),
    n('Vibration_Motor_Axial', 'Vibration Motor Axial', 'in/s', 2, 0, 1),
    n('Blow_Off_Valve_Position', 'Blow-Off Valve Position', '%', 1, 0, 100),
    flag('VFD_Fault_Status', 'VFD Fault Status', 'Normal', 'Fault'),
    n('Motor_Speed', 'Motor Speed', 'RPM', 0, 0, 4000),
    n('Motor_Power', 'Motor Power', 'kW', 1, 0, 300),
    flag('Low_Oil_Level_Alarm', 'Low Oil Level Alarm', 'Normal', 'Alarm'),
    n('Energy_Consumption', 'Energy Consumption', 'kWh', 0, 0, 5000000),
    n('Start_Count', 'Start Count', '', 0, 0, 100000),
  ],
  'Weather Station': [
    n('Cloud_Cover', 'Cloud Cover', '%', 0, 0, 100),
    n('PM2_5', 'PM2.5', 'µg/m³', 1, 0, 500),
    n('PM10', 'PM10', 'µg/m³', 1, 0, 600),
    n('CO2_Concentration', 'CO₂ Concentration', 'ppm', 0, 0, 2000),
    n('Evapotranspiration', 'Evapotranspiration', 'mm', 2, 0, 15),
    n('Battery_Level', 'Battery Level', '%', 0, 0, 100),
    n('Signal_Strength', 'Signal Strength', 'dBm', 0, -120, 0),
    flag('Lightning_Detection_Status', 'Lightning Detection Status', 'None', 'Detected'),
    n('Lightning_Strike_Count', 'Lightning Strike Count', '', 0, 0, 10000),
    n('Feels_Like_Temperature', 'Feels Like Temperature', '°C', 1, -50, 70),
    n('Heat_Index', 'Heat Index', '°C', 1, -40, 80),
    n('Sea_Level_Pressure', 'Sea Level Pressure', 'hPa', 1, 800, 1100),
    n('Visibility', 'Visibility', 'km', 1, 0, 50),
    n('Illuminance', 'Illuminance', 'lx', 0, 0, 200000),
    n('Air_Quality_Index', 'Air Quality Index', '', 0, 0, 500),
    n('Leaf_Wetness', 'Leaf Wetness', '%', 1, 0, 100),
    n('Solar_Panel_Voltage', 'Solar Panel Voltage', 'V', 2, 0, 30),
  ],
};

const c = await targetClient();
const day = new Date().toISOString().slice(0, 10);
for (const name of ASSETS) {
  const a = await c.api('GET', `/api/tenant/assets?assetName=${encodeURIComponent(name)}`, undefined, { allow404: true });
  if (!a) { console.log(`${name}: not on this ThingsBoard, skipped`); continue; }
  const row = ((await c.api('GET', `/api/plugins/telemetry/ASSET/${a.id.id}/values/attributes/SERVER_SCOPE?keys=dbb_profile_keys`)) || [])[0];
  if (!row) { console.log(`${name}: no catalogue, skipped`); continue; }
  const cat = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  const added = [];
  for (const [kind, list] of Object.entries(ADD)) {
    if (!Array.isArray(cat[kind])) continue; // only kinds the catalogue already has
    const have = new Set(cat[kind].map((p) => p.key));
    for (const p of list) if (!have.has(p.key)) { cat[kind].push(p); added.push(`${kind}: ${p.displayName}`); }
  }
  console.log(`${name}: ${added.length} to add${added.length ? ' (' + Object.keys(ADD).map((k) => k + ' ' + added.filter((x) => x.startsWith(k + ':')).length).join(', ') + ')' : ''}`);
  if (!GO || !added.length) continue;
  mkdirSync(`backups/${day}`, { recursive: true });
  writeFileSync(`backups/${day}/dbb_profile_keys-${name.replace(/\W+/g, '_')}.json`, JSON.stringify(row.value, null, 1));
  await c.api('POST', `/api/plugins/telemetry/ASSET/${a.id.id}/attributes/SERVER_SCOPE`, { dbb_profile_keys: cat });
}
console.log(GO ? 'done' : 'Dry run. Re-run with --go to write.');
