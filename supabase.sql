-- Stadt Tracker – Datenbank für Konten, Freunde und geteilte Karten (Supabase / Postgres)
-- Einmal im Supabase-Dashboard unter "SQL Editor" ausführen.
--
-- Sicherheitsprinzip: Die App spricht direkt mit der Datenbank. Was jemand lesen oder ändern darf,
-- entscheidet deshalb ausschließlich die Datenbank selbst (Row Level Security), nie der Browser.

-- ---------- Tabellen ----------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  -- private = niemand sieht meine Karte, friends = bestätigte Freunde, public = alle angemeldeten Nutzer
  visibility text not null default 'private' check (visibility in ('private', 'friends', 'public')),
  created_at timestamptz not null default now()
);

create table public.friendships (
  requester uuid not null references public.profiles (id) on delete cascade,
  addressee uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);
create index friendships_addressee_idx on public.friendships (addressee);

-- Pro Nutzer eine Zeile: die besuchten Straßenstücke (nur deren Mittelpunkte, keine GPS-Spur, keine Zeiten).
create table public.coverage (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  city text not null check (length(city) between 1 and 80),
  points text not null check (length(points) <= 4000000),
  visited_m double precision not null default 0 check (visited_m >= 0),
  total_m double precision not null default 0 check (total_m >= 0),
  streets_done integer not null default 0 check (streets_done >= 0),
  updated_at timestamptz not null default now()
);

create table public.invites (
  code text primary key,
  created_by uuid not null references public.profiles (id) on delete cascade,
  used_by uuid references public.profiles (id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index invites_created_by_idx on public.invites (created_by);

-- ---------- Hilfsfunktionen ----------

-- Wer eine Authenticator-App eingerichtet hat, kommt nur mit bestätigtem zweitem Faktor an Daten.
create function public.mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = (select auth.uid()) and f.status = 'verified'
      );
$$;

create function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester = a and f.addressee = b) or (f.requester = b and f.addressee = a))
  );
$$;

