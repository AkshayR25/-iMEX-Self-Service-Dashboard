// core/shiftcal.ts — the iMEX shift calendar core, TypeScript copy for the Dashboard Builder.
//
// Pure functions, no requests. The caller loads the `imexShifts` attributes of the location tree (nearest first:
// [deviceDoc, siteDoc, orgDoc, sysDoc], entries may be null) and the nearest `imexTimeZone`, and passes them in.
// Spec: docs/SHIFTS.md in the iMEX App UI repo. Contract: widgets/test/shift-vectors.json (byte-identical copy of the
// App UI's tests/shift-vectors.json; the same vectors pin the JavaScript core widgets/_shared/shifts.js and the Python
// copies in Reports and AIML). Keep this file a line-by-line port of the JavaScript core: same names, same decisions
// (SHIFTS.md section 5), same answers on bad data.
//
// Timestamps are ms since the epoch (UTC); dates are 'YYYY-MM-DD'; times are 'HH:MM' (24 h). Zone maths uses the
// browser's original Intl.DateTimeFormat (globalThis.__imxOrigDTF, saved by the App UI's clock.js, which replaces
// Intl.DateTimeFormat and forces the app's 12/24-hour choice) with hourCycle 'h23'.

// ------------------------------------------------------------------------------------------------- types

/** A break inside a shift (stored form). Times are wall-clock 'HH:MM', placed relative to the shift start. */
export interface ShiftBreakDef {
  name?: string;
  start: string;
  end: string;
}

/** One shift of a version (stored form). */
export interface ShiftDef {
  id: string | number;
  name: string;
  start: string;
  end: string;
  /** ISO weekdays (1 = Monday ... 7 = Sunday) of the production day. Missing = all 7. */
  days?: number[];
  breaks?: ShiftBreakDef[];
}

/** A dated version of one level's shifts (stored form). */
export interface ShiftVersion {
  id: string | number;
  /** First production day ('YYYY-MM-DD', local date in the site's zone); null = since always. */
  from: string | null;
  /** true = "use the level above" from this date on; shifts are ignored. */
  inherit?: boolean;
  template?: TemplateKey | string;
  /** 0 to 8 shifts. An empty list is an explicit "no shifts" and does not fall through to the level above. */
  shifts: ShiftDef[];
  by?: string;
  byName?: string;
  at?: number;
}

export interface Holiday {
  date: string;
  name?: string;
}

/** The `imexShifts` attribute (SERVER_SCOPE, JSON), format v1. */
export interface ShiftsDoc {
  v: 1;
  rev?: number;
  versions: ShiftVersion[];
  holidays?: Array<Holiday | string>;
  /** Versions removed by "All past data too"; ignored by the core. */
  replaced?: ShiftVersion[];
  by?: string;
  at?: number;
}

/** A chain entry: the document, its JSON string (as ThingsBoard often returns it), or null for "not set here". */
export type ShiftsChainEntry = ShiftsDoc | string | null | undefined;

export interface CalendarOptions {
  /** Nearest level first, e.g. [deviceDoc, siteDoc, orgDoc, sysDoc]. Unreadable entries count as null. */
  chain?: ReadonlyArray<ShiftsChainEntry> | null;
  /** IANA zone; invalid or missing falls back to 'UTC'. */
  tz?: string | null;
}

export interface BreakInstance {
  name: string;
  start: number;
  end: number;
}

/** A shift instance: half-open [start, end), belonging to the production day it starts on. */
export interface ShiftInstance {
  /** The shift id as stored (null when missing). */
  id: string | number | null;
  name: string;
  start: number;
  end: number;
  productionDay: string;
  /** The version id as stored (null when missing). */
  versionId: string | number | null;
  breaks: BreakInstance[];
  /** Only on at() / current(). */
  inBreak?: boolean;
}

export interface ShiftCalendar {
  /** The zone actually used. */
  readonly tz: string;
  /** The instance containing ts (with inBreak), or null. */
  at(ts: number): ShiftInstance | null;
  /** Same as at(now). */
  current(now: number): ShiftInstance | null;
  /** The instance with the greatest end <= now (production days localDate(now)-14 .. localDate(now)). */
  previous(now: number): ShiftInstance | null;
  /** The instance with the smallest start > now (production days localDate(now) .. +14). */
  next(now: number): ShiftInstance | null;
  /** Instances overlapping [from, to), sorted by start then end, NOT clipped to the range. */
  between(from: number, to: number): ShiftInstance[];
  /** The productionDay of the instance containing ts, else the local calendar date of ts. */
  productionDay(ts: number): string;
  /** Sorted, unique instance starts and ends inside [from, to] (both inclusive). */
  boundaries(from: number, to: number): number[];
}

export type ValidationCode =
  | 'SHIFTS_INVALID'
  | 'FROM_INVALID'
  | 'TOO_MANY_SHIFTS'
  | 'ID_INVALID'
  | 'NAME_INVALID'
  | 'NAME_DUPLICATE'
  | 'TIME_INVALID'
  | 'TIME_GRID'
  | 'DAYS_INVALID'
  | 'BREAK_INVALID'
  | 'BREAK_OUTSIDE'
  | 'BREAK_OVERLAP'
  | 'OVERLAP';

export interface ValidationIssue {
  code: ValidationCode;
  message: string;
  shiftId?: string | number;
}

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** Per ISO weekday, the uncovered [start, end) minutes (0..1440) of that calendar day. */
export type CoverageGaps = Record<IsoWeekday, Array<[number, number]>>;

