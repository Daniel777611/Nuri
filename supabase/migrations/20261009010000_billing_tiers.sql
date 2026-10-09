-- Membership tiers (backend/billing.py, backend/quota.py).
--
-- The tier a subscription buys is read off its Stripe price when the webhook
-- syncs it, and written here so a parent keeps what they bought if a price
-- variable is later pointed at a new price. Null on rows synced before this
-- migration; the backend falls back to mapping the stored price_id, and the
-- next webhook for that subscription fills the column in.
--
-- The daily allowance itself needs no table: it is summed from
-- llm_call_logs, whose (user_id, created_at) index already serves it.

alter table public.billing_subscriptions
  add column if not exists tier text
  check (tier in ('plus', 'unlimited'));

comment on column public.billing_subscriptions.tier is
  'Paid tier this subscription grants (plus / unlimited); null = derive from price_id.';
