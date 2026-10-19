-- The goodbye the bot sends when a chat ends (no time-of-day greeting, so it works any time).
alter table public.mvnos add column closing_message text not null default 'Thank you for contacting us. Have a blessed day!'
  check (length(closing_message) between 5 and 300);
update public.mvnos set closing_message = 'Thank you for choosing SalamTel. Have a blessed day!' where slug = 'salamtel';
