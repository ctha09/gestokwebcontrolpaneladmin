import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function slugify(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function dateOnly(d: Date) {
  return d.toISOString().slice(0, 10)
}

function addDays(dateString: string, days: number) {
  const d = new Date(`${dateString}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return dateOnly(d)
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && dateOnly(date) === value && !value.startsWith('0000-')
}

function rolledBack(code: string | undefined) {
  return code === 'PGRST202' || code === '40001' || code === '40P01' ||
    /^(22|23|25|42|P0)[0-9A-Z]{3}$/.test(code ?? '')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Método no permitido' }, 405)

  const token = (req.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token) return jsonResponse({ error: 'Falta sesión de administrador' }, 401)

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: authUser, error: authError } = await admin.auth.getUser(token)
    if (authError || !authUser?.user) return jsonResponse({ error: 'Sesión inválida' }, 401)

    const { data: developer, error: developerError } = await admin
      .from('developer_admins').select('user_id').eq('user_id', authUser.user.id).maybeSingle()
    if (developerError) return jsonResponse({ error: 'No se pudo verificar la autorización' }, 503)
    if (!developer) return jsonResponse({ error: 'No autorizado para GestOK Control' }, 403)

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: 'Datos de alta inválidos' }, 400)
    }

    const name = String(body.name || '').trim()
    const type = String(body.type || '').trim()
    const phone = String(body.phone || '').trim()
    const password = String(body.password || '')
    const loginSlug = slugify(body.loginUsername || body.name || '')
    const monthlyFee = Number(body.monthlyFee || 0)
    const startDate = String(body.startDate || dateOnly(new Date()))
    const requestedStatus = String(body.status || 'Activo')
    const isTrial = requestedStatus === 'Prueba gratuita' || Number(body.trialDays || 0) === 7
    const status = isTrial ? 'Prueba gratuita' : requestedStatus

    if (!name || !loginSlug || !['commerce', 'barbershop', 'parking', 'restaurant', 'transport'].includes(type)) {
      return jsonResponse({ error: 'Nombre, usuario y tipo son obligatorios' }, 400)
    }
    if (password.length < 6) {
      return jsonResponse({ error: 'La contraseña debe tener al menos 6 caracteres' }, 400)
    }
    if (!Number.isFinite(monthlyFee) || monthlyFee < 0) {
      return jsonResponse({ error: 'Mensualidad inválida' }, 400)
    }
    if (!['Activo', 'Pendiente de pago', 'Por vencer', 'Vencido', 'Prueba gratuita'].includes(status)) {
      return jsonResponse({ error: 'Estado de suscripción inválido' }, 400)
    }
    if (!validDate(startDate)) return jsonResponse({ error: 'Fecha de inicio inválida' }, 400)

    const nextDueDate = isTrial ? addDays(startDate, 7) : String(body.nextDueDate || '')
    if (!validDate(nextDueDate)) return jsonResponse({ error: 'Próximo vencimiento inválido' }, 400)

    const { data: existingOrg, error: lookupError } = await admin
      .from('organizations').select('id').eq('login_slug', loginSlug).maybeSingle()
    if (lookupError) return jsonResponse({ error: 'No se pudo comprobar el usuario de acceso' }, 503)
    if (existingOrg) return jsonResponse({ error: 'Ese usuario de acceso ya está en uso' }, 409)

    const organizationId = crypto.randomUUID()
    const { data: createdAuth, error: createAuthError } = await admin.auth.admin.createUser({
      email: `${loginSlug}@login.gestok.local`,
      password,
      email_confirm: true,
      user_metadata: { gestok_login: loginSlug, organization_name: name },
    })
    const authUserId = createdAuth?.user?.id
    if (createAuthError || !authUserId) {
      if (['email_exists', 'user_already_exists'].includes(createAuthError?.code ?? '')) {
        return jsonResponse({ error: 'Ese usuario de acceso ya está en uso' }, 409)
      }
      console.error('Alta GestOK: Auth sin confirmación', { organizationId, code: createAuthError?.code })
      return jsonResponse({ error: 'No se confirmó la creación del acceso. Verificá el estado antes de reintentar.', organizationId }, 502)
    }

    const unresolved = () => {
      console.error('Alta GestOK: estado pendiente de revisar', { organizationId, authUserId })
      return jsonResponse({ error: 'Alta sin confirmar. Verificá el estado antes de reintentar.', organizationId }, 503)
    }

    // El RPC confirma todas las filas en una sola transacción.
    const result = await Promise.resolve(admin.rpc('gestok_admin_create_organization_v40', {
      p_org: organizationId,
      p_user: authUserId,
      p_name: name,
      p_slug: loginSlug,
      p_type: type,
      p_phone: phone || null,
      p_fee: monthlyFee,
      p_start: startDate,
      p_due: nextDueDate,
      p_status: status,
    })).catch(() => null)

    if (!result || result.error || result.data !== organizationId) {
      const code = result?.error?.code
      if (rolledBack(code)) {
        console.error('Alta GestOK: escritura revertida', { organizationId, code })
        // Solo se compensa el usuario de Auth devuelto por esta solicitud.
        const cleanup = await admin.auth.admin.deleteUser(authUserId).catch(() => null)
        if (!cleanup || cleanup.error) return unresolved()
        return jsonResponse({ error: 'No se pudo completar el alta. La operación fue revertida.', organizationId }, 500)
      }

      // Una respuesta perdida no prueba un rollback. La membresía confirma el commit.
      const confirmed = await Promise.resolve(admin.from('organization_members').select('organization_id')
        .eq('organization_id', organizationId).eq('auth_user_id', authUserId).maybeSingle()).catch(() => null)
      if (confirmed?.error || confirmed?.data?.organization_id !== organizationId) return unresolved()
    }

    return jsonResponse({ ok: true, organizationId, username: loginSlug, status, trialEndsAt: isTrial ? nextDueDate : null })
  } catch {
    return jsonResponse({ error: 'No se pudo confirmar el alta. Verificá el estado antes de reintentar.' }, 500)
  }
})
