#!/bin/bash
# Mezo testnet read helper: mezo-read.sh <address> <selector-hex-10-chars>
RPC=https://rpc.test.mezo.org
curl -s $RPC -X POST -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$1\",\"data\":\"$2\"},\"latest\"]}" \
  --max-time 12 | grep -o '"result":"[^"]*"' | cut -d'"' -f4
