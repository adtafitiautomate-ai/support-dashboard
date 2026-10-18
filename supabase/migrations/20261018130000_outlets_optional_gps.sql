-- Agents/service centres can be listed before their GPS coordinates are known.
-- Those are found by town/area name instead of distance.
alter table public.outlets alter column lat drop not null;
alter table public.outlets alter column lng drop not null;
alter table public.outlets add constraint outlets_coords_together check ((lat is null) = (lng is null));
