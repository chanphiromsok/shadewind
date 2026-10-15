#!/bin/bash
# usage: scripts/arm.sh plain|engine   writes src/boot.ts for the arm; set REAL_PLAIN=1 for the plain Metro config
cd "$(dirname "$0")/.."
if [ "$1" = "engine" ]; then
  printf "import { installUniwind } from 'shadewind/uniwind';\n\nexport { decisions, renders } from 'shadewind/uniwind';\nexport const status = () => JSON.stringify(installUniwind());\n" > src/engineReport.ts
  printf "import { Settings } from 'react-native';\nimport { installUniwind } from 'shadewind/uniwind';\n\n// -realDebug 1 collects why each className was or was not handed to the engine (Account > Engine report)\nif (Settings.get('armB')) {\n  // measurement: refs stay attached, the engine is never called (what the ref machinery alone costs)\n  (globalThis as { __SHADEWIND_SKIP_REGISTER?: boolean }).__SHADEWIND_SKIP_REGISTER = true;\n}\n\nif (Settings.get('realDebug')) {\n  (globalThis as { __SHADEWIND_DEBUG__?: boolean }).__SHADEWIND_DEBUG__ = true;\n}\n\ninstallUniwind();\n" > src/boot.ts
else
  printf "export const decisions = new Map<string, string>();\nexport const renders = new Map<string, number>();\nexport const status = () => 'plain arm: no engine';\n" > src/engineReport.ts
  printf "export {};\n" > src/boot.ts
fi
echo "arm: $1"
