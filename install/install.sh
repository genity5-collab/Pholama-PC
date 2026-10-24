#!/usr/bin/env bash
# Pholama installer for Mac and Linux. Run:
#   curl -fsSL https://raw.githubusercontent.com/genity5-collab/Pholama-PC/main/install/install.sh | bash
set -e
# Pholama for PC is for Windows, Mac and Linux computers. Refuse phones (Android via Termux) so it is never installed by accident.
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ] || uname -a | grep -qi android; then
  printf '\n  Pholama for PC is for computers, not phones. On your phone just open the Pholama website.\n\n'; exit 1
fi
DIR="$HOME/Pholama"; TAR="https://github.com/genity5-collab/Pholama-PC/archive/refs/heads/main.tar.gz"
say() { printf '\n  %s\n' "$1"; }
NODE="node"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  # No Node.js on this computer: fetch a private copy into ~/.pholama/node so nothing has to be installed first.
  command -v curl >/dev/null 2>&1 || { say "curl is needed."; exit 1; }
  NV="v20.20.2"; OS="$(uname -s | tr A-Z a-z)"; AR="$(uname -m)"
  case "$AR" in x86_64|amd64) AR=x64;; aarch64|arm64) AR=arm64;; *) say "This computer type ($AR) is not supported yet."; exit 1;; esac
  case "$OS" in linux|darwin) ;; *) say "This system ($OS) is not supported."; exit 1;; esac
  PRIV="$HOME/.pholama/node"
  if [ ! -x "$PRIV/bin/node" ]; then
    say "No Node.js found, so Pholama is getting its own private copy (about 30 MB, one time). Nothing is installed system-wide."
    T2="$(mktemp -d)"; EXT="tar.gz"; [ "$OS" = linux ] && EXT="tar.xz"
    if ! curl -fsSL "https://nodejs.org/dist/$NV/node-$NV-$OS-$AR.$EXT" -o "$T2/node.$EXT"; then say "Could not download Node.js. Check your internet connection."; exit 1; fi
    mkdir -p "$PRIV"
    if ! tar -xf "$T2/node.$EXT" -C "$PRIV" --strip-components=1; then say "Could not unpack Node.js."; exit 1; fi
  fi
  NODE="$PRIV/bin/node"
  "$NODE" -v >/dev/null 2>&1 || { say "The private Node.js did not start on this computer."; exit 1; }
fi
command -v curl >/dev/null 2>&1 || { say "curl is needed."; exit 1; }
command -v tar >/dev/null 2>&1 || { say "tar is needed."; exit 1; }
# Clean up after older attempts that did not finish: a half-finished install folder (no server/cli.js in it).
# A working install is never touched here. Leftover temp folders are removed by the trap below on every normal exit.
if [ -d "$DIR" ] && [ ! -f "$DIR/server/cli.js" ]; then
  if [ -n "$(find "$DIR" -mindepth 1 -maxdepth 1 ! -name node_modules 2>/dev/null | head -1)" ]; then
    find "$DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + 2>/dev/null || true
    say "Cleaned up leftover files from an earlier attempt that did not finish."
  fi
fi
say "Downloading Pholama to $DIR ..."
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if ! curl -fsSL "$TAR" -o "$TMP/p.tgz"; then say "Could not download Pholama. Check your internet connection and run the command again."; exit 1; fi
if ! tar -xzf "$TMP/p.tgz" -C "$TMP"; then say "The download was damaged. Run the command again."; exit 1; fi
# Never touch an existing install unless the download really unpacked into a complete Pholama.
# GitHub names the folder after the repo and branch (Pholama-PC-main) and that name has changed before: find it by looking, never by a fixed name.
SRC=""; for d in "$TMP"/*/; do [ -f "${d}server/cli.js" ] && { SRC="${d%/}"; break; }; done
[ -n "$SRC" ] || SRC="$TMP/Pholama-PC-main"
for f in server/cli.js server/server.js models.pc.json; do
  [ -f "$SRC/$f" ] || { say "The download was incomplete ($f is missing), so nothing was changed. Run the command again."; exit 1; }
done
mkdir -p "$DIR"
# Reinstall cleanly: remove the old app files first so nothing stale stays. Models and chats live in ~/.pholama, not here.
find "$DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + 2>/dev/null || true
cp -R "$SRC"/. "$DIR"/
for f in server/cli.js server/server.js models.pc.json; do
  [ -f "$DIR/$f" ] || { say "Install failed: $f is missing in $DIR. Run the command again."; exit 1; }
done
chmod +x "$DIR/start.sh" "$DIR/server/server.js"
# make the pholama command available
mkdir -p "$HOME/.local/bin"
printf '#!/usr/bin/env bash\nexec "%s" "%s/server/cli.js" "$@"\n' "$NODE" "$DIR" > "$HOME/.local/bin/pholama"; chmod +x "$HOME/.local/bin/pholama"
cp "$HOME/.local/bin/pholama" "$HOME/.local/bin/phollama" 2>/dev/null || true
if "$NODE" "$DIR/server/cli.js" schedule-updates >/dev/null 2>&1; then say "Background update task installed (checks every 5 hours while Pholama is closed)."; else say "Could not install the background update task. You can retry later with: pholama schedule-updates"; fi
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "Add this to your shell profile so the pholama command works everywhere:  export PATH=\"\$HOME/.local/bin:\$PATH\"";; esac
# App icon so it is easy to find: Linux gets a launcher entry, Mac gets a double-clickable .command on the Desktop
ICON="$DIR/web/icon-512.png"
if [ "$(uname)" = "Linux" ]; then
  mkdir -p "$HOME/.local/share/applications"
  printf '[Desktop Entry]\nType=Application\nName=Pholama\nComment=Private AI on your PC\nExec="%s" "%s/server/cli.js" web\nIcon=%s\nTerminal=false\nCategories=Utility;\n' "$NODE" "$DIR" "$ICON" > "$HOME/.local/share/applications/pholama.desktop"
  [ -d "$HOME/Desktop" ] && cp "$HOME/.local/share/applications/pholama.desktop" "$HOME/Desktop/Pholama.desktop" && chmod +x "$HOME/Desktop/Pholama.desktop" 2>/dev/null || true
elif [ "$(uname)" = "Darwin" ]; then
  printf '#!/usr/bin/env bash\nexec "%s" "%s/server/cli.js" web\n' "$NODE" "$DIR" > "$HOME/Desktop/Pholama.command"; chmod +x "$HOME/Desktop/Pholama.command"
fi
say "Installed. Try:  pholama list     then:  pholama pull qwen2.5-0.5b"
say "Or open the app:  pholama web"
"$NODE" "$DIR/server/cli.js" web || true