-- Darf der angemeldete Nutzer die Karte von "owner" sehen?
create function public.can_view(owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select owner = (select auth.uid())
      or exists (
        select 1 from public.profiles p
        where p.id = owner
          and (p.visibility = 'public'
               or (p.visibility = 'friends' and public.are_friends(owner, (select auth.uid()))))
      );
$$;

-- Besteht irgendeine Freundschaftszeile (auch eine offene Anfrage) zwischen mir und "other"?
create function public.is_related(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.friendships f
    where (f.requester = (select auth.uid()) and f.addressee = other)
       or (f.addressee = (select auth.uid()) and f.requester = other)
  );
$$;

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger coverage_touch before insert or update on public.coverage
  for each row execute function public.touch_updated_at();

-- ---------- Aktionen (laufen mit geprüften Regeln auf dem Server) ----------

-- Profil anlegen. Der allererste Nutzer braucht keinen Code, alle weiteren einen unbenutzten Einladungscode.
create function public.register(p_username text, p_invite text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  uname text := lower(trim(coalesce(p_username, '')));
  first_user boolean;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not public.mfa_ok() then raise exception 'mfa_required'; end if;
  if uname !~ '^[a-z0-9_]{3,20}$' then raise exception 'invalid_username'; end if;
  perform pg_advisory_xact_lock(7461001);
  if exists (select 1 from public.profiles where id = uid) then raise exception 'already_registered'; end if;
  if exists (select 1 from public.profiles where username = uname) then raise exception 'username_taken'; end if;
  first_user := not exists (select 1 from public.profiles);
  insert into public.profiles (id, username) values (uid, uname);
  if not first_user then
    update public.invites set used_by = uid, used_at = now()
      where code = trim(coalesce(p_invite, '')) and used_at is null;
    if not found then raise exception 'invalid_invite'; end if;
  end if;
end;
$$;

create function public.create_invite() returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  new_code text;
begin
  if uid is null or not exists (select 1 from public.profiles where id = uid) then raise exception 'not_registered'; end if;
  if not public.mfa_ok() then raise exception 'mfa_required'; end if;
  if (select count(*) from public.invites where created_by = uid and used_at is null) >= 5 then
    raise exception 'too_many_invites';
  end if;
  new_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into public.invites (code, created_by) values (new_code, uid);
  return new_code;
end;
$$;

-- Freundschaftsanfrage per exaktem Nutzernamen. Liegt schon eine Anfrage der Gegenseite vor, wird sie angenommen.
create function public.request_friend(p_username text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  target uuid;
begin
  if uid is null or not exists (select 1 from public.profiles where id = uid) then raise exception 'not_registered'; end if;
  if not public.mfa_ok() then raise exception 'mfa_required'; end if;
  select id into target from public.profiles where username = lower(trim(coalesce(p_username, '')));
  if target is null then raise exception 'user_not_found'; end if;
  if target = uid then raise exception 'cannot_add_self'; end if;
  if exists (select 1 from public.friendships where requester = target and addressee = uid) then
    update public.friendships set status = 'accepted' where requester = target and addressee = uid;
    return 'accepted';
  end if;
  if exists (select 1 from public.friendships where requester = uid and addressee = target) then
    return 'exists';
  end if;
  if (select count(*) from public.friendships where requester = uid and status = 'pending') >= 30 then
    raise exception 'too_many_requests';
  end if;
  insert into public.friendships (requester, addressee) values (uid, target);
  return 'pending';
end;
$$;

create function public.accept_friend(p_requester uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not public.mfa_ok() then raise exception 'mfa_required'; end if;
  update public.friendships set status = 'accepted'
    where requester = p_requester and addressee = uid and status = 'pending';
  if not found then raise exception 'request_not_found'; end if;
end;
$$;

-- Löscht das eigene Konto samt Profil, Karte, Freundschaften und Einladungen.
create function public.delete_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not public.mfa_ok() then raise exception 'mfa_required'; end if;
  delete from auth.users where id = uid;
end;
$$;

-- ---------- Rechte: erst alles entziehen, dann gezielt erlauben ----------

revoke all on public.profiles, public.friendships, public.coverage, public.invites from anon, authenticated, public;
revoke execute on function
  public.mfa_ok(), public.are_friends(uuid, uuid), public.can_view(uuid), public.is_related(uuid),
  public.register(text, text), public.create_invite(), public.request_friend(text),
  public.accept_friend(uuid), public.delete_account(), public.touch_updated_at()
  from anon, authenticated, public;

grant select on public.profiles to authenticated;
grant update (visibility) on public.profiles to authenticated;
grant select, delete on public.friendships to authenticated;
grant select, insert, update, delete on public.coverage to authenticated;
grant select on public.invites to authenticated;
grant execute on function
  public.mfa_ok(), public.can_view(uuid), public.is_related(uuid),
  public.register(text, text), public.create_invite(), public.request_friend(text),
  public.accept_friend(uuid), public.delete_account()
  to authenticated;

-- ---------- Row Level Security ----------

alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.coverage enable row level security;
alter table public.invites enable row level security;

-- Profile: das eigene, öffentliche, und die von Personen mit (auch offener) Freundschaftsanfrage.
create policy profiles_select on public.profiles for select to authenticated
  using (public.mfa_ok() and (id = (select auth.uid()) or visibility = 'public' or public.is_related(id)));
create policy profiles_update on public.profiles for update to authenticated
  using (public.mfa_ok() and id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Freundschaften: nur die eigenen sehen und beenden. Anlegen und Annehmen läuft über die Funktionen oben.
create policy friendships_select on public.friendships for select to authenticated
  using (public.mfa_ok() and (requester = (select auth.uid()) or addressee = (select auth.uid())));
create policy friendships_delete on public.friendships for delete to authenticated
  using (public.mfa_ok() and (requester = (select auth.uid()) or addressee = (select auth.uid())));

-- Karten: lesen nur, wenn die Sichtbarkeit des Besitzers es erlaubt; schreiben nur die eigene.
create policy coverage_select on public.coverage for select to authenticated
  using (public.mfa_ok() and public.can_view(user_id));
create policy coverage_insert on public.coverage for insert to authenticated
  with check (public.mfa_ok() and user_id = (select auth.uid()));
create policy coverage_update on public.coverage for update to authenticated
  using (public.mfa_ok() and user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy coverage_delete on public.coverage for delete to authenticated
  using (public.mfa_ok() and user_id = (select auth.uid()));

-- Einladungen: nur die selbst erstellten sehen.
create policy invites_select on public.invites for select to authenticated
  using (public.mfa_ok() and created_by = (select auth.uid()));
