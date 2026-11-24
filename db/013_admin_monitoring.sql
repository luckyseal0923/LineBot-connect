-- Add read-only management views in the dedicated LINEBOT schema.
-- Review and test against a separate database before applying to a shared service.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
create view linebot_private.admin_accounts as
 select a.username, a.display_name, a.status, a.created_at,
 (select count(*)::int from linebot_private.bot_credentials b where b.account_id=a.id and b.enabled) as active_bots,
 (select count(*)::int from linebot_private.notifications n where n.account_id=a.id and n.created_at >= now()-interval '30 days') as notifications_30d
 from linebot_private.accounts a;
create view linebot_private.admin_bots as
 select a.username, a.display_name, b.bot_name, b.enabled, b.updated_at,
 (select count(*)::int from linebot_private.notifications n where n.bot_id=b.id and n.created_at >= now()-interval '30 days') as notifications_30d
 from linebot_private.bot_credentials b join linebot_private.accounts a on a.id=b.account_id;
create view linebot_private.admin_notifications as
 select a.username, a.display_name, b.bot_name, r.label as recipient_label,
 n.status, n.line_status, n.created_at, n.completed_at
 from linebot_private.notifications n
 join linebot_private.accounts a on a.id=n.account_id
 join linebot_private.bot_credentials b on b.id=n.bot_id and b.account_id=n.account_id
 join linebot_private.recipients r on r.id=n.recipient_id and r.account_id=n.account_id and r.bot_id=n.bot_id;
create view linebot_private.admin_review_audit as
 select a.username, x.actor, x.old_status, x.new_status, x.reason, x.reviewed_at
 from linebot_private.review_audit x join linebot_private.accounts a on a.id=x.account_id;
revoke all on linebot_private.admin_accounts,linebot_private.admin_bots,linebot_private.admin_notifications,linebot_private.admin_review_audit from public,anon,authenticated,linebot_runtime,linebot_admin_auth;
grant select on linebot_private.admin_accounts,linebot_private.admin_bots,linebot_private.admin_notifications,linebot_private.admin_review_audit to linebot_reviewer;
commit;
