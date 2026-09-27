-- Stripe subscriptions. Stripe stays the source of truth: the webhook re-reads
-- each subscription from Stripe and overwrites the row here, so these tables
-- are a cache the app can check without a network call on every request.
-- App clients never access them directly; the service-role backend owns both.

create table if not exists public.billing_customers (
  user_id text primary key references public.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.billing_subscriptions (
  -- Stripe's subscription id (sub_...). One account can accumulate several
  -- over time (cancel, resubscribe); the newest live one decides access.
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  stripe_customer_id text not null,
  status text not null,
  price_id text,
  plan_interval text check (plan_interval in ('month', 'year')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billing_subscriptions_user_idx
  on public.billing_subscriptions (user_id, updated_at desc);
create index if not exists billing_subscriptions_customer_idx
  on public.billing_subscriptions (stripe_customer_id);

alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;

revoke all on table public.billing_customers from anon, authenticated;
revoke all on table public.billing_subscriptions from anon, authenticated;
grant select, insert, update, delete on table public.billing_customers to service_role;
grant select, insert, update, delete on table public.billing_subscriptions to service_role;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'billing_customers'
      and policyname = 'srole_billing_customers'
  ) then
    execute $p$
      create policy srole_billing_customers on public.billing_customers
        for all to service_role using (true) with check (true)
    $p$;
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'billing_subscriptions'
      and policyname = 'srole_billing_subscriptions'
  ) then
    execute $p$
      create policy srole_billing_subscriptions on public.billing_subscriptions
        for all to service_role using (true) with check (true)
    $p$;
  end if;
end $$;

comment on table public.billing_customers is
  'Account -> Stripe customer. Created lazily on the first checkout.';
comment on table public.billing_subscriptions is
  'Webhook-maintained copy of each Stripe subscription; Stripe is authoritative.';
