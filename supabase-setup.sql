create table public.otaku_collection (
	id smallint primary key check (id = 1),
	anime_list jsonb not null default '[]'::jsonb,
	updated_at timestamptz not null default now()
);

alter table public.otaku_collection enable row level security;

grant select, update (anime_list) on public.otaku_collection to anon;

create policy "Anyone can read the shared anime list"
	on public.otaku_collection
	for select
	to anon
	using (true);

create policy "Anyone can update the shared anime list"
	on public.otaku_collection
	for update
	to anon
	using (true)
	with check (true);

create function public.set_otaku_collection_updated_at()
	returns trigger
	language plpgsql
	set search_path = ''
as $$
begin
	new.updated_at = now();
	return new;
end;
$$;

create trigger set_otaku_collection_updated_at
	before update on public.otaku_collection
	for each row
	execute function public.set_otaku_collection_updated_at();

insert into public.otaku_collection (id, anime_list)
values (1, '[]'::jsonb);
