-- SIM/eSIM home delivery is offered per tenant (off by default: most tenants issue SIMs in person).
alter table public.mvnos add column sim_delivery boolean not null default false;
