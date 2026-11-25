-- GestOK V40: etapa 1, alta de cuentas Traslados.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

lock table public.organizations in access exclusive mode;
do $$
declare
  v_current text;
  v_legacy constant text := $check$CHECK ((type = ANY (ARRAY['commerce'::text, 'barbershop'::text, 'parking'::text, 'restaurant'::text])))$check$;
  v_v40 constant text := $check$CHECK ((type = ANY (ARRAY['commerce'::text, 'barbershop'::text, 'parking'::text, 'restaurant'::text, 'transport'::text])))$check$;
begin
  select pg_get_constraintdef(oid) into v_current
  from pg_constraint
  where conrelid = 'public.organizations'::regclass
    and conname = 'organizations_type_check' and contype = 'c'
    and convalidated and not connoinherit and conislocal and coninhcount = 0;

  if v_current is null or v_current not in (v_legacy, v_v40) then
    raise exception 'La definición de organizations_type_check difiere de la auditada';
  end if;
  if v_current = v_legacy then
    alter table public.organizations drop constraint organizations_type_check;
    alter table public.organizations add constraint organizations_type_check
      check (type in ('commerce','barbershop','parking','restaurant','transport'));
  end if;
end $$;

do $$
declare
  v_table regclass := to_regclass('public.transport_settings');
  v_columns jsonb;
  v_constraints text[];
  v_expected constant text[] := array[
    'FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE',
    'PRIMARY KEY (organization_id)', 'UNIQUE (public_code)'
  ];
begin
  if v_table is null then
    create table public.transport_settings (
      organization_id uuid primary key references public.organizations(id) on delete cascade,
      public_code uuid not null unique default gen_random_uuid(),
      requests_enabled boolean not null default false,
      created_at timestamptz not null default now()
    );
  else
    if not exists (select 1 from pg_class where oid = v_table and relkind = 'r' and relpersistence = 'p')
      or exists (select 1 from pg_inherits where inhrelid = v_table or inhparent = v_table) then
      raise exception 'transport_settings debe ser una tabla permanente sin herencia';
    end if;
    lock table public.transport_settings in access exclusive mode;
    select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod),
      a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attgenerated, a.attidentity) order by a.attname)
    into v_columns
    from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = v_table and a.attnum > 0 and not a.attisdropped;

    if v_columns is distinct from '[
      ["created_at", "timestamp with time zone", true, "now()", "", ""],
      ["organization_id", "uuid", true, null, "", ""],
      ["public_code", "uuid", true, "gen_random_uuid()", "", ""],
      ["requests_enabled", "boolean", true, "false", "", ""]
    ]'::jsonb then
      raise exception 'Las columnas de transport_settings difieren de V40';
    end if;

    select array_agg(pg_get_constraintdef(oid) order by pg_get_constraintdef(oid)) into v_constraints
    from pg_constraint where conrelid = v_table;
    if (v_constraints is distinct from v_expected and v_constraints is distinct from
        (array['CHECK ((NOT requests_enabled))'] || v_expected))
      or exists (select 1 from pg_constraint c left join pg_index i on i.indexrelid = c.conindid
        where c.conrelid = v_table and (not c.convalidated
          or (c.contype = 'c' and c.conname <> 'transport_settings_requests_disabled_v40')
          or (c.contype in ('p','u') and (i.indisvalid and i.indisready) is not true))) then
      raise exception 'Las restricciones de transport_settings difieren de V40';
    end if;
    if exists (select 1 from pg_trigger where tgrelid = v_table and not tgisinternal
        and (tgname <> 'gestok_keep_transport_identifier' or tgenabled <> 'O' or tgtype <> 19
          or tgfoid is distinct from to_regprocedure('public.gestok_keep_transport_identifier()')::oid
          or tgqual is not null or tgnargs <> 0 or tgattr <> ''))
      or exists (select 1 from pg_rewrite where ev_class = v_table) then
      raise exception 'transport_settings tiene triggers o reglas ajenos a V40';
    end if;
    if exists (select 1 from public.transport_settings s join public.organizations o
        on o.id = s.organization_id where o.type is distinct from 'transport' or s.requests_enabled) then
      raise exception 'transport_settings contiene configuraciones incompatibles; revisar sin modificar registros';
    end if;
  end if;

  if not exists (select 1 from pg_constraint where conrelid = 'public.transport_settings'::regclass
      and contype = 'c' and pg_get_constraintdef(oid) = 'CHECK ((NOT requests_enabled))') then
    alter table public.transport_settings add constraint transport_settings_requests_disabled_v40
      check (not requests_enabled);
  end if;
end $$;

alter table public.transport_settings enable row level security;
revoke all on public.transport_settings from public, anon, authenticated;
revoke all on public.transport_settings from service_role;
grant select on public.transport_settings to service_role;
do $$
begin
  if exists (select 1 from pg_roles where rolname in ('anon','authenticated')
    and (has_any_column_privilege(oid, 'public.transport_settings', 'SELECT, INSERT, UPDATE, REFERENCES')
      or has_table_privilege(oid, 'public.transport_settings', 'DELETE, TRUNCATE, TRIGGER'))) then
    raise exception 'transport_settings conserva permisos de navegador; revisar los grants';
  end if;
end $$;

