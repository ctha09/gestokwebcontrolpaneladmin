import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'

const { GESTOK_LOCAL_API_URL: address, GESTOK_LOCAL_ANON_KEY: anonKey,
  GESTOK_LOCAL_SERVICE_KEY: serviceKey } = process.env
const types = ['commerce', 'barbershop', 'parking', 'restaurant', 'transport']

function verifyLocalAddress() {
  const url = new URL(address)
  assert.equal(url.protocol, 'http:')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Se requiere un destino loopback')
  assert.ok(url.port && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password)
  assert.ok(anonKey && serviceKey, 'Faltan las claves generadas por el stack local')
  return url
}

async function watchInserts(base, key, token) {
  const url = new URL('/realtime/v1/websocket', base)
  url.protocol = 'ws:'
  url.search = new URLSearchParams({ apikey: key, vsn: '1.0.0' })
  const socket = new WebSocket(url)
  const topic = 'realtime:gestok-test-' + randomUUID()
  const records = []
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Realtime no confirmó la suscripción')), 12000)
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('No se pudo conectar a Realtime')) }, { once: true })
      socket.addEventListener('open', () => socket.send(JSON.stringify({
        topic, event: 'phx_join', ref: '1', payload: { access_token: token, config: {
          broadcast: { self: false }, presence: { key: '' },
          postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'transport_requests' }],
        } },
      })), { once: true })
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data)
        if (message.event === 'postgres_changes') records.push(message.payload.data.record)
        if (message.ref === '1' && message.event === 'phx_reply') {
          clearTimeout(timer)
          const accepted = message.payload.status === 'ok' && message.payload.response?.postgres_changes?.length === 1
          if (accepted) resolve()
          else reject(new Error('Realtime rechazó la suscripción'))
        }
      })
    })
  } catch (error) {
    socket.close()
    throw error
  }
  return { records, close: () => socket.close() }
}

