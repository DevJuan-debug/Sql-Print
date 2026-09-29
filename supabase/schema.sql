-- =====================================================================
-- MerFresh · Esquema de Supabase
--
-- Ejecuta este archivo completo en Supabase → SQL Editor → Run.
-- Es idempotente: puedes volver a ejecutarlo después de actualizar la app.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------

-- Un proyecto guarda una instantánea compactada del diagrama (`doc`) que ya incluye los cambios
-- hasta `ops_until`; al abrirlo solo se aplican los lotes posteriores de `project_ops`.
-- Los lotes no se borran nunca (son el historial) y cada instantánea queda además como copia
-- completa en `project_checkpoints`.
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

-- Papelera: un proyecto con `deleted_at` es invisible para todos hasta que el propietario lo
-- restaura; pasados 30 días se borra definitivamente.
alter table public.projects add column if not exists deleted_at timestamptz;
alter table public.projects add column if not exists deleted_by uuid references auth.users (id) on delete set null;
create index if not exists projects_trash_idx on public.projects (owner_id, deleted_at) where deleted_at is not null;

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
-- Es permanente (solo desaparece al eliminar definitivamente el proyecto): cada lote es una copia
-- de esa modificación y el estado tras cualquier lote se reconstruye con el último punto de
-- control anterior más los lotes que lo siguen.
create table if not exists public.project_ops (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     uuid default auth.uid() references auth.users (id) on delete set null,
  client_id   text not null check (char_length(client_id) between 4 and 64),
  ops         jsonb not null check (jsonb_typeof(ops) = 'array' and jsonb_array_length(ops) between 1 and 1000),
  created_at  timestamptz not null default now()
);
create index if not exists project_ops_project_id_idx on public.project_ops (project_id, id);

-- Puntos de control: documento completo con los lotes hasta `until_op` (incluido) ya aplicados.
-- Se guarda uno al crear el proyecto (0) y otro en cada compactación.
create table if not exists public.project_checkpoints (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references public.projects (id) on delete cascade,
  until_op    bigint not null,
  doc         jsonb not null check (jsonb_typeof(doc) = 'object'),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (project_id, until_op)
);

-- Los proyectos de instalaciones anteriores empiezan su historial en la última compactación.
insert into public.project_checkpoints (project_id, until_op, doc, created_by, created_at)
select p.id, p.ops_until, p.doc, p.owner_id,
       coalesce(
         case when p.ops_until = 0 then p.created_at end,
         (select min(o.created_at) from public.project_ops o where o.project_id = p.id and o.id > p.ops_until),
         p.updated_at,
         now())
from public.projects p
where not exists (select 1 from public.project_checkpoints c where c.project_id = p.id);

