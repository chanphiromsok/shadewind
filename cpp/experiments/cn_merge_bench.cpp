// Optimised C++ merge. Same semantics as cn.cpp (verified against tailwind-merge output), three entry points:
//   mergeStrings : class strings in, merged string out (what JS `cn` returns)
//   mergeParsed  : pre-parsed token lists (the AOT / id design), kept token indexes out
// Build: clang++ -O2 -std=c++17 cn2.cpp -o cn2_bench
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <string_view>
#include <vector>

static inline uint64_t fnv(const char* p, size_t n, uint64_t h = 1469598103934665603ULL) {
  for (size_t i = 0; i < n; i++) { h ^= static_cast<unsigned char>(p[i]); h *= 1099511628211ULL; }
  return h;
}

struct Entry { uint64_t hash = 0; std::string key; int group = -2; bool used = false; }; // group -1: kept unknown, >=0 tailwind

class Table {
public:
  void load(const char* path) {
    std::ifstream in(path);
    std::string line;
    std::vector<std::pair<std::string, int>> items;

    while (std::getline(in, line)) {
      if (line.size() < 2) continue;
      std::vector<std::string> f;
      size_t s = 0;
      for (size_t i = 0; i <= line.size(); i++) if (i == line.size() || line[i] == '\t') { f.push_back(line.substr(s, i - s)); s = i + 1; }
      if (line[0] == 'G') kills.assign(std::stoi(f[1]), {});
      else if (line[0] == 'K') {
        std::vector<int> ks; const std::string list = f.size() > 2 ? f[2] : "";
        size_t p = 0;
        while (p < list.size()) { size_t c = list.find(',', p); if (c == std::string::npos) c = list.size(); ks.push_back(std::stoi(list.substr(p, c - p))); p = c + 1; }
        kills[std::stoi(f[1])] = ks;
      } else if (line[0] == 'T') items.push_back({f[1], std::stoi(f[2])});
      else if (line[0] == 'U') items.push_back({f[1], -1});
    }

    size_t cap = 1; while (cap < items.size() * 2) cap <<= 1;
    slots.assign(cap, Entry{});
    mask = cap - 1;
    for (auto& it : items) {
      uint64_t h = fnv(it.first.data(), it.first.size());
      size_t i = h & mask;
      while (slots[i].used) i = (i + 1) & mask;
      slots[i] = Entry{h, it.first, it.second, true};
    }
  }

  // -2: not in table
  int find(const char* p, size_t n) const {
    uint64_t h = fnv(p, n);
    for (size_t i = h & mask;; i = (i + 1) & mask) {
      const Entry& e = slots[i];
      if (!e.used) return -2;
      if (e.hash == h && e.key.size() == n && std::memcmp(e.key.data(), p, n) == 0) return e.group;
    }
  }

  std::vector<std::vector<int>> kills;

private:
  std::vector<Entry> slots;
  size_t mask = 0;
};

struct Tok { uint64_t modKey; int group; const char* p; uint32_t n; };

static bool parseToken(const Table& t, const char* p, size_t n, Tok& out) {
  std::string_view parts[16];
  int np = 0, depth = 0;
  size_t start = 0;
  for (size_t i = 0; i < n; i++) {
    const char c = p[i];
    if (c == '[' || c == '(') depth++;
    else if (c == ']' || c == ')') depth--;
    else if (c == ':' && depth == 0 && np < 15) { parts[np++] = std::string_view(p + start, i - start); start = i + 1; }
  }
  const char* b = p + start;
  size_t bn = n - start;
  bool important = false;
  if (bn && b[0] == '!') { important = true; b++; bn--; }
  if (bn && b[bn - 1] == '!') { important = true; bn--; }
  int run = 0;
  for (int i = 0; i <= np; i++) if (i == np || parts[i].front() == '[') { std::sort(parts + run, parts + i); run = i + 1; }
  uint64_t h = 1469598103934665603ULL;
  for (int i = 0; i < np; i++) { h = fnv(parts[i].data(), parts[i].size(), h); h = fnv(":", 1, h); }
  if (important) h = fnv("!", 1, h);
  const int g = t.find(b, bn);
  if (g == -2) return false;       // not in the table: caller falls back to the JS reference
  out = Tok{h, g, p, static_cast<uint32_t>(n)};
  return true;
}

// kept flags for a token list (back to front, like tailwind-merge)
static void resolve(const Table& t, const Tok* toks, size_t n, uint8_t* keep) {
  uint64_t seen[256];
  size_t ns = 0;
  for (size_t k = n; k-- > 0;) {
    keep[k] = 1;
    const Tok& tk = toks[k];
    if (tk.group < 0) continue;
    const uint64_t id = tk.modKey * 1000003ULL + static_cast<uint64_t>(tk.group);
    bool dup = false;
    for (size_t s = 0; s < ns; s++) if (seen[s] == id) { dup = true; break; }
    if (dup) { keep[k] = 0; continue; }
    for (int g : t.kills[tk.group]) if (ns < 256) seen[ns++] = tk.modKey * 1000003ULL + static_cast<uint64_t>(g);
  }
}

