#!/bin/sh
# Backs up the running stack of server/compose.yaml (README.md, "Backups"):
#
#   db-<time>.dump          the database, as pg_dump writes it in its custom format (pg_restore reads it)
#   env-<time>              server/.env with its secrets
#   caddy_data-<time>.tgz   the volume caddy_data: the certificates, the key of the ACME account and the local CA
#
# The dump uses the user and the database of server/.env, as the container db has them. Each run then deletes the files
# of these three kinds that are older than KEEP_DAYS days (default 14). The files hold secrets, password hashes and
# e-mail addresses: the folder gets the rights of its owner only. Copy it off the host after each run.
#
# Usage, from any folder:  server/backup.sh <folder>
#   COMPOSE_PROJECT_NAME picks a stack with a project name of its own, as docker compose -p does.
#   Cron, every night at 03:15, in the crontab of the user who runs Docker. The folder and the log belong to that user:
#   15 3 * * * /srv/skill-map/server/backup.sh "$HOME/backups/skill-map" >> "$HOME/skill-map-backup.log" 2>&1
#
# A run that cannot write its folder, or that fails in any step, ends with exit code 1 and a line "backup.sh: FAILED"
# on stderr. It also sends that line to the system log (logger), so that a failure shows even without the log file.
set -eu
target=${1:?Usage: server/backup.sh <folder>}
here=$(cd "$(dirname "$0")" && pwd)
keep=${KEEP_DAYS:-14}
stamp=$(date +%Y-%m-%d-%H%M%S)
umask 077

cleanup() { rm -f "$target/db-$stamp.dump.part" "$target/caddy_data-$stamp.tgz.part" 2>/dev/null || true; }
fail() {
  trap - EXIT
  cleanup
  echo "backup.sh: FAILED: $*" >&2
  if command -v logger >/dev/null 2>&1; then logger -t skill-map-backup "FAILED: $*" || true; fi
  exit 1
}
# Any step that fails ends the script (set -e). Then this trap removes the part files and names the failure.
trap 'status=$?; [ "$status" -eq 0 ] || fail "a step ended with exit code $status, so there is no complete backup $stamp in $target"' EXIT

mkdir -p "$target" 2>/dev/null || fail "cannot create the folder $target. Use a folder that the user $(id -un) can write."
probe="$target/.backup-write-test-$$"
if ! ( : > "$probe" ) 2>/dev/null; then
  fail "cannot write to the folder $target. Use a folder that the user $(id -un) can write."
fi
rm -f "$probe"
compose() { docker compose -f "$here/compose.yaml" "$@"; }

# A file appears under its final name only when it is complete.
compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$target/db-$stamp.dump.part"
[ -s "$target/db-$stamp.dump.part" ] || fail "the dump of the database is empty"
mv "$target/db-$stamp.dump.part" "$target/db-$stamp.dump"
cp "$here/.env" "$target/env-$stamp"
compose exec -T proxy tar czf - -C /data . > "$target/caddy_data-$stamp.tgz.part"
[ -s "$target/caddy_data-$stamp.tgz.part" ] || fail "the archive of caddy_data is empty"
mv "$target/caddy_data-$stamp.tgz.part" "$target/caddy_data-$stamp.tgz"

find "$target" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'env-*' -o -name 'caddy_data-*.tgz' \) -mtime +"$keep" -exec rm -f {} +
echo "backup $stamp in $target: db-$stamp.dump, env-$stamp, caddy_data-$stamp.tgz"
