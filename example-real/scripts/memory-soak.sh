#!/bin/bash
# usage: scripts/memory-soak.sh <udid> <app> <label> [soak launch args...]
# Installs <app>, launches it with -soak 1 (see src/bench/SoakBench.tsx) and samples the process footprint every 5 s until the screen reports DONE
# (or 5 minutes). Prints "<label> <seconds> <footprint MB>" per sample, then the growth over the second half.
U=$1; APP=$2; LABEL=$3; shift 3
B=org.reactjs.native.example.RealWorld
xcrun simctl terminate "$U" $B >/dev/null 2>&1
xcrun simctl install "$U" "$APP"
PID=$(xcrun simctl launch --terminate-running-process "$U" $B -soak 1 "$@" | awk '{print $2}')
sleep 6
OUT=$(mktemp)
for i in $(seq 1 60); do
  MB=$(footprint "$PID" 2>/dev/null | grep -i "Footprint:" | head -1 | sed -E 's/.*Footprint: ([0-9.]+) (MB|GB|KB).*/\1 \2/' | awk '{v=$1; if ($2=="GB") v*=1024; if ($2=="KB") v/=1024; printf "%.1f", v}')
  [ -z "$MB" ] && break
  echo "$LABEL $((i*5)) $MB" | tee -a "$OUT"
  sleep 5
done
python3 - "$OUT" "$LABEL" <<'PY'
import sys
rows=[l.split() for l in open(sys.argv[1]) if l.strip()]
vals=[float(r[2]) for r in rows]
if len(vals) >= 6:
    h=len(vals)//2
    a=sum(vals[h:h+3])/3; b=sum(vals[-3:])/3
    print(f"{sys.argv[2]}: {len(vals)} samples, start {vals[0]:.1f} MB, mid {a:.1f} MB, end {b:.1f} MB, growth over the second half {b-a:+.1f} MB, peak {max(vals):.1f} MB")
PY
