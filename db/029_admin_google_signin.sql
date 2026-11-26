begin;
set local lock_timeout='4s';
alter table linebot_private.admin_auth
 add column google_email text unique check (google_email=lower(google_email) and length(google_email) between 3 and 254),
 add column google_subject text unique check (google_subject is null or (google_email is not null and length(google_subject) between 1 and 255));
grant update(google_subject) on linebot_private.admin_auth to linebot_admin_auth;
commit;
