# Guard fixtures

Captured read-only from the live machine on 2026-10-11 (Docker 27.4.0, macOS 26):

| file | command |
|---|---|
| `vm_stat.txt` | `vm_stat` |
| `pressure.txt` | `sysctl -n kern.memorystatus_vm_pressure_level` |
| `swapusage.txt` | `sysctl -n vm.swapusage` |
| `docker-ps.jsonl` | `docker ps -a --format '{{json .}}'` |
| `docker-inspect.tsv` | `docker inspect -f '<the 5-field format in docker-inventory.ts>' <all names>` |
| `docker-stats.tsv` | `docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}'` |
| `docker-compose-ls.json` | `docker compose ls --all --format json` |
| `netstat-established.txt` | `netstat -anp tcp \| grep ESTABLISHED \| head -50` |

The machine had just been restarted when these were taken, so the real `vm_stat`
shows an empty compressor and no swap. Two files are therefore NOT captures:

- `vm_stat-compressed-synthetic.txt` — `vm_stat.txt` with the two compressor lines
  edited to 56.8 GB occupied (the 09:41 reading from memguard-system.log).
- `swapusage-synthetic.txt` — the real line's format with 18.5 GB used.
