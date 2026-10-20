'use strict';

// shadewind/metro `cacheColors: true`: React Native's colour parser with a cache in front of it (see metro.cjs). Only strings are
// cached (numbers and PlatformColor objects go straight through), and the cache holds at most MAX_ENTRIES colours: a JS-driven
// animation produces a new colour string every frame, so it is emptied when full instead of growing without end.
const normalizeColor = require('shadewind-internal/normalize-colors');

const MAX_ENTRIES = 512;
const cache = new Map();

function cachedNormalizeColor(color) {
  if (typeof color !== 'string') {
    return normalizeColor(color);
  }

  const hit = cache.get(color);

  if (hit !== undefined) {
    return hit;
  }

  const value = normalizeColor(color);

  if (cache.size >= MAX_ENTRIES) {
    cache.clear();
  }

  cache.set(color, value);

  return value;
}

module.exports = cachedNormalizeColor;