export type TemplateKey = '3x8' | '2x12' | 'day' | 'custom';
export interface ShiftTemplate {
  readonly label: string;
  readonly shifts: ReadonlyArray<Readonly<Omit<ShiftDef, 'days'>> & { readonly days?: ReadonlyArray<number> }>;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  /** 'YYYY-MM-DD' */
  date: string;
}

// ------------------------------------------------------------------------------------------------- dates and times

const DAY_MS = 86400000;
const MIN_MS = 60000;
const WEEK_MIN = 7 * 1440;
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

type AnyObj = Record<string, any>;

const pad = (n: number): string => (n < 10 ? '0' : '') + n;
const isArray = (a: unknown): a is any[] => Array.isArray(a);
const isObj = (x: unknown): x is AnyObj => !!x && typeof x === 'object';
const mod1440 = (x: number): number => ((x % 1440) + 1440) % 1440;

/** 'HH:MM' -> minutes of the day, or null. */
function hm(s: unknown): number | null {
  const m = typeof s === 'string' ? HM_RE.exec(s) : null;
  return m ? +m[1] * 60 + +m[2] : null;
}

/** 'YYYY-MM-DD' -> days since 1970-01-01, or null (also null for impossible dates such as 2026-02-30). */
function dayNum(s: unknown): number | null {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null;
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const c = new Date(t);
  if (y < 100 || c.getUTCFullYear() !== y || c.getUTCMonth() !== mo - 1 || c.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function dayStr(n: number): string {
  const c = new Date(n * DAY_MS);
  return c.getUTCFullYear() + '-' + pad(c.getUTCMonth() + 1) + '-' + pad(c.getUTCDate());
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a day number; 1970-01-01 was a Thursday. */
const isoWeekday = (n: number): number => (((n % 7) + 7 + 3) % 7) + 1;

// ------------------------------------------------------------------------------------------------- zone helpers

// The IANA zone names (tzdata 2026e, 597 names, the same set Python's zoneinfo + tzdata accepts, without 'Factory' and
// 'localtime'), grouped by prefix. A name is valid only with exactly this spelling: the engine itself also accepts
// 'asia/kolkata' or '+05:30', which Python rejects, and the two would then use different zones.
const ZONE_LIST =
  'Africa/:Abidjan Accra Addis_Ababa Algiers Asmara Asmera Bamako Bangui Banjul Bissau Blantyre Brazzaville Bujumbura' +
  ' Cairo Casablanca Ceuta Conakry Dakar Dar_es_Salaam Djibouti Douala El_Aaiun Freetown Gaborone Harare Johannesburg' +
  ' Juba Kampala Khartoum Kigali Kinshasa Lagos Libreville Lome Luanda Lubumbashi Lusaka Malabo Maputo Maseru Mbabane' +
  ' Mogadishu Monrovia Nairobi Ndjamena Niamey Nouakchott Ouagadougou Porto-Novo Sao_Tome Timbuktu Tripoli Tunis' +
  ' Windhoek' +
  '|America/:Adak Anchorage Anguilla Antigua Araguaina Aruba Asuncion Atikokan Atka Bahia Bahia_Banderas Barbados' +
  ' Belem Belize Blanc-Sablon Boa_Vista Bogota Boise Buenos_Aires Cambridge_Bay Campo_Grande Cancun Caracas Catamarca' +
  ' Cayenne Cayman Chicago Chihuahua Ciudad_Juarez Coral_Harbour Cordoba Costa_Rica Coyhaique Creston Cuiaba Curacao' +
  ' Danmarkshavn Dawson Dawson_Creek Denver Detroit Dominica Edmonton Eirunepe El_Salvador Ensenada Fort_Nelson' +
  ' Fort_Wayne Fortaleza Glace_Bay Godthab Goose_Bay Grand_Turk Grenada Guadeloupe Guatemala Guayaquil Guyana Halifax' +
  ' Havana Hermosillo Indianapolis Inuvik Iqaluit Jamaica Jujuy Juneau Knox_IN Kralendijk La_Paz Lima Los_Angeles' +
  ' Louisville Lower_Princes Maceio Managua Manaus Marigot Martinique Matamoros Mazatlan Mendoza Menominee Merida' +
  ' Metlakatla Mexico_City Miquelon Moncton Monterrey Montevideo Montreal Montserrat Nassau New_York Nipigon Nome' +
  ' Noronha Nuuk Ojinaga Panama Pangnirtung Paramaribo Phoenix Port-au-Prince Port_of_Spain Porto_Acre Porto_Velho' +
  ' Puerto_Rico Punta_Arenas Rainy_River Rankin_Inlet Recife Regina Resolute Rio_Branco Rosario Santa_Isabel Santarem' +
  ' Santiago Santo_Domingo Sao_Paulo Scoresbysund Shiprock Sitka St_Barthelemy St_Johns St_Kitts St_Lucia St_Thomas' +
  ' St_Vincent Swift_Current Tegucigalpa Thule Thunder_Bay Tijuana Toronto Tortola Vancouver Virgin Whitehorse' +
  ' Winnipeg Yakutat Yellowknife' +
  '|America/Argentina/:Buenos_Aires Catamarca ComodRivadavia Cordoba Jujuy La_Rioja Mendoza Rio_Gallegos Salta' +
  ' San_Juan San_Luis Tucuman Ushuaia' +
  '|America/Indiana/:Indianapolis Knox Marengo Petersburg Tell_City Vevay Vincennes Winamac' +
  '|America/Kentucky/:Louisville Monticello' +
  '|America/North_Dakota/:Beulah Center New_Salem' +
  '|Antarctica/:Casey Davis DumontDUrville Macquarie Mawson McMurdo Palmer Rothera South_Pole Syowa Troll Vostok' +
  '|Arctic/:Longyearbyen' +
  '|Asia/:Aden Almaty Amman Anadyr Aqtau Aqtobe Ashgabat Ashkhabad Atyrau Baghdad Bahrain Baku Bangkok Barnaul Beirut' +
  ' Bishkek Brunei Calcutta Chita Choibalsan Chongqing Chungking Colombo Dacca Damascus Dhaka Dili Dubai Dushanbe' +
  ' Famagusta Gaza Harbin Hebron Ho_Chi_Minh Hong_Kong Hovd Irkutsk Istanbul Jakarta Jayapura Jerusalem Kabul' +
  ' Kamchatka Karachi Kashgar Kathmandu Katmandu Khandyga Kolkata Krasnoyarsk Kuala_Lumpur Kuching Kuwait Macao Macau' +
  ' Magadan Makassar Manila Muscat Nicosia Novokuznetsk Novosibirsk Omsk Oral Phnom_Penh Pontianak Pyongyang Qatar' +
  ' Qostanay Qyzylorda Rangoon Riyadh Saigon Sakhalin Samarkand Seoul Shanghai Singapore Srednekolymsk Taipei' +
  ' Tashkent Tbilisi Tehran Tel_Aviv Thimbu Thimphu Tokyo Tomsk Ujung_Pandang Ulaanbaatar Ulan_Bator Urumqi Ust-Nera' +
  ' Vientiane Vladivostok Yakutsk Yangon Yekaterinburg Yerevan' +
  '|Atlantic/:Azores Bermuda Canary Cape_Verde Faeroe Faroe Jan_Mayen Madeira Reykjavik South_Georgia St_Helena' +
  ' Stanley' +
  '|Australia/:ACT Adelaide Brisbane Broken_Hill Canberra Currie Darwin Eucla Hobart LHI Lindeman Lord_Howe Melbourne' +
  ' NSW North Perth Queensland South Sydney Tasmania Victoria West Yancowinna' +
  '|Brazil/:Acre DeNoronha East West' +
  '|:CET CST6CDT Cuba EET EST EST5EDT Egypt Eire GB GB-Eire GMT GMT+0 GMT-0 GMT0 Greenwich HST Hongkong Iceland Iran' +
  ' Israel Jamaica Japan Kwajalein Libya MET MST MST7MDT NZ NZ-CHAT Navajo PRC PST8PDT Poland Portugal ROC ROK' +
  ' Singapore Turkey UCT UTC Universal W-SU WET Zulu' +
  '|Canada/:Atlantic Central Eastern Mountain Newfoundland Pacific Saskatchewan Yukon' +
  '|Chile/:Continental EasterIsland' +
  '|Etc/:GMT GMT+0 GMT+1 GMT+10 GMT+11 GMT+12 GMT+2 GMT+3 GMT+4 GMT+5 GMT+6 GMT+7 GMT+8 GMT+9 GMT-0 GMT-1 GMT-10' +
  ' GMT-11 GMT-12 GMT-13 GMT-14 GMT-2 GMT-3 GMT-4 GMT-5 GMT-6 GMT-7 GMT-8 GMT-9 GMT0 Greenwich UCT UTC Universal Zulu' +
  '|Europe/:Amsterdam Andorra Astrakhan Athens Belfast Belgrade Berlin Bratislava Brussels Bucharest Budapest' +
  ' Busingen Chisinau Copenhagen Dublin Gibraltar Guernsey Helsinki Isle_of_Man Istanbul Jersey Kaliningrad Kiev' +
  ' Kirov Kyiv Lisbon Ljubljana London Luxembourg Madrid Malta Mariehamn Minsk Monaco Moscow Nicosia Oslo Paris' +
  ' Podgorica Prague Riga Rome Samara San_Marino Sarajevo Saratov Simferopol Skopje Sofia Stockholm Tallinn Tirane' +
  ' Tiraspol Ulyanovsk Uzhgorod Vaduz Vatican Vienna Vilnius Volgograd Warsaw Zagreb Zaporozhye Zurich' +
  '|Indian/:Antananarivo Chagos Christmas Cocos Comoro Kerguelen Mahe Maldives Mauritius Mayotte Reunion' +
  '|Mexico/:BajaNorte BajaSur General' +
  '|Pacific/:Apia Auckland Bougainville Chatham Chuuk Easter Efate Enderbury Fakaofo Fiji Funafuti Galapagos Gambier' +
  ' Guadalcanal Guam Honolulu Johnston Kanton Kiritimati Kosrae Kwajalein Majuro Marquesas Midway Nauru Niue Norfolk' +
  ' Noumea Pago_Pago Palau Pitcairn Pohnpei Ponape Port_Moresby Rarotonga Saipan Samoa Tahiti Tarawa Tongatapu Truk' +
  ' Wake Wallis Yap' +
  '|US/:Alaska Aleutian Arizona Central East-Indiana Eastern Hawaii Indiana-Starke Michigan Mountain Pacific Samoa';

let zoneSet: Set<string> | null = null;
function knownZones(): Set<string> {
  if (!zoneSet) {
    zoneSet = new Set();
    for (const g of ZONE_LIST.split('|')) {
      const c = g.indexOf(':'), p = g.slice(0, c);
      for (const n of g.slice(c + 1).split(' ')) zoneSet.add(p + n);
    }
  }
  return zoneSet;
}

type DTFCtor = typeof Intl.DateTimeFormat;
const fmtCache = new Map<string, Intl.DateTimeFormat>();
const tzOk = new Map<string, boolean>();

function DTF(): DTFCtor {
  return ((globalThis as any).__imxOrigDTF as DTFCtor | undefined) || Intl.DateTimeFormat;
}

/**
 * Whether tz is a valid zone name: a case-exact IANA name the engine knows (one of the list above, or a newer zone the
 * engine reports under exactly that name). Offset strings ('+05:30') and other spellings ('asia/kolkata') are not.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  const known = tzOk.get(tz);
  if (known !== undefined) return known;
  let ok = false;
  if (tz.charAt(0) !== '+' && tz.charAt(0) !== '-') {
    try {
      const f = new (DTF())('en-US', { timeZone: tz });
      ok = knownZones().has(tz) || (typeof f.resolvedOptions === 'function' && f.resolvedOptions().timeZone === tz);
    } catch {
      ok = false;
    }
  }
  tzOk.set(tz, ok);
  return ok;
}

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    // hour12:false as well: an engine that ignores hourCycle still gives 0-23 (or 1-24, read below)
    f = new (DTF())('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

interface Fields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Offset of the zone at an instant (ms east of UTC), read from the formatter. Robust to a formatter that still writes
 * 12-hour times (a wrapper that forces hour12, an engine that ignores hourCycle): a dayPeriod part (AM/PM) is
 * converted. An engine without formatToParts, or any failure, gives 0 (UTC) instead of an exception.
 */
function readOffset(ts: number, tz: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    const f = fmt(tz);
    if (typeof f.formatToParts !== 'function') return 0;
    parts = f.formatToParts(new Date(ts));
  } catch {
    return 0;
  }
  const o: Fields = { year: NaN, month: NaN, day: NaN, hour: NaN, minute: NaN, second: NaN };
  let pm: boolean | null = null;
  for (const p of parts) {
    switch (p.type as string) {
      case 'year':
      case 'month':
      case 'day':
      case 'hour':
      case 'minute':
      case 'second':
        o[p.type as keyof Fields] = parseInt(p.value, 10);
        break;
      case 'dayPeriod':
      case 'dayperiod':
        pm = /p/i.test(p.value);
        break;
    }
  }
  if (pm !== null) o.hour = (o.hour % 12) + (pm ? 12 : 0);
  else if (o.hour === 24) o.hour = 0; // engines that write midnight as 24
  const off = Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second) - Math.floor(ts / 1000) * 1000;
  return off === off && Math.abs(off) < 2 * DAY_MS ? off : 0;
}

// Offsets cached per zone and UTC hour, shared by all calendars (reset at 200 000 entries). An hour is cached only when
// its first and last second have the same offset, so an hour with a change in it (on any minute or second) is always
// read directly. Most calls then cost no formatter call at all.
let offCache = new Map<string, Map<number, number | null>>();
let offCount = 0;
const HOUR_MS = 3600000;

/** Offset of the zone at an instant, in ms east of UTC. */
function offsetMs(ts: number, tz: string): number {
  const b = Math.floor(ts / HOUR_MS);
  if (!Number.isFinite(b)) return readOffset(ts, tz);
  if (offCount > 200000) {
    offCache = new Map();
    offCount = 0;
  }
  let c = offCache.get(tz);
  if (!c) {
    c = new Map();
    offCache.set(tz, c);
  }
  let v = c.get(b);
  if (v === undefined) {
    const o1 = readOffset(b * HOUR_MS, tz), o2 = readOffset(b * HOUR_MS + HOUR_MS - 1000, tz);
    v = o1 === o2 ? o1 : null;
    c.set(b, v);
    offCount++;
  }
  return v === null ? readOffset(ts, tz) : v;
}

/** Wall-clock fields of an instant in a zone (whole seconds). */
function fields(ts: number, tz: string): Fields {
  const d = new Date(Math.floor(ts / 1000) * 1000 + offsetMs(ts, tz));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}

function tzOr(tz: unknown): string {
  return isValidTimeZone(tz) ? tz : 'UTC';
}

/** The zone's UTC offset at ts in minutes east of UTC (Asia/Kolkata 330, America/New_York in winter -300). */
export function offset(ts: number, tz?: string | null): number {
  return Math.round(offsetMs(ts, tzOr(tz)) / MIN_MS);
}

/** Wall-clock parts of ts in the zone; weekday is ISO (1 = Monday), date is 'YYYY-MM-DD'. */
export function localParts(ts: number, tz?: string | null): LocalParts {
  const f = fields(ts, tzOr(tz));
  const n = Math.round(Date.UTC(f.year, f.month - 1, f.day) / DAY_MS);
  return { ...f, weekday: isoWeekday(n), date: dayStr(n) };
}

function localDay(ts: number, tz: string): number {
  const f = fields(ts, tz);
  return Math.round(Date.UTC(f.year, f.month - 1, f.day) / DAY_MS);
}

// Wall-clock (day number + minute of the day) -> instant. A time that does not exist (spring gap) moves forward by
// the gap; an ambiguous time (autumn) takes the first occurrence. Same as Python zoneinfo with fold=0.
// Shared by all calendars (per zone), reset at 50 000 entries.
let wallCache = new Map<string, Map<number, number>>();
let wallCount = 0;

function wall(n: number, minute: number, tz: string): number {
  if (wallCount > 50000) {
    wallCache = new Map();
    wallCount = 0;
  }
  let c = wallCache.get(tz);
  if (!c) {
    c = new Map();
    wallCache.set(tz, c);
  }
  const key = n * 1440 + minute;
  const hit = c.get(key);
  if (hit !== undefined) return hit;
  let v: number | undefined;
  const L = n * DAY_MS + minute * MIN_MS; // the wall time read as if it were UTC
  const oa = offsetMs(L - DAY_MS, tz); // offset well before the instant
  let ob = offsetMs(L + DAY_MS, tz); // offset well after it
  if (oa === ob) {
    const t0 = L - oa;
    const o0 = offsetMs(t0, tz);
    if (o0 === oa) v = t0;
    else ob = o0; // two changes within two days: rare, resolve below
  }
  if (v === undefined) {
    const ta = L - oa, tb = L - ob;
    const va = offsetMs(ta, tz) === oa, vb = offsetMs(tb, tz) === ob;
    if (va && vb) v = Math.min(ta, tb); // ambiguous: first occurrence
    else if (va) v = ta;
    else if (vb) v = tb;
    else v = ta; // gap: the offset before the change, so the time moves forward
  }
  c.set(key, v);
  wallCount++;
  return v;
}

/** The instant of a wall-clock time in the zone (DST rules above). NaN for an invalid date or time. */
export function fromLocal(dateStr: string, time: string, tz?: string | null): number {
  const n = dayNum(dateStr), m = hm(time);
  if (n === null || m === null) return NaN;
  return wall(n, m, tzOr(tz));
}

// ------------------------------------------------------------------------------------------------- documents

interface PrepBreak {
  name: string;
  bs: number;
  be: number;
  /** Calendar-day offsets (from the production day) of the break start and end. */
  ds: number;
  de: number;
}
interface PrepShift {
  id: string | number | null;
  name: string;
  a: number;
  b: number;
  len: number;
  cross: boolean;
  mask: number;
  breaks: PrepBreak[];
  idx: number;
}
interface PrepVersion {
  id: string | number | null;
  /** from, or '' for since always. */
  key: string;
  inherit: boolean;
  shifts: PrepShift[];
  idx: number;
}
interface PrepDoc {
  versions: PrepVersion[];
  holidays: string[];
}

function parseDoc(d: unknown): AnyObj | null {
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  return isObj(d) && !isArray(d) ? d : null;
}

/** A shift as the core uses it; null when its times are unusable. */
function prepShift(s: unknown, idx: number): PrepShift | null {
  if (!isObj(s)) return null;
  const a = hm(s.start), b = hm(s.end);
  if (a === null || b === null) return null;
  const len = mod1440(b - a) || 1440;
  let mask = 0;
  if (isArray(s.days)) {
    for (const d of s.days) {
      if (typeof d === 'number' && d >= 1 && d <= 7 && d % 1 === 0) mask |= 1 << d;
    }
  } else mask = 254; // days missing: every day
  const brs: PrepBreak[] = [];
  if (isArray(s.breaks)) {
    for (const br of s.breaks) {
      if (!isObj(br)) continue;
      const bs = hm(br.start), be = hm(br.end);
      if (bs === null || be === null) continue;
      const rs = mod1440(bs - a);
      let re = mod1440(be - a);
      if (re <= rs) re += 1440;
      brs.push({
        name: typeof br.name === 'string' ? br.name : '',
        bs,
        be,
        ds: Math.floor((a + rs) / 1440),
        de: Math.floor((a + re) / 1440),
      });
    }
  }
  return {
    id: s.id === undefined ? null : s.id,
    name: typeof s.name === 'string' ? s.name : '',
    a,
    b,
    len,
    cross: b <= a,
    mask,
    breaks: brs,
    idx,
  };
}

function prepVersion(v: AnyObj, idx: number): PrepVersion {
  const shifts: PrepShift[] = [];
  if (isArray(v.shifts)) {
    v.shifts.forEach((s, i) => {
      const p = prepShift(s, i);
      if (p) shifts.push(p);
    });
  }
  return { id: v.id === undefined ? null : v.id, key: v.from == null ? '' : v.from, inherit: v.inherit === true, shifts, idx };
}

function prepDoc(raw: unknown): PrepDoc | null {
  const d = parseDoc(raw);
  if (!d) return null;
  const vs: PrepVersion[] = [];
  if (isArray(d.versions)) {
    d.versions.forEach((v, i) => {
      if (!isObj(v)) return;
      if (v.from != null && dayNum(v.from) === null) return; // unreadable start date: ignored
      vs.push(prepVersion(v, i));
    });
  }
  // ascending by start date; on equal dates the later one in the array wins (it sorts last)
  vs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.idx - y.idx));
  const hol: string[] = [];
  if (isArray(d.holidays)) {
    for (const h of d.holidays) {
      const ds = typeof h === 'string' ? h : isObj(h) ? h.date : null;
      if (dayNum(ds) !== null) hol.push(ds);
    }
  }
  return { versions: vs, holidays: hol };
}

