-- "To rank": films a user has watched and listed, but not ranked yet. Private to each user.
create table if not exists public.backlog (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  film_id int not null check (film_id >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, film_id)
);

alter table public.backlog enable row level security;

drop policy if exists "see own to-rank list" on public.backlog;
drop policy if exists "add to own to-rank list" on public.backlog;
drop policy if exists "remove from own to-rank list" on public.backlog;
create policy "see own to-rank list" on public.backlog for select to authenticated using (user_id = auth.uid());
create policy "add to own to-rank list" on public.backlog for insert to authenticated with check (user_id = auth.uid());
create policy "remove from own to-rank list" on public.backlog for delete to authenticated using (user_id = auth.uid());
revoke update on public.backlog from anon, authenticated;
