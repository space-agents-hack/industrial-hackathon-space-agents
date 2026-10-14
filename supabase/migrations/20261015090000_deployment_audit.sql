-- Changes to the deployment itself, made from Admin > Deployment: new credentials stored in
-- GitHub, a re-run of the Bootstrap workflow, a release started from the app (ADR-0005). They
-- belong to no organisation, so they are written with organization_id null, and only platform
-- admins read them. The values themselves never reach the database: only their names.

create policy "platform admins read deployment changes"
on public.audit_events for select to authenticated
using (organization_id is null and (select private.is_platform_admin()));

create function public.record_deployment_change(change text, detail jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'only a platform admin changes the deployment' using errcode = '42501';
  end if;
  if change not in ('deployment.values_saved', 'deployment.reconfigure_started', 'deployment.release_started') then
    raise exception 'unknown deployment change' using errcode = '22023';
  end if;
  perform private.audit(null, change, detail);
end;
$$;

revoke all on function public.record_deployment_change(text, jsonb) from public, anon;
grant execute on function public.record_deployment_change(text, jsonb) to authenticated;
