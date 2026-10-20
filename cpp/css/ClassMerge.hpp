#pragma once

// tailwind-merge compatible class merge, table driven.
//
// The conflict table is *generated* with tailwind-merge itself as the oracle (see tools/cn-table), so for every token it knows
// the result is byte-identical to `twMerge(clsx(...))`. A token that is not in the table makes `merge` return false: the caller
// then uses the JS reference. Nothing here guesses.
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

namespace margelo::nitro::shadewind::css {

class ClassMerge {
public:
  /**
   * Loads the generated table (lines: `G\t<count>`, `K\t<group>\t<g,g,...>`, `T\t<base>\t<group>`, `U\t<base>`,
   * `S\t<modifier,modifier,...>`: the oracle's order-sensitive modifiers).
   */
  bool load(std::string_view text) {
    std::vector<std::pair<std::string, int>> items;
    kills_.clear();
    // a table from before `S` lines existed: tailwind-merge 3.x's list (3.7.0, the version the generator was used with)
    orderSensitive_ = {"*", "**", "after", "backdrop", "before", "details-content", "file", "first-letter", "first-line", "marker",
                       "placeholder", "selection"};
    size_t pos = 0;

    while (pos < text.size()) {
      size_t eol = text.find('\n', pos);

      if (eol == std::string_view::npos) {
        eol = text.size();
      }

      const std::string_view line = text.substr(pos, eol - pos);
      pos = eol + 1;

      if (line.size() < 2) {
        continue;
      }

      std::string_view f[3];
      size_t nf = 0, s = 0;

      for (size_t i = 0; i <= line.size() && nf < 3; i++) {
        if (i == line.size() || line[i] == '\t') {
          f[nf++] = line.substr(s, i - s);
          s = i + 1;
        }
      }

      if (line[0] == 'G' && nf >= 2) {
        kills_.assign(toInt(f[1]), {});
      } else if (line[0] == 'K' && nf >= 2) {
        const size_t g = toInt(f[1]);
        std::vector<int> ks;
        const std::string_view list = nf > 2 ? f[2] : std::string_view();
        size_t p = 0;

        while (p < list.size()) {
          size_t c = list.find(',', p);

          if (c == std::string_view::npos) {
            c = list.size();
          }

          ks.push_back(static_cast<int>(toInt(list.substr(p, c - p))));
          p = c + 1;
        }

        if (g < kills_.size()) {
          kills_[g] = std::move(ks);
        }
      } else if (line[0] == 'T' && nf >= 3) {
        items.emplace_back(std::string(f[1]), static_cast<int>(toInt(f[2])));
      } else if (line[0] == 'U' && nf >= 2) {
        items.emplace_back(std::string(f[1]), -1);
      } else if (line[0] == 'S') {
        orderSensitive_.clear();

        const std::string_view list = nf > 1 ? f[1] : std::string_view();
        size_t p = 0;

        while (p < list.size()) {
          size_t c = list.find(',', p);

          if (c == std::string_view::npos) {
            c = list.size();
          }

          if (c > p) {
            orderSensitive_.emplace_back(list.substr(p, c - p));
          }

          p = c + 1;
        }
      }
    }

    firstChars_[0] = firstChars_[1] = 0;

    for (const auto& name : orderSensitive_) {
      const unsigned char first = name.empty() ? 0 : static_cast<unsigned char>(name.front());

      if (first < 128) {
        firstChars_[first >> 6] |= 1ULL << (first & 63);
      }
    }

    size_t cap = 1;

    while (cap < items.size() * 2 + 2) {
      cap <<= 1;
    }

    slots_.assign(cap, Slot{});
    mask_ = cap - 1;

    for (auto& item : items) {
      const uint64_t h = fnv(item.first.data(), item.first.size());
      size_t i = h & mask_;

      while (slots_[i].used) {
        i = (i + 1) & mask_;
      }

      slots_[i] = Slot{h, std::move(item.first), item.second, true};
    }

    return !kills_.empty();
  }

  bool loaded() const { return !kills_.empty(); }

  /**
   * Merges class strings. Returns false (and leaves `out` unspecified) when any token is not in the table or the input is
   * larger than the fixed working set: the caller must then use the JS reference.
   */
  bool merge(const std::string_view* inputs, size_t count, std::string& out) const {
    constexpr size_t kMax = 96;
    Tok toks[kMax];
    uint8_t keep[kMax];
    size_t n = 0;

    for (size_t a = 0; a < count; a++) {
      const char* s = inputs[a].data();
      const size_t len = inputs[a].size();
      size_t i = 0;

      while (i < len) {
        while (i < len && isSpace(s[i])) {
          i++;
        }

        size_t j = i;

        bool colon = false;

        while (j < len && !isSpace(s[j])) {
          colon |= s[j] == ':';
          j++;
        }

        if (j > i) {
          if (n >= kMax || !parse(s + i, j - i, colon, toks[n])) {
            return false;
          }

          n++;
        }

        i = j;
      }
    }

    uint64_t seen[256];
    size_t ns = 0;

    for (size_t k = n; k-- > 0;) {
      keep[k] = 1;
      const Tok& tk = toks[k];

      if (tk.group < 0) {
        continue; // not a tailwind class: kept unconditionally, like tailwind-merge
      }

      const uint64_t id = key(tk.modKey, tk.group);
      bool dup = false;

      for (size_t s = 0; s < ns; s++) {
        if (seen[s] == id) {
          dup = true;
          break;
        }
      }

      if (dup) {
        keep[k] = 0;
        continue;
      }

      for (int g : kills_[static_cast<size_t>(tk.group)]) {
        if (ns >= 256) {
          return false;
        }

        seen[ns++] = key(tk.modKey, g);
      }
    }

    size_t total = 0;

    for (size_t k = 0; k < n; k++) {
      if (keep[k]) {
        total += toks[k].n + 1;
      }
    }

    // one resize, then plain copies: no per-token capacity check
    out.resize(total ? total - 1 : 0);

    char* dst = out.data();

    for (size_t k = 0; k < n; k++) {
      if (keep[k]) {
        std::memcpy(dst, toks[k].p, toks[k].n);
        dst += toks[k].n;

        if (dst != out.data() + out.size()) {
          *dst++ = ' ';
        }
      }
    }

    return true;
  }

private:
  struct Slot {
    uint64_t hash = 0;
    std::string key;
    int group = -2;
    bool used = false;
  };

