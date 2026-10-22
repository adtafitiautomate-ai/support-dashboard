-- vtiger escalation is per tenant (off by default): only tenants that use the shared vtiger get it.
alter table public.mvnos add column vtiger_enabled boolean not null default false;
update public.mvnos set vtiger_enabled = true where name in ('SalamTel', 'PaxTel', 'AgroTel') and kind = 'telecom';
