#!/usr/bin/env bash
# Regenerates k8s/base/data/db-migrations-configmap.yaml from db/migrations/*.sql.
#
# Why this exists instead of a kustomize configMapGenerator: kustomize
# refuses (for security reasons) to let a generator read files from outside
# the kustomization root, and db/migrations/ lives outside k8s/base/. So the
# ConfigMap is a plain, generated resource instead — same idea as the
# existing bakery-db-init ConfigMap in k8s/base/data/postgres.yaml, except
# this one is produced by script, not by hand, so it can't drift silently.
#
# Run this after adding, renaming, or editing any file under db/migrations/,
# then commit the resulting YAML. CI (see .github/workflows) should re-run
# this and fail the build on a diff.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="${ROOT_DIR}/db/migrations"
OUT_FILE="${ROOT_DIR}/k8s/base/data/db-migrations-configmap.yaml"

{
  echo "# GENERATED FILE — do not hand-edit."
  echo "# Source of truth: db/migrations/*.sql"
  echo "# Regenerate with: scripts/sync-db-migrations-configmap.sh"
  echo "apiVersion: v1"
  echo "kind: ConfigMap"
  echo "metadata:"
  echo "  name: bakery-db-migrations"
  echo "  namespace: bakery"
  echo "  labels:"
  echo "    app.kubernetes.io/part-of: crumb-and-ember"
  echo "data:"
  for f in $(ls "${MIGRATIONS_DIR}"/*.sql | sort); do
    name="$(basename "$f")"
    echo "  ${name}: |"
    sed 's/^/    /' "$f"
  done
} > "${OUT_FILE}"

echo "wrote ${OUT_FILE}"
