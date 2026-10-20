-- The vtiger HelpDesk ticket a conversation was escalated to (one per conversation).
alter table public.conversations
  add column vtiger_ticket_id text,    -- webservice id, e.g. 17x1807
  add column vtiger_ticket_no text;    -- e.g. TT00412
