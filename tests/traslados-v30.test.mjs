import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const migration = readFileSync(new URL('../supabase/migrations/20261124000100_traslados_admin_v40.sql', import.meta.url), 'utf8')
const fixture = readFileSync(new URL('./traslados-schema.sql', import.meta.url), 'utf8')
const edge = stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/admin-create-client/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/, ''))
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const sectors = ['commerce', 'barbershop', 'parking', 'restaurant', 'transport']

function simulateEdge(options = {}) {
  const calls = []
  const authUserId = randomUUID()
  let handler
  const admin = {
    auth: {
      getUser: async () => ({ data: { user: { id: 'administrator' } } }),
      admin: {
        async createUser(request) {
          calls.push(['createUser', request.email])
          return options.authError
            ? { data: null, error: { code: options.authError } }
            : { data: { user: { id: authUserId } } }
        },
        async deleteUser(id) {
          calls.push(['deleteUser', id])
          return { error: options.cleanupError }
        },
      },
    },
    from(table) {
      const query = {
        select: () => query,
        eq: () => query,
        async maybeSingle() {
          if (table === 'developer_admins') return { data: options.denied ? null : { user_id: 'administrator' } }
          if (table === 'organizations') return { data: options.existing ? { id: 'existing' } : null }
          if (table === 'organization_members') {
            return { data: options.committed ? { organization_id: calls.find(call => call[0] === 'rpc')[1].p_org } : null }
          }
          throw new Error('Unexpected table ' + table)
        },
      }
      return query
    },
    rpc(name, args) {
      assert.equal(name, 'gestok_admin_create_organization_v40')
      calls.push(['rpc', args])
      // PostgREST devuelve un objeto thenable, sin método catch propio.
      return { then(resolve, reject) {
        if (options.lostResponse) return reject(new Error('Connection reset'))
        return resolve(options.dbError ? { error: { code: options.dbError } } : { data: args.p_org })
      } }
    },
  }
  runInNewContext(edge, {
    Response, crypto: { randomUUID }, console: { error() {} }, createClient: () => admin,
    Deno: { env: { get() {} }, serve(callback) { handler = callback } },
  })
  return {
    calls, authUserId,
    async create(type, fields = {}, authorized = true) {
      const headers = authorized ? { Authorization: 'Bearer simulated' } : {}
      const response = await handler(new Request('https://example.invalid', {
        method: 'POST',
        headers,
        body: JSON.stringify({ type, name: 'Empresa de prueba', loginUsername: 'empresa-prueba',
          password: 'simulated-only', monthlyFee: 100, startDate: '2026-11-24', nextDueDate: '2026-12-24', ...fields }),
      }))
      return { status: response.status, body: await response.json() }
    },
  }
}

for (const type of sectors) {
  test('Edge: alta paga y prueba gratuita de ' + type, async () => {
    for (const trialDays of [0, 7]) {
      const simulated = simulateEdge()
      const response = await simulated.create(type, { trialDays })
      assert.equal(response.status, 200)
      assert.equal(response.body.ok, true)
      assert.deepEqual(simulated.calls.map(call => call[0]), ['createUser', 'rpc'])
      const args = simulated.calls[1][1]
      assert.equal(args.p_type, type)
      assert.equal(args.p_org, response.body.organizationId)
      assert.equal(args.p_status, trialDays ? 'Prueba gratuita' : 'Activo')
      assert.equal(args.p_due, trialDays ? '2026-12-01' : '2026-12-24')
    }
  })
}

test('Edge: autorización, validación, duplicados y conflicto de Auth', async () => {
  const denied = simulateEdge({ denied: true })
  assert.equal((await denied.create('transport', {}, false)).status, 401)
  assert.equal((await denied.create('transport')).status, 403)
  assert.deepEqual(denied.calls, [])
  const invalid = simulateEdge()
  assert.equal((await invalid.create('invalid')).status, 400)
  assert.equal((await invalid.create('transport', { startDate: '2026-02-31' })).status, 400)
  assert.deepEqual(invalid.calls, [])
  const existing = simulateEdge({ existing: true })
  assert.equal((await existing.create('transport')).status, 409)
  assert.deepEqual(existing.calls, [])
  const auth = simulateEdge({ authError: 'email_exists' })
  assert.equal((await auth.create('transport')).status, 409)
  assert.deepEqual(auth.calls.map(call => call[0]), ['createUser'])
  const unconfirmed = simulateEdge({ authError: 'unexpected_failure' })
  assert.equal((await unconfirmed.create('transport')).status, 502)
  assert.deepEqual(unconfirmed.calls.map(call => call[0]), ['createUser'])
})

