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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.replace('Bearer ', '').trim()

    if (!token) {
      return new Response(JSON.stringify({ error: 'Falta sesión de administrador' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: authUser, error: authError } = await admin.auth.getUser(token)
    if (authError || !authUser.user) {
      return new Response(JSON.stringify({ error: 'Sesión inválida' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: developer } = await admin
      .from('developer_admins')
      .select('user_id')
      .eq('user_id', authUser.user.id)
      .maybeSingle()

    if (!developer) {
      return new Response(JSON.stringify({ error: 'No autorizado para GestOK Control' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = await req.json()

    const name = String(body.name || '').trim()
    const type = String(body.type || '').trim()
    const phone = String(body.phone || '').trim()
    const password = String(body.password || '')
    const usernameRaw = String(body.loginUsername || body.name || '').trim()
    const loginSlug = slugify(usernameRaw)
    const monthlyFee = Number(body.monthlyFee || 0)
    const startDate = String(body.startDate || dateOnly(new Date()))
    const requestedStatus = String(body.status || 'Activo')
    const isTrial = requestedStatus === 'Prueba gratuita' || Number(body.trialDays || 0) === 7
    const trialDays = isTrial ? 7 : 0
    const nextDueDate = isTrial
      ? addDays(startDate, trialDays)
      : String(body.nextDueDate || '')

    if (!name || !loginSlug || !['commerce','barbershop','parking','restaurant','transport'].includes(type)) {
      throw new Error('Nombre, usuario y tipo son obligatorios')
    }
    if (password.length < 6) {
      throw new Error('La contraseña debe tener al menos 6 caracteres')
    }
    if (!isTrial && !nextDueDate) {
      throw new Error('Falta el próximo vencimiento')
    }
    if (monthlyFee < 0) {
      throw new Error('Mensualidad inválida')
    }

    const email = `${loginSlug}@login.gestok.local`

    const { data: existingOrg } = await admin
      .from('organizations')
      .select('id')
      .eq('login_slug', loginSlug)
      .maybeSingle()

    if (existingOrg) {
      throw new Error('Ese usuario de acceso ya está en uso')
    }

    let authUserId: string | null = null
    let orgId: string | null = null

    try {
      const { data: createdAuth, error: createAuthError } =
        await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: {
            gestok_login: loginSlug,
            organization_name: name,
          },
        })

      if (createAuthError || !createdAuth.user) {
        throw createAuthError || new Error('No se pudo crear el acceso')
      }

      authUserId = createdAuth.user.id

      const { data: org, error: orgError } = await admin
        .from('organizations')
        .insert({
          name,
          login_slug: loginSlug,
          type,
          phone: phone || null,
          monthly_fee: monthlyFee,
          active: true,
        })
        .select('id')
        .single()

      if (orgError || !org) throw orgError || new Error('No se pudo crear la empresa')
      orgId = org.id

      const { error: memberError } = await admin
        .from('organization_members')
        .insert({
          organization_id: orgId,
          auth_user_id: authUserId,
          display_name: 'Administrador',
          role: 'admin',
          active: true,
        })

      if (memberError) throw memberError

      const { error: subError } = await admin
        .from('subscriptions')
        .insert({
          organization_id: orgId,
          status: isTrial ? 'Prueba gratuita' : requestedStatus,
          start_date: startDate,
          next_due_date: nextDueDate,
          reason: isTrial ? 'Prueba gratuita de 7 días.' : null,
          trial_started_at: isTrial ? startDate : null,
          trial_ends_at: isTrial ? nextDueDate : null,
          updated_at: new Date().toISOString(),
        })

      if (subError) throw subError

      if (!isTrial && monthlyFee > 0) {
        const { error: paymentError } = await admin
          .from('subscription_payments')
          .insert({
            organization_id: orgId,
            amount: monthlyFee,
            paid_at: startDate,
            note: 'Pago inicial',
            initial_payment: true,
          })

        if (paymentError) throw paymentError
      }

      await admin.from('notifications').insert({
        organization_id: orgId,
        title: isTrial ? 'Prueba gratuita activada' : 'Bienvenido a GestOK',
        message: isTrial
          ? `Tu prueba gratuita de 7 días está activa hasta el ${nextDueDate}.`
          : 'Tu acceso a GestOK Web Control está activo.',
        reason: isTrial ? 'Podés probar todas las funciones habilitadas durante 7 días.' : null,
      })

      if (type === 'barbershop') {
        await admin.from('barber_services').insert([
          { organization_id: orgId, name: 'Corte', price: 0, active: true },
          { organization_id: orgId, name: 'Barba', price: 0, active: true },
        ])
      }

      if (type === 'parking') {
        await admin.from('parking_settings').upsert({
          organization_id: orgId,
          minute_rate: 150,
          flat_rate: 10000,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'organization_id' })
      }

      if (type === 'restaurant') {
        await admin.from('restaurant_settings').upsert({
          organization_id: orgId,
          currency: 'ARS',
          ordering_enabled: true,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'organization_id' })

        const tables = Array.from({ length: 10 }, (_, i) => ({
          organization_id: orgId,
          table_number: i + 1,
          active: true,
        }))
        await admin.from('restaurant_tables').upsert(tables, {
          onConflict: 'organization_id,table_number'
        })
      }


      return new Response(JSON.stringify({
        ok: true,
        organizationId: orgId,
        username: loginSlug,
        status: isTrial ? 'Prueba gratuita' : requestedStatus,
        trialEndsAt: isTrial ? nextDueDate : null,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    } catch (innerError) {
      if (orgId) {
        await admin.from('organizations').delete().eq('id', orgId)
      }
      if (authUserId) {
        await admin.auth.admin.deleteUser(authUserId)
      }
      throw innerError
    }

  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Error inesperado',
    }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
