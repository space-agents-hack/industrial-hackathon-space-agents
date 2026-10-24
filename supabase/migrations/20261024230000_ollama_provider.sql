-- Ollama as a fifth provider (SYS-30, #21). A hosted provider is one key; an Ollama server is a
-- URL the organisation runs itself plus, if it sits behind a proxy, a way to log in to it. The
-- URL and the user name are not secrets and every member may see them; the token or password
-- goes to Vault like any key, and only the agent reads it back.
--
-- Additive: the code already deployed never writes `ollama` and never reads the new columns, so
-- it keeps working while this is applied ahead of it.

alter table public.provider_connections
  drop constraint provider_connections_provider_check,
  add constraint provider_connections_provider_check
    check (provider in ('anthropic', 'openai', 'openrouter', 'deepseek', 'ollama')),
  -- An Ollama server with no proxy in front has no secret at all.
  alter column secret_id drop not null,
  add column base_url text,
  add column auth_scheme text,
  add column auth_username text,
  -- Hosted providers have a fixed address and their own header; an endpoint has both or neither.
  add constraint provider_connections_endpoint_check check (
    (provider = 'ollama') = (base_url is not null and auth_scheme is not null)
  ),
  add constraint provider_connections_auth_scheme_check
    check (auth_scheme in ('none', 'bearer', 'basic')),
  -- Without a secret only 'none' makes sense; with one, never 'none'.
  add constraint provider_connections_secret_check
    check (auth_scheme is null or (auth_scheme = 'none') = (secret_id is null));

grant select (base_url, auth_scheme, auth_username) on public.provider_connections to authenticated;

-- The URL is checked here as well as in the web, because this is the function a person calls.
-- No user:password@ in it: that would put a secret in a column every member can read.
create function private.valid_endpoint_url(url text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select url ~ '^https?://[^/@\s?#]+(/[^\s?#@]*)?$' and length(url) <= 500;
$$;

-- key_provider is a parameter so a second self-hosted server (vLLM, LM Studio) can reuse this
-- without a new function; today only 'ollama' is accepted. A null secret with an unchanged
-- scheme keeps the stored one, so moving the server to another port does not mean typing the
-- token again.
create function public.set_provider_endpoint(
  org uuid,
  key_provider text,
  endpoint_url text,
  endpoint_auth text,
  endpoint_username text default null,
  endpoint_secret text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.provider_connections;
  new_secret uuid;
  username text := nullif(btrim(coalesce(endpoint_username, '')), '');
  secret text := nullif(endpoint_secret, '');
begin
  if not private.can_manage(org) then
    raise exception 'only an admin of this organisation manages its keys' using errcode = '42501';
  end if;
  if key_provider is distinct from 'ollama' then
    raise exception 'only an Ollama server is configured with a URL' using errcode = '22023';
  end if;
  if not coalesce(private.valid_endpoint_url(endpoint_url), false) then
    raise exception 'the server URL must start with http:// or https:// and carry no user, password or query'
      using errcode = '22023';
  end if;
  if endpoint_auth is null or endpoint_auth not in ('none', 'bearer', 'basic') then
    raise exception 'unknown authentication; use none, bearer or basic' using errcode = '22023';
  end if;
  if endpoint_auth = 'basic' and (username is null or length(username) > 200 or username ~ '[:\s]') then
    raise exception 'basic authentication needs a user name without colons or spaces' using errcode = '22023';
  end if;
  if secret is not null and (length(secret) > 1000 or secret ~ '[\r\n]') then
    raise exception 'that does not look like a token or password' using errcode = '22023';
  end if;

  select * into existing from public.provider_connections
  where organization_id = org and provider = key_provider
  for update;

  if endpoint_auth = 'none' then
    if existing.secret_id is not null then
      delete from vault.secrets where id = existing.secret_id;
    end if;
    new_secret := null;
  elsif secret is not null then
    if existing.secret_id is not null then
      perform vault.update_secret(existing.secret_id, secret);
      new_secret := existing.secret_id;
    else
      new_secret := vault.create_secret(secret, format('provider:%s:%s', org, key_provider));
    end if;
  elsif existing.secret_id is not null and existing.auth_scheme = endpoint_auth then
    new_secret := existing.secret_id;
  else
    raise exception 'enter the token or password for this server' using errcode = '22023';
  end if;

  if existing.organization_id is null then
    insert into public.provider_connections
      (organization_id, provider, last4, source, secret_id, base_url, auth_scheme, auth_username, created_by)
    values (org, key_provider, case when endpoint_auth = 'bearer' then right(secret, 4) else '' end,
            'pasted', new_secret, endpoint_url, endpoint_auth,
            case when endpoint_auth = 'basic' then username end, (select auth.uid()));
  else
    update public.provider_connections
    set last4 = case
          when endpoint_auth <> 'bearer' then ''
          when secret is not null then right(secret, 4)
          else existing.last4
        end,
        secret_id = new_secret,
        base_url = endpoint_url,
        auth_scheme = endpoint_auth,
        auth_username = case when endpoint_auth = 'basic' then username end,
        created_at = now(),
        created_by = (select auth.uid())
    where organization_id = org and provider = key_provider;
  end if;

  -- Never the secret, nor its last characters for a password: a short one would be half given away.
  perform private.audit(org, case when existing.organization_id is null then 'provider.connected' else 'provider.rotated' end,
    jsonb_build_object('provider', key_provider, 'base_url', endpoint_url, 'auth_scheme', endpoint_auth,
                       'last4', case when endpoint_auth = 'bearer' and secret is not null then right(secret, 4) end,
                       'source', 'pasted'));
end;
$$;

-- What the agent needs to call the server: address, scheme, user name and the decrypted secret.
-- Like read_provider_key, only the secret key may call it.
create function public.read_provider_endpoint(org uuid, key_provider text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'base_url', c.base_url,
    'auth_scheme', c.auth_scheme,
    'username', c.auth_username,
    'secret', s.decrypted_secret
  )
  from public.provider_connections c
  left join vault.decrypted_secrets s on s.id = c.secret_id
  where c.organization_id = org and c.provider = key_provider and c.base_url is not null;
$$;

revoke all on function private.valid_endpoint_url(text) from public;
revoke all on function public.set_provider_endpoint(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.set_provider_endpoint(uuid, text, text, text, text, text) to authenticated;
revoke all on function public.read_provider_endpoint(uuid, text) from public, anon, authenticated;
grant execute on function public.read_provider_endpoint(uuid, text) to service_role;