test('Edge: revierte únicamente el Auth recién creado ante error SQL concluyente', async () => {
  const simulated = simulateEdge({ dbError: '23514' })
  const response = await simulated.create('transport')
  assert.equal(response.status, 500)
  assert.equal(response.body.ok, undefined)
  assert.deepEqual(simulated.calls.at(-1), ['deleteUser', simulated.authUserId])
  const unresolved = simulateEdge({ dbError: 'P0001', cleanupError: true })
  const failedCleanup = await unresolved.create('transport')
  assert.equal(failedCleanup.status, 503)
  assert.equal(typeof failedCleanup.body.organizationId, 'string')
})

test('Edge: respuesta perdida, commit confirmado e incertidumbre sin borrar Auth', async () => {
  for (const committed of [true, false]) {
    const simulated = simulateEdge({ lostResponse: true, committed })
    const response = await simulated.create('transport')
    assert.equal(response.status, committed ? 200 : 503)
    assert.equal(Boolean(response.body.ok), committed)
    assert.deepEqual(simulated.calls.map(call => call[0]), ['createUser', 'rpc'])
  }
  const unknown = simulateEdge({ dbError: '40003' })
  assert.equal((await unknown.create('transport')).status, 503)
  assert.deepEqual(unknown.calls.map(call => call[0]), ['createUser', 'rpc'])
})

test('HTML: selector de cinco sectores y contrato de edición de credenciales', async () => {
  const select = html.match(/<select id="cType"[^>]*>(.*?)<\/select>/s)[1]
  assert.deepEqual([...select.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]).sort(), [...sectors].sort())

  const handler = html.match(/saveCredentials\.onclick=async\(\)=>\{[\s\S]*?^\};/m)[0]
  const calls = []
  const browser = {
    saveCredentials: {}, credentialsOrgId: randomUUID(), credentialsUsername: { value: ' usuario ' },
    credentialsPassword: { value: '' }, toast() {}, closeCredentials() {}, async loadData() {},
    sb: { functions: { async invoke(slug, { body }) {
      calls.push([slug, JSON.parse(JSON.stringify(body))])
      return { data: { ok: true } }
    } } },
  }
  runInNewContext(handler, browser)
  await browser.saveCredentials.onclick()
  assert.deepEqual(calls, [['admin-update-client-credentials-5-',
    { organizationId: browser.credentialsOrgId, username: 'usuario', password: '' }]])
})

test('HTML: el alta requiere confirmación y muestra la referencia de un fallo', async () => {
  const handler = html.match(/saveClient\.onclick=async\(\)=>\{[\s\S]*?^\};/m)[0]
  const results = [
    { data: null },
    { error: { context: Response.json({ error: 'Alta sin confirmar.', organizationId: 'test-reference' }, { status: 503 }) } },
    { data: { ok: true } },
  ]
  const messages = []
  let closed = 0
  const browser = {
    Response, saveClient: {}, cStatus: { value: 'Activo' }, cType: { value: 'transport' },
    cName: { value: 'Prueba' }, cUsername: { value: 'prueba' }, cPhone: { value: '' },
    cPassword: { value: 'simulated-only' }, cFee: { value: '100' },
    cStart: { value: '2026-11-24' }, cDue: { value: '2026-12-24' },
    toast(message) { messages.push(message) }, closeClient() { closed++ }, async loadData() {},
    sb: { functions: { async invoke(slug, { body }) {
      assert.equal(slug, 'admin-create-client')
      assert.equal(body.type, 'transport')
      return results.shift()
    } } },
  }
  runInNewContext(handler, browser)
  await browser.saveClient.onclick()
  await browser.saveClient.onclick()
  assert.equal(closed, 0)
  assert.match(messages[0], /No se pudo confirmar/)
  assert.match(messages[1], /test-reference/)
  await browser.saveClient.onclick()
  assert.equal(closed, 1)
})

