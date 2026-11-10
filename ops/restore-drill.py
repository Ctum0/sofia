#!/usr/bin/env python3
"""Restore drill: read the artefacts a restore would actually consume."""
import gzip, os, sqlite3, subprocess, sys

BASE = "/home/ctum/archive/drill-2026-11-10a/vps-backup-2026-11-10"
DB = os.path.join(BASE, "databases")


def pg_rows(path):
    rows, cur = {}, None
    with gzip.open(path, "rt", errors="replace") as f:
        for line in f:
            if line.startswith("COPY "):
                cur = line.split()[1].split(".")[-1].strip('"')
                rows.setdefault(cur, 0)
                continue
            if line.startswith("\\."):
                cur = None
                continue
            if cur:
                rows[cur] += 1
    return rows


print("=== coolify-db.sql.gz ===")
r = pg_rows(os.path.join(DB, "coolify-db.sql.gz"))
print("tables:", len(r), "| non-empty:", sum(1 for v in r.values() if v))
for k in ("applications", "application_deployment_queues", "servers", "projects",
          "environment_variables", "users", "instance_settings", "standalone_dockers"):
    print("  %-32s %s" % (k, r.get(k, "absent")))

for name in ("honcho-db", "litellm-db", "iriswebapp_db"):
    p = os.path.join(DB, name + ".sql.gz")
    rr = pg_rows(p)
    print("=== %s === tables %d | non-empty %d" % (
        name, len(rr), sum(1 for v in rr.values() if v)))

print("=== n8n_database.sqlite.gz ===")
tmp = "/tmp/drill-n8n.sqlite"
with gzip.open(os.path.join(DB, "n8n_database.sqlite.gz"), "rb") as s, open(tmp, "wb") as d:
    d.write(s.read())
con = sqlite3.connect("file:%s?mode=ro" % tmp, uri=True)
tabs = [x[0] for x in con.execute(
    "select name from sqlite_master where type='table' order by name")]
print("tables:", len(tabs), "| db size: %.1f MB" % (os.path.getsize(tmp) / 1e6))
for t in ("workflow_entity", "execution_entity", "credentials_entity", "user", "project"):
    if t in tabs:
        n = con.execute('select count(*) from "%s"' % t).fetchone()[0]
        print("  %-20s %d" % (t, n))
con.close()

print("=== caddy/Caddyfile ===")
cf = open(os.path.join(BASE, "caddy", "Caddyfile")).read()
print("bytes:", len(cf), "| blocks:", cf.count("{"))
for host in ("sofia.ctum.org", "hermes.ctum.org", "coolify.ctum.org", "n8n", "wazuh"):
    print("  %-20s %s" % (host, "present" if host in cf else "MISSING"))