create or replace function public.gestok_keep_transport_identifier()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.public_code is distinct from old.public_code or new.organization_id is distinct from old.organization_id then
    raise exception 'El identificador de Traslados es permanente';
  end if;
  return new;
end $$;
revoke all on function public.gestok_keep_transport_identifier() from public, anon, authenticated;
create or replace trigger gestok_keep_transport_identifier before update on public.transport_settings
  for each row execute function public.gestok_keep_transport_identifier();

-- Inicialización automática sólo para nuevas organizaciones de Traslados.
create or replace function public.gestok_init_transport_settings()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if new.type='transport' then
   insert into public.transport_settings(organization_id) values(new.id)
   on conflict (organization_id) do nothing;
 end if;
 return new;
end $$;
revoke all on function public.gestok_init_transport_settings() from public, anon, authenticated;
create or replace trigger gestok_init_transport_settings after insert on public.organizations
 for each row execute function public.gestok_init_transport_settings();
insert into public.transport_settings(organization_id)
select id from public.organizations where type='transport'
on conflict (organization_id) do nothing;

-- Extender el resolver V38 conservando la lógica anterior.
create or replace function public.gestok_resolve_login_slug(p_login_raw text,p_type text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
 v_raw text := lower(btrim(coalesce(p_login_raw,'')));
 v_slug text;
 v_matches bigint;
begin
 if length(v_raw)<1 or length(v_raw)>120 or p_type is null or p_type not in ('commerce','parking','restaurant','barbershop','transport') then return null; end if;
 select o.login_slug into v_slug from public.organizations o where o.type=p_type and lower(btrim(o.login_slug))=v_raw limit 1;
 if v_slug is not null then return v_slug; end if;
 select count(*),min(o.login_slug) into v_matches,v_slug from public.organizations o where o.type=p_type and lower(btrim(o.name))=v_raw;
 if v_matches=1 then return v_slug; end if;
 return null;
end $$;
revoke all on function public.gestok_resolve_login_slug(text,text) from public,anon,authenticated;
grant execute on function public.gestok_resolve_login_slug(text,text) to anon,authenticated;

-- Auth se crea desde la Edge Function. Todas las escrituras de la empresa se confirman juntas.
create or replace function public.gestok_admin_create_organization_v40(
  p_org uuid, p_user uuid, p_name text, p_slug text, p_type text, p_phone text,
  p_fee numeric, p_start date, p_due date, p_status text
)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_trial boolean := p_status = 'Prueba gratuita';
begin
  insert into public.organizations(id, name, login_slug, type, phone, monthly_fee, active)
  values (p_org, p_name, p_slug, p_type, p_phone, p_fee, true);

  insert into public.organization_members(organization_id, auth_user_id, display_name, role, active)
  values (p_org, p_user, 'Administrador', 'admin', true);

  -- La configuración de parking se escribe antes de la suscripción, cuyo estado puede bloquear cambios posteriores.
  if p_type = 'parking' then
    insert into public.parking_settings(organization_id, minute_rate, flat_rate, updated_at)
    values (p_org, 150, 10000, now())
    on conflict (organization_id) do update set minute_rate = excluded.minute_rate,
      flat_rate = excluded.flat_rate, updated_at = excluded.updated_at;
  end if;

  insert into public.subscriptions(organization_id, status, start_date, next_due_date, reason,
    trial_started_at, trial_ends_at, updated_at)
  values (p_org, p_status, p_start, p_due, case when v_trial then 'Prueba gratuita de 7 días.' end,
    case when v_trial then p_start end, case when v_trial then p_due end, now());

  if not v_trial and p_fee > 0 then
    insert into public.subscription_payments(organization_id, amount, paid_at, note, initial_payment)
    values (p_org, p_fee, p_start, 'Pago inicial', true);
  end if;

  insert into public.notifications(organization_id, title, message, reason)
  values (p_org,
    case when v_trial then 'Prueba gratuita activada' else 'Bienvenido a GestOK' end,
    case when v_trial then 'Tu prueba gratuita de 7 días está activa hasta el ' || to_char(p_due, 'YYYY-MM-DD') || '.'
      else 'Tu acceso a GestOK Web Control está activo.' end,
    case when v_trial then 'Podés probar todas las funciones habilitadas durante 7 días.' end);

  case p_type
    when 'barbershop' then
      insert into public.barber_services(organization_id, name, price, active)
      values (p_org, 'Corte', 0, true), (p_org, 'Barba', 0, true);
    when 'restaurant' then
      insert into public.restaurant_settings(organization_id, currency, ordering_enabled, updated_at)
      values (p_org, 'ARS', true, now());
      insert into public.restaurant_tables(organization_id, table_number, active)
      select p_org, table_number, true from generate_series(1, 10) as tables(table_number);
    when 'transport' then
      if not exists (select 1 from public.transport_settings where organization_id = p_org and not requests_enabled) then
        raise exception 'Falta la configuración privada de Traslados';
      end if;
    else null;
  end case;

  return p_org;
end $$;
revoke all on function public.gestok_admin_create_organization_v40(uuid,uuid,text,text,text,text,numeric,date,date,text)
  from public, anon, authenticated;
grant execute on function public.gestok_admin_create_organization_v40(uuid,uuid,text,text,text,text,numeric,date,date,text)
  to service_role;
notify pgrst,'reload schema';
commit;
