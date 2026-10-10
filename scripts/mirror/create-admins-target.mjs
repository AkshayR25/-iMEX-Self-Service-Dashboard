// Creates app Admin users on the NEW tenant ("iMEX - AI Features") the way the app's Users page would: a customer
// user of ITHENA, activated with a password, and the same app attributes as an existing Admin (role, whole-organisation
// access, notification flags), copied from a template user. Akshay, 10 Oct 2026.
//   NEW_USER_PASSWORD=... node scripts/mirror/create-admins-target.mjs a@x.com b@x.com            dry run
//   NEW_USER_PASSWORD=... node scripts/mirror/create-admins-target.mjs a@x.com b@x.com --go       creates
// The password comes only from the environment and is never printed. Existing users are reported and left alone.
import { newTenantClient } from './clients.mjs';
const GO = process.argv.includes('--go');
const emails = process.argv.slice(2).filter((a) => a.includes('@')).map((e) => e.trim().toLowerCase());
const TEMPLATE = process.env.TEMPLATE_USER || 'ar@imex.com';
const PW = process.env.NEW_USER_PASSWORD || '';
if (!emails.length) { console.log('no e-mails given'); process.exit(1); }
if (GO && PW.length < 6) { console.log('NEW_USER_PASSWORD missing'); process.exit(1); }
const T = await newTenantClient();
const all = [];
for (let p = 0; p < 20; p++) { const r = await T.api('GET', `/api/users?pageSize=100&page=${p}`); all.push(...r.data); if (!r.hasNext) break; }
console.log(`${T.base}: ${all.length} users now: ${all.map((u) => u.email).join(', ')}`);
const tpl = all.find((u) => u.email.toLowerCase() === TEMPLATE);
if (!tpl) { console.log('template user not found: ' + TEMPLATE); process.exit(1); }
const attrs = await T.api('GET', `/api/plugins/telemetry/USER/${tpl.id.id}/values/attributes/SERVER_SCOPE`);
const SKIP = new Set(['firstName', 'lastName', 'email', 'phone', 'lastLoginTs', 'active', 'lastActivityTime', 'userActivated']);
const copy = {}; for (const a of attrs) if (!SKIP.has(a.key)) copy[a.key] = a.value;
console.log(`template ${TEMPLATE} (customer ${tpl.customerId.id}): copies ${Object.keys(copy).sort().join(', ')}`);
// a +tag (tusharl+imex@...) is not part of the name
const name = (e) => { const l = e.split('@')[0].split('+')[0].replace(/[^a-z]/g, ''); return { first: l.charAt(0).toUpperCase() + l.slice(1, -1), last: l.slice(-1).toUpperCase() }; };
for (const email of emails) {
  const have = all.find((u) => u.email.toLowerCase() === email);
  const n = name(email);
  // a user of this tenant that an earlier run created but did not finish (no app role yet) is finished; others are left alone
  let resume = null;
  if (have) {
    const r = await T.api('GET', `/api/plugins/telemetry/USER/${have.id.id}/values/attributes/SERVER_SCOPE?keys=imexRole`);
    if (r.length || have.customerId.id !== tpl.customerId.id) { console.log(`  skip ${email}: already exists (${have.authority})`); continue; }
    resume = have;
  }
  if (!GO) { console.log(`  would ${resume ? 'finish' : 'create'} ${email} as "${n.first} ${n.last}", customer user of ITHENA, activated, Admin with the template's attributes`); continue; }
  let u = resume;
  if (!u) try {
    u = await T.api('POST', '/api/user?sendActivationMail=false', { email, authority: 'CUSTOMER_USER', customerId: tpl.customerId, tenantId: tpl.tenantId, firstName: n.first, lastName: n.last, additionalInfo: tpl.additionalInfo || {} });
  } catch (e) {
    // e-mails are unique across the whole ThingsBoard: one used in another tenant cannot be created here
    if (/already present/i.test(e.message)) { console.log('  NOT created ' + email + ': this e-mail already belongs to a user of another tenant on this server'); continue; }
    throw e;
  }
  const link = (await T.api('GET', `/api/user/${u.id.id}/activationLink`, undefined, { raw: true })).toString('utf8'); // plain text
  const token = link.split('activateToken=')[1];
  if (!token) throw new Error('no activation token for ' + email);
  await T.api('POST', '/api/noauth/activate?sendActivationMail=false', { activateToken: decodeURIComponent(token), password: PW });
  const a = { ...copy, firstName: n.first, lastName: n.last, email };
  if (a.imexAccess && typeof a.imexAccess === 'object') a.imexAccess = { ...a.imexAccess, at: Date.now(), by: 'create-admins-target' };
  await T.api('POST', `/api/plugins/telemetry/USER/${u.id.id}/attributes/SERVER_SCOPE`, a);
  const back = await T.api('GET', `/api/plugins/telemetry/USER/${u.id.id}/values/attributes/SERVER_SCOPE?keys=Role,imexRole,imexAccess`);
  console.log(`  created ${email} (${u.id.id}): ${back.map((x) => x.key + '=' + (typeof x.value === 'object' ? JSON.stringify(x.value).slice(0, 60) : x.value)).join(' | ')}`);
}
if (!GO) console.log('dry run: nothing written (--go creates)');
