#!/usr/bin/env bash
# Install the selected PLaMo GGUF and, on macOS, configure a per-user launchd service.
set -euo pipefail

LABEL="io.github.akitana-airtanker.pi-plamo-ja"
MODEL_DIR="${HOME}/models/plamo"
PORT="${PLAMO_JA_PORT:-18080}"
SKIP_SERVICE="${PLAMO_SKIP_SERVICE:-0}"
MODEL="0.8b"
CHECK_ONLY=0
while (($#)); do
  case "$1" in
    --model) (($# >= 2)) || { echo '--model requires 0.8b or 2b' >&2; exit 2; }; MODEL="$2"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$MODEL" in
  0.8b) FILE=plamo-3-translate-0.8b-Q4_K_M.gguf; URL="https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/main/$FILE"; SHA="73a1d942d8ab1e654d83898d997b8b4808c32ba669b378df612230989d18f079" ;;
  2b) FILE=plamo-3-translate-2b-Q4_K_M.gguf; URL="https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/main/$FILE"; SHA="2189a8a0b4b359f59443ec36cfb9c9c3f603a678c00dbcee8598b3f7ea7c12fb" ;;
  *) echo '--model must be 0.8b or 2b' >&2; exit 2 ;;
esac
URL="${PLAMO_MODEL_URL:-$URL}"
SHA="${PLAMO_MODEL_SHA256:-$SHA}"
MODEL_PATH="$MODEL_DIR/$FILE"
sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

if [[ "$CHECK_ONLY" == 1 ]]; then
  [[ -f "$MODEL_PATH" && "$(sha_of "$MODEL_PATH")" == "$SHA" ]] || { echo "model missing or SHA-256 mismatch: $MODEL_PATH" >&2; exit 1; }
  echo "model verified: $MODEL_PATH"
  if [[ "$SKIP_SERVICE" != 1 && "$(uname -s)" == Darwin ]]; then
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || { echo "launchd service is not loaded: $LABEL" >&2; exit 1; }
  fi
  exit 0
fi

if [[ "$SKIP_SERVICE" != 1 && "$(uname -s)" == Darwin ]] && ! command -v llama-server >/dev/null; then
  command -v brew >/dev/null || { echo 'Homebrew is required to install llama.cpp' >&2; exit 1; }
  brew install llama.cpp
fi
if [[ ! -f "$MODEL_PATH" || "$(sha_of "$MODEL_PATH")" != "$SHA" ]]; then
  mkdir -p "$MODEL_DIR"
  part="$MODEL_PATH.part"
  curl -fL --retry 3 -o "$part" "$URL"
  [[ "$(sha_of "$part")" == "$SHA" ]] || { rm -f "$part"; echo 'model SHA-256 mismatch' >&2; exit 1; }
  mv -f "$part" "$MODEL_PATH"
fi
printf 'Model ready: %s\n' "$MODEL_PATH"
if [[ "$SKIP_SERVICE" == 1 ]]; then exit 0; fi
if [[ "$(uname -s)" != Darwin ]]; then
  LLAMA_SERVER="$(command -v llama-server || true)"
  [[ -n "$LLAMA_SERVER" ]] || LLAMA_SERVER=llama-server
  printf 'Linux does not install a service. Start the server with:\n%s -m %q --host 127.0.0.1 --port %q -c 8192\n' "$LLAMA_SERVER" "$MODEL_PATH" "$PORT"
  exit 0
fi
case "$(uname -m)" in arm64|x86_64) ;; *) echo 'Only Apple Silicon and Intel macOS are supported' >&2; exit 1 ;; esac
LLAMA_SERVER="$(command -v llama-server)"
PLIST_SRC="$(cd "$(dirname "$0")/.." && pwd -P)/launchd/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_PATH="$HOME/Library/Logs/pi-plamo-ja.log"
mkdir -p "$(dirname "$PLIST_DST")" "$(dirname "$LOG_PATH")"
sed -e "s|__LLAMA_SERVER__|$LLAMA_SERVER|g" -e "s|__MODEL_PATH__|$MODEL_PATH|g" -e "s|__LOG_PATH__|$LOG_PATH|g" "$PLIST_SRC" > "$PLIST_DST.tmp"
plutil -lint "$PLIST_DST.tmp" >/dev/null
mv -f "$PLIST_DST.tmp" "$PLIST_DST"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
echo "launchd service started: $LABEL"
for _ in $(seq 1 60); do curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null && { echo 'llama-server is ready'; exit 0; }; sleep 1; done
echo "llama-server did not become ready; see $LOG_PATH" >&2
exit 1
