-- AI suggestions: learning settings and the consented correction log (src/ledger/learningStore.ts).
-- Idempotent: if both tables already exist this only (re)applies RLS, policies and checks.
-- Neither table ever holds raw SMS text: merchant_text is the cleaned, masked merchant string.
-- Without these tables the app still works; learning just stays in the browser session.

begin;

do $$
declare
  cat_id_type text;
begin
  -- category_id must have the same type as fuloos_categories.id (uuid or text, depending on how the base schema was made).
  select format_type(a.atttypid, a.atttypmod)
    into cat_id_type
  from pg_attribute a
  where a.attrelid = 'public.fuloos_categories'::regclass
    and a.attname = 'id'
    and not a.attisdropped;

  if to_regclass('public.fuloos_ml_settings') is null then
    create table public.fuloos_ml_settings (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
      learn_consent boolean not null default false,
      share_consent boolean not null default false,
      consent_version text not null default '' check (char_length(consent_version) <= 32),
      consent_at timestamptz,
      category_map jsonb not null default '{}'::jsonb
        check (jsonb_typeof(category_map) = 'object'),
      created timestamptz not null default now(),
      updated timestamptz not null default now(),
      unique (user_id)
    );
  end if;

  if to_regclass('public.fuloos_ml_examples') is null then
    execute format($sql$
      create table public.fuloos_ml_examples (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
        merchant_text text not null check (char_length(btrim(merchant_text)) between 1 and 160),
        payee text not null default '' check (char_length(payee) <= 160),
        amount bigint not null default 0 check (amount between 0 and 100000000000),
        category_id %s references public.fuloos_categories (id) on delete set null,
        source text not null check (source in ('sms', 'csv', 'manual')),
        model_version text not null default '' check (char_length(model_version) <= 32),
        suggested_category text not null default '' check (char_length(suggested_category) <= 64),
        accepted boolean not null default false,
        created timestamptz not null default now()
      )
    $sql$, cat_id_type);
  end if;
end $$;

create index if not exists fuloos_ml_examples_user_created_idx
  on public.fuloos_ml_examples (user_id, created);
create index if not exists fuloos_ml_examples_category_idx
  on public.fuloos_ml_examples (category_id);

-- A correction may only point at one of the same user's categories.
create or replace function public.fuloos_ml_examples_check_category()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.category_id is not null and not exists (
    select 1 from public.fuloos_categories c
    where c.id = new.category_id and c.user_id = new.user_id
  ) then
    raise exception 'Category must belong to the same user' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists fuloos_ml_examples_category_owner on public.fuloos_ml_examples;
create trigger fuloos_ml_examples_category_owner
  before insert or update on public.fuloos_ml_examples
  for each row execute function public.fuloos_ml_examples_check_category();

-- Owner-only access.
alter table public.fuloos_ml_settings enable row level security;
alter table public.fuloos_ml_examples enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['fuloos_ml_settings', 'fuloos_ml_examples'] loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_delete', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id::text = auth.uid()::text)',
      t || '_owner_select', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (user_id::text = auth.uid()::text)',
      t || '_owner_insert', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (user_id::text = auth.uid()::text) with check (user_id::text = auth.uid()::text)',
      t || '_owner_update', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (user_id::text = auth.uid()::text)',
      t || '_owner_delete', t);
  end loop;
end $$;

grant select, insert, update, delete on public.fuloos_ml_settings to authenticated;
grant select, insert, update, delete on public.fuloos_ml_examples to authenticated;
revoke all on public.fuloos_ml_settings from anon;
revoke all on public.fuloos_ml_examples from anon;

commit;
