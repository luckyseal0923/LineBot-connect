-- Isolated-test only. The administrator must separately provision a constrained,
-- non-superuser login role named linebot_runtime; never reuse the postgres role.
begin;
do $$ begin
 if current_setting('linebot.isolated_test', true) is distinct from 'yes' then
  raise exception 'Blocked: isolated test only; production review is required';
 end if;
end $$;
grant usage on schema linebot_private to linebot_runtime;
grant select on linebot_private.accounts to linebot_runtime;
grant insert (username,display_name,password_salt,password_hash) on linebot_private.accounts to linebot_runtime;
grant update (failed_attempts,locked_until) on linebot_private.accounts to linebot_runtime;
grant select,insert,delete on linebot_private.sessions to linebot_runtime;
grant select,insert,update on linebot_private.bot_credentials to linebot_runtime;
grant select,insert on linebot_private.webhook_events to linebot_runtime;
grant select,insert,update on linebot_private.request_limits to linebot_runtime;
commit;
