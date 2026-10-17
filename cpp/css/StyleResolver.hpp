#pragma once

// Uniwind's class resolution (UniwindStore.resolveStyles, Uniwind 1.12 core/native/store.ts), natively, from the table that
// src/uniwind/styleTable.ts builds once per session: every value is already evaluated for every theme, so resolving a className is
// splitting it, looking the classes up, keeping the winning style per property and copying values.
//
// `resolve` covers a className with no scoped theme and no scoped variables (the caller checks those). It does what resolveStyles
// does: the same split, the same conditions (width, theme, pressed / focused / disabled), the same precedence (minWidth,
// complexity, important), the winning inline variables (`--tw-leading`, ...) in place for the values that read them, the result in
// the same key order, and the post-processing that applies to table values (lineHeight under 6, visibility, border and outline
// colour). Everything else returns false and the caller runs Uniwind's own JS, so nothing here guesses: a class the table lists as
// fallback (or an Object.prototype name), a relative lineHeight with a fontSize that is not a number, a multi-line className with
// non-ASCII text (JS `\s` has Unicode spaces). cpp/harness/fixtures/resolver checks the results against Uniwind's own.
//
// One thread at a time: resolve uses scratch state of the instance.
#include <folly/container/F14Map.h>
#include <folly/dynamic.h>
#include <folly/json.h>
#include <cmath>
#include <cstdint>
#include <exception>
#include <limits>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace margelo::nitro::shadewind::css {

class StyleResolver {
public:
  /** A value of the table. `undefined` is a value of its own: the key is set, to undefined, as in Uniwind's result. */
  struct Value {
    folly::dynamic value;
    bool undefined = false;
  };

  /** isPressed / isFocused / isDisabled as resolveStyles sees them: unset (no state, or undefined) matches neither true nor false. */
  enum class Tri : int8_t { Unset = -1, False = 0, True = 1 };

  /** One key of the result: `value`, or (lineHeight scaled by fontSize) `number` when `value` is null. */
  struct Item {
    uint32_t property;
    const Value* value;
    double number;
  };

  struct Result {
    std::vector<Item> styles;
    std::vector<int> dependencies;
    uint32_t dependencySum = 0;

    void clear() {
      styles.clear();
      dependencies.clear();
      dependencySum = 0;
    }
  };

  /** Loads a table (version 2). On false the resolver is empty and resolve always returns false. */
  bool load(std::string_view json, std::string* error = nullptr) {
    clear();

    if (!read(json, error)) {
      clear();
      return false;
    }

    best_.assign(properties_.size(), nullptr);
    slot_.assign(properties_.size(), -1);
    winner_.assign(properties_.size(), -1);
    return true;
  }

  void clear() {
    themes_.clear();
    index_.clear();
    classes_.clear();
    values_.clear();
    propertyIds_.clear();
    properties_.clear();
    best_.clear();
    slot_.clear();
    winner_.clear();
    touched_.clear();
    order_.clear();
    unsupported_ = 0;
  }

  bool loaded() const { return !themes_.empty(); }
  const std::vector<std::string>& themes() const { return themes_; }
  size_t classCount() const { return classes_.size(); }
  /** Classes of the table this resolver could not read (they fall back like the table's own fallback list): 0 for a sound table. */
  size_t unsupportedCount() const { return unsupported_; }
  const std::string& propertyName(uint32_t property) const { return properties_[property]; }

  int themeIndex(std::string_view name) const {
    for (size_t i = 0; i < themes_.size(); i++) {
      if (themes_[i] == name) {
        return static_cast<int>(i);
      }
    }

    return -1;
  }

