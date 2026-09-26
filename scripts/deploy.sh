#!/usr/bin/env bash
# Runs ON THE VPS, piped in over SSH by .github/workflows/deploy.yml.
# Expects a checkout at $DEPLOY_DIR holding a .env that git never tracks.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/home/debian/wardogs-modlog}"
BRANCH="${DEPLOY_BRANCH:-master}"

cd "$DEPLOY_DIR"

if [ ! -f .env ]; then
  echo "no .env in $DEPLOY_DIR — create it before the first deploy" >&2
  exit 1
fi

# .env is gitignored, so a hard reset cannot clobber it.
git fetch --prune origin
git reset --hard "origin/$BRANCH"
echo "deploying $(git rev-parse --short HEAD)"

docker compose build

# Credentials and panel reachability are checked against the NEW image before the
# running container is replaced. Read-only: it never posts to Discord.
#
# -T and </dev/null both matter: this script is fed to bash over stdin by the
# workflow, and `docker compose run` attaches stdin by default — without them it
# swallows the rest of this file and everything below silently never runs.
echo "running preflight…"
docker compose run --rm --no-deps -T modlog node dist/preflight.js </dev/null

# Deliberately no `docker image prune` anywhere: every command stays scoped to
# this compose project, so nothing can reach the panel's containers or images.
docker compose up -d </dev/null

# A truncated or half-failed run must not look like a success.
docker compose ps --status running --format '{{.Name}}' | grep -q . \
  || { echo "container is not running after up -d" >&2; exit 1; }

echo "deployed $(git rev-parse --short HEAD)"
