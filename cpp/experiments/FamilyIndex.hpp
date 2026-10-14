#pragma once
// FamilyIndex: a flat, open-addressing pointer -> uint32 map that probes 16 slots per step with SIMD
// (NEON on arm64, SSE2 on x86-64, a portable loop otherwise). This is the Swiss-table idea:
//   1 control byte per slot = 7-bit hash tag (or EMPTY / DELETED),
//   one vector compare tests 16 tags at once, a bitmask names the candidate slots, only those keys are read.
// Intended use: ThemeHook::walkTree asks "is this ShadowNodeFamily registered?" once per node per commit.
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>

#if defined(__ARM_NEON)
#include <arm_neon.h>
#define FI_NEON 1
#elif defined(__SSE2__)
#include <emmintrin.h>
#define FI_SSE2 1
#endif

class FamilyIndex {
public:
  static constexpr uint32_t kNotFound = 0xFFFFFFFFu;
  using Mask = uint64_t;

  explicit FamilyIndex(size_t expected = 64) { rehash(groupsFor(expected)); }

  uint32_t find(const void* key) const noexcept {
    const uint64_t h = hash(key);
    const uint8_t tag = h2(h);
    size_t g = h1(h) & _groupMask;

    for (;;) {
      const uint8_t* ctrl = _ctrl.get() + g * 16;
      Mask match = matchTag(ctrl, tag);

      while (match) {
        const unsigned bit = lane(match);
        const size_t slot = g * 16 + bit;

        if (_keys[slot] == key) {
          return _values[slot];
        }

        match &= match - 1;
      }

      if (matchEmpty(ctrl)) {
        return kNotFound; // an EMPTY slot ends the probe: the key was never placed past this group
      }

      g = (g + 1) & _groupMask;
    }
  }

  void insert(const void* key, uint32_t value) {
    if ((_size + _deleted + 1) * 8 > (_groupMask + 1) * 16 * 7) { // load factor 7/8
      rehash((_groupMask + 1) * 2);
    }

    const uint64_t h = hash(key);
    const uint8_t tag = h2(h);
    size_t g = h1(h) & _groupMask;

    for (;;) {
      uint8_t* ctrl = _ctrl.get() + g * 16;
      Mask match = matchTag(ctrl, tag);

      while (match) {
        const size_t slot = g * 16 + lane(match);

        if (_keys[slot] == key) {
          _values[slot] = value;
          return;
        }

        match &= match - 1;
      }

      const Mask free = matchEmptyOrDeleted(ctrl);

      if (free) {
        const size_t slot = g * 16 + lane(free);

        if (ctrl[lane(free)] == kDeleted) {
          --_deleted;
        }

        ctrl[lane(free)] = tag;
        _keys[slot] = key;
        _values[slot] = value;
        ++_size;

        return;
      }

      g = (g + 1) & _groupMask;
    }
  }

  void erase(const void* key) noexcept {
    const uint64_t h = hash(key);
    const uint8_t tag = h2(h);
    size_t g = h1(h) & _groupMask;

    for (;;) {
      uint8_t* ctrl = _ctrl.get() + g * 16;
      Mask match = matchTag(ctrl, tag);

      while (match) {
        const unsigned bit = lane(match);
        const size_t slot = g * 16 + bit;

        if (_keys[slot] == key) {
          ctrl[bit] = kDeleted;
          _keys[slot] = nullptr;
          --_size;
          ++_deleted;

          return;
        }

        match &= match - 1;
      }

      if (matchEmpty(ctrl)) {
        return;
      }

      g = (g + 1) & _groupMask;
    }
  }

  size_t size() const noexcept { return _size; }

private:
  static constexpr uint8_t kEmpty = 0x80;
  static constexpr uint8_t kDeleted = 0xFE;

  static uint64_t hash(const void* p) noexcept {
    uint64_t x = reinterpret_cast<uintptr_t>(p);
    x ^= x >> 33;
    x *= 0xff51afd7ed558ccdULL; // murmur3 finalizer: pointers share low zero bits and a common high prefix
    x ^= x >> 33;
    x *= 0xc4ceb9fe1a85ec53ULL;
    x ^= x >> 33;

    return x;
  }

  static uint8_t h2(uint64_t h) noexcept { return static_cast<uint8_t>(h & 0x7F); }
  static size_t h1(uint64_t h) noexcept { return static_cast<size_t>(h >> 7); }

