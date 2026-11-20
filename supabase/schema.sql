-- ParkPay live schema.
-- Run this once in the Supabase SQL editor, then turn off
-- Authentication > Providers > Email > Confirm email for the demo.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  name text not null check (char_length(name) between 1 and 40),
  phone text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

grant select, insert, update on public.profiles to authenticated;

create policy "signed-in users can read profiles"
  on public.profiles for select to authenticated
  using (true);

create policy "users can insert their own profile"
  on public.profiles for insert to authenticated
  with check (id = auth.uid());

create policy "users can update their own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  wanted_username text;
  wanted_name text;
begin
  wanted_username := lower(coalesce(
    new.raw_user_meta_data ->> 'username',
    'user_' || substr(new.id::text, 1, 8)
  ));
  wanted_name := coalesce(
    new.raw_user_meta_data ->> 'name',
    split_part(coalesce(new.email, 'User'), '@', 1)
  );
  insert into public.profiles (id, username, name, phone)
  values (
    new.id,
    wanted_username,
    wanted_name,
    nullif(new.raw_user_meta_data ->> 'phone', '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.username_available(want text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select not exists (select 1 from public.profiles where username = lower(want));
$$;

grant execute on function public.username_available(text) to anon, authenticated;

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles (id) on delete cascade,
  buyer_id uuid not null references public.profiles (id) on delete cascade,
  seller_username text not null,
  buyer_username text not null,
  seller_name text not null,
  buyer_name text not null,
  item text not null check (char_length(item) between 1 and 80),
  amount_kobo bigint not null check (amount_kobo > 0),
  sats bigint not null check (sats between 1 and 10000000),
  ngn_per_btc bigint not null check (ngn_per_btc > 0),
  driver_name text not null check (char_length(driver_name) between 1 and 40),
  driver_phone text not null check (char_length(driver_phone) between 7 and 20),
  hours int not null check (hours between 1 and 72),
  state text not null default 'created'
    check (state in ('created', 'pin_set', 'invoice_ready', 'locked', 'code_sent', 'released', 'cancelled', 'expired')),
  hash text check (hash is null or hash ~ '^[0-9a-f]{64}$'),
  invoice text check (invoice is null or char_length(invoice) between 20 and 2100),
  expires_at bigint,
  code text check (code is null or code ~ '^[0-9a-f]{64}$'),
  demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.deals enable row level security;
alter table public.deals replica identity full;

grant select, insert, update on public.deals to authenticated;

create policy "parties can read their deals"
  on public.deals for select to authenticated
  using (seller_id = auth.uid() or buyer_id = auth.uid());

create policy "sellers can create deals"
  on public.deals for insert to authenticated
  with check (seller_id = auth.uid());

create policy "parties can update their deals"
  on public.deals for update to authenticated
  using (seller_id = auth.uid() or buyer_id = auth.uid())
  with check (seller_id = auth.uid() or buyer_id = auth.uid());

create or replace function public.protect_deal()
returns trigger
language plpgsql
as $$
begin
  if new.seller_id <> old.seller_id or new.buyer_id <> old.buyer_id then
    raise exception 'deal parties cannot change';
  end if;
  if new.item <> old.item
     or new.amount_kobo <> old.amount_kobo
     or new.sats <> old.sats
     or new.ngn_per_btc <> old.ngn_per_btc
     or new.driver_name <> old.driver_name
     or new.driver_phone <> old.driver_phone
     or new.hours <> old.hours
     or new.demo <> old.demo
     or new.seller_username <> old.seller_username
     or new.buyer_username <> old.buyer_username
     or new.seller_name <> old.seller_name
     or new.buyer_name <> old.buyer_name then
    raise exception 'deal terms cannot change';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger protect_deal_before_update
  before update on public.deals
  for each row execute function public.protect_deal();

-- The buyer's code is encrypted with the buyer's PIN before it is stored here.
-- Only the buyer can read this table, so the seller never sees the vault.
create table public.deal_secrets (
  deal_id uuid primary key references public.deals (id) on delete cascade,
  buyer_id uuid not null references public.profiles (id) on delete cascade,
  vault jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.deal_secrets enable row level security;

grant select, insert, update, delete on public.deal_secrets to authenticated;

create policy "buyers manage their own secrets"
  on public.deal_secrets for all to authenticated
  using (buyer_id = auth.uid())
  with check (buyer_id = auth.uid());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'deals'
  ) then
    alter publication supabase_realtime add table public.deals;
  end if;
end $$;