  /**
   * Resolves `className` for theme `theme` (an index of themes()) at screen width `width`. True: `out` is Uniwind's result. False:
   * resolve it with Uniwind's JS (`out` is then meaningless).
   */
  bool resolve(std::string_view className, int theme, double width, Tri pressed, Tri focused, Tri disabled, Result& out) {
    out.clear();

    if (theme < 0 || static_cast<size_t>(theme) >= themes_.size()) {
      return false;
    }

    const Scope scope(*this);
    uint32_t seen = 0;

    const auto apply = [&](std::string_view token) -> bool {
      const auto it = index_.find(token);

      if (it == index_.end()) {
        return true; // not a class: resolveStyles skips it
      }

      if (it->second == kFallback) {
        return false;
      }

      for (const Style& style : classes_[it->second]) {
        for (const uint8_t dependency : style.dependencies) {
          if (!(seen & (1u << dependency))) {
            seen |= 1u << dependency;
            out.dependencies.push_back(dependency);
          }

          out.dependencySum |= 1u << dependency;
        }

        if (style.minWidth > width || style.maxWidth < width || (style.theme != kAnyTheme && style.theme != theme) ||
            (style.active != Tri::Unset && pressed != style.active) || (style.focus != Tri::Unset && focused != style.focus) ||
            (style.disabled != Tri::Unset && disabled != style.disabled)) {
          continue;
        }

        for (const Entry& entry : style.entries) {
          const uint32_t property = entry.property;
          const Style* previous = best_[property];

          if (previous) {
            const bool previousWins = previous->minWidth > style.minWidth || previous->complexity > style.complexity ||
                (previous->complexity == style.complexity && previous->isImportant(property));

            if (previousWins) {
              continue;
            }
          } else {
            touched_.push_back(property);
          }

          if (entry.kind == Entry::Kind::Define) {
            winner_[property] = entry.provider;
          } else if (slot_[property] < 0) {
            slot_[property] = static_cast<int32_t>(order_.size());
            order_.push_back(&entry);
          } else {
            order_[slot_[property]] = &entry; // a later winner keeps the key's first position, as an object property does
          }

          best_[property] = &style;
        }
      }

      return true;
    };

    if (className.find('\n') != std::string_view::npos) {
      // split(/\s+/).filter(Boolean)
      size_t start = std::string_view::npos;

      for (size_t i = 0; i <= className.size(); i++) {
        const unsigned char c = i < className.size() ? static_cast<unsigned char>(className[i]) : ' ';

        if (c >= 0x80) {
          return false;
        }

        const bool space = c == ' ' || (c >= '\t' && c <= '\r');

        if (!space && start == std::string_view::npos) {
          start = i;
        } else if (space && start != std::string_view::npos) {
          if (!apply(className.substr(start, i - start))) {
            return false;
          }

          start = std::string_view::npos;
        }
      }
    } else {
      // split(' '): empty tokens and tokens with other whitespace are not classes
      size_t start = 0;

      while (start <= className.size()) {
        size_t end = className.find(' ', start);

        if (end == std::string_view::npos) {
          end = className.size();
        }

        if (end > start && !apply(className.substr(start, end - start))) {
          return false;
        }

        start = end + 1;
      }
    }

    // values, in the order their keys were first set
    out.styles.reserve(order_.size() + 3);

    for (const Entry* entry : order_) {
      uint32_t values = entry->values;

      if (entry->kind == Entry::Kind::Read) {
        if (const int32_t provider = winner_[entry->variable]; provider >= 0) {
          bool found = false;

          for (const auto& [id, offset] : entry->by) {
            if (id == provider) {
              values = offset;
              found = true;
              break;
            }
          }

          if (!found) {
            return false;
          }
        }
      }

      out.styles.push_back({entry->property, &values_[values + theme], 0});
    }

    // resolveStyles' post-processing of the values a table can hold
    const auto at = [&](uint32_t property) -> Item* {
      const int32_t index = slot_[property];
      return index < 0 ? nullptr : &out.styles[index];
    };
    const auto isUndefined = [](const Item* item) { return !item || (item->value && item->value->undefined); };
    const auto set = [&](uint32_t property, const Value* value) {
      if (Item* item = at(property)) {
        *item = {property, value, 0};
      } else {
        slot_[property] = static_cast<int32_t>(out.styles.size());
        touched_.push_back(property);
        out.styles.push_back({property, value, 0});
      }
    };

    if (Item* lineHeight = at(lineHeight_); !isUndefined(lineHeight)) {
      if (!lineHeight->value->value.isNumber()) {
        return false;
      }

      const double height = lineHeight->value->value.asDouble();

      if (height < 6) {
        const Item* fontSize = at(fontSize_);
        double size = std::numeric_limits<double>::quiet_NaN();

        if (!isUndefined(fontSize)) {
          if (!fontSize->value->value.isNumber()) {
            return false;
          }

          size = fontSize->value->value.asDouble();
        }

        lineHeight->value = nullptr;
        lineHeight->number = height * size;
      }
    }

    if (const Item* visibility = at(visibility_);
        !isUndefined(visibility) && visibility->value->value.isString() && visibility->value->value.getString() == "hidden") {
      set(display_, &none_);
    }

    if (!isUndefined(at(borderStyle_)) && isUndefined(at(borderColor_))) {
      set(borderColor_, &black_);
    }

    if (!isUndefined(at(outlineStyle_)) && isUndefined(at(outlineColor_))) {
      set(outlineColor_, &black_);
    }

    return true;
  }

private:
  static constexpr uint32_t kFallback = UINT32_MAX;
  static constexpr int kAnyTheme = -1;
  static constexpr int kNoSuchTheme = -2;

  struct Entry {
    enum class Kind : uint8_t { Value, Define, Read };

