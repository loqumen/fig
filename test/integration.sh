#!/bin/bash
set -uo pipefail
T="${TMPDIR:-/tmp}/fig-itest"
rm -rf "$T"; mkdir -p "$T/home/.local/bin" "$T/home/.fig"
PORT=41599
FIGD="/Users/bradytinnin/Desktop/Claude Codebases/fig/companion/figd.js"

# fake claude: edits edited.html in place (targeted change), writes changes.json.
# Behavior switched by ~/.fig-test-mode contents.
cat > "$T/home/.local/bin/claude" <<'FAKE'
#!/usr/bin/env node
const fs = require("fs"), path = require("path"), os = require("os");
const mode = (() => { try { return fs.readFileSync(path.join(os.homedir(), ".fig-test-mode"), "utf8").trim(); } catch { return "edit"; } })();
setTimeout(() => {
  if (mode === "edit") {
    const p = "edited.html";
    const s = fs.readFileSync(p, "utf8");
    fs.writeFileSync(p, s.replace("OLD-HEADLINE", "NEW-HEADLINE"));
    fs.writeFileSync("changes.json", JSON.stringify([{ marking: "[1]", change: "Headline updated", where: "h1" }]));
    // Emit a stream-json result line like the real CLI: figd captures it as
    // the round's diagnosis (round memory).
    console.log(JSON.stringify({ type: "result", is_error: false, result: "DIAGNOSIS-TEXT: headline root cause was X." }));
    process.exit(0);
  }
  if (mode === "noop") process.exit(0);        // exits clean, changes nothing
  if (mode === "fail") process.exit(1);        // hard failure
}, 400);
FAKE
chmod +x "$T/home/.local/bin/claude"

# settings with a known token; claudeArgs empty (fake ignores them)
cat > "$T/home/.fig/settings.json" <<'J'
{ "token": "testtoken123", "target": "localhost", "vercelDir": "/tmp/fig-itest/edits", "claudeArgs": ["--x"] }
J

HOME="$T/home" FIG_PORT=$PORT node "$FIGD" > "$T/figd.log" 2>&1 &
FIGD_PID=$!
sleep 0.6

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ✓ $1"; }
bad()  { fail=$((fail+1)); echo "  ✗ $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got: $2 | want: $3)"; fi }

post() { # $1 = json file → prints "HTTPCODE BODY"
  curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$PORT/fig" \
    -H "Content-Type: application/json" -H "X-Fig-Token: testtoken123" \
    --data-binary @"$1"
}

SNAP='<!doctype html><html><head><base href="https://x.test/"></head><body><h1>OLD-HEADLINE</h1><p>keep me</p></body></html>'