test('Supabase local: Auth, Edge Function, suscripciones y RLS de los cinco sectores', {
  timeout: 180_000, skip: process.env.GESTOK_LOCAL_RUN === '1' ? false : 'Ejecutar start-traslados-local.ps1',
}, async (t) => {
  const base = verifyLocalAddress()
  const nonce = randomUUID().slice(0, 8)
  const password = () => randomBytes(24).toString('base64url')

  async function request(path, { key = anonKey, token, method = 'GET', body } = {}) {
    const headers = { apikey: key }
    if (token) headers.Authorization = 'Bearer ' + token
    else if (key.split('.').length === 3) headers.Authorization = 'Bearer ' + key
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(new URL(path, base), {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    })
    const data = await response.json().catch(() => null)
    return { status: response.status, data }
  }

  function expect(result, status, context) {
    assert.ok([status].flat().includes(result.status), context + ' devolvió HTTP ' + result.status)
    return result.data
  }

  const fixture = await request('/rest/v1/rpc/gestok_v30_fixture', { key: serviceKey, method: 'POST', body: {} })
  assert.equal(expect(fixture, 200, 'Marcador local'), 'gestok-v30-local-fixture')

  async function signIn(email, secret) {
    const response = await request('/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email, password: secret },
    })
    const session = expect(response, 200, 'Inicio de sesión')
    assert.ok(session.access_token && session.user.id, 'Auth no devolvió sesión')
    return session
  }

  const adminEmail = 'gestok-test-' + nonce + '@example.test'
  const adminPassword = password()
  const adminUser = expect(await request('/auth/v1/admin/users', {
    key: serviceKey, method: 'POST',
    body: { email: adminEmail, password: adminPassword, email_confirm: true },
  }), [200, 201], 'Auth del administrador ficticio')
  expect(await request('/rest/v1/developer_admins', {
    key: serviceKey, method: 'POST', body: { user_id: adminUser.id },
  }), 201, 'Membresía de administrador general')
  const administrator = await signIn(adminEmail, adminPassword)

  const edge = '/functions/v1/admin-create-client'
  const accounts = []
  const now = Date.now()
  const start = new Date(now).toISOString().slice(0, 10)
  const paidDue = new Date(now + 30 * 86_400_000).toISOString().slice(0, 10)
  const trialDue = new Date(now + 7 * 86_400_000).toISOString().slice(0, 10)

  for (const type of types) {
    for (const trial of [false, true]) {
      await t.test(type + (trial ? ' · prueba' : ' · paga'), async () => {
        const slug = ['test', type, nonce, trial ? 'trial' : 'paid'].join('-')
        const secret = password()
        const status = trial ? 'Prueba gratuita' : 'Activo'
        const input = { name: 'Ficticio ' + slug, loginUsername: slug, type, password: secret, status,
          startDate: start, nextDueDate: paidDue, monthlyFee: trial ? 0 : 100, trialDays: trial ? 7 : 0 }
        const created = expect(await request(edge, {
          method: 'POST', token: administrator.access_token, body: input,
        }), 200, 'Alta')
        assert.equal(created.ok, true)
        assert.equal(created.username, slug)
        assert.equal(created.status, status)
        assert.equal(created.trialEndsAt, trial ? trialDue : null)

        const session = await signIn(slug + '@login.gestok.local', secret)
        const token = session.access_token
        const orgFilter = '&organization_id=eq.' + created.organizationId
        const organization = expect(await request('/rest/v1/organizations?select=id,type', { token }), 200, 'RLS organización')
        assert.deepEqual(organization, [{ id: created.organizationId, type }])
        const member = expect(await request('/rest/v1/organization_members?select=role,auth_user_id', { token }), 200, 'Membresía')
        assert.deepEqual(member, [{ role: 'admin', auth_user_id: session.user.id }])
        const subscriptions = expect(await request('/rest/v1/subscriptions?select=status,next_due_date,trial_ends_at', { token }), 200, 'Suscripción')
        assert.deepEqual(subscriptions, [{ status, next_due_date: trial ? trialDue : paidDue, trial_ends_at: trial ? trialDue : null }])
        const payments = expect(await request('/rest/v1/subscription_payments?select=amount,initial_payment' + orgFilter, { token }), 200, 'Pago inicial')
        assert.deepEqual(payments, trial ? [] : [{ amount: 100, initial_payment: true }])
        const alias = expect(await request('/rest/v1/rpc/gestok_resolve_login_slug', {
          method: 'POST', body: { p_login_raw: input.name, p_type: type },
        }), 200, 'Resolver de alias')
        assert.equal(alias, slug)

        if (type === 'barbershop') {
          const services = expect(await request('/rest/v1/barber_services?select=name&order=name', { token }), 200, 'Servicios de Barbería')
          assert.deepEqual(services, [{ name: 'Barba' }, { name: 'Corte' }])
        }
        if (type === 'parking') {
          const settings = expect(await request('/rest/v1/parking_settings?select=minute_rate,flat_rate', { token }), 200, 'Tarifas de Estacionamiento')
          assert.deepEqual(settings, [{ minute_rate: 150, flat_rate: 10000 }])
        }
        if (type === 'restaurant') {
          const tables = expect(await request('/rest/v1/restaurant_tables?select=table_number&order=table_number', { token }), 200, 'Mesas de Restaurante')
          assert.deepEqual(tables.map(row => row.table_number), Array.from({ length: 10 }, (_, i) => i + 1))
        }
        if (type === 'transport') {
          const path = '/rest/v1/transport_settings?select=public_code,requests_enabled' + orgFilter
          const settings = expect(await request(path, { key: serviceKey }), 200, 'Configuración privada')
          assert.equal(settings.length, 1)
          assert.match(settings[0].public_code, /^[0-9a-f-]{36}$/)
          assert.equal(settings[0].requests_enabled, false)
          expect(await request(path, { token }), [401, 403, 404], 'Configuración para miembro')
          expect(await request(path), [401, 403, 404], 'Configuración para anónimo')
          accounts.push({ type, token, session, id: created.organizationId, code: settings[0].public_code })
        } else {
          accounts.push({ type, token, id: created.organizationId })
        }
      })
    }
  }

  await t.test('aislamiento cruzado y rechazo de permisos de alta', async () => {
    assert.equal(accounts.length, 10)
    assert.equal(new Set(accounts.filter(a => a.code).map(a => a.code)).size, 2)
    for (const account of accounts) {
      const visible = expect(await request('/rest/v1/organizations?select=id', { token: account.token }), 200, 'Organizaciones visibles')
      const subscriptions = expect(await request('/rest/v1/subscriptions?select=organization_id', { token: account.token }), 200, 'Suscripciones visibles')
      assert.deepEqual(visible, [{ id: account.id }])
      assert.deepEqual(subscriptions, [{ organization_id: account.id }])
    }
    expect(await request(edge, { method: 'POST', token: accounts[0].token, body: {} }), 403, 'Alta por cliente')
    expect(await request(edge, { method: 'POST', body: {} }), 401, 'Alta sin sesión')
  })

  if (process.env.GESTOK_LOCAL_V53 !== '1') return
  await t.test('V53: dos conductores, comprobantes independientes, Realtime, cierres y finanzas', async t => {
    const [a, b] = accounts.filter(account => account.type === 'transport')
    const rpc = (name, body, options = {}) => request('/rest/v1/rpc/' + name, { ...options, method: 'POST', body })
    const receipt = () => randomBytes(32).toString('hex')
    const draft = (account, key) => ({ p_code: account.code, p_receipt: key,
      p_pickup: 'Punto ficticio', p_destination: 'Destino ficticio', p_lat: null, p_lng: null,
      p_schedule: 'now', p_at: null })
    const submit = async body => expect(await rpc('gestok_transport_submit', body), 200, 'Solicitud ficticia')
    const status = async (account, key) => expect(await rpc('gestok_transport_request_status',
      { p_code: account.code, p_receipt: key }), 200, 'Estado del comprobante')
    const list = async account => expect(await request('/rest/v1/transport_requests?select=id,status,updated_at',
      { token: account.token }), 200, 'Pedidos visibles')
    for (const account of [a, b]) {
      assert.equal(expect(await rpc('gestok_transport_public_available', { p_code: account.code }), 200, 'Disponibilidad antes de activar'), false)
      expect(await rpc('gestok_local_enable_requests', { p_org: account.id }, { key: serviceKey }), 204, 'Activación ficticia')
    }
    const listenerA = await watchInserts(base, anonKey, a.token)
    t.after(listenerA.close)
    const listenerB = await watchInserts(base, anonKey, b.token)
    t.after(listenerB.close)
    const keyA = receipt(), keyB = receipt()
    const [first, duplicate, second] = await Promise.all([submit(draft(a, keyA)), submit(draft(a, keyA)), submit(draft(b, keyB))])
    assert.equal(duplicate, first)
    assert.notEqual(first, second)
    const waitForEvents = async condition => {
      const expiry = Date.now() + 12000
      while (!condition()) {
        if (Date.now() >= expiry) throw new Error('No llegó el evento esperado por Realtime')
        await new Promise(resolve => setTimeout(resolve, 150))
      }
    }
    await waitForEvents(() => listenerA.records.some(row => row.id === first) && listenerB.records.some(row => row.id === second))
    assert.ok(listenerA.records.every(row => row.organization_id === a.id))
    assert.ok(listenerB.records.every(row => row.organization_id === b.id))
    assert.deepEqual((await list(a)).map(row => row.id), [first])
    assert.deepEqual((await list(b)).map(row => row.id), [second])
    assert.deepEqual(await status(b, keyA), [])
    assert.deepEqual(await status(a, keyB), [])
    assert.deepEqual(Object.keys((await status(a, keyA))[0]).sort(),
      ['id','status','pickup_at','delay_minutes','amount','updated_at'].sort())

    const action = async (account, id, verb, delay = null) => {
      const row = (await list(account)).find(row => row.id === id)
      const args = { p_org: account.id, p_request: id, p_version: row.updated_at,
        p_action: verb, p_delay: delay, p_amount: null }
      expect(await rpc('gestok_transport_driver_action', args, { token: account.token }), 204, verb)
    }
    await action(a, first, 'delay', 45)
    assert.equal((await status(a, keyA))[0].delay_minutes, 45)
    await action(a, first, 'confirm')
    assert.equal((await status(a, keyA))[0].status, 'confirmed')
    await action(b, second, 'reject')
    assert.equal((await status(b, keyB))[0].status, 'rejected')
    const current = (await list(a)).find(row => row.id === first)
    const close = { p_org: a.id, p_request: first, p_version: current.updated_at,
      p_outcome: 'completed', p_amount: 100, p_payment: 'transfer' }
    for (let i = 0; i < 2; i++) expect(await rpc('gestok_transport_close_v42', close, { token: a.token }), 204, 'Cierre')
    assert.equal((await status(a, keyA))[0].status, 'completed')
    const expense = { p_org: a.id, p_id: randomUUID(), p_category: 'fuel',
      p_description: 'Gasto ficticio', p_amount: 25, p_at: new Date(Date.now() - 1000).toISOString() }
    for (let i = 0; i < 2; i++) expect(await rpc('gestok_transport_add_expense_v42', expense, { token: a.token }), 200, 'Gasto')
    const finances = expect(await rpc('gestok_transport_finance_v42',
      { p_org: a.id, p_period: 'month', p_anchor: null }, { token: a.token }), 200, 'Balance')
    assert.deepEqual([finances.income,finances.expenses,finances.net,finances.trips], [100,25,75,1])
    const historical = expect(await rpc('gestok_transport_history_v42', {
      p_org: a.id, p_from: null, p_to: null, p_status: 'completed', p_payment: 'transfer', p_offset: 0,
    }, { token: a.token }), 200, 'Historial')
    assert.equal(historical.length, 1)
    assert.ok(!('pickup_lat' in historical[0]))
    listenerA.close()
    const missed = await submit(draft(a, receipt()))
    const reconnected = await watchInserts(base, anonKey, a.token)
    t.after(reconnected.close)
    assert.ok((await list(a)).some(row => row.id === missed))
    const live = await submit(draft(a, receipt()))
    await waitForEvents(() => reconnected.records.some(row => row.id === live))
    expect(await request('/auth/v1/logout', { method: 'POST', token: b.token }), [200, 204], 'Cerrar sesión')
    expect(await request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: b.session.refresh_token },
    }), [400, 401, 403], 'Token de renovación revocado')
  })
})