    Kind kind = Kind::Value;
    uint32_t property = 0; // the style property, or the variable a Define sets
    uint32_t values = 0; // Value, and Read with no definition of its variable: values_[values + theme]
    int32_t provider = -1; // Define
    uint32_t variable = 0; // Read
    std::vector<std::pair<int32_t, uint32_t>> by; // Read: definition (provider) -> values
  };

  struct Style {
    double minWidth = 0;
    double maxWidth = 0;
    double complexity = 0;
    int theme = kAnyTheme;
    Tri active = Tri::Unset;
    Tri focus = Tri::Unset;
    Tri disabled = Tri::Unset;
    std::vector<uint32_t> important;
    std::vector<uint8_t> dependencies;
    std::vector<Entry> entries;

    bool isImportant(uint32_t property) const {
      for (const uint32_t p : important) {
        if (p == property) {
          return true;
        }
      }

      return false;
    }
  };

  // clears the per-call state on every return
  struct Scope {
    StyleResolver& self;

    explicit Scope(StyleResolver& resolver) : self(resolver) {}

    ~Scope() {
      for (const uint32_t property : self.touched_) {
        self.best_[property] = nullptr;
        self.slot_[property] = -1;
        self.winner_[property] = -1;
      }

      self.touched_.clear();
      self.order_.clear();
    }
  };

  bool read(std::string_view json, std::string* error) {
    try {
      const folly::dynamic doc = folly::parseJson(json);

      if (!doc.isObject() || doc.getDefault("version", 0) != 2) {
        return fail(error, "not a version 2 table");
      }

      const folly::dynamic* themes = doc.get_ptr("themes");
      const folly::dynamic* classes = doc.get_ptr("classes");

      if (!themes || !themes->isArray() || themes->empty() || !classes || !classes->isObject()) {
        return fail(error, "no themes or classes");
      }

      for (const auto& theme : *themes) {
        if (!theme.isString()) {
          return fail(error, "theme is not a string");
        }

        themes_.push_back(theme.getString());
      }

      for (const char* list : {"reserved", "fallback"}) {
        if (const folly::dynamic* names = doc.get_ptr(list); names && names->isArray()) {
          for (const auto& name : *names) {
            if (name.isString()) {
              index_[name.getString()] = kFallback;
            }
          }
        }
      }

      lineHeight_ = intern("lineHeight");
      fontSize_ = intern("fontSize");
      visibility_ = intern("visibility");
      display_ = intern("display");
      borderStyle_ = intern("borderStyle");
      borderColor_ = intern("borderColor");
      outlineStyle_ = intern("outlineStyle");
      outlineColor_ = intern("outlineColor");

      for (const auto& [name, styles] : classes->items()) {
        if (!name.isString() || index_.count(name.getString())) {
          continue;
        }

        std::vector<Style> parsed;

        if (parseClass(styles, parsed)) {
          index_[name.getString()] = static_cast<uint32_t>(classes_.size());
          classes_.push_back(std::move(parsed));
        } else {
          index_[name.getString()] = kFallback;
          unsupported_++;
        }
      }
    } catch (const std::exception& e) {
      return fail(error, e.what());
    }

    return true;
  }

  static bool fail(std::string* error, std::string_view message) {
    if (error) {
      *error = std::string(message);
    }

    return false;
  }

  uint32_t intern(const std::string& name) {
    const auto [it, inserted] = propertyIds_.try_emplace(name, static_cast<uint32_t>(properties_.size()));

    if (inserted) {
      properties_.push_back(name);
    }

    return it->second;
  }

  static bool readTri(const folly::dynamic& value, Tri& out) {
    if (value.isNull()) {
      out = Tri::Unset;
    } else if (value.isBool()) {
      out = value.getBool() ? Tri::True : Tri::False;
    } else {
      return false;
    }

    return true;
  }

  // one value per theme, appended to values_
  bool readValues(const folly::dynamic& list, uint32_t& offset) {
    if (!list.isArray() || list.size() != themes_.size()) {
      return false;
    }

    offset = static_cast<uint32_t>(values_.size());

    // markers for what JSON has no literal for: undefined, NaN, Infinity
    for (const auto& value : list) {
      const folly::dynamic* infinity = value.isObject() && value.size() == 1 ? value.get_ptr("$inf") : nullptr;

      if (value.isObject() && value.size() == 1 && value.count("$u")) {
        values_.push_back({nullptr, true});
      } else if (value.isObject() && value.size() == 1 && value.count("$nan")) {
        values_.push_back({std::numeric_limits<double>::quiet_NaN(), false});
      } else if (infinity && infinity->isNumber()) {
        values_.push_back({infinity->asDouble() * std::numeric_limits<double>::infinity(), false});
      } else {
        values_.push_back({value, false});
      }
    }

    return true;
  }