echo "== T1 happy path: pre-copy + targeted edit + SSE done =="
echo edit > "$T/home/.fig-test-mode"
python3 - "$T/p1.json" <<PY
import json,sys
json.dump({"type":"html","url":"https://x.test/","title":"Test Page","viewport":{"w":800,"h":600},
"capturedAt":"now","html":'''$SNAP''',
"annotations":{"comments":[{"id":1,"n":1,"text":"change headline","x":1,"y":1,"targetPath":"h1","targetText":"OLD-HEADLINE"}],"highlights":[],"strokes":[]}}, open(sys.argv[1],"w"))
PY
R=$(post "$T/p1.json"); CODE=$(echo "$R"|tail -1); BODY=$(echo "$R"|sed '$d')
check "dispatch 200" "$CODE" "200"
SLUG=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['job'])")
[ -n "$SLUG" ] && ok "slug assigned: $SLUG" || bad "no slug"
# state while generating
ST=$(curl -s "http://127.0.0.1:$PORT/jobs/$SLUG/state" | python3 -c "import json,sys;print(json.load(sys.stdin)['phase'])")
check "state=generating immediately" "$ST" "generating"
# edited.html pre-copied
[ -f "$T/home/.fig/jobs/$SLUG/edited.html" ] && ok "edited.html pre-copied at t=0" || bad "no pre-copy"
# status page is the animated one (no meta refresh)
SP=$(curl -s "http://127.0.0.1:$PORT/jobs/$SLUG/")
echo "$SP" | grep -q 'class="ring"' && echo "$SP" | grep -q 'class="branch"' && ok "status page carries the logo-build animation" || bad "animation missing"
echo "$SP" | grep -q "View revised page" && ok "ready-state button present" || bad "view button missing"
echo "$SP" | grep -qi "location.replace\|Refresh:" && bad "auto-redirect still present" || ok "no auto-redirect (button handoff)"
echo "$SP" | grep -q "EventSource" && ok "status page uses SSE" || bad "no SSE"
echo "$SP" | grep -qi "refresh" && bad "meta-refresh still present" || ok "meta-refresh gone"
echo "$SP" | grep -q "Applying 1 marking" && ok "marking count rendered" || bad "marking count missing"
# SSE announces done (fake claude finishes at ~400ms)
SSE=$(curl -s --max-time 3 -N "http://127.0.0.1:$PORT/jobs/$SLUG/events" | head -c 2000)
echo "$SSE" | grep -q '"phase":"done"' && ok "SSE pushed done" || bad "SSE never said done: $SSE"
ST=$(curl -s "http://127.0.0.1:$PORT/jobs/$SLUG/state" | python3 -c "import json,sys;print(json.load(sys.stdin)['phase'])")
check "state=done" "$ST" "done"
# /jobs redirects to /pages
LOC=$(curl -s -o /dev/null -w "%{redirect_url}" "http://127.0.0.1:$PORT/jobs/$SLUG/")
echo "$LOC" | grep -q "/pages/$SLUG/" && ok "/jobs 302 → /pages" || bad "no redirect ($LOC)"
# served page has the edit + preserved content + changelog
PAGE=$(curl -s "http://127.0.0.1:$PORT/pages/$SLUG/")
echo "$PAGE" | grep -q "NEW-HEADLINE" && ok "edit applied" || bad "edit missing"
echo "$PAGE" | grep -q "keep me" && ok "unmarked content preserved" || bad "content lost"
echo "$PAGE" | grep -q "fig-changelog" && ok "changelog injected" || bad "no changelog"

echo "== T1b scripted page: true source becomes the edit base =="
python3 - "$T/p1b.json" <<PY
import json,sys
snap = '<!doctype html><html><head><base href="http://s.test/viz/"></head><body><h1>OLD-HEADLINE</h1><canvas id="cv" width="640" height="640"></canvas></body></html>'
src = '<!DOCTYPE html><html><head><title>Viz</title></head><body><h1>OLD-HEADLINE</h1><canvas id="cv"></canvas><script>var ring="dashed"; draw();</script></body></html>'
json.dump({"type":"html","url":"http://s.test/viz/","title":"Scripted Page","viewport":{"w":800,"h":600},
"capturedAt":"now","html":snap,"sourceHtml":src,
"annotations":{"comments":[{"id":1,"n":1,"text":"change headline","x":1,"y":1,"targetPath":"h1","targetText":"OLD-HEADLINE"}],"highlights":[{"text":"OLD-HEADLINE","note":"flagged"}],"strokes":[]}}, open(sys.argv[1],"w"))
PY
R=$(post "$T/p1b.json"); CODE=$(echo "$R"|tail -1); BODY=$(echo "$R"|sed '$d')
check "scripted dispatch 200" "$CODE" "200"
SLUGB=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['job'])")
JD="$T/home/.fig/jobs/$SLUGB"
[ -f "$JD/source.html" ] && ok "source.html written" || bad "no source.html"
grep -q '<script>var ring' "$JD/edited.html" && ok "edit base carries the page's script" || bad "script missing from edit base"
grep -q '<base href="http://s.test/viz/">' "$JD/edited.html" && ok "base injected into source-based edit base" || bad "no base injected"
grep -q "TRUE SOURCE" "$JD/prompt.md" && ok "prompt teaches the source-based flow" || bad "prompt lacks source-based branch"
grep -q "existing scripts stay" "$JD/prompt.md" && ok "prompt keeps existing scripts" || bad "prompt still bans all scripts"
grep -q "Remove each <mark data-fig-highlight>" "$JD/prompt.md" && bad "wrapper-removal rule wrongly present" || ok "wrapper-removal rule dropped for source base"
grep -q "sourceHtml" "$JD/annotations.json" && bad "sourceHtml leaked into annotations.json" || ok "annotations.json stays lean"
sleep 1.2
PAGE=$(curl -s "http://127.0.0.1:$PORT/pages/$SLUGB/")
echo "$PAGE" | grep -q "NEW-HEADLINE" && ok "edit applied on source base" || bad "edit missing"
echo "$PAGE" | grep -q '<script>var ring' && ok "served page still runs its script" || bad "served page lost script"