// ------------------------------------------------------------------------------------------------- the calendar

function copyInst(x: ShiftInstance): ShiftInstance {
  return {
    id: x.id,
    name: x.name,
    start: x.start,
    end: x.end,
    productionDay: x.productionDay,
    versionId: x.versionId,
    breaks: x.breaks.map((b) => ({ name: b.name, start: b.start, end: b.end })),
  };
}
const byStart = (x: ShiftInstance, y: ShiftInstance): number => x.start - y.start || x.end - y.end;

interface RawBreak extends BreakInstance {
  idx: number;
}
interface RawInst extends Omit<ShiftInstance, 'breaks'> {
  breaks: RawBreak[];
  idx: number;
}
interface RawDay {
  ver: PrepVersion | null;
  list: RawInst[];
  /** The earliest start of an instance that is not empty (Infinity: none). */
  first: number;
}
interface Span {
  start: number;
  end: number;
  idx: number;
}

/**
 * Drops intervals with end <= start, sorts by (start, end, position), caps every end at the next start and at limit,
 * and drops what became empty. Used for the instances of a day and for the breaks of an instance.
 */
function untangle<T extends Span>(list: T[], limit: number): Array<{ x: T; end: number }> {
  const live = list.filter((x) => x.end > x.start);
  live.sort((x, y) => x.start - y.start || x.end - y.end || x.idx - y.idx);
  const out: Array<{ x: T; end: number }> = [];
  for (let k = 0; k < live.length; k++) {
    const end = Math.min(live[k].end, limit, k + 1 < live.length ? live[k + 1].start : Infinity);
    if (end > live[k].start) out.push({ x: live[k], end });
  }
  return out;
}