-- Versiones con nombre: marcan el estado tras los lotes con id <= `op_id`.
create table if not exists public.project_versions (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references public.projects (id) on delete cascade,
  op_id       bigint not null,
  label       text not null check (char_length(btrim(label)) between 1 and 120),
  kind        text not null default 'manual' check (kind in ('manual', 'before_restore', 'restore', 'before_import')),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists project_versions_project_id_idx on public.project_versions (project_id, op_id);

-- ---------------------------------------------------------------------
-- Funciones auxiliares para las políticas (security definer evita recursión en RLS)
-- Un proyecto en la papelera no da acceso a nadie.
-- ---------------------------------------------------------------------

create or replace function public.project_role(p_project uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select m.role
  from public.project_members m
  join public.projects p on p.id = m.project_id
  where m.project_id = p_project and m.user_id = auth.uid() and p.deleted_at is null
$$;

create or replace function public.is_project_member(p_project uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members m
    join public.projects p on p.id = m.project_id
    where m.project_id = p_project and m.user_id = auth.uid() and p.deleted_at is null
  )
$$;

create or replace function public.can_edit_project(p_project uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members m
    join public.projects p on p.id = m.project_id
    where m.project_id = p_project and m.user_id = auth.uid() and m.role in ('owner', 'editor')
      and p.deleted_at is null
  )
$$;

-- ---------------------------------------------------------------------
-- Disparadores
-- ---------------------------------------------------------------------

-- Al crear un proyecto: el creador queda como propietario, se prepara el enlace para compartir
-- y el documento inicial queda como primer punto de control del historial.
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

  insert into public.project_checkpoints (project_id, until_op, doc, created_by)
  values (new.id, 0, new.doc, new.owner_id)
  on conflict (project_id, until_op) do nothing;

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

alter table public.projects            enable row level security;
alter table public.project_members     enable row level security;
alter table public.project_shares      enable row level security;
alter table public.project_ops         enable row level security;
alter table public.project_checkpoints enable row level security;
alter table public.project_versions    enable row level security;

-- Solo se conceden las columnas que la app necesita escribir directamente;
-- el resto de cambios pasa por funciones con sus propias comprobaciones.
-- Los proyectos no se borran directamente: van a la papelera (trash_project) y de ahí se
-- eliminan con purge_project. Puntos de control y versiones solo se usan mediante funciones.
revoke all on public.projects, public.project_members, public.project_shares, public.project_ops,
  public.project_checkpoints, public.project_versions
from anon, authenticated;

grant select on public.projects to authenticated;
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
  using (deleted_at is null and (owner_id = (select auth.uid()) or public.is_project_member(id)));

drop policy if exists "merfresh_projects_insert" on public.projects;
create policy "merfresh_projects_insert" on public.projects
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

drop policy if exists "merfresh_projects_update" on public.projects;
create policy "merfresh_projects_update" on public.projects
  for update to authenticated
  using (public.can_edit_project(id))
  with check (public.can_edit_project(id));

-- (versiones anteriores permitían borrar directamente; ahora se usa la papelera)
drop policy if exists "merfresh_projects_delete" on public.projects;

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

-- project_checkpoints y project_versions no tienen políticas: sin permisos directos, RLS lo niega todo.

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
  where p.id = p_project and p.deleted_at is null
$$;

-- Guarda una instantánea que ya incluye los cambios hasta `p_until` para que abrir el proyecto
-- siga siendo rápido, y la deja como punto de control del historial. Los lotes no se borran.
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
  -- Cada punto de control es una copia completa permanente: como mucho uno por minuto (además del
  -- inicial), aunque alguien llame a la función en bucle. La app compacta mucho menos a menudo.
  if exists (
    select 1 from public.project_checkpoints c
    where c.project_id = p_project and c.until_op > 0 and c.created_at > now() - interval '1 minute'
  ) then
    return false;
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

  insert into public.project_checkpoints (project_id, until_op, doc)
  values (p_project, p_until, p_doc)
  on conflict (project_id, until_op) do nothing;
  return true;
end;
$$;

-- Aceptar un enlace compartido. Si ya era lector y el enlace es de edición, sube a editor.
-- Un proyecto en la papelera se trata como un enlace inválido.
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

  select s.* into v_share
  from public.project_shares s
  join public.projects p on p.id = s.project_id
  where s.token = p_token and s.enabled and p.deleted_at is null;
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
  where m.user_id = auth.uid() and p.deleted_at is null
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
-- Historial y copias de seguridad
-- (el estado de una versión se reconstruye en la app a partir de un punto de control y lotes)
-- ---------------------------------------------------------------------

-- Agrupa los lotes en "versiones" para el historial: un lote empieza grupo nuevo si pasaron más de
-- 2 minutos desde el anterior o si cae en otra ventana de 5 minutos (misma regla que groupHistory
-- en shared/history.js). Paginación con `p_before`. Inicio y fin de cada grupo son el created_at
-- más antiguo y el más reciente de sus lotes.
create or replace function public.list_project_history(p_project uuid, p_before bigint default null, p_limit integer default 40)
returns table (
  first_op bigint, last_op bigint, started_at timestamptz, ended_at timestamptz,
  batches integer, changes integer, authors jsonb
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 40), 1), 200);
  v_from bigint;
