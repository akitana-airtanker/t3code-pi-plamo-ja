#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
home="$tmp/home"
mkdir -p "$home"
printf 'test model\n' > "$tmp/model.gguf"
good="$(shasum -a 256 "$tmp/model.gguf" | awk '{print $1}')"
settings="$home/settings.json"
printf '{"extensions":["another-extension"]}\n' > "$settings"
run() { HOME="$home" PLAMO_SKIP_SERVICE=1 PLAMO_MODEL_URL="file://$tmp/model.gguf" PLAMO_MODEL_SHA256="${sha:-$good}" bash "$root/scripts/plamo-setup.sh" "$@"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

if run --model nope >/dev/null 2>&1; then fail 'invalid model accepted'; fi
if run --check >/dev/null 2>&1; then fail 'missing model passes check'; fi
[ ! -e "$home/models" ] || fail 'check modified HOME'
if sha=deadbeef run >/dev/null 2>&1; then fail 'wrong model hash accepted'; fi
[ ! -e "$home/models/plamo/plamo-3-translate-0.8b-Q4_K_M.gguf" ] || fail 'bad model left behind'
run >/dev/null || fail 'default model install failed'
run >/dev/null || fail 'repeat install failed'
run --check >/dev/null || fail 'installed model check failed'
cmp -s "$home/models/plamo/plamo-3-translate-0.8b-Q4_K_M.gguf" "$tmp/model.gguf" || fail 'wrong model installed'
cmp -s "$settings" <(printf '{"extensions":["another-extension"]}\n') || fail 'setup modified settings.json'
run --model 2b >/dev/null || fail '2B model selection failed'
[ -f "$home/models/plamo/plamo-3-translate-2b-Q4_K_M.gguf" ] || fail '2B model path incorrect'
sed -e 's|__LLAMA_SERVER__|/usr/bin/llama-server|g' -e 's|__MODEL_PATH__|/tmp/model.gguf|g' -e 's|__LOG_PATH__|/tmp/plamo.log|g' "$root/launchd/io.github.akitana-airtanker.t3code-pi-plamo-ja.plist" > "$tmp/rendered.plist"
plutil -lint "$tmp/rendered.plist" >/dev/null || fail 'rendered plist is invalid'
! rg -q '/Users/[^/]+|dotfiles' "$root/launchd/io.github.akitana-airtanker.t3code-pi-plamo-ja.plist" || fail 'plist has a personal path'
# A model URL on main stops matching the pinned checksum when upstream updates the file.
[ "$(rg -c 'huggingface\.co/pfnet/[^/]+/resolve/[0-9a-f]{40}/' "$root/scripts/plamo-setup.sh")" = 2 ] || fail 'model URLs must be pinned to a commit'
! rg -q 'resolve/main/' "$root/scripts/plamo-setup.sh" || fail 'a model URL points at main'
printf 'ok\n'
