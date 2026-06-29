#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[1/4] PHP syntax lint"
while IFS= read -r file; do
  php -l "$file" >/dev/null
done < <(rg --files api install.php seed.php)

echo "[2/4] JavaScript syntax lint"
while IFS= read -r file; do
  node --check "$file" >/dev/null
done < <(rg --files assets/js)
node --check sw.js >/dev/null

echo "[3/4] Static asset sanity (manifest JSON + CSS brace balance)"
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
node -e "const c=require('fs').readFileSync('assets/css/app.css','utf8');const o=(c.match(/{/g)||[]).length,x=(c.match(/}/g)||[]).length;if(o!==x){throw new Error('app.css unbalanced braces '+o+'/'+x)}"

echo "[4/4] UI surface smoke checks"
rg -q "h\\('h3', null, 'Slack integration'\\)" assets/js/app.js
rg -q "h\\('h3', null, 'Recurring rules'\\)" assets/js/app.js
rg -q "Template override \\(" assets/js/app.js
rg -q "labelsForRecurringProject" assets/js/app.js
# v2 surface
rg -q "renderTimeline" assets/js/app.js
rg -q "openNotifications" assets/js/app.js
rg -q "ThemeToggle" assets/js/app.js
rg -q "renderAdminExtras" assets/js/app.js

echo "beta-smoke: OK"
