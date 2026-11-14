#!/bin/sh
# Encrypted backup of the desk's private config, safe to commit.
#
#   secrets-vault.sh seal  [vault-file]   # secrets.toml + desk.toml + compute.toml -> vault-file
#   secrets-vault.sh open  [vault-file]   # vault-file -> files back in place (old ones kept as .bak)
#   secrets-vault.sh list  [vault-file]   # names inside, nothing written
#
# vault-file defaults to <data>/vault/<short hostname>.tar.gpg, one per host: the desk data repo
# (shared by the hosts) commits it. On a new host, open the vault of the host to copy from:
#   secrets-vault.sh open ~/agent-desk-data/vault/hp.tar.gpg
# Cipher: OpenPGP symmetric, AES-256, passphrase stretched with iterated+salted SHA-512 at the
# maximum count, MDC integrity check. Strength is the passphrase: use 6+ random words.
# gpg asks for the passphrase itself (pinentry); it never goes through argv, env or a file.
# Run from a real terminal.
set -eu
CMD=${1:-}
SECRETS=${AGENT_DESK_SECRETS:-$HOME/.config/agent-desk/secrets.toml}
DATA=${AGENT_DESK_DATA:-$HOME/agent-desk-data}
VAULT=${2:-$DATA/vault/$(hostname -s).tar.gpg}
GPG="gpg --quiet --no-symkey-cache ${VAULT_GPG_OPTS:-}" # VAULT_GPG_OPTS: tests only

umask 077
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

case "$CMD" in
seal)
  mkdir -p "$TMP/config" "$TMP/data" "$(dirname "$VAULT")"
  [ -f "$SECRETS" ] && cp "$SECRETS" "$TMP/config/secrets.toml"
  for f in desk.toml compute.toml; do [ -f "$DATA/$f" ] && cp "$DATA/$f" "$TMP/data/$f"; done
  tar -C "$TMP" -cf "$TMP/c.tar" config data
  $GPG --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 \
    --force-mdc --compress-algo none -o "$VAULT.new" "$TMP/c.tar"
  mv "$VAULT.new" "$VAULT"
  chmod 644 "$VAULT"
  echo "sealed: $VAULT"; tar -tf "$TMP/c.tar" | grep -v '/$' | sed 's/^/  /'
  ;;
open | list)
  [ -f "$VAULT" ] || { echo "no vault at $VAULT" >&2; exit 1; }
  $GPG --decrypt -o "$TMP/c.tar" "$VAULT"
  if [ "$CMD" = list ]; then tar -tf "$TMP/c.tar" | grep -v '/$'; exit 0; fi
  tar -C "$TMP" -xf "$TMP/c.tar"
  put() { # src dst
    [ -f "$1" ] || return 0
    mkdir -p "$(dirname "$2")"
    if [ -f "$2" ] && ! cmp -s "$1" "$2"; then cp -p "$2" "$2.bak"; echo "  kept old as $2.bak"; fi
    cp "$1" "$2"; chmod 600 "$2"; echo "restored: $2"
  }
  put "$TMP/config/secrets.toml" "$SECRETS"
  for f in desk.toml compute.toml; do put "$TMP/data/$f" "$DATA/$f"; done
  ;;
*)
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