/** The shift calendar of one machine (or site): chain nearest first, plus the zone. */
export function calendar(opts?: CalendarOptions | null): ShiftCalendar {
  const o: AnyObj = isObj(opts) ? opts : {};
  const tz = tzOr(o.tz);
  const docs: Array<PrepDoc | null> = [];
  const holidays = new Set<string>();
  const chain: unknown[] = isArray(o.chain) ? o.chain : [];
  for (const entry of chain) {
    const d = prepDoc(entry);
    docs.push(d);
    if (d) for (const h of d.holidays) holidays.add(h);
  }

  // the version that defines production day 'ds' (null: no shifts that day)
  function versionFor(ds: string): PrepVersion | null {
    for (const d of docs) {
      if (!d) continue;
      let found: PrepVersion | null = null;
      for (let k = d.versions.length - 1; k >= 0; k--) {
        if (d.versions[k].key <= ds) {
          found = d.versions[k];
          break;
        }
      }
      if (!found || found.inherit) continue;
      return found;
    }
    return null;
  }

  let rawCache = new Map<number, RawDay>();
  let dayCache = new Map<number, ShiftInstance[]>();
  let cached = 0;

  // instances of production day n as resolved from the wall clock, before any clipping (unsorted)
  function raw(n: number): RawDay {
    const hit = rawCache.get(n);
    if (hit) return hit;
    const ds = dayStr(n);
    const ver = holidays.has(ds) ? null : versionFor(ds);
    const list: RawInst[] = [];
    let first = Infinity;
    if (ver) {
      const bit = 1 << isoWeekday(n);
      for (const s of ver.shifts) {
        if (!(s.mask & bit)) continue;
        const brs = s.breaks.map((b, j) => ({ name: b.name, start: wall(n + b.ds, b.bs, tz), end: wall(n + b.de, b.be, tz), idx: j }));
        const x: RawInst = {
          id: s.id,
          name: s.name,
          start: wall(n, s.a, tz),
          end: wall(s.cross ? n + 1 : n, s.b, tz),
          productionDay: ds,
          versionId: ver.id,
          breaks: brs,
          idx: s.idx,
        };
        list.push(x);
        if (x.end > x.start && x.start < first) first = x.start;
      }
    }
    const r: RawDay = { ver, list, first };
    rawCache.set(n, r);
    return r;
  }

  // Final instances of production day n (SHIFTS.md 3.4). Wall-clock times inside a spring gap move forward by the gap,
  // which is not monotonic (02:30 becomes 03:30 while 03:15 stays 03:15), and a dated change can start the next day
  // earlier. So: drop instances with end <= start, sort, and cap every end at the next instance's start and at the
  // first start of day n+1 (whichever version that day uses). Instances then never overlap and are never empty.
  // Breaks are clipped to their instance and untangled the same way.
  function day(n: number): ShiftInstance[] {
    const hit = dayCache.get(n);
    if (hit) return hit;
    if (cached > 4000) {
      rawCache = new Map();
      dayCache = new Map();
      cached = 0;
    }
    const r = raw(n);
    const out: ShiftInstance[] = [];
    if (r.list.length) {
      for (const { x, end } of untangle(r.list, raw(n + 1).first)) {
        const clipped: RawBreak[] = x.breaks.map((b) => ({ name: b.name, start: Math.max(b.start, x.start), end: Math.min(b.end, end), idx: b.idx }));
        const brs: BreakInstance[] = untangle(clipped, end).map((u) => ({ name: u.x.name, start: u.x.start, end: u.end }));
        out.push({ id: x.id, name: x.name, start: x.start, end, productionDay: x.productionDay, versionId: x.versionId, breaks: brs });
      }
    }
    dayCache.set(n, out);
    cached++;
    return out;
  }

  function at(t: number): ShiftInstance | null {
    const ts = Number(t);
    if (Number.isNaN(ts)) return null;
    const n = localDay(ts, tz);
    let best: ShiftInstance | null = null;
    for (let k = n - 2; k <= n; k++) {
      for (const x of day(k)) {
        if (x.start <= ts && ts < x.end && (!best || x.start > best.start)) best = x;
      }
    }
    if (!best) return null;
    const res = copyInst(best);
    res.inBreak = res.breaks.some((b) => b.start <= ts && ts < b.end);
    return res;
  }

  function previous(t: number): ShiftInstance | null {
    const now = Number(t);
    if (Number.isNaN(now)) return null;
    const n = localDay(now, tz);
    let best: ShiftInstance | null = null;
    for (let k = n - 14; k <= n; k++) {
      for (const x of day(k)) {
        if (x.end <= now && (!best || x.end > best.end || (x.end === best.end && x.start > best.start))) best = x;
      }
    }
    return best ? copyInst(best) : null;
  }

  function next(t: number): ShiftInstance | null {
    const now = Number(t);
    if (Number.isNaN(now)) return null;
    const n = localDay(now, tz);
    for (let k = n; k <= n + 14; k++) {
      let best: ShiftInstance | null = null;
      for (const x of day(k)) if (x.start > now && (!best || x.start < best.start)) best = x;
      if (best) return copyInst(best); // every instance of a day starts before the first one of the next day
    }
    return null;
  }

  function between(f: number, t: number): ShiftInstance[] {
    const from = Number(f), to = Number(t);
    if (!(to > from)) return [];
    const out: ShiftInstance[] = [];
    const n1 = localDay(to, tz);
    for (let k = localDay(from, tz) - 2; k <= n1; k++) {
      for (const x of day(k)) if (x.start < to && x.end > from) out.push(copyInst(x));
    }
    return out.sort(byStart);
  }

  function boundaries(f: number, t: number): number[] {
    const from = Number(f), to = Number(t);
    if (!(to >= from)) return [];
    const seen = new Set<number>();
    const n1 = localDay(to, tz);
    for (let k = localDay(from, tz) - 2; k <= n1; k++) {
      for (const x of day(k)) {
        for (const v of [x.start, x.end]) if (v >= from && v <= to) seen.add(v);
      }
    }
    return [...seen].sort((a, b) => a - b);
  }

  function productionDay(t: number): string {
    const ts = Number(t);
    const x = at(ts);
    return x ? x.productionDay : dayStr(localDay(ts, tz));
  }

  return { tz, at, current: at, previous, next, between, productionDay, boundaries };
}