echo "== T1c JSON-LD-only source keeps the snapshot base =="
python3 - "$T/p1c.json" <<PY
import json,sys
snap = '<!doctype html><html><head><base href="http://s.test/p/"></head><body><h1>OLD-HEADLINE</h1></body></html>'
src = '<!DOCTYPE html><html><head><script type="application/ld+json">{"@type":"Article"}</script></head><body><h1>OLD-HEADLINE</h1></body></html>'
json.dump({"type":"html","url":"http://s.test/p/","title":"Static Page","viewport":{"w":800,"h":600},
"capturedAt":"now","html":snap,"sourceHtml":src,
"annotations":{"comments":[{"id":1,"n":1,"text":"x","x":1,"y":1,"targetPath":"h1","targetText":"OLD-HEADLINE"}],"highlights":[],"strokes":[]}}, open(sys.argv[1],"w"))
PY
R=$(post "$T/p1c.json"); BODY=$(echo "$R"|sed '$d')
SLUGC=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['job'])")
JD="$T/home/.fig/jobs/$SLUGC"
[ -f "$JD/source.html" ] && bad "source.html written for data-only script" || ok "data-only script keeps snapshot base"
grep -q '<base href="http://s.test/p/">' "$JD/edited.html" && ok "snapshot base kept verbatim" || bad "snapshot base altered"
sleep 1.2   # let this job's fake generation finish before the next test flips the mode

echo "== T2 noop: exit 0 with no change → error, never infinite spin =="
echo noop > "$T/home/.fig-test-mode"
sed 's/Test Page/Noop Page/' "$T/p1.json" > "$T/p2.json"
SLUG2=$(post "$T/p2.json" | sed '$d' | python3 -c "import json,sys;print(json.load(sys.stdin)['job'])")
sleep 1.2
ST=$(curl -s "http://127.0.0.1:$PORT/jobs/$SLUG2/state" | python3 -c "import json,sys;print(json.load(sys.stdin)['phase'])")
check "unchanged page = error (was: infinite spin)" "$ST" "error"
curl -s "http://127.0.0.1:$PORT/jobs/$SLUG2/" | grep -q "Generation failed" && ok "error page served" || bad "error page missing"

echo "== T3 hard fail: exit 1 =="
echo fail > "$T/home/.fig-test-mode"
sed 's/Test Page/Fail Page/' "$T/p1.json" > "$T/p3.json"
SLUG3=$(post "$T/p3.json" | sed '$d' | python3 -c "import json,sys;print(json.load(sys.stdin)['job'])")
sleep 1.2
ST=$(curl -s "http://127.0.0.1:$PORT/jobs/$SLUG3/state" | python3 -c "import json,sys;print(json.load(sys.stdin)['phase'])")
check "exit 1 = error" "$ST" "error"

echo "== T4 rapid same-title dispatches get distinct jobs =="
echo edit > "$T/home/.fig-test-mode"
A=$(post "$T/p1.json" | sed '$d' | python3 -c "import json,sys;print(json.load(sys.stdin)['job'])")
B=$(post "$T/p1.json" | sed '$d' | python3 -c "import json,sys;print(json.load(sys.stdin)['job'])")
[ "$A" != "$B" ] && ok "no slug collision ($A vs $B)" || bad "COLLISION: $A"