begin
  if not public.is_project_member(p_project) then
    raise exception 'No tienes acceso a este proyecto' using errcode = '42501';
  end if;

  -- Primer lote del grupo número `v_limit` contando desde el más reciente. Si un lote empieza grupo
  -- solo depende del lote anterior, así que basta recorrer el índice hacia atrás hasta encontrarlo:
  -- el coste no crece con la longitud del historial. Sin él (hay menos grupos) se leen todos.
  select x.lote into v_from
  from (
    select o.id as lote, o.created_at as momento,
           lead(o.created_at) over (order by o.id desc) as anterior
    from public.project_ops o
    where o.project_id = p_project and (p_before is null or o.id < p_before)
    order by o.id desc
  ) x
  where x.anterior is null
     or x.momento - x.anterior > interval '2 minutes'
     or floor(extract(epoch from x.momento) / 300) <> floor(extract(epoch from x.anterior) / 300)
  order by x.lote desc
  offset v_limit - 1
  limit 1;

  return query
    with lotes as (
      select o.id as lote, o.user_id as autor, o.created_at as momento,
             jsonb_array_length(o.ops) as cambios,
             lag(o.created_at) over (order by o.id) as anterior
      from public.project_ops o
      where o.project_id = p_project
        and (p_before is null or o.id < p_before)
        and (v_from is null or o.id >= v_from)
    ),
    agrupados as (
      select l.*,
             sum(case
                   when l.anterior is null
                     or l.momento - l.anterior > interval '2 minutes'
                     or floor(extract(epoch from l.momento) / 300) <> floor(extract(epoch from l.anterior) / 300)
                   then 1 else 0
                 end) over (order by l.lote) as grupo
      from lotes l
    ),
    grupos as (
      select a.grupo, min(a.lote) as primero, max(a.lote) as ultimo,
             min(a.momento) as inicio, max(a.momento) as fin,
             count(*)::integer as n_lotes, sum(a.cambios)::integer as n_cambios
      from agrupados a
      group by a.grupo
    ),
    -- Autores distintos de cada grupo, por orden de primera aparición (una sola pasada).
    autores as (
      select a.grupo, a.autor, min(a.lote) as primero
      from agrupados a
      group by a.grupo, a.autor
    ),
    autores_json as (
      select x.grupo,
             jsonb_agg(jsonb_build_object(
               'id', x.autor,
               'name', coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), u.email::text, '')
             ) order by x.primero) as lista
      from autores x
      left join auth.users u on u.id = x.autor
      group by x.grupo
    )
    select g.primero, g.ultimo, g.inicio, g.fin, g.n_lotes, g.n_cambios, j.lista
    from grupos g
    join autores_json j on j.grupo = g.grupo
    order by g.ultimo desc
    limit v_limit;
end;
$$;

create or replace function public.list_project_versions(p_project uuid)
returns table (
  id bigint, op_id bigint, label text, kind text, created_by uuid, author_name text, created_at timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.is_project_member(p_project) then
    raise exception 'No tienes acceso a este proyecto' using errcode = '42501';
  end if;

  return query
    select v.id, v.op_id, v.label, v.kind, v.created_by,
           coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), u.email::text, ''),
           v.created_at
    from public.project_versions v
    left join auth.users u on u.id = v.created_by
    where v.project_id = p_project
    order by v.op_id desc, v.id desc;
end;
$$;

-- Marca con nombre el estado actual (tras el último lote guardado).
create or replace function public.save_project_version(p_project uuid, p_label text, p_kind text default 'manual')
returns bigint
language plpgsql security definer
set search_path = ''
as $$
declare
  v_label text := btrim(coalesce(p_label, ''));
  v_op bigint;
  v_id bigint;
