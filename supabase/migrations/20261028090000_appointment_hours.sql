-- When appointments can be booked (can be narrower than office hours, e.g. consular hours 9:00-15:00)
-- and dates the office is closed (public holidays). Null appointment_hours = the working hours.
alter table public.mvnos add column if not exists appointment_hours jsonb;          -- {"open":"09:00","close":"15:00"}
alter table public.mvnos add column if not exists closed_dates jsonb not null default '[]'; -- [{"date":"2026-12-25","name":"Christmas Day"}]