// ------------------------------------------------------------------------------------------------- validation

// reference week intervals [start, end) in minutes from Monday 00:00, plus a copy moved back one week for a Sunday
// shift that runs into Monday
function weekIntervals(a: number, len: number, mask: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let d = 1; d <= 7; d++) {
    if (!(mask & (1 << d))) continue;
    const s = (d - 1) * 1440 + a, e = s + len;
    out.push([s, e]);
    if (e > WEEK_MIN) out.push([s - WEEK_MIN, e - WEEK_MIN]);
  }
  return out;
}

// note: unlike the calendar (where a non-list `days` means every day), here a non-list `days` covers no day
function daysMask(days: unknown): number {
  if (days == null) return 254;
  let m = 0;
  if (isArray(days)) {
    for (const d of days) if (typeof d === 'number' && d % 1 === 0 && d >= 1 && d <= 7) m |= 1 << d;
  }
  return m;
}

type AddFn = (code: ValidationCode, message: string, shiftId?: unknown) => void;

function timeCheck(t: unknown, what: string, sid: unknown, add: AddFn): number | null {
  const m = hm(t);
  if (m === null) {
    add('TIME_INVALID', what + ': "' + String(t) + '" is not a time (HH:MM, 00:00 to 23:59).', sid);
    return null;
  }
  if (m % 5) add('TIME_GRID', what + ': ' + t + ' is not on the 5-minute grid.', sid);
  return m;
}