  struct Tok {
    uint64_t modKey;
    int group;
    const char* p;
    uint32_t n;
  };

  static constexpr uint64_t kSeed = 1469598103934665603ULL;

  static bool isSpace(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

  static size_t toInt(std::string_view s) {
    size_t v = 0;

    for (char c : s) {
      if (c >= '0' && c <= '9') {
        v = v * 10 + static_cast<size_t>(c - '0');
      }
    }

    return v;
  }

  static uint64_t fnv(const char* p, size_t n, uint64_t h = 1469598103934665603ULL) {
    constexpr uint64_t M = 0x9E3779B97F4A7C15ULL;
    size_t i = 0;

    for (; i + 8 <= n; i += 8) {
      uint64_t w;
      std::memcpy(&w, p + i, 8);
      h = (h ^ w) * M;
      h ^= h >> 29;
    }

    uint64_t tail = 0;

    if (i < n) {
      std::memcpy(&tail, p + i, n - i);
      h = (h ^ tail ^ (static_cast<uint64_t>(n - i) << 56)) * M;
      h ^= h >> 29;
    }

    return h;
  }

  static uint64_t key(uint64_t mod, int group) { return mod * 1000003ULL + static_cast<uint64_t>(group); }

  int find(const char* p, size_t n) const {
    const uint64_t h = fnv(p, n);

    for (size_t i = h & mask_;; i = (i + 1) & mask_) {
      const Slot& e = slots_[i];

      if (!e.used) {
        return -2;
      }

      if (e.hash == h && e.key.size() == n && std::memcmp(e.key.data(), p, n) == 0) {
        return e.group;
      }
    }
  }

  // a modifier tailwind-merge does not reorder across: an arbitrary variant, or one of its order-sensitive modifiers (before:, ...)
  bool isBarrier(std::string_view modifier) const {
    if (!modifier.empty() && modifier.front() == '[') {
      return true;
    }

    // a modifier whose first character starts no listed name cannot be one (names with a byte >= 128 first are never rejected)
    if (modifier.empty()) {
      return false;
    }

    const unsigned char first = static_cast<unsigned char>(modifier.front());

    if (first < 128 && !((firstChars_[first >> 6] >> (first & 63)) & 1)) {
      return false;
    }

    for (const auto& name : orderSensitive_) {
      if (name == modifier) {
        return true;
      }
    }

    return false;
  }

  // modifiers sorted like tailwind-merge (barriers stay in place, see isBarrier), important marker either side
  bool parse(const char* p, size_t n, bool colon, Tok& out) const {
    if (!colon && p[0] != '!' && p[n - 1] != '!') {
      const int g0 = find(p, n);

      if (g0 == -2) {
        return false;
      }

      out = Tok{kSeed, g0, p, static_cast<uint32_t>(n)};

      return true;
    }

    std::string_view parts[16];
    int np = 0, depth = 0;
    size_t start = 0;

    for (size_t i = 0; i < n; i++) {
      const char c = p[i];

      if (c == '[' || c == '(') {
        depth++;
      } else if (c == ']' || c == ')') {
        depth--;
      } else if (c == ':' && depth == 0) {
        if (np >= 15) {
          return false;
        }

        parts[np++] = std::string_view(p + start, i - start);
        start = i + 1;
      }
    }

    const char* b = p + start;
    size_t bn = n - start;
    bool important = false;

    if (bn && b[0] == '!') {
      important = true;
      b++;
      bn--;
    }

    if (bn && b[bn - 1] == '!') {
      important = true;
      bn--;
    }

    if (np > 1) { // nothing to reorder with fewer than two modifiers
      int run = 0;

      for (int i = 0; i <= np; i++) {
        if (i == np || isBarrier(parts[i])) {
          std::sort(parts + run, parts + i);
          run = i + 1;
        }
      }
    }

    uint64_t h = kSeed;

    for (int i = 0; i < np; i++) {
      h = fnv(parts[i].data(), parts[i].size(), h);
      h = fnv(":", 1, h);
    }

    if (important) {
      h = fnv("!", 1, h);
    }

    const int g = find(b, bn);

    if (g == -2) {
      return false;
    }

    out = Tok{h, g, p, static_cast<uint32_t>(n)};

    return true;
  }

  std::vector<Slot> slots_;
  size_t mask_ = 0;
  std::vector<std::vector<int>> kills_;
  std::vector<std::string> orderSensitive_;
  uint64_t firstChars_[2] = {0, 0}; // bit per first character of an order-sensitive modifier
};

} // namespace margelo::nitro::shadewind::css
