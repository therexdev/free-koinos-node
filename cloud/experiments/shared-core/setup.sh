#!/usr/bin/env bash
# Copies the config assets the shared-core spike needs from the node template,
# so we don't duplicate the large genesis file in the repo. Run before `up`.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tpl="$here/../../../node-template"
cp -f "$tpl/common/koinos_descriptors.pb" "$here/config/koinos_descriptors.pb"
cp -f "$tpl/common/rabbitmq.conf"          "$here/config/rabbitmq.conf"
cp -f "$tpl/mainnet/genesis_data.json"     "$here/config/genesis_data.json"
echo "Config assets copied. Now: docker compose up -d"
echo "Then inspect the broker: curl -s http://guest:guest@127.0.0.1:15672/api/bindings"