begin
  if not public.can_edit_project(p_project) then
    raise exception 'No tienes permiso para editar este proyecto' using errcode = '42501';
  end if;
  if char_length(v_label) not between 1 and 120 then
    raise exception 'Nombre de versión inválido' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('manual', 'before_restore', 'restore', 'before_import') then
    raise exception 'Tipo de versión inválido' using errcode = '22023';
  end if;

  select greatest(
           coalesce((select max(o.id) from public.project_ops o where o.project_id = p_project), 0),
           p.ops_until)
    into v_op
  from public.projects p
  where p.id = p_project;

  insert into public.project_versions (project_id, op_id, label, kind)
  values (p_project, coalesce(v_op, 0), v_label, p_kind)
  returning id into v_id;
  return v_id;
end;
$$;

-- La borra el propietario, o quien la creó mientras siga pudiendo editar. Si la cuenta del autor
-- ya no existe (created_by es null) solo puede el propietario.
create or replace function public.delete_project_version(p_version bigint)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_version public.project_versions%rowtype;
begin
  select * into v_version from public.project_versions v where v.id = p_version;
  if not found then
    return false;
  end if;
  if public.project_role(v_version.project_id) is distinct from 'owner'
     and not coalesce(v_version.created_by = auth.uid() and public.can_edit_project(v_version.project_id), false) then
    raise exception 'No tienes permiso para borrar esta versión' using errcode = '42501';
  end if;

  delete from public.project_versions v where v.id = p_version;
  return found;
end;
$$;

-- Punto de control más reciente con until_op <= p_op (o el último) y los lotes que lo siguen hasta
-- p_op; la app aplica esos lotes con la lógica CRDT para obtener el estado de esa versión.
create or replace function public.get_project_state_at(p_project uuid, p_op bigint default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_limit bigint := coalesce(p_op, 9223372036854775807);
  v_checkpoint public.project_checkpoints%rowtype;
  v_ops jsonb;
  v_op bigint;
  v_at timestamptz;
begin
  if not public.is_project_member(p_project) then
    raise exception 'No tienes acceso a este proyecto' using errcode = '42501';
  end if;

  select * into v_checkpoint
  from public.project_checkpoints c
  where c.project_id = p_project and c.until_op <= v_limit
  order by c.until_op desc
  limit 1;
  if not found then
    raise exception 'Esa versión ya no está disponible' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(o.ops order by o.id), '[]'::jsonb), max(o.id)
    into v_ops, v_op
  from public.project_ops o
  where o.project_id = p_project and o.id > v_checkpoint.until_op and o.id <= v_limit;

  if v_op is null then
    -- Justo en el punto de control: la fecha es la de su último lote (si sigue existiendo; en
    -- proyectos de instalaciones anteriores pudo borrarse), no la de la compactación.
    v_op := v_checkpoint.until_op;
    v_at := coalesce(
      (select o.created_at from public.project_ops o where o.project_id = p_project and o.id = v_checkpoint.until_op),
      v_checkpoint.created_at);
  else
    select o.created_at into v_at from public.project_ops o where o.id = v_op;
  end if;

  return jsonb_build_object(
    'kind', (select p.kind from public.projects p where p.id = p_project),
    'base_op', v_checkpoint.until_op,
    'doc', v_checkpoint.doc,
    'ops', v_ops,
    'op', v_op,
    'at', v_at
  );
end;
$$;

