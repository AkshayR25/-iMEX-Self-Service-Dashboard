// Sample data model (build instructions, section 3). All values are fictional.
// Single source of truth for setup (what to create), backfill/simulator (which devices and keys) and
// teardown (customer title, marker). Hierarchy: ITHENA-ROOT -> SITE-RICHMOND (RIC-COMP-01, RIC-DRY-01),
// SITE-PUNE (PUN-COMP-01, PUN-WS-01), linked by `Contains` relations.

export const POC_MARKER = '[poc=true]'; // profiles cannot hold attributes; they carry this in description
export const RELATION_TYPE = 'Contains';
export const CUSTOMER_TITLE = 'ITHENA';

export const ASSET_PROFILES = ['Organization', 'Site', 'Plant', 'Line'] as const;

/** Catalogue entry for one telemetry key (shape also used by `dbb_profile_keys` in the widgets). */
export interface KeyMeta {
  key: string;
  displayName: string;
  unit: string;
  decimals: number;
  min: number;
  max: number;
}

/** One device-profile alarm: `key` compared with the device's `thresholdAttr` server attribute (D-003). */
export interface AlarmSpec {
  id: string;
  alarmType: string;
  key: string;
  operator: 'GREATER' | 'LESS';
  thresholdAttr: string;
  defaultValue: number;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'INDETERMINATE';
}

export interface DeviceProfileSpec {
  name: string;
  keys: KeyMeta[];
  alarms: AlarmSpec[];
}

export const DEVICE_PROFILES: DeviceProfileSpec[] = [
  {
    name: 'Compressor',
    keys: [
      { key: 'dischargePressure', displayName: 'Discharge pressure', unit: 'bar', decimals: 2, min: 0, max: 10 },
      { key: 'dischargeTemp', displayName: 'Discharge temperature', unit: '°C', decimals: 1, min: 0, max: 120 },
      { key: 'motorCurrent', displayName: 'Motor current', unit: 'A', decimals: 1, min: 0, max: 200 },
      { key: 'powerKw', displayName: 'Power', unit: 'kW', decimals: 1, min: 0, max: 100 },
      { key: 'runStatus', displayName: 'Run status', unit: '', decimals: 0, min: 0, max: 1 },
      { key: 'runHours', displayName: 'Run hours', unit: 'h', decimals: 1, min: 0, max: 100000 },
    ],
    alarms: [
      {
        id: 'high_discharge_temp',
        alarmType: 'High Discharge Temp',
        key: 'dischargeTemp',
        operator: 'GREATER',
        thresholdAttr: 'thr_dischargeTemp_high',
        defaultValue: 95,
        severity: 'MAJOR',
      },
    ],
  },
  {
    name: 'Dryer',
    keys: [
      { key: 'dewPoint', displayName: 'Dew point', unit: '°C', decimals: 1, min: -40, max: 20 },
      { key: 'inletTemp', displayName: 'Inlet temperature', unit: '°C', decimals: 1, min: 0, max: 80 },
      { key: 'outletTemp', displayName: 'Outlet temperature', unit: '°C', decimals: 1, min: 0, max: 80 },
      { key: 'pressureDrop', displayName: 'Pressure drop', unit: 'bar', decimals: 2, min: 0, max: 2 },
      { key: 'runStatus', displayName: 'Run status', unit: '', decimals: 0, min: 0, max: 1 },
    ],
    alarms: [
      {
        id: 'high_dew_point',
        alarmType: 'High Dew Point',
        key: 'dewPoint',
        operator: 'GREATER',
        thresholdAttr: 'thr_dewPoint_high',
        defaultValue: 5,
        severity: 'MAJOR',
      },
    ],
  },
  {
    name: 'Weather Station',
    keys: [
      { key: 'temperature', displayName: 'Temperature', unit: '°C', decimals: 1, min: -20, max: 60 },
      { key: 'humidity', displayName: 'Humidity', unit: '%', decimals: 0, min: 0, max: 100 },
      { key: 'windSpeed', displayName: 'Wind speed', unit: 'm/s', decimals: 1, min: 0, max: 40 },
      { key: 'pressure', displayName: 'Pressure', unit: 'hPa', decimals: 1, min: 950, max: 1050 },
    ],
    alarms: [
      {
        id: 'high_temperature',
        alarmType: 'High Temperature',
        key: 'temperature',
        operator: 'GREATER',
        thresholdAttr: 'thr_temperature_high',
        defaultValue: 42,
        severity: 'WARNING',
      },
    ],
  },
];

export interface AssetSpec {
  name: string;
  label: string;
  profile: (typeof ASSET_PROFILES)[number];
  parent: string | null; // internal name of parent asset; null = hierarchy root
  attributes: Record<string, unknown>;
}

export const ASSETS: AssetSpec[] = [
  { name: 'ITHENA-ROOT', label: 'ITHENA', profile: 'Organization', parent: null, attributes: { poc: true } },
  {
    name: 'SITE-RICHMOND',
    label: 'Richmond',
    profile: 'Site',
    parent: 'ITHENA-ROOT',
    attributes: { latitude: 37.5407, longitude: -77.436, address: 'Richmond, VA, USA', timezone: 'America/New_York', poc: true },
  },
  {
    name: 'SITE-PUNE',
    label: 'Pune',
    profile: 'Site',
    parent: 'ITHENA-ROOT',
    attributes: { latitude: 18.5204, longitude: 73.8567, address: 'Pune, India', timezone: 'Asia/Kolkata', poc: true },
  },
];

export interface DeviceSpec {
  name: string;
  label: string;
  profile: string;
  parent: string;
  /** UTC offset in hours, used for the weather station's day/night cycle. */
  utcOffsetH: number;
}

export const DEVICES: DeviceSpec[] = [
  { name: 'RIC-COMP-01', label: 'Richmond Compressor 1', profile: 'Compressor', parent: 'SITE-RICHMOND', utcOffsetH: -4 },
  { name: 'RIC-DRY-01', label: 'Richmond Dryer 1', profile: 'Dryer', parent: 'SITE-RICHMOND', utcOffsetH: -4 },
  { name: 'PUN-COMP-01', label: 'Pune Compressor 1', profile: 'Compressor', parent: 'SITE-PUNE', utcOffsetH: 5.5 },
  { name: 'PUN-WS-01', label: 'Pune Weather Station', profile: 'Weather Station', parent: 'SITE-PUNE', utcOffsetH: 5.5 },
];

/** Default threshold server attributes for a device, from its profile's alarm specs. */
export function defaultThresholds(profileName: string): Record<string, number> {
  const p = DEVICE_PROFILES.find((x) => x.name === profileName);
  return Object.fromEntries((p?.alarms ?? []).map((a) => [a.thresholdAttr, a.defaultValue]));
}

/**
 * App users. Per DECISIONS.md D-002 these are NOT ThingsBoard users; they are seeded into the
 * config service's own database in Phase 2.
 * D-002 has since been superseded by D-010 (no service; app users are ThingsBoard customer users with
 * `selectedNodes` / `Role` attributes). The list is still copied into setup-result.json.
 */
export const APP_USERS = [
  { email: 'admin@ithena-poc.example', role: 'Customer Admin', scope: 'ITHENA-ROOT' },
  { email: 'richmond.manager@ithena-poc.example', role: 'Site Manager', scope: 'SITE-RICHMOND' },
  { email: 'pune.viewer@ithena-poc.example', role: 'Viewer', scope: 'SITE-PUNE' },
];
