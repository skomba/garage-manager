-- Garage Manager – database setup for Supabase
-- Paste this whole file into: Supabase dashboard > SQL Editor > New query > Run
-- Safe to run more than once.

create table if not exists public.vehicles (
  user_id  uuid    not null default auth.uid() references auth.users(id) on delete cascade,
  id       text    not null,                 -- the car's id inside the app
  ts       bigint  not null,                 -- last-changed time (used to detect conflicts)
  h        text,                             -- content fingerprint
  deleted  boolean not null default false,   -- deleted cars are kept as a marker so other devices remove them too
  data     jsonb   not null default '{}'::jsonb,
  primary key (user_id, id)
);

-- Photos and repair images are stored once each, separately, so editing a trip never re-uploads pictures.
create table if not exists public.blobs (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  hash    text not null,
  data    text not null,
  primary key (user_id, hash)
);

-- Privacy: every signed-in person can only ever see and change their own rows.
alter table public.vehicles enable row level security;
alter table public.blobs    enable row level security;

drop policy if exists "own vehicles" on public.vehicles;
create policy "own vehicles" on public.vehicles for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own blobs" on public.blobs;
create policy "own blobs" on public.blobs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on public.vehicles, public.blobs to authenticated;
