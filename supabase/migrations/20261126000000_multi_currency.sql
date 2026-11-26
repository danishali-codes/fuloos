-- Multi-currency support for Fuloos.
-- Safe, idempotent migration. Apply to Supabase Postgres via `supabase db push` or SQL Editor.
-- Does not alter existing AED-only totals or balances.

begin;

-- ============================================================================
-- 1. fuloos_accounts: enforce 3-letter uppercase ISO 4217 currency (default AED)
-- ============================================================================

alter table public.fuloos_accounts
  add column if not exists currency text;

update public.fuloos_accounts
set currency = coalesce(nullif(upper(trim(currency)), ''), 'AED')
where currency is null
   or trim(currency) = ''
   or currency <> upper(trim(currency));

alter table public.fuloos_accounts
  alter column currency set default 'AED',
  alter column currency set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fuloos_accounts_currency_iso_chk'
      and conrelid = 'public.fuloos_accounts'::regclass
  ) then
    alter table public.fuloos_accounts
      add constraint fuloos_accounts_currency_iso_chk
      check (currency ~ '^[A-Z]{3}$');
  end if;
end $$;

-- ============================================================================
-- 2. fuloos_transactions: multi-currency & FX provenance columns + backfill
-- ============================================================================

alter table public.fuloos_transactions
  add column if not exists original_amount bigint,
  add column if not exists original_currency text,
  add column if not exists fx_rate numeric(20, 10),
  add column if not exists fx_rate_date date,
  add column if not exists fx_source text,
  add column if not exists fx_status text default 'exact',
  add column if not exists to_amount bigint;

-- Backfill existing foreign-currency transactions (manual_rate + exact)
update public.fuloos_transactions t
set
  original_currency = upper(trim(t.original_currency)),
  original_amount = coalesce(t.original_amount, t.amount),
  fx_rate = coalesce(nullif(t.fx_rate, 0), 1),
  fx_rate_date = coalesce(t.fx_rate_date, t.date),
  fx_source = coalesce(t.fx_source, 'manual_rate'),
  fx_status = coalesce(t.fx_status, 'exact')
from public.fuloos_accounts a
where a.id = t.account_id
  and t.original_currency is not null
  and trim(t.original_currency) <> ''
  and upper(trim(t.original_currency)) <> coalesce(nullif(upper(trim(a.currency)), ''), 'AED');

-- Backfill existing same-currency transactions (same_currency + exact)
update public.fuloos_transactions t
set
  original_currency = coalesce(nullif(upper(trim(a.currency)), ''), 'AED'),
  original_amount = t.amount,
  fx_rate = 1,
  fx_rate_date = coalesce(t.fx_rate_date, t.date),
  fx_source = coalesce(t.fx_source, 'same_currency'),
  fx_status = coalesce(t.fx_status, 'exact')
from public.fuloos_accounts a
where a.id = t.account_id
  and (
    t.original_currency is null
    or trim(t.original_currency) = ''
    or upper(trim(t.original_currency)) = coalesce(nullif(upper(trim(a.currency)), ''), 'AED')
  );

-- Catch any orphaned rows without a matching account row
update public.fuloos_transactions
set
  original_currency = coalesce(nullif(upper(trim(original_currency)), ''), 'AED'),
  original_amount = coalesce(original_amount, amount),
  fx_rate = coalesce(fx_rate, 1),
  fx_rate_date = coalesce(fx_rate_date, date),
  fx_source = coalesce(fx_source, 'same_currency'),
  fx_status = coalesce(fx_status, 'exact')
where original_currency is null
   or fx_source is null
   or fx_status is null;

