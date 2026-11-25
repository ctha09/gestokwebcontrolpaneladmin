param([switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'

$source = Split-Path -Parent $PSScriptRoot
$directory = Join-Path ([IO.Path]::GetTempPath()) ('gestok-v30-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
$stack = Join-Path $directory 'supabase'
$migrations = Join-Path $stack 'migrations'
$functions = Join-Path $stack 'functions'
$utf8 = [Text.UTF8Encoding]::new($false)

function Invoke-LocalCli {
    & npx.cmd --yes supabase@3.4.0 @args --agent=no --workdir $directory
    if ($LASTEXITCODE -ne 0) { throw "Supabase CLI falló ($LASTEXITCODE)." }
}

if (-not $PrepareOnly) {
    & docker info --format '{{.ServerVersion}}'
    if ($LASTEXITCODE -ne 0) { throw 'El motor de Docker tiene que estar iniciado.' }
}

New-Item -ItemType Directory -Path $migrations,$functions | Out-Null
$schema = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'traslados-schema.sql'))
$start = $schema.IndexOf('create table public.organizations(')
if ($start -lt 0) { throw 'No se encontró el comienzo del esquema ficticio.' }

# Supabase local ya proporciona auth.users, auth.uid() y los roles de API.
$extensions = @'
create table public.developer_admins (user_id uuid primary key references auth.users(id));
alter table public.developer_admins enable row level security;
grant select, insert on public.developer_admins to service_role;

create function public.is_org_member(target_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = target_org and m.auth_user_id = auth.uid() and m.active
  );
$$;

alter table public.organizations enable row level security;
create policy fixture_organizations_select on public.organizations for select to authenticated
  using (public.is_org_member(id));
grant select on public.organizations to authenticated;

alter table public.organization_members enable row level security;
alter table public.subscriptions enable row level security;
alter table public.subscription_payments enable row level security;
alter table public.notifications enable row level security;
alter table public.barber_services enable row level security;
alter table public.parking_settings enable row level security;
alter table public.restaurant_settings enable row level security;
alter table public.restaurant_tables enable row level security;
alter table public.orders enable row level security;

do $$
declare
  target text;
begin
  foreach target in array array[
    'organization_members', 'subscriptions', 'subscription_payments', 'notifications',
    'barber_services', 'parking_settings', 'restaurant_settings', 'restaurant_tables', 'orders'
  ] loop
    execute format('grant select on public.%I to authenticated', target);
    execute format('create policy fixture_member_select on public.%I for select to authenticated using (public.is_org_member(organization_id))', target);
  end loop;
end $$;

-- El cliente de pruebas exige este marcador antes de crear usuarios.
create function public.gestok_v30_fixture() returns text language sql stable
  as $$ select 'gestok-v30-local-fixture'::text $$;
revoke execute on function public.gestok_v30_fixture() from public, anon, authenticated;
grant execute on function public.gestok_v30_fixture() to service_role;
'@
[IO.File]::WriteAllText((Join-Path $migrations '20261124000000_fixture.sql'), $schema.Substring($start) + [Environment]::NewLine + $extensions, $utf8)
Copy-Item -LiteralPath (Join-Path $source 'supabase/migrations/20261124000100_traslados_admin_v40.sql') -Destination $migrations
Copy-Item -LiteralPath (Join-Path $source 'supabase/functions/admin-create-client') -Destination $functions -Recurse

if ($PrepareOnly) {
    Write-Output "Fixture preparado en $directory"
    return
}

# El directorio temporal se crea desde cero, sin .temp/project-ref ni archivos .env.
Invoke-LocalCli init
if (Test-Path -LiteralPath (Join-Path $stack '.temp/project-ref')) { throw 'El proyecto temporal tiene un vínculo inesperado.' }
try {
    $null = Invoke-LocalCli start
    $status = (Invoke-LocalCli status --output json | Out-String) | ConvertFrom-Json
    $env:GESTOK_LOCAL_API_URL = $status.API_URL
    $env:GESTOK_LOCAL_ANON_KEY = if ($status.ANON_KEY) { $status.ANON_KEY } else { $status.PUBLISHABLE_KEY }
    $env:GESTOK_LOCAL_SERVICE_KEY = if ($status.SERVICE_ROLE_KEY) { $status.SERVICE_ROLE_KEY } else { $status.SECRET_KEY }
    $env:GESTOK_LOCAL_RUN = '1'
    & node --test (Join-Path $PSScriptRoot 'traslados-local.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Fallaron las pruebas de integración.' }
} finally {
    Remove-Item Env:GESTOK_LOCAL_API_URL,Env:GESTOK_LOCAL_ANON_KEY,Env:GESTOK_LOCAL_SERVICE_KEY,Env:GESTOK_LOCAL_RUN -ErrorAction SilentlyContinue
    Invoke-LocalCli stop
}
