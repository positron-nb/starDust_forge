#!/usr/bin/env bash
# Pre-run checks before spending hosted-model quota on Task B.
#   bench/preflight.sh <provider/model> <compactAt>
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; MODEL=$1; COMPACT=${2:-100000}; ok=1
echo "== Flask"
git -C "$ROOT/flask" status --short | grep -q . && { echo "NOT clean"; ok=0; } || echo "clean"
HEAD=$(git -C "$ROOT/flask" rev-parse --short=8 HEAD); echo "HEAD $HEAD (expect 22d92470)"; [ "$HEAD" = 22d92470 ] || ok=0
(cd "$ROOT/flask" && .venv/Scripts/python -m pytest tests/test_cli.py -q -p no:cacheprovider 2>&1 | tail -1)
echo "== TrueForge"
curl -s -o /dev/null -w "api %{http_code}\n" http://localhost:8790/api/v1/settings/model-providers
PROV=${MODEL%%/*}; NAME=${MODEL#*/}
curl -s http://localhost:8790/api/v1/settings/model-providers | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d).data.find(p=>p.name==='$PROV');const m=p?.manifest.models.find(m=>m.name==='$NAME');console.log(m?'model '+m.model_id+' ctx='+m.properties.context_length+' max_out='+m.properties.max_output_tokens:'MODEL NOT CONFIGURED');process.exit(m?0:1)})" || ok=0
echo "== Effective compaction"
node -e "const c=$COMPACT;console.log(c>0?'trigger input_tokens='+c:c<0?'disabled':'TrueForge default')"
echo "== Connectivity (1 request)"
(cd "$ROOT/extension" && node out/ping.js "$MODEL") || ok=0
[ $ok = 1 ] && echo "PREFLIGHT OK" || echo "PREFLIGHT FAILED"
