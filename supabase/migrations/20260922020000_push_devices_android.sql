-- Migration: push_devices_android.sql
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- Lets push_devices hold Android installs next to iOS ones. An Android row
-- keeps its FCM registration token in `apns_token` and always has
-- apns_environment = 'production' (FCM has no sandbox), so the unique keys,
-- the active-token index and the dispatcher's query all work unchanged.

alter table public.push_devices
  drop constraint if exists push_devices_platform_check;

alter table public.push_devices
  add constraint push_devices_platform_check
  check (platform in ('ios', 'android'));

comment on column public.push_devices.apns_token is
  'Device push token: APNs hex token on iOS, FCM registration token on Android.';
