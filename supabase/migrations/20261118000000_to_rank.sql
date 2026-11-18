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

-- Accounts created with Google: use the Google name for the display name and the email for the username.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base text := lower(regexp_replace(coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)), '[^a-zA-Z0-9_.]', '', 'g'));
  candidate text;
begin
  base := left(base, 16);
  if char_length(base) < 3 then base := 'movi' || base; end if;
  candidate := base;
  while exists (select 1 from profiles where username = candidate) loop
    candidate := left(base, 16) || floor(random() * 9000 + 1000)::int;
  end loop;
  insert into profiles (id, username, display_name, avatar_hue)
  values (
    new.id,
    candidate,
    left(coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_user_meta_data ->> 'name', ''),
      candidate), 40),
    floor(random() * 360)::int
  );
  return new;
end $$;