alter table public.fuloos_transactions
  alter column fx_status set default 'exact',
  alter column fx_status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fuloos_transactions_original_currency_chk'
      and conrelid = 'public.fuloos_transactions'::regclass
  ) then
    alter table public.fuloos_transactions
      add constraint fuloos_transactions_original_currency_chk
      check (original_currency is null or original_currency ~ '^[A-Z]{3}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'fuloos_transactions_original_amount_chk'
      and conrelid = 'public.fuloos_transactions'::regclass
  ) then
    alter table public.fuloos_transactions
      add constraint fuloos_transactions_original_amount_chk
      check (original_amount is null or original_amount >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'fuloos_transactions_fx_rate_chk'
      and conrelid = 'public.fuloos_transactions'::regclass
  ) then
    alter table public.fuloos_transactions
      add constraint fuloos_transactions_fx_rate_chk
      check (fx_rate is null or fx_rate > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'fuloos_transactions_fx_source_chk'
      and conrelid = 'public.fuloos_transactions'::regclass
  ) then
    alter table public.fuloos_transactions
      add constraint fuloos_transactions_fx_source_chk
      check (
        fx_source is null or fx_source in (
          'same_currency',
          'bank_sms',
          'api_estimate',
          'user_confirmed',
          'statement_match',
          'manual_rate'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'fuloos_transactions_fx_status_chk'
      and conrelid = 'public.fuloos_transactions'::regclass
  ) then
    alter table public.fuloos_transactions
      add constraint fuloos_transactions_fx_status_chk
      check (fx_status in ('exact', 'estimated'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'fuloos_transactions_to_amount_chk'
      and conrelid = 'public.fuloos_transactions'::regclass
  ) then
    alter table public.fuloos_transactions
      add constraint fuloos_transactions_to_amount_chk
      check (to_amount is null or to_amount >= 0);
  end if;
end $$;

create index if not exists idx_fuloos_transactions_user_fx_estimated
  on public.fuloos_transactions (user_id, date desc)
  where fx_status = 'estimated';

-- ============================================================================
-- 3. fuloos_recurring: optional schedule currency (defaults to account currency)
-- ============================================================================

alter table public.fuloos_recurring
  add column if not exists currency text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fuloos_recurring_currency_iso_chk'
      and conrelid = 'public.fuloos_recurring'::regclass
  ) then
    alter table public.fuloos_recurring
      add constraint fuloos_recurring_currency_iso_chk
      check (currency is null or currency ~ '^[A-Z]{3}$');
  end if;
end $$;

-- ============================================================================
-- 4. fuloos_captured_alerts: preserve foreign-currency fields on SMS drafts
-- ============================================================================

alter table public.fuloos_captured_alerts
  add column if not exists parsed_currency text,
  add column if not exists parsed_original_amount bigint,
  add column if not exists parsed_fx_rate numeric(20, 10),
  add column if not exists parsed_fx_rate_date date,
  add column if not exists parsed_fx_source text,
  add column if not exists parsed_fx_status text,
  add column if not exists warnings jsonb;

-- ============================================================================
-- 5. fuloos_user_settings: reporting currency & foreign confirmation preferences
-- ============================================================================

create table if not exists public.fuloos_user_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  reporting_currency text not null default 'AED'
    check (reporting_currency ~ '^[A-Z]{3}$'),
  confirm_foreign_mode text not null default 'always'
    check (confirm_foreign_mode in ('always', 'above_threshold', 'never')),
  confirm_foreign_threshold bigint not null default 5000
    check (confirm_foreign_threshold >= 0),
  created timestamptz not null default now(),
  updated timestamptz not null default now()
);

alter table public.fuloos_user_settings enable row level security;

drop policy if exists "user_settings_select_own" on public.fuloos_user_settings;
create policy "user_settings_select_own"
  on public.fuloos_user_settings
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "user_settings_insert_own" on public.fuloos_user_settings;
create policy "user_settings_insert_own"
  on public.fuloos_user_settings
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "user_settings_update_own" on public.fuloos_user_settings;
create policy "user_settings_update_own"
  on public.fuloos_user_settings
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "user_settings_delete_own" on public.fuloos_user_settings;
create policy "user_settings_delete_own"
  on public.fuloos_user_settings
  for delete
  to authenticated
  using (user_id = auth.uid());

-- ============================================================================
-- 6. fuloos_fx_rates: shared public exchange-rate cache
--    Readable by authenticated users; writable ONLY by Edge Function service_role.
-- ============================================================================

create table if not exists public.fuloos_fx_rates (
  base text not null check (base ~ '^[A-Z]{3}$'),
  quote text not null check (quote ~ '^[A-Z]{3}$'),
  rate_date date not null,
  rate numeric(20, 10) not null check (rate > 0),
  provider text not null,
  fetched_at timestamptz not null default now(),
  primary key (base, quote, rate_date)
);

alter table public.fuloos_fx_rates enable row level security;

drop policy if exists "fx_rates_select_authenticated" on public.fuloos_fx_rates;
create policy "fx_rates_select_authenticated"
  on public.fuloos_fx_rates
  for select
  to authenticated
  using (true);

-- Intentionally NO insert/update/delete policies for anon or authenticated roles.
-- Only the `fx-rate` Edge Function using `service_role` may write cached rates.

create index if not exists idx_fuloos_fx_rates_pair_latest
  on public.fuloos_fx_rates (base, quote, rate_date desc);

commit;
