#pragma once

// CSS colour -> ARGB (0xAARRGGBB), no allocation, no exceptions.
//
// Supported: #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba(), hsl()/hsla(), oklch(), `transparent`, a small named set.
// Both the comma syntax and the space + `/ alpha` syntax are accepted; numbers may be percentages.
//
// Policy (must match the build-time pipeline, see docs/ARCHITECTURE.md section 11): channels are clamped to [0, 1] after the
// colour-space conversion (no gamut mapping), alpha is kept and rounded to 8 bits.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string_view>

namespace margelo::nitro::shadewind::css {

namespace detail {

inline bool isSpace(char c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

inline char lower(char c) {
  return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c;
}

inline bool equalsIgnoreCase(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) {
    return false;
  }

  for (size_t i = 0; i < a.size(); i++) {
    if (lower(a[i]) != b[i]) {
      return false;
    }
  }

  return true;
}

inline std::optional<uint32_t> hexDigit(char c) {
  if (c >= '0' && c <= '9') {
    return static_cast<uint32_t>(c - '0');
  }

  c = lower(c);

  if (c >= 'a' && c <= 'f') {
    return static_cast<uint32_t>(c - 'a' + 10);
  }

  return std::nullopt;
}

inline uint8_t toByte(double v) {
  return static_cast<uint8_t>(std::lround(std::clamp(v, 0.0, 1.0) * 255.0));
}

inline uint32_t pack(double r, double g, double b, double a) {
  return (static_cast<uint32_t>(toByte(a)) << 24) | (static_cast<uint32_t>(toByte(r)) << 16) |
         (static_cast<uint32_t>(toByte(g)) << 8) | static_cast<uint32_t>(toByte(b));
}

// sRGB transfer function (linear -> encoded), sign preserving so slightly out-of-gamut values clamp, not NaN
inline double encode(double x) {
  const double a = std::fabs(x);
  const double e = a <= 0.0031308 ? 12.92 * a : 1.055 * std::pow(a, 1.0 / 2.4) - 0.055;

  return x < 0 ? -e : e;
}

struct Number {
  double value = 0;
  bool percent = false;
  bool angle = false; // has a deg/turn/rad/grad unit (already converted to degrees)
};

// parses one number with an optional unit starting at `pos`; moves `pos` past it
inline bool parseNumber(std::string_view s, size_t& pos, Number& out) {
  while (pos < s.size() && isSpace(s[pos])) {
    pos++;
  }

  if (pos >= s.size()) {
    return false;
  }

  // strtod needs a NUL-terminated buffer; copy the token (numbers are short)
  char buf[48];
  size_t n = 0;
  size_t p = pos;

  while (p < s.size() && n < sizeof(buf) - 1 && (std::isdigit(static_cast<unsigned char>(s[p])) || s[p] == '.' || s[p] == '-' ||
                                                  s[p] == '+' || s[p] == 'e' || s[p] == 'E')) {
    // an 'e' that starts a unit (none of ours do) is not handled; css numbers here never need it
    buf[n++] = s[p++];
  }

  if (n == 0) {
    return false;
  }

  buf[n] = '\0';
  char* end = nullptr;
  out.value = std::strtod(buf, &end);

  if (end == buf) {
    return false;
  }

  // consume the part strtod did not use (e.g. a trailing 'e' that was not an exponent)
  p = pos + static_cast<size_t>(end - buf);
  out.percent = false;
  out.angle = false;

  if (p < s.size() && s[p] == '%') {
    out.percent = true;
    p++;
  } else {
    size_t u = p;

    while (u < s.size() && std::isalpha(static_cast<unsigned char>(s[u]))) {
      u++;
    }

    const std::string_view unit = s.substr(p, u - p);

    if (!unit.empty()) {
      if (equalsIgnoreCase(unit, "deg")) {
        out.angle = true;
      } else if (equalsIgnoreCase(unit, "rad")) {
        out.value = out.value * 180.0 / M_PI;
        out.angle = true;
      } else if (equalsIgnoreCase(unit, "turn")) {
        out.value = out.value * 360.0;
        out.angle = true;
      } else if (equalsIgnoreCase(unit, "grad")) {
        out.value = out.value * 0.9;
        out.angle = true;
      } else {
        return false;
      }

      p = u;
    }
  }

  pos = p;

  return true;
}

// reads up to 4 components of a functional notation body, separated by spaces, commas or '/'
inline int parseComponents(std::string_view s, size_t pos, Number* out, int maxCount) {
  int count = 0;

  while (count < maxCount) {
    while (pos < s.size() && (isSpace(s[pos]) || s[pos] == ',' || s[pos] == '/')) {
      pos++;
    }

    if (pos >= s.size() || s[pos] == ')') {
      break;
    }

    if (equalsIgnoreCase(s.substr(pos, 4), "none")) { // CSS "none" component = 0
      out[count++] = Number{};
      pos += 4;

      continue;
    }

    if (!parseNumber(s, pos, out[count])) {
      return -1;
    }

    count++;
  }

  return count;
}

inline double hueToRgb(double p, double q, double t) {
  if (t < 0) {
    t += 1;
  }

  if (t > 1) {
    t -= 1;
  }

  if (t < 1.0 / 6) {
    return p + (q - p) * 6 * t;
  }

  if (t < 1.0 / 2) {
    return q;
  }

  if (t < 2.0 / 3) {
    return p + (q - p) * (2.0 / 3 - t) * 6;
  }

  return p;
}

} // namespace detail

/** Parses a CSS colour. Returns std::nullopt when the text is not a supported colour. */
inline std::optional<uint32_t> parseColor(std::string_view s) {
  using namespace detail;

  while (!s.empty() && isSpace(s.front())) {
    s.remove_prefix(1);
  }

  while (!s.empty() && isSpace(s.back())) {
    s.remove_suffix(1);
  }

  if (s.empty()) {
    return std::nullopt;
  }

  if (s.front() == '#') {
    const std::string_view h = s.substr(1);
    uint32_t v[8];

    if (h.size() != 3 && h.size() != 4 && h.size() != 6 && h.size() != 8) {
      return std::nullopt;
    }

    for (size_t i = 0; i < h.size(); i++) {
      const auto d = hexDigit(h[i]);

      if (!d) {
        return std::nullopt;
      }

      v[i] = *d;
    }

    if (h.size() <= 4) {
      const uint32_t a = h.size() == 4 ? v[3] * 17 : 255;

      return (a << 24) | ((v[0] * 17) << 16) | ((v[1] * 17) << 8) | (v[2] * 17);
    }

    const uint32_t a = h.size() == 8 ? (v[6] << 4 | v[7]) : 255;

    return (a << 24) | ((v[0] << 4 | v[1]) << 16) | ((v[2] << 4 | v[3]) << 8) | (v[4] << 4 | v[5]);
  }

  if (equalsIgnoreCase(s, "transparent")) {
    return 0u;
  }

  if (equalsIgnoreCase(s, "white")) {
    return 0xFFFFFFFFu;
  }

  if (equalsIgnoreCase(s, "black")) {
    return 0xFF000000u;
  }

  const size_t open = s.find('(');

  if (open == std::string_view::npos || s.back() != ')') {
    return std::nullopt;
  }

  const std::string_view fn = s.substr(0, open);
  Number c[4];
  const int count = parseComponents(s, open + 1, c, 4);

  if (count < 3) {
    return std::nullopt;
  }

  double alpha = 1.0;

  if (count == 4) {
    alpha = c[3].percent ? c[3].value / 100.0 : c[3].value;
  }

  if (equalsIgnoreCase(fn, "rgb") || equalsIgnoreCase(fn, "rgba")) {
    const auto ch = [](const Number& n) { return n.percent ? n.value / 100.0 : n.value / 255.0; };

    return pack(ch(c[0]), ch(c[1]), ch(c[2]), alpha);
  }

  if (equalsIgnoreCase(fn, "hsl") || equalsIgnoreCase(fn, "hsla")) {
    double h = std::fmod(c[0].value, 360.0);

    if (h < 0) {
      h += 360.0;
    }

    h /= 360.0;
    const double sat = std::clamp(c[1].value / 100.0, 0.0, 1.0);
    const double lig = std::clamp(c[2].value / 100.0, 0.0, 1.0);

    if (sat == 0) {
      return pack(lig, lig, lig, alpha);
    }

    const double q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
    const double p = 2 * lig - q;

    return pack(hueToRgb(p, q, h + 1.0 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1.0 / 3), alpha);
  }

  if (equalsIgnoreCase(fn, "oklch")) {
    const double L = c[0].percent ? c[0].value / 100.0 : c[0].value;
    const double C = c[1].percent ? c[1].value / 100.0 * 0.4 : c[1].value;
    const double H = c[2].value * M_PI / 180.0;
    const double a = C * std::cos(H);
    const double b = C * std::sin(H);
    const double l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const double m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const double s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const double l = l_ * l_ * l_;
    const double m = m_ * m_ * m_;
    const double sv = s_ * s_ * s_;
    const double r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * sv;
    const double g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * sv;
    const double bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * sv;

    return pack(encode(r), encode(g), encode(bl), alpha);
  }

  return std::nullopt;
}

} // namespace margelo::nitro::shadewind::css