/** Checks one version for the editor. Empty list = it can be saved. Codes match every port; wording may differ. */
export function validateVersion(v: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const add: AddFn = (code, message, shiftId) => {
    const o: ValidationIssue = { code, message };
    if (shiftId !== undefined && shiftId !== null) o.shiftId = shiftId as string | number;
    out.push(o);
  };
  if (!isObj(v) || isArray(v)) {
    add('SHIFTS_INVALID', 'This shift version cannot be read.');
    return out;
  }
  if (v.from != null && dayNum(v.from) === null) add('FROM_INVALID', 'The start date "' + v.from + '" is not a date (YYYY-MM-DD).');
  const shifts: unknown = v.shifts == null ? [] : v.shifts;
  if (!isArray(shifts)) {
    add('SHIFTS_INVALID', 'The shift list cannot be read.');
    return out;
  }
  if (shifts.length > 8) add('TOO_MANY_SHIFTS', 'At most 8 shifts are allowed; there are ' + shifts.length + '.');
  const ids = new Set<string>();
  const names = new Set<string>();
  const placed: Array<{ sid: unknown; label: string; iv: Array<[number, number]> }> = [];
  for (let i = 0; i < shifts.length; i++) {
    const s: unknown = shifts[i];
    if (!isObj(s) || isArray(s)) {
      add('SHIFTS_INVALID', 'Shift ' + (i + 1) + ' cannot be read.');
      continue;
    }
    const sid: unknown = s.id;
    const label = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : 'Shift ' + (i + 1);
    if ((typeof sid !== 'string' && typeof sid !== 'number') || String(sid) === '' || ids.has('k' + sid)) {
      add('ID_INVALID', label + ': missing or repeated shift id.', sid);
    } else ids.add('k' + sid);
    const nm = typeof s.name === 'string' ? s.name.trim() : '';
    if (nm.length < 1 || nm.length > 40) add('NAME_INVALID', 'Shift ' + (i + 1) + ': the name must be 1 to 40 characters.', sid);
    else if (names.has('k' + nm.toLowerCase())) add('NAME_DUPLICATE', 'Two shifts are called "' + nm + '".', sid);
    else names.add('k' + nm.toLowerCase());
    const a = timeCheck(s.start, label + ' start', sid, add), b = timeCheck(s.end, label + ' end', sid, add);
    if (s.days != null) {
      let ok = isArray(s.days) && s.days.length > 0;
      const seen = new Set<number>();
      if (ok) {
        for (const d of s.days as unknown[]) {
          if (typeof d !== 'number' || d % 1 !== 0 || d < 1 || d > 7 || seen.has(d)) {
            ok = false;
            break;
          }
          seen.add(d);
        }
      }
      if (!ok) add('DAYS_INVALID', label + ': the weekdays must be 1 (Mon) to 7 (Sun), each once, at least one.', sid);
    }
    const len = a !== null && b !== null ? mod1440(b - a) || 1440 : null;
    if (s.breaks != null) {
      if (!isArray(s.breaks)) add('BREAK_INVALID', label + ': the breaks cannot be read.', sid);
      else {
        const spans: Array<[number, number]> = [];
        for (let j = 0; j < s.breaks.length; j++) {
          const br: unknown = s.breaks[j];
          if (!isObj(br) || isArray(br)) {
            add('BREAK_INVALID', label + ': break ' + (j + 1) + ' cannot be read.', sid);
            continue;
          }
          const bl = label + ' break ' + (typeof br.name === 'string' && br.name ? '"' + br.name + '"' : j + 1);
          if (br.name != null && (typeof br.name !== 'string' || br.name.trim().length > 40)) {
            add('NAME_INVALID', bl + ': the name must be at most 40 characters.', sid);
          }
          const bs = timeCheck(br.start, bl + ' start', sid, add), be = timeCheck(br.end, bl + ' end', sid, add);
          if (bs === null || be === null || len === null || a === null) continue;
          const rs = mod1440(bs - a);
          let re = mod1440(be - a);
          if (re <= rs) re += 1440;
          if (re > len) {
            add('BREAK_OUTSIDE', bl + ' is not inside the shift.', sid);
            continue;
          }
          spans.push([rs, re]);
        }
        spans.sort((x, y) => x[0] - y[0]);
        for (let q = 1; q < spans.length; q++) {
          if (spans[q][0] < spans[q - 1][1]) {
            add('BREAK_OVERLAP', label + ': breaks overlap.', sid);
            break;
          }
        }
      }
    }
    if (len !== null && a !== null) placed.push({ sid, label, iv: weekIntervals(a, len, daysMask(s.days)) });
  }
  for (let x = 0; x < placed.length; x++) {
    for (let y = x + 1; y < placed.length; y++) {
      const P = placed[x].iv, Q = placed[y].iv;
      const hit = P.some((p) => Q.some((r) => p[0] < r[1] && r[0] < p[1]));
      if (hit) add('OVERLAP', placed[y].label + ' overlaps ' + placed[x].label + '.', placed[y].sid);
    }
  }
  return out;
}