  static size_t groupsFor(size_t expected) noexcept {
    size_t g = 1;

    while (g * 16 * 7 < expected * 8) {
      g <<= 1;
    }

    return g;
  }

#if FI_NEON
  // vshrn gives 4 bits per input lane in a 64-bit word; keep the top bit of each nibble: bit 4*i+3 <=> lane i matched.
  static Mask laneMask(uint8x16_t eq) noexcept {
    const uint8x8_t narrowed = vshrn_n_u16(vreinterpretq_u16_u8(eq), 4);

    return vget_lane_u64(vreinterpret_u64_u8(narrowed), 0) & 0x8888888888888888ULL;
  }

  static unsigned lane(Mask m) noexcept { return static_cast<unsigned>(__builtin_ctzll(m)) >> 2; }

  static Mask matchTag(const uint8_t* ctrl, uint8_t tag) noexcept {
    return laneMask(vceqq_u8(vld1q_u8(ctrl), vdupq_n_u8(tag)));
  }

  static Mask matchEmpty(const uint8_t* ctrl) noexcept {
    return laneMask(vceqq_u8(vld1q_u8(ctrl), vdupq_n_u8(kEmpty)));
  }

  static Mask matchEmptyOrDeleted(const uint8_t* ctrl) noexcept {
    return laneMask(vcgeq_u8(vld1q_u8(ctrl), vdupq_n_u8(kEmpty))); // tags are < 0x80, EMPTY/DELETED are >= 0x80
  }
#elif FI_SSE2
  static unsigned lane(Mask m) noexcept { return static_cast<unsigned>(__builtin_ctzll(m)); }

  static Mask matchTag(const uint8_t* ctrl, uint8_t tag) noexcept {
    return static_cast<uint32_t>(
        _mm_movemask_epi8(_mm_cmpeq_epi8(_mm_loadu_si128(reinterpret_cast<const __m128i*>(ctrl)), _mm_set1_epi8(static_cast<char>(tag)))));
  }

  static Mask matchEmpty(const uint8_t* ctrl) noexcept {
    return matchTag(ctrl, kEmpty);
  }

  static Mask matchEmptyOrDeleted(const uint8_t* ctrl) noexcept {
    return static_cast<Mask>(_mm_movemask_epi8(_mm_loadu_si128(reinterpret_cast<const __m128i*>(ctrl)))); // high bit set
  }
#else
  static unsigned lane(Mask m) noexcept { return static_cast<unsigned>(__builtin_ctzll(m)); }

  static Mask matchTag(const uint8_t* ctrl, uint8_t tag) noexcept {
    Mask m = 0;

    for (int i = 0; i < 16; i++) {
      m |= static_cast<Mask>(ctrl[i] == tag) << i;
    }

    return m;
  }

  static Mask matchEmpty(const uint8_t* ctrl) noexcept { return matchTag(ctrl, kEmpty); }

  static Mask matchEmptyOrDeleted(const uint8_t* ctrl) noexcept {
    Mask m = 0;

    for (int i = 0; i < 16; i++) {
      m |= static_cast<Mask>(ctrl[i] >= kEmpty) << i;
    }

    return m;
  }
#endif

  void rehash(size_t groups) {
    auto oldCtrl = std::move(_ctrl);
    auto oldKeys = std::move(_keys);
    auto oldValues = std::move(_values);
    const size_t oldSlots = (_groupMask + 1) * 16;
    const bool hadOld = oldCtrl != nullptr;

    _groupMask = groups - 1;
    _ctrl.reset(new uint8_t[groups * 16]);
    std::memset(_ctrl.get(), kEmpty, groups * 16);
    _keys.reset(new const void*[groups * 16]());
    _values.reset(new uint32_t[groups * 16]);
    _size = 0;
    _deleted = 0;

    if (hadOld) {
      for (size_t i = 0; i < oldSlots; i++) {
        if (oldCtrl[i] < kEmpty) {
          insert(oldKeys[i], oldValues[i]);
        }
      }
    }
  }

  std::unique_ptr<uint8_t[]> _ctrl;
  std::unique_ptr<const void*[]> _keys;
  std::unique_ptr<uint32_t[]> _values;
  size_t _groupMask = 0;
  size_t _size = 0;
  size_t _deleted = 0;
};
