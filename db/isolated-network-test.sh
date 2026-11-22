#!/bin/sh
# Disposable test; networks contain only synthetic services, no host ports.
set -eu
prefix="linebot-nettest-$(date +%s)-$$"
na="$prefix-a"; nb="$prefix-b"; db="$prefix-db"; relay="$prefix-relay"
a_created=0; b_created=0; db_created=0; relay_created=0
cleanup() {
 if [ "$relay_created" = 1 ]; then docker stop "$relay" >/dev/null 2>&1 || true; fi
 if [ "$db_created" = 1 ]; then docker stop "$db" >/dev/null 2>&1 || true; fi
 if [ "$b_created" = 1 ]; then docker network rm "$nb" >/dev/null 2>&1 || true; fi
 if [ "$a_created" = 1 ]; then docker network rm "$na" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
image=$(docker inspect --format '{{.Config.Image}}' ywwcd83znpekygfxyqykt8ts-20261122T150536)
docker network create --internal "$na" >/dev/null; a_created=1
docker network create --internal "$nb" >/dev/null; b_created=1
docker run -d --rm --name "$db" --network "$na" --network-alias supabase-db-isolated --memory 128m --cpus 0.12 --tmpfs /var/lib/postgresql/data:rw,size=64m -e POSTGRES_HOST_AUTH_METHOD=trust postgres:15-alpine postgres -c shared_buffers=16MB -c max_connections=10 >/dev/null; db_created=1
ready=0
for i in $(seq 1 120); do
 if docker exec "$db" psql -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; then sleep 8; if docker exec "$db" psql -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; then ready=1; break; fi; fi
 sleep 1
done
[ "$ready" = 1 ] || { echo NETTEST_DATABASE_START_FAILED; exit 1; }
relay_script=$(printf '%s' 'H4sIAJwNA2sC/4VU70/bMBD93r/CSJOSiCZlg0msWZhgdKMSFNb2yzRtyE0uqUVqR7bTriv933eOE/oD2PopPr/37vnuemxWCKkJB01SKWbE4SKBLh6dsNXpkC9CLqhMiOD5ktwJpTMJo2/XREuapiwmWuAVkFjwlGWlhIQkoDTjVDPBAzIsOWGcUCMl8UKyWCMG4ZoyDpJQrWk8xRAKUVJINqcaCC2KnMWVhnG2EPKBUI6gKRilUVnQCVVAFJIfGkSIH3OULMpJztQU5abol5jnBa205HElF0vADHfZEHK6dFeaygz0FQLb9vMO4dH7k+N37Rn9/VlwDhVPRSdtluQwZjMQpb5R0fER/tqxRUToIbDSG87aW7UIS129LECkZJPqIIocUwueOY+PB51fqn6Pn0z8H9T/c+R/+Hn4phNorJi7oXkIHpSzCciAqT7XkIF0N67xenPAFOYRLzF234Ws3cDHt/uRs1NPT6VYkJ6UQrpOn89pzhJsKJbwqfVVtxwvbJEcZ4kidQ7RER4l6FJWfawrNAKJfXLjnAHX0RkWyVTJMs6iPXsrCwvMWEmxdL3Q6oVrpFnO4WFoUsY5UA5JlNJcQRUpC+QAnaEJYxOHIWUcRyNyPUyLOWuKV0s2ClqWEFpt3w+fGWhkP23F1lUOi1Sg6zFxd0ambbN7jaLgrgOmpM5LN3EuFGxuUL7JG9VD567MgHe3RtjMenczBOsd2v99PSFfcLZz99xbbbxgBbgNdItUxS3GwI2xdavF7O5ZkVyIh7Ig6+0VlHDVKfDIFCjcRS3bwNV1f9C7uB3fD3vX59/vL/qDy/vB+U2v3cQvL+6vbkfjdYTcGJQKgM/DFvb6FaL5L+a4iiZC+0XmVzPt13vI+dfcTxhPzLhbX+YU0QVlun7Ma/naq5TOWL7snqyfyKr6Q0Svrqbu3uP2VlP31EhZkQBXnwbuVhvMmApokuDmVW0z8yadyCHIReY6l1TbLWrfg8mTpeOhUlM5wWNwnVH/67g3vHEqgTpJ1X/XYP8C12hqgT8GAAA=' | base64 -d | gzip -d)
docker run -d --rm --name "$relay" --network "$nb" --network-alias linebot-pg-relay-private --memory 64m --cpus 0.06 -e LINEBOT_RELAY_BIND_NAME=linebot-pg-relay-private -e LINEBOT_DB_HOST=supabase-db-isolated --entrypoint node "$image" --input-type=module -e "$relay_script" >/dev/null; relay_created=1
docker network connect "$na" "$relay"
sleep 3
result=$(docker run --rm --network "$nb" --memory 64m --cpus 0.07 -e PGCONNECT_TIMEOUT=5 --entrypoint psql postgres:15-alpine -h linebot-pg-relay-private -U postgres -d postgres -Atc 'select 42')
[ "$result" = 42 ] || { echo NETTEST_QUERY_FAILED; exit 1; }
# The private listener must not accept connections from the database network.
if docker run --rm --network "$na" --memory 64m --cpus 0.07 -e PGCONNECT_TIMEOUT=5 --entrypoint psql postgres:15-alpine -h "$relay" -U postgres -d postgres -Atc 'select 42' >/dev/null 2>&1; then echo NETTEST_UNEXPECTED_LISTENER; exit 1; fi
echo LINEBOT_PRIVATE_NETWORK_TEST_PASSED
