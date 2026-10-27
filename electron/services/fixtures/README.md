# Services fixtures

| file | origin |
|---|---|
| `docker-ps.jsonl` | copy of `../../guard/fixtures/docker-ps.jsonl` (real capture, 2026-10-11) |
| `docker-compose-ls.json` | copy of `../../guard/fixtures/docker-compose-ls.json` (real capture, 2026-10-11) |
| `services-inspect.tsv` | **hand-written** (Docker was stopped when this was built, 2026-10-26) in the shape of `docker inspect -f SERVICES_INSPECT_FORMAT <names>`: a compose project with two config files and `0.0.0.0` / `127.0.0.1` / `::` / empty-host bindings (influence), a supabase project with no config files (shelly-monitor), a standalone container (redis), stopped containers with bindings (pe-db, case-challenge-postgres) and one with `null` bindings (case-challenge-redis). Containers absent here fall back to the `docker ps` labels and get no ports. |