echo "== T5 malformed payload: 400, daemon survives =="
R=$(curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$PORT/fig" -H "Content-Type: application/json" -H "X-Fig-Token: testtoken123" -d '{"type":"html","html":"<p>x</p>"}')
check "missing annotations → 400" "$(echo "$R"|tail -1)" "400"
R=$(curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$PORT/fig" -H "Content-Type: application/json" -H "X-Fig-Token: testtoken123" -d '{"type":"html","html":"","annotations":{}}')
check "empty snapshot → 400" "$(echo "$R"|tail -1)" "400"
kill -0 $FIGD_PID 2>/dev/null && ok "daemon still alive after bad payloads" || bad "DAEMON DIED"
C=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/")
check "daemon still serving" "$C" "200"

echo "== T6 legacy job (no state file) keeps old semantics =="
L="$T/home/.fig/jobs/legacy-job-0101120000"
mkdir -p "$L"; echo '{"t":1}' > "$L/annotations.json"; echo "<html>old</html>" > "$L/edited.html"
LOC=$(curl -s -o /dev/null -w "%{redirect_url}" "http://127.0.0.1:$PORT/jobs/legacy-job-0101120000/")
echo "$LOC" | grep -q "/pages/legacy-job" && ok "legacy edited.html = done" || bad "legacy broken ($LOC)"

echo "== T9 favicon on figd surfaces =="
curl -s "http://127.0.0.1:$PORT/" | grep -q 'rel="icon" type="image/svg+xml"' && ok "index has fig favicon" || bad "index favicon missing"
curl -s "http://127.0.0.1:$PORT/pages/$SLUG/" | grep -q 'rel="icon" type="image/svg+xml"' && ok "result page has fig favicon" || bad "result favicon missing"

echo "== T8 settings: network tools granted + legacy default migrated =="
python3 - "$T/home/.fig/settings.json" <<'PYS'
import json,sys
d=json.load(open(sys.argv[1]))
args=d.get("claudeArgs",[])
ok = args == ["--x"]
print(("  \u2713" if ok else "  \u2717"), "hand-customized claudeArgs preserved (not migrated):", args)
sys.exit(0 if ok else 1)
PYS
[ $? -eq 0 ] && pass=$((pass+1)) || fail=$((fail+1))
# migration: write the LEGACY default, hit the server once, confirm upgrade
python3 -c "
import json,sys
p='$T/home/.fig/settings.json'; d=json.load(open(p))
d['claudeArgs']=['--permission-mode','acceptEdits','--allowedTools','Read,Write,Edit']
json.dump(d,open(p,'w'))"
curl -s -o /dev/null "http://127.0.0.1:$PORT/"
python3 - "$T/home/.fig/settings.json" <<'PYS'
import json,sys
d=json.load(open(sys.argv[1]))
ok = "Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Bash" in d.get("claudeArgs",[])
print(("  \u2713" if ok else "  \u2717"), "legacy default migrated to the full toolbelt")
sys.exit(0 if ok else 1)
PYS
[ $? -eq 0 ] && pass=$((pass+1)) || fail=$((fail+1))
# migration: the curl-only default (2026-07-30) also upgrades
python3 -c "
import json,sys
p='$T/home/.fig/settings.json'; d=json.load(open(p))
d['claudeArgs']=['--permission-mode','acceptEdits','--allowedTools','Read,Write,Edit,WebFetch,WebSearch,Bash(curl:*)']
json.dump(d,open(p,'w'))"
curl -s -o /dev/null "http://127.0.0.1:$PORT/"
python3 - "$T/home/.fig/settings.json" <<'PYS'
import json,sys
d=json.load(open(sys.argv[1]))
ok = "Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Bash" in d.get("claudeArgs",[])
print(("  \u2713" if ok else "  \u2717"), "curl-only default migrated to the full toolbelt")
sys.exit(0 if ok else 1)
PYS
[ $? -eq 0 ] && pass=$((pass+1)) || fail=$((fail+1))

echo "== T7 wrong token still rejected =="
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/fig" -H "X-Fig-Token: wrong" -d '{}')
check "bad token → 403" "$C" "403"

echo "== T10 changelog pill matches the Fig button radius =="
curl -s "http://127.0.0.1:$PORT/pages/$SLUG/" | grep -q 'fig-changelog-btn" type="button" style="[^"]*border-radius:9px' && ok "pill radius 9px" || bad "pill radius wrong"

echo "== T11 fig-on-fig: changelog accumulates across rounds =="
echo edit > "$T/home/.fig-test-mode"
python3 - "$T/p11.json" "$SLUG" <<'PY11'
import json,sys
json.dump({"type":"html","url":"http://127.0.0.1:41599/pages/"+sys.argv[2]+"/","title":"Test Page Round2","viewport":{"w":800,"h":600},
"capturedAt":"now","html":"<!doctype html><html><head></head><body><h1>OLD-HEADLINE</h1><p>round two</p></body></html>",
"annotations":{"comments":[{"id":1,"n":1,"text":"again","x":1,"y":1,"targetPath":"h1","targetText":"OLD-HEADLINE"}],"highlights":[],"strokes":[]}}, open(sys.argv[1],"w"))
PY11
SLUG2B=$(post "$T/p11.json" | sed '$d' | python3 -c "import json,sys;print(json.load(sys.stdin)['job'])")
[ -f "$T/home/.fig/jobs/$SLUG2B/history.json" ] && ok "history carried from parent job" || bad "no history.json"
sleep 1.2
P2=$(curl -s "http://127.0.0.1:$PORT/pages/$SLUG2B/")
echo "$P2" | grep -q "Changes · 2" && ok "pill counts BOTH rounds (2)" || bad "pill count wrong"
echo "$P2" | grep -q "Round 1" && echo "$P2" | grep -q "Round 2 · latest" && ok "rounds labeled" || bad "round labels missing"

echo "== T13 verify phase + full toolbelt in the prompt =="
grep -q "VERIFY BEFORE FINISHING" "$T/home/.fig/jobs/$SLUG/prompt.md" && ok "prompt mandates the render-and-verify phase" || bad "no verify phase in prompt"
grep -q -- "--headless" "$T/home/.fig/jobs/$SLUG/prompt.md" && ok "prompt carries the exact headless render command" || bad "no render command"

echo "== T14 round memory: diagnosis written, carried into the child prompt =="
[ -f "$T/home/.fig/jobs/$SLUG/diagnosis.md" ] && grep -q "DIAGNOSIS-TEXT" "$T/home/.fig/jobs/$SLUG/diagnosis.md" && ok "diagnosis.md captured from the result stream" || bad "no diagnosis.md"
grep -q "WHAT THE PREVIOUS ROUND DID" "$T/home/.fig/jobs/$SLUG2B/prompt.md" && grep -q "DIAGNOSIS-TEXT" "$T/home/.fig/jobs/$SLUG2B/prompt.md" && ok "child prompt inherits the parent diagnosis" || bad "child prompt lacks prior diagnosis"

echo "== T15 retry: failed job re-runs in place =="
# SLUG3 is in error state from T3. Error page must offer the retry form.
EP=$(curl -s "http://127.0.0.1:$PORT/jobs/$SLUG3/")
echo "$EP" | grep -q "Retry this fig" && ok "error page has a Retry button" || bad "no retry button"
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/jobs/$SLUG3/retry" --data "token=wrongtoken")
check "retry with bad token → 403" "$C" "403"
echo edit > "$T/home/.fig-test-mode"
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/jobs/$SLUG3/retry" --data "token=testtoken123")
check "retry accepted → 302" "$C" "302"
sleep 1.2
ST=$(curl -s "http://127.0.0.1:$PORT/jobs/$SLUG3/state" | python3 -c "import json,sys;print(json.load(sys.stdin)['phase'])")
check "retried job reaches done" "$ST" "done"
curl -s "http://127.0.0.1:$PORT/pages/$SLUG3/" | grep -q "NEW-HEADLINE" && ok "retried job produced the edit" || bad "retry edit missing"
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/jobs/$SLUG3/retry" --data "token=testtoken123")
check "retry on a non-failed job → 409" "$C" "409"

echo "== T12 settings page removed (gear popover owns settings) =="
C=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/settings")
check "GET /settings → 404" "$C" "404"
node "$(cd "$(dirname "$0")" && pwd)/host-settings.mjs" "$T/home" && { pass=$((pass+3)); } || { fail=$((fail+1)); echo "  ✗ host settings suite"; }

kill $FIGD_PID 2>/dev/null
echo
echo "RESULT: $pass passed, $fail failed"
[ $fail -eq 0 ]
