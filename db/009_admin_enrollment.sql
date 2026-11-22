begin;
do $$ begin
 if current_setting('linebot.isolated_test',true) is distinct from 'yes' then raise exception 'Blocked: isolated test only'; end if;
end $$;
create function linebot_private.enroll_initial_admin(p_id uuid,p_username text,p_salt text,p_hash text,p_totp jsonb,p_step bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(741232503);
 if exists(select 1 from linebot_private.admin_auth) then raise exception 'administrator already exists'; end if;
 if p_username !~ '^[a-z0-9_]{3,32}$' or p_salt !~ '^[0-9a-f]{32}$' or p_hash !~ '^[0-9a-f]{128}$' or p_step<0 or jsonb_typeof(p_totp)<>'object' then raise exception 'invalid enrollment'; end if;
 insert into linebot_private.admin_auth(id,username,password_salt,password_hash,encrypted_totp,last_totp_step,enabled)
 values(p_id,p_username,p_salt,p_hash,p_totp,p_step,true);
end $$;
revoke all on function linebot_private.enroll_initial_admin(uuid,text,text,text,jsonb,bigint) from public,anon,authenticated,linebot_runtime,linebot_reviewer,linebot_admin_auth;
grant usage on schema linebot_private to linebot_enroller;
grant execute on function linebot_private.enroll_initial_admin(uuid,text,text,text,jsonb,bigint) to linebot_enroller;
commit;