// parts -> string. returns false on fallback
static bool mergeStrings(const Table& t, const std::string* parts, size_t np, std::string& out) {
  Tok toks[96];
  uint8_t keep[96];
  size_t n = 0;
  for (size_t a = 0; a < np; a++) {
    const char* s = parts[a].data();
    const size_t len = parts[a].size();
    size_t i = 0;
    while (i < len) {
      while (i < len && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n')) i++;
      size_t j = i;
      while (j < len && s[j] != ' ' && s[j] != '\t' && s[j] != '\n') j++;
      if (j > i) {
        if (n >= 96 || !parseToken(t, s + i, j - i, toks[n])) return false;
        n++;
      }
      i = j;
    }
  }
  resolve(t, toks, n, keep);
  out.clear();
  for (size_t k = 0; k < n; k++) if (keep[k]) { if (!out.empty()) out += ' '; out.append(toks[k].p, toks[k].n); }
  return true;
}

int main() {
  Table table; table.load("table.tsv");
  std::ifstream in("cases.txt");
  std::string line;
  std::vector<std::vector<std::string>> cases;
  std::vector<std::string> expected;
  while (std::getline(in, line)) {
    const size_t rs = line.find('\x1e');
    if (rs == std::string::npos) continue;
    std::vector<std::string> parts; size_t s = 0;
    for (size_t i = 0; i <= rs; i++) if (i == rs || line[i] == '\x1f') { parts.push_back(line.substr(s, i - s)); s = i + 1; }
    cases.push_back(std::move(parts)); expected.push_back(line.substr(rs + 1));
  }

  size_t mismatch = 0, fallback = 0;
  std::string out;
  for (size_t i = 0; i < cases.size(); i++) {
    if (!mergeStrings(table, cases[i].data(), cases[i].size(), out)) { fallback++; continue; }
    if (out != expected[i]) mismatch++;
  }
  std::printf("string path: cases %zu  mismatches %zu  fallbacks %zu\n", cases.size(), mismatch, fallback);

  // pre-parse every distinct class string once (what the AOT table would hold): vector<Tok> per string
  std::vector<std::vector<std::vector<Tok>>> parsed(cases.size());
  for (size_t i = 0; i < cases.size(); i++) for (auto& part : cases[i]) {
    std::vector<Tok> v; const char* s = part.data(); size_t len = part.size(), a = 0;
    while (a < len) {
      while (a < len && s[a] == ' ') a++;
      size_t b = a; while (b < len && s[b] != ' ') b++;
      if (b > a) { Tok tk; if (parseToken(table, s + a, b - a, tk)) v.push_back(tk); }
      a = b;
    }
    parsed[i].push_back(std::move(v));
  }
  size_t idMismatch = 0;
  for (size_t i = 0; i < cases.size(); i++) {
    Tok toks[96]; uint8_t keep[96]; size_t n = 0;
    for (auto& v : parsed[i]) for (auto& tk : v) if (n < 96) toks[n++] = tk;
    resolve(table, toks, n, keep);
    std::string o;
    for (size_t k = 0; k < n; k++) if (keep[k]) { if (!o.empty()) o += ' '; o.append(toks[k].p, toks[k].n); }
    if (o != expected[i]) idMismatch++;
  }
  std::printf("id path   : mismatches %zu\n", idMismatch);

  const int reps = 60;
  size_t sink = 0;
  auto t0 = std::chrono::steady_clock::now();
  for (int r = 0; r < reps; r++) for (auto& c : cases) { mergeStrings(table, c.data(), c.size(), out); sink += out.size(); }
  double nsStr = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - t0).count() / (double(reps) * cases.size());

  t0 = std::chrono::steady_clock::now();
  for (int r = 0; r < reps; r++) for (size_t i = 0; i < cases.size(); i++) {
    Tok toks[96]; uint8_t keep[96]; size_t n = 0;
    for (auto& v : parsed[i]) for (auto& tk : v) if (n < 96) toks[n++] = tk;
    resolve(table, toks, n, keep);
    for (size_t k = 0; k < n; k++) sink += keep[k];
  }
  double nsId = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - t0).count() / (double(reps) * cases.size());

  std::printf("C++ string in/out : %.0f ns/call\nC++ pre-parsed ids: %.0f ns/call  (sink %zu)\n", nsStr, nsId, sink & 1);
  return (mismatch || idMismatch) ? 1 : 0;
}