  bool parseClass(const folly::dynamic& styles, std::vector<Style>& out) {
    if (!styles.isArray()) {
      return false;
    }

    for (const auto& item : styles) {
      if (!item.isObject()) {
        return false;
      }

      Style style;
      const folly::dynamic minWidth = item.getDefault("minWidth");
      const folly::dynamic maxWidth = item.getDefault("maxWidth");
      const folly::dynamic complexity = item.getDefault("complexity");
      const folly::dynamic theme = item.getDefault("theme");

      // maxWidth null: Infinity (JSON has no Infinity)
      if (!minWidth.isNumber() || !(maxWidth.isNumber() || maxWidth.isNull()) || !complexity.isNumber()) {
        return false;
      }

      style.minWidth = minWidth.asDouble();
      style.maxWidth = maxWidth.isNull() ? std::numeric_limits<double>::infinity() : maxWidth.asDouble();
      style.complexity = complexity.asDouble();

      if (theme.isString()) {
        const int index = themeIndex(theme.getString());
        style.theme = index < 0 ? kNoSuchTheme : index;
      } else if (!theme.isNull()) {
        return false;
      }

      if (!readTri(item.getDefault("active"), style.active) || !readTri(item.getDefault("focus"), style.focus) ||
          !readTri(item.getDefault("disabled"), style.disabled)) {
        return false;
      }

      const folly::dynamic* important = item.get_ptr("important");
      const folly::dynamic* dependencies = item.get_ptr("deps");
      const folly::dynamic* entries = item.get_ptr("entries");

      if (!important || !important->isArray() || !dependencies || !dependencies->isArray() || !entries || !entries->isArray()) {
        return false;
      }

      for (const auto& name : *important) {
        if (!name.isString()) {
          return false;
        }

        style.important.push_back(intern(name.getString()));
      }

      for (const auto& dependency : *dependencies) {
        if (!dependency.isInt() || dependency.getInt() < 0 || dependency.getInt() > 31) {
          return false;
        }

        style.dependencies.push_back(static_cast<uint8_t>(dependency.getInt()));
      }

      for (const auto& pair : *entries) {
        if (!pair.isArray() || pair.size() != 2 || !pair[0].isString() || pair[0].getString().empty()) {
          return false;
        }

        Entry entry;
        entry.property = intern(pair[0].getString());
        const folly::dynamic& spec = pair[1];

        if (spec.isArray()) {
          entry.kind = Entry::Kind::Value;

          if (pair[0].getString()[0] == '-' || !readValues(spec, entry.values)) {
            return false;
          }
        } else if (const folly::dynamic* def = spec.isObject() ? spec.get_ptr("def") : nullptr) {
          if (!def->isInt() || pair[0].getString()[0] != '-') {
            return false;
          }

          entry.kind = Entry::Kind::Define;
          entry.provider = static_cast<int32_t>(def->getInt());
        } else if (const folly::dynamic* variable = spec.isObject() ? spec.get_ptr("var") : nullptr) {
          const folly::dynamic* none = spec.get_ptr("none");
          const folly::dynamic* by = spec.get_ptr("by");

          if (!variable->isString() || !none || !by || !by->isObject() || pair[0].getString()[0] == '-' ||
              !readValues(*none, entry.values)) {
            return false;
          }

          entry.kind = Entry::Kind::Read;
          entry.variable = intern(variable->getString());

          for (const auto& [id, list] : by->items()) {
            uint32_t offset = 0;

            if (!id.isString() || !readValues(list, offset)) {
              return false;
            }

            entry.by.emplace_back(static_cast<int32_t>(std::stol(id.getString())), offset);
          }
        } else {
          return false;
        }

        style.entries.push_back(std::move(entry));
      }

      out.push_back(std::move(style));
    }

    return true;
  }

  std::vector<std::string> themes_;
  folly::F14FastMap<std::string, uint32_t> index_; // class -> classes_, or kFallback
  std::vector<std::vector<Style>> classes_;
  std::vector<Value> values_;
  folly::F14FastMap<std::string, uint32_t> propertyIds_; // style properties and inline variables share one id space
  std::vector<std::string> properties_;
  size_t unsupported_ = 0;

  uint32_t lineHeight_ = 0, fontSize_ = 0, visibility_ = 0, display_ = 0;
  uint32_t borderStyle_ = 0, borderColor_ = 0, outlineStyle_ = 0, outlineColor_ = 0;
  const Value none_{"none", false};
  const Value black_{"#000000", false};

  // per call, indexed by property id
  std::vector<const Style*> best_;
  std::vector<int32_t> slot_;
  std::vector<int32_t> winner_;
  std::vector<uint32_t> touched_;
  std::vector<const Entry*> order_;
};

} // namespace margelo::nitro::shadewind::css