/**
 * Uncovered local minutes per ISO weekday: {1: [[start, end], ...], ..., 7: [...]}, minutes 0..1440 of that calendar
 * day. A shift that crosses midnight covers the next day's early hours (Sunday's into Monday's). Holidays are ignored.
 */
export function coverageGaps(v: unknown): CoverageGaps {
  const cov: Array<[number, number]> = [];
  const shifts: unknown[] = isObj(v) && isArray(v.shifts) ? v.shifts : [];
  for (const s of shifts) {
    if (!isObj(s)) continue;
    const a = hm(s.start), b = hm(s.end);
    if (a === null || b === null) continue;
    const len = mod1440(b - a) || 1440;
    cov.push(...weekIntervals(a, len, daysMask(s.days)));
  }
  cov.sort((x, y) => x[0] - y[0]);
  const out = {} as CoverageGaps;
  for (let d = 1 as IsoWeekday; d <= 7; d = (d + 1) as IsoWeekday) {
    const lo = (d - 1) * 1440, hi = d * 1440;
    let cur = lo;
    const gaps: Array<[number, number]> = [];
    for (const c of cov) {
      const c0 = Math.max(c[0], lo), c1 = Math.min(c[1], hi);
      if (c1 <= c0) continue;
      if (c0 > cur) gaps.push([cur - lo, c0 - lo]);
      if (c1 > cur) cur = c1;
    }
    if (cur < hi) gaps.push([cur - lo, hi - lo]);
    out[d] = gaps;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- templates

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) deepFreeze((o as AnyObj)[k]);
    Object.freeze(o);
  }
  return o;
}