const pgModule = process.env.GESTOK_PGLITE_MODULE
const sqlOptions = { skip: pgModule ? false : 'Configurar GESTOK_PGLITE_MODULE para ejecutar PostgreSQL local' }

async function openDatabase(t) {
  const { PGlite } = await import(pathToFileURL(resolve(pgModule)).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(fixture)
  return db
}

async function createOrganization(db, type, status = 'Activo', user = randomUUID()) {
  const org = randomUUID()
  await db.query('insert into auth.users values ($1)', [user])
  await db.exec('set role service_role')
  try {
    const result = await db.query('select public.gestok_admin_create_organization_v40($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as id',
      [org, user, type, org, type, null, 100, '2026-11-24', '2026-12-01', status])
    assert.equal(result.rows[0].id, org)
    return org
  } finally {
    await db.exec('reset role')
  }
}

async function scalar(db, sql, args = []) {
  return Object.values((await db.query(sql, args)).rows[0])[0]
}

test('SQL: cinco sectores, configuración obligatoria, UUID único y solicitudes bloqueadas', sqlOptions, async (t) => {
  const db = await openDatabase(t)
  await db.exec(migration)
  for (const type of sectors) {
    for (const status of ['Activo', 'Prueba gratuita']) {
      const id = await createOrganization(db, type, status)
      assert.equal(await scalar(db, 'select type from organizations where id=$1', [id]), type)
      assert.equal(await scalar(db, 'select role from organization_members where organization_id=$1', [id]), 'admin')
      assert.equal(await scalar(db, 'select status from subscriptions where organization_id=$1', [id]), status)
      assert.equal(await scalar(db, 'select count(*)::int from notifications where organization_id=$1', [id]), 1)
      assert.equal(await scalar(db, 'select count(*)::int from subscription_payments where organization_id=$1', [id]),
        status === 'Activo' ? 1 : 0)
    }
  }
  assert.equal(await scalar(db, "select count(*)::int from barber_services where name in ('Corte','Barba')"), 4)
  assert.equal(await scalar(db, 'select count(*)::int from parking_settings where minute_rate=150 and flat_rate=10000'), 2)
  await createOrganization(db, 'parking', 'Vencido')
  assert.equal(await scalar(db, "select count(*)::int from restaurant_settings where currency='ARS' and ordering_enabled"), 2)
  assert.equal(await scalar(db, 'select count(*)::int from restaurant_tables where active'), 20)
  const settings = (await db.query('select * from transport_settings order by organization_id')).rows
  assert.equal(settings.length, 2)
  assert.notEqual(settings[0].public_code, settings[1].public_code)
  assert.ok(settings.every(row => row.requests_enabled === false))
  await assert.rejects(db.query('update transport_settings set public_code=gen_random_uuid()'), /permanente/)
  await assert.rejects(db.query('update transport_settings set requests_enabled=true'), /requests_disabled_v40/)
  const commerce = await scalar(db, "select id from organizations where type='commerce' limit 1")
  await assert.rejects(db.query('insert into transport_settings(organization_id,public_code) values ($1,$2)',
    [commerce, settings[1].public_code]), /transport_settings_public_code_key/)
  await db.exec('set role anon')
  try {
    await assert.rejects(db.query('select public_code from transport_settings'), /permission denied/)
    await assert.rejects(db.query('select public.gestok_admin_create_organization_v40(null,null,null,null,null,null,null,null,null,null)'),
      /permission denied/)
  } finally {
    await db.exec('reset role')
  }
  await db.exec(migration)
  assert.deepEqual((await db.query('select * from transport_settings order by organization_id')).rows, settings)
})

test('SQL: si falla una configuración obligatoria se revierte toda el alta', sqlOptions, async (t) => {
  const db = await openDatabase(t)
  await db.exec(migration)
  await db.exec("alter table restaurant_tables add check (table_number < 10)")
  await assert.rejects(createOrganization(db, 'restaurant'), /check constraint/)
  await db.exec('alter table notifications add check (false)')
  await assert.rejects(createOrganization(db, 'commerce'), /check constraint/)
  await db.exec('alter table notifications drop constraint notifications_check')
  await db.exec('alter table organizations disable trigger gestok_init_transport_settings')
  await assert.rejects(createOrganization(db, 'transport'), /Falta la configuración privada/)
  for (const table of ['organizations', 'organization_members', 'subscriptions', 'subscription_payments',
    'notifications', 'restaurant_settings', 'restaurant_tables', 'transport_settings']) {
    assert.equal(await scalar(db, 'select count(*)::int from ' + table), 0)
  }
})

test('SQL: V40 aborta de forma atómica ante definiciones preexistentes incompatibles', sqlOptions, async (t) => {
  const db = await openDatabase(t)
  await db.exec('create table transport_settings (organization_id uuid primary key)')
  await assert.rejects(db.exec(migration), /columnas de transport_settings/)
  await db.exec('rollback')
  assert.equal(await scalar(db, "select count(*)::int from information_schema.columns where table_name='transport_settings'"), 1)
  assert.match(await scalar(db, "select pg_get_constraintdef(oid) from pg_constraint where conname='organizations_type_check'"),
    /restaurant'::text\]\)\)\)$/)
  await db.exec("alter table organizations drop constraint organizations_type_check; alter table organizations add constraint organizations_type_check check (type <> '')")
  await assert.rejects(db.exec(migration), /definición de organizations_type_check/)
  await db.exec('rollback')
  assert.match(await scalar(db, "select pg_get_constraintdef(oid) from pg_constraint where conname='organizations_type_check'"),
    /<>/)
})

test('SQL: SCR conserva reglas de seña y cobro, Carlos conserva su acceso específico', sqlOptions, async (t) => {
  const db = await openDatabase(t)
  const scr = randomUUID()
  const carlos = randomUUID()
  const user = randomUUID()
  await db.query("insert into organizations values ($1,'SCR','scr-access','commerce',null,100,true), ($2,'Carlos','carlos','commerce',null,100,true)", [scr, carlos])
  await db.query('insert into auth.users values ($1)', [user])
  await db.query("insert into organization_members values ($1,$2,'Administrador','admin',true)", [carlos, user])
  await db.query("insert into subscriptions(organization_id,status) values ($1,'Activo'),($2,'Activo')", [scr, carlos])
  const snapshot = ['organizations','organization_members','subscriptions']
  const before = await Promise.all(snapshot.map(table => db.query('select * from ' + table + ' order by 1')))
  await db.exec(migration)
  const after = await Promise.all(snapshot.map(table => db.query('select * from ' + table + ' order by 1')))
  assert.deepEqual(after.map(result => result.rows), before.map(result => result.rows))

  assert.equal(await scalar(db, "select gestok_resolve_login_slug(' SCR ','commerce')"), 'scr-access')
  assert.equal(await scalar(db, "select gestok_resolve_login_slug('Carlos','commerce')"), 'carlos')
  assert.equal(await scalar(db, "select gestok_resolve_login_slug('Carlos','transport')"), null)
  await assert.rejects(db.query("insert into orders(organization_id,amount,deposit_amount,status,payment_status) values ($1,100,110,'Pendiente','No cobrado')", [scr]), /seña/)
  await assert.rejects(db.query("insert into orders(organization_id,amount,deposit_amount,status,payment_status) values ($1,100,0,'Pendiente','Cobrado')", [scr]), /Finalizado/)
  assert.equal(await scalar(db, "insert into orders(organization_id,amount,deposit_amount,deposit_payment_method,status,payment_status,final_payment_method) values ($1,100,30,'QR','Finalizado','Cobrado','Efectivo') returning ledger_posted", [scr]), true)
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user])
  assert.equal(await scalar(db, 'select gestok_ai_is_carlos_admin($1)', [carlos]), true)
  assert.equal(await scalar(db, 'select gestok_ai_is_carlos_admin($1)', [scr]), false)
})