-- Resumen del historial guardado (tamaño aproximado en bytes tal como lo almacena Postgres).
create or replace function public.project_history_stats(p_project uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_batches bigint;
  v_changes bigint;
  v_ops_bytes bigint;
  v_docs_bytes bigint;
  v_first bigint;
  v_since timestamptz;
begin
  if not public.is_project_member(p_project) then
    raise exception 'No tienes acceso a este proyecto' using errcode = '42501';
  end if;

  select count(*), coalesce(sum(jsonb_array_length(o.ops)), 0), coalesce(sum(pg_column_size(o.ops)), 0)
    into v_batches, v_changes, v_ops_bytes
  from public.project_ops o
  where o.project_id = p_project;

  select coalesce(sum(pg_column_size(c.doc)), 0)
    into v_docs_bytes
  from public.project_checkpoints c
  where c.project_id = p_project;

  select c.until_op, c.created_at
    into v_first, v_since
  from public.project_checkpoints c
  where c.project_id = p_project
  order by c.until_op
  limit 1;

  return jsonb_build_object(
    'batches', v_batches,
    'changes', v_changes,
    'first_op', v_first,
    'since', v_since,
    'bytes', v_ops_bytes + v_docs_bytes
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Papelera (solo el propietario; se vacía sola a los 30 días)
-- ---------------------------------------------------------------------

create or replace function public.trash_project(p_project uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_project public.projects%rowtype;
begin
  select * into v_project from public.projects p where p.id = p_project for update;
  if not found then
    raise exception 'El proyecto no existe' using errcode = 'P0002';
  end if;
  if v_project.owner_id is distinct from v_uid then
    raise exception 'Solo el propietario puede eliminar el proyecto' using errcode = '42501';
  end if;
  if v_project.deleted_at is not null then
    raise exception 'El proyecto ya está en la papelera' using errcode = '22023';
  end if;

  update public.projects p
     set deleted_at = now(), deleted_by = v_uid
   where p.id = p_project;

  -- De paso se vacía lo que ya cumplió su plazo en la papelera.
  delete from public.projects p
   where p.owner_id = v_uid and p.deleted_at < now() - interval '30 days';
end;
$$;

create or replace function public.restore_project(p_project uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_project public.projects%rowtype;
begin
  select * into v_project from public.projects p where p.id = p_project for update;
  if not found then
    raise exception 'El proyecto no existe o ya se eliminó definitivamente' using errcode = 'P0002';
  end if;
  if v_project.owner_id is distinct from auth.uid() then
    raise exception 'Solo el propietario puede restaurar el proyecto' using errcode = '42501';
  end if;
  if v_project.deleted_at is null then
    raise exception 'El proyecto no está en la papelera' using errcode = '22023';
  end if;

  update public.projects p
     set deleted_at = null, deleted_by = null
   where p.id = p_project;
end;
$$;

create or replace function public.list_trash()
returns table (
  id uuid, name text, kind text, deleted_at timestamptz, purge_at timestamptz, member_count integer
)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  delete from public.projects p
   where p.owner_id = v_uid and p.deleted_at < now() - interval '30 days';

  return query
    select p.id, p.name, p.kind, p.deleted_at, p.deleted_at + interval '30 days',
           (select count(*)::integer from public.project_members x where x.project_id = p.id)
    from public.projects p
    where p.owner_id = v_uid and p.deleted_at is not null
    order by p.deleted_at desc;
end;
$$;

-- Borrado definitivo (con todo su historial). Solo desde la papelera.
create or replace function public.purge_project(p_project uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_project public.projects%rowtype;
begin
  select * into v_project from public.projects p where p.id = p_project for update;
  if not found then
    raise exception 'El proyecto no existe o ya se eliminó definitivamente' using errcode = 'P0002';
  end if;
  if v_project.owner_id is distinct from auth.uid() then
    raise exception 'Solo el propietario puede eliminar el proyecto' using errcode = '42501';
  end if;
  if v_project.deleted_at is null then
    raise exception 'Primero mueve el proyecto a la papelera' using errcode = '22023';
  end if;

  delete from public.projects p where p.id = p_project;
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
  public.get_project_members(uuid),
  public.list_project_history(uuid, bigint, integer),
  public.list_project_versions(uuid),
  public.save_project_version(uuid, text, text),
  public.delete_project_version(bigint),
  public.get_project_state_at(uuid, bigint),
  public.project_history_stats(uuid),
  public.trash_project(uuid),
  public.restore_project(uuid),
  public.list_trash(),
  public.purge_project(uuid)
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
  public.get_project_members(uuid),
  public.list_project_history(uuid, bigint, integer),
  public.list_project_versions(uuid),
  public.save_project_version(uuid, text, text),
  public.delete_project_version(bigint),
  public.get_project_state_at(uuid, bigint),
  public.project_history_stats(uuid),
  public.trash_project(uuid),
  public.restore_project(uuid),
  public.list_trash(),
  public.purge_project(uuid)
to authenticated;
