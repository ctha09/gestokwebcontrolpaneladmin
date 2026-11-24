-- GestOK V40: etapa 1, alta de cuentas Traslados.
-- Basado en el CHECK de V21. No modifica registros existentes.
begin;

-- Abortar si el esquema difiere del esperado, antes de cambiar nada.
lock table public.organizations in access exclusive mode;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.organizations'::regclass and conname='organizations_type_check' and contype='c') then
    raise exception 'No se encontró la restricción esperada; revisar el esquema antes de continuar';
  end if;
  if exists (select 1 from public.organizations where type not in ('commerce','barbershop','parking','restaurant','transport')) then
    raise exception 'Existen otros sectores; revisar antes de migrar';
  end if;
end $$;
alter table public.organizations drop constraint organizations_type_check;
alter table public.organizations add constraint organizations_type_check
 check (type in ('commerce','barbershop','parking','restaurant','transport'));

-- Configuración privada, sin acceso público ni escritura desde el navegador.
create table if not exists public.transport_settings (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 public_code uuid not null unique default gen_random_uuid(),
 requests_enabled boolean not null default false,
 created_at timestamptz not null default now()
);
alter table public.transport_settings enable row level security;
revoke all on public.transport_settings from public, anon, authenticated;
grant select, insert, update on public.transport_settings to service_role;

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
drop trigger if exists gestok_init_transport_settings on public.organizations;
create trigger gestok_init_transport_settings after insert on public.organizations
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
notify pgrst,'reload schema';
commit;
