create table if not exists public.user_anime_lists (
	owner_id uuid primary key references auth.users (id) on delete cascade,
	display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
	anime_list jsonb not null default '[]'::jsonb check (jsonb_typeof(anime_list) = 'array'),
	updated_at timestamptz not null default now()
);

alter table public.user_anime_lists enable row level security;

revoke all on public.user_anime_lists from public, anon, authenticated;
grant select on public.user_anime_lists to anon, authenticated;
grant update (anime_list) on public.user_anime_lists to authenticated;

drop policy if exists "Anyone can read registered anime lists" on public.user_anime_lists;
create policy "Anyone can read registered anime lists"
	on public.user_anime_lists
	for select
	to anon, authenticated
	using (true);

drop policy if exists "Users can update their own anime list" on public.user_anime_lists;
create policy "Users can update their own anime list"
	on public.user_anime_lists
	for update
	to authenticated
	using ((select auth.uid()) = owner_id)
	with check ((select auth.uid()) = owner_id);

create or replace function public.set_user_anime_list_updated_at()
	returns trigger
	language plpgsql
	set search_path = ''
as $$
begin
	new.updated_at = now();
	return new;
end;
$$;

drop trigger if exists set_user_anime_list_updated_at on public.user_anime_lists;
create trigger set_user_anime_list_updated_at
	before update on public.user_anime_lists
	for each row
	execute function public.set_user_anime_list_updated_at();

drop policy if exists "Anyone can read the shared anime list" on public.otaku_collection;
drop policy if exists "Anyone can update the shared anime list" on public.otaku_collection;
revoke all on public.otaku_collection from public, anon, authenticated;

-- After creating a user manually in Authentication > Users, find its UUID there.
-- For the first account, transfer the existing shared collection with:
-- insert into public.user_anime_lists (owner_id, display_name, anime_list)
-- select 'PASTE_USER_UUID_HERE'::uuid, 'PSEUDO', anime_list
-- from public.otaku_collection where id = 1;
--
-- For each additional account, insert a new empty list:
-- insert into public.user_anime_lists (owner_id, display_name)
-- values ('PASTE_USER_UUID_HERE'::uuid, 'PSEUDO');
