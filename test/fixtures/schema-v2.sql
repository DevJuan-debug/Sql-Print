-- Esquema v2 (con tipo de diagrama, sin historial). Solo para probar actualizaciones; no editar.
-- =====================================================================
-- MerFresh · Esquema de Supabase
--
-- Ejecuta este archivo completo en Supabase → SQL Editor → Run.
-- Es idempotente: puedes volver a ejecutarlo después de actualizar la app.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------

-- Un proyecto guarda una instantánea compactada del diagrama (`doc`);
-- los cambios posteriores viven en `project_ops` hasta la siguiente compactación.
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  doc         jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  ops_until   bigint not null default 0,
  version     integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Tipo de diagrama del proyecto (añadido después: se agrega también a instalaciones anteriores).
alter table public.projects add column if not exists kind text not null default 'er';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'projects_kind_check' and conrelid = 'public.projects'::regclass) then
    alter table public.projects
      add constraint projects_kind_check check (kind in ('er', 'flow', 'class', 'sequence', 'component'));
  end if;
end;
$$;

create table if not exists public.project_members (
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null check (role in ('owner', 'editor', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists project_members_user_id_idx on public.project_members (user_id);

-- Enlace para compartir: quien lo abra (con sesión iniciada) entra con `role`.
create table if not exists public.project_shares (
  project_id  uuid primary key references public.projects (id) on delete cascade,
  token       text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  role        text not null default 'editor' check (role in ('editor', 'viewer')),
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now()
);

-- Registro de cambios. Cada fila es un lote de operaciones [colección, id, campo, valor, marca].
create table if not exists public.project_ops (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     uuid default auth.uid() references auth.users (id) on delete set null,
  client_id   text not null check (char_length(client_id) between 4 and 64),
  ops         jsonb not null check (jsonb_typeof(ops) = 'array' and jsonb_array_length(ops) between 1 and 1000),
  created_at  timestamptz not null default now()
);
create index if not exists project_ops_project_id_idx on public.project_ops (project_id, id);

-- ---------------------------------------------------------------------
-- Funciones auxiliares para las políticas (security definer evita recursión en RLS)
-- ---------------------------------------------------------------------

create or replace function public.project_role(p_project uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select m.role
  from public.project_members m
  where m.project_id = p_project and m.user_id = auth.uid()
$$;

create or replace function public.is_project_member(p_project uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = p_project and m.user_id = auth.uid()
  )
$$;

create or replace function public.can_edit_project(p_project uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = p_project and m.user_id = auth.uid() and m.role in ('owner', 'editor')
  )
$$;

-- ---------------------------------------------------------------------
-- Disparadores
-- ---------------------------------------------------------------------

-- Al crear un proyecto: el creador queda como propietario y se prepara el enlace para compartir.
create or replace function public.handle_new_project()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (project_id, user_id) do update set role = 'owner';

  insert into public.project_shares (project_id)
  values (new.id)
  on conflict (project_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_project_created on public.projects;
create trigger on_project_created
  after insert on public.projects
  for each row execute function public.handle_new_project();

create or replace function public.set_project_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists on_project_updated on public.projects;
create trigger on_project_updated
  before update on public.projects
  for each row execute function public.set_project_updated_at();

-- Cada cambio actualiza la fecha del proyecto (como mucho una vez cada 20 s).
create or replace function public.touch_project_from_op()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.projects
     set updated_at = now()
   where id = new.project_id
     and updated_at < now() - interval '20 seconds';
  return new;
end;
$$;

drop trigger if exists on_project_op_created on public.project_ops;
create trigger on_project_op_created
  after insert on public.project_ops
  for each row execute function public.touch_project_from_op();

-- ---------------------------------------------------------------------
-- Permisos y seguridad a nivel de fila (RLS)
-- ---------------------------------------------------------------------

alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.project_shares  enable row level security;
alter table public.project_ops     enable row level security;

-- Solo se conceden las columnas que la app necesita escribir directamente;
-- el resto de cambios pasa por funciones con sus propias comprobaciones.
revoke all on public.projects, public.project_members, public.project_shares, public.project_ops from anon, authenticated;

grant select, delete on public.projects to authenticated;
grant insert (name, doc, kind) on public.projects to authenticated;
grant update (name) on public.projects to authenticated;

grant select, delete on public.project_members to authenticated;
grant update (role) on public.project_members to authenticated;

grant select on public.project_shares to authenticated;
grant update (role, enabled) on public.project_shares to authenticated;

grant select on public.project_ops to authenticated;
grant insert (project_id, client_id, ops) on public.project_ops to authenticated;

-- projects
drop policy if exists "merfresh_projects_select" on public.projects;
create policy "merfresh_projects_select" on public.projects
  for select to authenticated
  using (owner_id = (select auth.uid()) or public.is_project_member(id));

drop policy if exists "merfresh_projects_insert" on public.projects;
create policy "merfresh_projects_insert" on public.projects
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

drop policy if exists "merfresh_projects_update" on public.projects;
create policy "merfresh_projects_update" on public.projects
  for update to authenticated
  using (public.can_edit_project(id))
  with check (public.can_edit_project(id));

drop policy if exists "merfresh_projects_delete" on public.projects;
create policy "merfresh_projects_delete" on public.projects
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- project_members
drop policy if exists "merfresh_members_select" on public.project_members;
create policy "merfresh_members_select" on public.project_members
  for select to authenticated
  using (public.is_project_member(project_id));

drop policy if exists "merfresh_members_update" on public.project_members;
create policy "merfresh_members_update" on public.project_members
  for update to authenticated
  using (public.project_role(project_id) = 'owner' and role <> 'owner')
  with check (public.project_role(project_id) = 'owner' and role in ('editor', 'viewer'));

-- El propietario puede quitar a cualquiera; cada miembro puede salir por su cuenta.
drop policy if exists "merfresh_members_delete" on public.project_members;
create policy "merfresh_members_delete" on public.project_members
  for delete to authenticated
  using (role <> 'owner' and (public.project_role(project_id) = 'owner' or user_id = (select auth.uid())));

-- project_shares (solo el propietario ve y cambia el enlace)
drop policy if exists "merfresh_shares_select" on public.project_shares;
create policy "merfresh_shares_select" on public.project_shares
  for select to authenticated
  using (public.project_role(project_id) = 'owner');

drop policy if exists "merfresh_shares_update" on public.project_shares;
create policy "merfresh_shares_update" on public.project_shares
  for update to authenticated
  using (public.project_role(project_id) = 'owner')
  with check (public.project_role(project_id) = 'owner');

-- project_ops (los lectores ven los cambios; solo editores y propietario los crean)
drop policy if exists "merfresh_ops_select" on public.project_ops;
create policy "merfresh_ops_select" on public.project_ops
  for select to authenticated
  using (public.is_project_member(project_id));

drop policy if exists "merfresh_ops_insert" on public.project_ops;
create policy "merfresh_ops_insert" on public.project_ops
  for insert to authenticated
  with check (public.can_edit_project(project_id) and user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- Funciones que usa la app (RPC)
-- ---------------------------------------------------------------------

-- Instantánea + cambios pendientes en una sola consulta (lectura consistente).
create or replace function public.load_project(p_project uuid)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'owner_id', p.owner_id,
    'role', public.project_role(p.id),
    'kind', p.kind,
    'doc', p.doc,
    'ops_until', p.ops_until,
    'version', p.version,
    'ops', coalesce((
      select jsonb_agg(jsonb_build_array(o.id, o.client_id, o.ops, o.created_at) order by o.id)
      from public.project_ops o
      where o.project_id = p.id and o.id > p.ops_until
    ), '[]'::jsonb)
  )
  from public.projects p
  where p.id = p_project
$$;

-- Guarda una instantánea que ya incluye los cambios hasta `p_until` y borra esos cambios.
-- `p_version` evita que dos compactaciones simultáneas se pisen.
create or replace function public.compact_project(p_project uuid, p_doc jsonb, p_until bigint, p_version integer)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.can_edit_project(p_project) then
    raise exception 'No tienes permiso para editar este proyecto' using errcode = '42501';
  end if;
  if p_doc is null or jsonb_typeof(p_doc) <> 'object' then
    raise exception 'Documento inválido' using errcode = '22023';
  end if;

  update public.projects p
     set doc = p_doc, ops_until = p_until, version = p.version + 1
   where p.id = p_project
     and p.version = p_version
     and p_until > p.ops_until
     and exists (select 1 from public.project_ops o where o.project_id = p_project and o.id = p_until);
  if not found then
    return false;
  end if;

  delete from public.project_ops where project_id = p_project and id <= p_until;
  return true;
end;
$$;

-- Aceptar un enlace compartido. Si ya era lector y el enlace es de edición, sube a editor.
create or replace function public.join_project(p_token text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_share public.project_shares%rowtype;
begin
  if v_uid is null then
    raise exception 'Debes iniciar sesión' using errcode = '28000';
  end if;

  select * into v_share
  from public.project_shares s
  where s.token = p_token and s.enabled;
  if not found then
    raise exception 'El enlace no es válido o fue desactivado' using errcode = 'P0002';
  end if;

  insert into public.project_members as m (project_id, user_id, role)
  values (v_share.project_id, v_uid, v_share.role)
  on conflict (project_id, user_id) do update
    set role = excluded.role
    where m.role = 'viewer' and excluded.role = 'editor';

  return v_share.project_id;
end;
$$;

create or replace function public.regenerate_share_token(p_project uuid)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if public.project_role(p_project) is distinct from 'owner' then
    raise exception 'Solo el propietario puede cambiar el enlace' using errcode = '42501';
  end if;

  update public.project_shares
     set token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
         updated_at = now()
   where project_id = p_project
  returning token into v_token;

  return v_token;
end;
$$;

-- (se borra antes porque cambió la lista de columnas que devuelve)
drop function if exists public.list_projects();
create function public.list_projects()
returns table (
  id uuid, name text, kind text, role text, owner_id uuid, owner_name text,
  member_count integer, created_at timestamptz, updated_at timestamptz
)
language sql stable security definer
set search_path = ''
as $$
  select p.id, p.name, p.kind, m.role, p.owner_id,
         coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), u.email::text, '') as owner_name,
         (select count(*)::integer from public.project_members x where x.project_id = p.id) as member_count,
         p.created_at, p.updated_at
  from public.project_members m
  join public.projects p on p.id = m.project_id
  left join auth.users u on u.id = p.owner_id
  where m.user_id = auth.uid()
  order by p.updated_at desc
$$;

create or replace function public.get_project_members(p_project uuid)
returns table (user_id uuid, role text, email text, full_name text, joined_at timestamptz)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.is_project_member(p_project) then
    raise exception 'No tienes acceso a este proyecto' using errcode = '42501';
  end if;

  return query
    select m.user_id, m.role,
           coalesce(u.email::text, ''),
           coalesce(u.raw_user_meta_data ->> 'full_name', ''),
           m.created_at
    from public.project_members m
    left join auth.users u on u.id = m.user_id
    where m.project_id = p_project
    order by (m.role = 'owner') desc, m.created_at;
end;
$$;

-- ---------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------

-- Los cambios del diagrama se difunden a los miembros con postgres_changes (respeta RLS).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'project_ops'
     ) then
    alter publication supabase_realtime add table public.project_ops;
  end if;
end;
$$;

-- Presencia y cursores viajan por un canal privado "project:<uuid>" solo para miembros.
create or replace function public.can_use_project_topic(p_topic text)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_topic is null
     or p_topic !~ '^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.is_project_member(substr(p_topic, 9)::uuid);
end;
$$;

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'realtime' and table_name = 'messages') then
    execute 'drop policy if exists "merfresh_realtime_select" on realtime.messages';
    execute $policy$
      create policy "merfresh_realtime_select" on realtime.messages
        for select to authenticated
        using (
          realtime.messages.extension in ('broadcast', 'presence')
          and public.can_use_project_topic((select realtime.topic()))
        )
    $policy$;

    execute 'drop policy if exists "merfresh_realtime_insert" on realtime.messages';
    execute $policy$
      create policy "merfresh_realtime_insert" on realtime.messages
        for insert to authenticated
        with check (
          realtime.messages.extension in ('broadcast', 'presence')
          and public.can_use_project_topic((select realtime.topic()))
        )
    $policy$;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Quién puede llamar a cada función
-- ---------------------------------------------------------------------

revoke execute on function
  public.project_role(uuid),
  public.is_project_member(uuid),
  public.can_edit_project(uuid),
  public.can_use_project_topic(text),
  public.load_project(uuid),
  public.compact_project(uuid, jsonb, bigint, integer),
  public.join_project(text),
  public.regenerate_share_token(uuid),
  public.list_projects(),
  public.get_project_members(uuid)
from public, anon;

grant execute on function
  public.project_role(uuid),
  public.is_project_member(uuid),
  public.can_edit_project(uuid),
  public.can_use_project_topic(text),
  public.load_project(uuid),
  public.compact_project(uuid, jsonb, bigint, integer),
  public.join_project(text),
  public.regenerate_share_token(uuid),
  public.list_projects(),
  public.get_project_members(uuid)
to authenticated;
