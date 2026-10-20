#!/usr/bin/env python3
"""Pixel-compare the `-edgeCases 1` screen (src/bench/EdgeCases.tsx) between builds.

usage: scripts/edge-cases.py <udid> <oracle.app> <other.app> [<other.app> ...]
With two or more other builds the last is also compared with the one before it (list the adapter, then the precompiled build).

Each build is installed, launched with `-edgeCases 1` and screenshotted about every 0.7 s while the screen steps through its seven
phases (28 s). The phase of a screenshot is read from the squares in its header, and the last screenshot of each phase is kept. Every
grid cell of every other build is compared with the oracle's (the first build: plain Uniwind) in every phase; a cell is reported when
more than 0.3 % of its pixels differ by more than 24 in any channel.
"""
import glob
import os
import re
import subprocess
import sys
import tempfile
import time

from PIL import Image, ImageChops

BUNDLE = 'org.reactjs.native.example.RealWorld'
PHASES = 7
COLS, ROWS = 4, 7
SCALE = 3  # screenshot pixels per point (iPhone 17 Pro)
PHASE_S = 4.0
CELL_H = 84 * SCALE
GRID_TOP = (64 + 14 + 8) * SCALE  # root paddingTop + header + its margin
PAD = 8 * SCALE
THRESHOLD = 24
MAX_DIFF_SHARE = 0.003


def sh(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def phase_of(img):
    px = img.convert('L').load()
    filled = 0

    for i in range(PHASES):
        x = PAD + i * 16 * SCALE + 6 * SCALE
        y = (64 + 7) * SCALE

        if px[x, y] < 100:
            filled += 1

    return filled - 1


def capture(udid, app, out):
    os.makedirs(out, exist_ok=True)
    subprocess.run(['xcrun', 'simctl', 'terminate', udid, BUNDLE], capture_output=True)
    sh('xcrun', 'simctl', 'install', udid, app)
    sh('xcrun', 'simctl', 'launch', '--terminate-running-process', udid, BUNDLE, '-edgeCases', '1')
    start = time.time()
    n = 0

    while time.time() - start < PHASES * PHASE_S + 6:
        sh('xcrun', 'simctl', 'io', udid, 'screenshot', '--type=png', f'{out}/{n:03d}.png')
        n += 1
        time.sleep(0.2)

    last = {}

    for path in sorted(glob.glob(f'{out}/*.png')):
        img = Image.open(path).convert('RGB')
        phase = phase_of(img)

        if phase >= 0:
            last[phase] = (path, img)

    return last


def cell_box(i, width):
    col, row = i % COLS, i // COLS
    cw = (width - 2 * PAD) / COLS

    return (int(PAD + col * cw), GRID_TOP + row * CELL_H, int(PAD + (col + 1) * cw), GRID_TOP + (row + 1) * CELL_H)


def differs(a, b):
    diff = ImageChops.difference(a, b).convert('RGB')
    bad = sum(1 for p in diff.getdata() if max(p) > THRESHOLD)

    return bad / (diff.width * diff.height)


def main():
    udid, oracle, *others = sys.argv[1:]

    if not others:
        sys.exit(__doc__)

    work = tempfile.mkdtemp(prefix='edge-cases-')
    shots = {app: capture(udid, app, f'{work}/{os.path.basename(app)}') for app in [oracle, *others]}

    for app, by_phase in shots.items():
        print(f'{os.path.basename(app)}: phases seen {sorted(by_phase)}')

    failures = 0
    pairs = [(oracle, app) for app in others]

    if len(others) > 1:
        pairs.append((others[-2], others[-1]))  # e.g. the adapter against the precompiled build: what precompile changed

    for ref, app in pairs:
        print(f'--- {os.path.basename(app)} against {os.path.basename(ref)}')

        for phase in range(PHASES):
            if phase not in shots[ref] or phase not in shots[app]:
                print(f'{os.path.basename(app)} phase {phase}: missing screenshot')
                failures += 1
                continue

            base, other = shots[ref][phase][1], shots[app][phase][1]
            bad = []

            for i in range(COLS * ROWS):
                box = cell_box(i, base.width)
                share = differs(base.crop(box), other.crop(box))

                if share > MAX_DIFF_SHARE:
                    bad.append(f'cell {i + 1} ({share * 100:.1f}%)')

            if bad:
                failures += len(bad)

            print(f'{os.path.basename(app)} phase {phase}: ' + ('same' if not bad else 'DIFFERENT ' + ', '.join(bad)))

    print(f'screenshots kept in {work}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
