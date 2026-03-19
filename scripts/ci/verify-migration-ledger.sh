#!/usr/bin/env bash
set -Eeuo pipefail

BASE_SHA="${BASE_SHA:-}"
HEAD_SHA="${HEAD_SHA:-HEAD}"
MIGRATIONS_DIR="apps/api/src/db/migrations"
JOURNAL_PATH="$MIGRATIONS_DIR/meta/_journal.json"

fail() {
  echo "[ledger][error] $1" >&2
  exit 1
}

echo "[ledger] start verification"
test -d "$MIGRATIONS_DIR" || fail "directory not found: $MIGRATIONS_DIR"
test -f "$JOURNAL_PATH" || fail "journal not found: $JOURNAL_PATH"

python3 - <<'PY'
import json
from pathlib import Path

base = Path('apps/api/src/db/migrations')
meta = base / 'meta'
journal_path = meta / '_journal.json'

with journal_path.open('r', encoding='utf-8') as fh:
    journal = json.load(fh)

entries = journal.get('entries', [])
if not isinstance(entries, list) or not entries:
    raise SystemExit('[ledger][error] _journal.json must contain non-empty entries list')

tags = []
for entry in entries:
    tag = str(entry.get('tag', '')).strip()
    if not tag:
        raise SystemExit('[ledger][error] journal entry without tag detected')
    tags.append(tag)

if len(tags) != len(set(tags)):
    raise SystemExit('[ledger][error] duplicate migration tags detected in journal')

def snapshot_exists(tag: str) -> bool:
    exact = meta / f'{tag}_snapshot.json'
    if exact.exists():
        return True
    prefix = tag.split('_', 1)[0]
    if prefix and (meta / f'{prefix}_snapshot.json').exists():
        return True
    return False

missing_sql = [tag for tag in tags if not (base / f'{tag}.sql').exists()]
missing_snapshots = [tag for tag in tags if not snapshot_exists(tag)]

if missing_sql:
    raise SystemExit('[ledger][error] missing sql for tags: ' + ', '.join(missing_sql))
if missing_snapshots:
    raise SystemExit('[ledger][error] missing snapshots for tags: ' + ', '.join(missing_snapshots))

print('[ledger] local journal/sql/snapshot integrity OK')
PY

if [ -n "$BASE_SHA" ] && [ "$BASE_SHA" != "0000000000000000000000000000000000000000" ]; then
  echo "[ledger] checking append-only history in range $BASE_SHA..$HEAD_SHA"

  deleted_paths="$(git diff --diff-filter=D --name-only "$BASE_SHA" "$HEAD_SHA" -- "$MIGRATIONS_DIR")"
  if [ -n "$deleted_paths" ]; then
    echo "$deleted_paths"
    fail "migration ledger files must not be deleted"
  fi

  modified_sql="$(git diff --name-only "$BASE_SHA" "$HEAD_SHA" -- "$MIGRATIONS_DIR/*.sql")"
  if [ -n "$modified_sql" ]; then
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      status="$(git diff --name-status "$BASE_SHA" "$HEAD_SHA" -- "$path" | awk '{print $1}')"
      case "$status" in
        A)
          ;;
        *)
          fail "existing migration SQL must be immutable: $path"
          ;;
      esac
    done <<< "$modified_sql"
  fi

  python3 - "$BASE_SHA" "$HEAD_SHA" <<'PY'
import json
import subprocess
import sys

base_sha, head_sha = sys.argv[1], sys.argv[2]
path = 'apps/api/src/db/migrations/meta/_journal.json'

def read_json(rev: str):
    try:
        raw = subprocess.check_output(['git', 'show', f'{rev}:{path}'], text=True)
    except subprocess.CalledProcessError:
        return None
    return json.loads(raw)

base = read_json(base_sha)
head = read_json(head_sha)
if head is None:
    raise SystemExit('[ledger][error] head journal is missing')
if base is None:
    print('[ledger] base journal is absent, append-only diff skipped')
    raise SystemExit(0)

base_entries = base.get('entries', [])
head_entries = head.get('entries', [])

if len(head_entries) < len(base_entries):
    raise SystemExit('[ledger][error] journal entries count decreased')

for index, old_entry in enumerate(base_entries):
    try:
        new_entry = head_entries[index]
    except IndexError:
        raise SystemExit(f'[ledger][error] journal entry removed at index {index}')
    if old_entry != new_entry:
        raise SystemExit(f'[ledger][error] existing journal entry changed at index {index}: {old_entry.get("tag")}')

print('[ledger] append-only journal verification OK')
PY
fi

echo "[ledger] verification completed successfully"
