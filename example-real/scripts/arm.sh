#!/bin/bash
# usage: scripts/arm.sh plain|engine   writes src/boot.ts for the arm; set REAL_PLAIN=1 for the plain Metro config
cd "$(dirname "$0")/.."
if [ "$1" = "engine" ]; then
  printf "import { installUniwind } from 'shadewind/uniwind';\n\ninstallUniwind();\n" > src/boot.ts
else
  printf "export {};\n" > src/boot.ts
fi
echo "arm: $1"
