-- Esquema mínimo de pruebas, sin registros de producción.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create table public.organizations(
  id uuid primary key, name text not null, login_slug text not null unique,
  type text not null check (type in ('commerce','barbershop','parking','restaurant')),
  phone text, monthly_fee numeric not null, active boolean not null
);
create table public.organization_members(
  organization_id uuid references public.organizations(id),
  auth_user_id uuid references auth.users(id), display_name text, role text, active boolean,
  unique (organization_id, auth_user_id)
);
create table public.subscriptions(
  organization_id uuid primary key references public.organizations(id),
  status text check (status in ('Activo','Pendiente de pago','Por vencer','Vencido','Prueba gratuita')),
  start_date date, next_due_date date, reason text, trial_started_at date, trial_ends_at date, updated_at timestamptz
);
create table public.subscription_payments(
  organization_id uuid references public.organizations(id), amount numeric check (amount >= 0),
  paid_at date, note text, initial_payment boolean
);
create table public.notifications(
  organization_id uuid references public.organizations(id), title text, message text, reason text
);
create table public.barber_services(
  organization_id uuid references public.organizations(id), name text, price numeric, active boolean
);
create table public.parking_settings(
  organization_id uuid primary key references public.organizations(id),
  minute_rate numeric default 150, flat_rate numeric default 10000, updated_at timestamptz
);
create table public.restaurant_settings(
  organization_id uuid primary key references public.organizations(id),
  currency text, ordering_enabled boolean, updated_at timestamptz
);
create table public.restaurant_tables(
  organization_id uuid references public.organizations(id), table_number integer, active boolean,
  unique (organization_id, table_number)
);
create table public.orders(
  organization_id uuid, deposit_amount numeric, amount numeric,
  deposit_payment_method text, status text, payment_status text,
  final_payment_method text, paid_at timestamptz, ledger_posted boolean, finalized_at timestamptz
);
grant select, insert, update on all tables in schema public to service_role;
CREATE OR REPLACE FUNCTION public.gestok_ai_is_carlos_admin(p_org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select auth.uid() is not null
   and exists (
     select 1 from public.organizations o
     join public.organization_members m on m.organization_id=o.id
     where o.id=p_org and o.type='commerce' and o.active=true
       and (lower(trim(o.name))='carlos' or lower(trim(coalesce(o.login_slug,'')))='carlos')
       and m.auth_user_id=auth.uid() and m.active=true
       and lower(trim(coalesce(m.role,''))) in ('admin','administrador','owner')
   );
$function$
;
CREATE OR REPLACE FUNCTION public.gestok_org_access_allowed(p_organization_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_active boolean;
  v_status text;
  v_trial_end date;
begin
  select o.active,
         coalesce(s.status,'Activo'),
         coalesce(s.trial_ends_at,s.next_due_date)
  into v_active,v_status,v_trial_end
  from public.organizations o
  left join public.subscriptions s
    on s.organization_id=o.id
  where o.id=p_organization_id
  limit 1;

  if not found or v_active is false then
    return false;
  end if;

  if lower(coalesce(v_status,''))='vencido' then
    return false;
  end if;

  if lower(coalesce(v_status,''))='prueba gratuita'
     and v_trial_end is not null
     and v_trial_end <= current_date then
    return false;
  end if;

  return true;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.parking_create_default_settings()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.type = 'parking' then
    insert into public.parking_settings(organization_id)
    values(new.id)
    on conflict (organization_id) do nothing;
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.scr_enforce_order_payment_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_is_scr boolean;
begin
 select exists(select 1 from public.organizations g
  where g.id=new.organization_id and g.type='commerce' and lower(btrim(g.name))='scr') into v_is_scr;
 if not v_is_scr then return new; end if;

 if coalesce(new.deposit_amount,0)<0 or new.deposit_amount>new.amount then
   raise exception 'La seña debe estar entre $0 y el monto del pedido';
 end if;
 if coalesce(new.deposit_amount,0)=0 then
   new.deposit_amount:=0;
   new.deposit_payment_method:=null;
 elsif coalesce(new.deposit_payment_method,'') not in ('Transferencia','QR','Tarjeta','Efectivo','Otro') then
   raise exception 'Elegí un medio de pago válido para la seña';
 end if;
 if new.status <> 'Finalizado' and new.payment_status='Cobrado' then
   raise exception 'Para cobrar un pedido SCR, primero debe estar Finalizado';
 end if;
 if new.payment_status='Cobrado' then
   if new.amount>new.deposit_amount and coalesce(new.final_payment_method,'') not in ('Transferencia','QR','Tarjeta','Efectivo','Otro') then
     raise exception 'Elegí un medio de pago válido para el saldo final';
   end if;
   new.paid_at:=coalesce(new.paid_at,now());
 else
   new.paid_at:=null;
   new.final_payment_method:=null;
 end if;
 new.ledger_posted:=(new.status='Finalizado' and new.payment_status='Cobrado');
 if new.status='Finalizado' then new.finalized_at:=coalesce(new.finalized_at,now());
 else new.finalized_at:=null;
 end if;
 return new;
end $function$
;
create trigger trg_parking_default_settings after insert on public.organizations
  for each row execute function public.parking_create_default_settings();
CREATE OR REPLACE FUNCTION public.parking_settings_require_active_subscription()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org_id uuid;
begin
  v_org_id := coalesce(new.organization_id,old.organization_id);

  if not public.gestok_org_access_allowed(v_org_id) then
    raise exception 'Suscripción vencida. Reactivá GestOK Web Control para continuar.';
  end if;

  return coalesce(new,old);
end;
$function$;
create trigger trg_parking_settings_require_active_subscription before insert or delete or update on public.parking_settings
  for each row execute function public.parking_settings_require_active_subscription();
create trigger tr_scr_enforce_order_payment_rules before insert or update on public.orders
  for each row execute function public.scr_enforce_order_payment_rules();
