#!/bin/bash
cd "$(dirname "$0")"
echo "[stealth] starting on http://localhost:8787"
exec node server/standalone.js