/** Read-only (deep-frozen): one widget changing it must not change what template() gives every other widget. */
export const TEMPLATES: Readonly<Record<TemplateKey, ShiftTemplate>> = deepFreeze({
  '3x8': {
    label: '3 × 8',
    shifts: [
      { id: 'a', name: 'Morning', start: '06:00', end: '14:00' },
      { id: 'b', name: 'Afternoon', start: '14:00', end: '22:00' },
      { id: 'c', name: 'Night', start: '22:00', end: '06:00' },
    ],
  },
  '2x12': {
    label: '2 × 12',
    shifts: [
      { id: 'a', name: 'Day', start: '06:00', end: '18:00' },
      { id: 'b', name: 'Night', start: '18:00', end: '06:00' },
    ],
  },
  day: {
    label: 'Day shift',
    shifts: [{ id: 'a', name: 'Day', start: '08:00', end: '17:00', days: [1, 2, 3, 4, 5] }],
  },
  custom: { label: 'Custom', shifts: [] },
});

/** A fresh, editable copy of a template's shifts ([] for an unknown key). */
export function template(key: TemplateKey | string): ShiftDef[] {
  const t = Object.prototype.hasOwnProperty.call(TEMPLATES, key) ? TEMPLATES[key as TemplateKey] : null;
  return t ? (JSON.parse(JSON.stringify(t.shifts)) as ShiftDef[]) : [];
}

/** The same object shape as the App UI's window.imxShiftCore. */
export const shiftCore = {
  calendar,
  validateVersion,
  coverageGaps,
  TEMPLATES,
  template,
  offset,
  localParts,
  fromLocal,
  isValidTimeZone,
};
