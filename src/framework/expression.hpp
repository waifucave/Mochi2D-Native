// Expression files `*.exp3.json` (3d), the expression queue (3m) and
// expression layers: port of Mochi2D's src/anim/expression.ts.
#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string_view>

#include "framework/jsutil.hpp"
#include "framework/values.hpp"
#include "util/alloc.hpp"
#include "util/json.hpp"

namespace mochi2d::framework {

enum class ExpressionBlend : uint8_t { Add, Multiply, Overwrite };

struct ExpressionParameter {
  String id;
  double value = 0;
  ExpressionBlend blend = ExpressionBlend::Add;
};

struct Expression {
  String label;
  double fade_in = 1, fade_out = 1;
  Vector<ExpressionParameter> parameters;
};

/** Reads an expression file (any fade time is accepted, a negative one included). */
bool parse_expression(std::string_view bytes, std::string_view label, Expression& out, FormatError& error);
bool expression_from_json(const json::Value& json, std::string_view label, Expression& out, FormatError& error);

/** An expression's contributions by ID: the first entry of each ID, in file order. */
struct ExpressionContributions {
  explicit ExpressionContributions(const Expression& e);
  Vector<ExpressionParameter> list;
  /** The contribution for an ID, or nullptr. */
  const ExpressionParameter* find(const String& id) const;

 private:
  HashMap<String, std::size_t> index_;
};

/** The expression queue of 3m. */
class ExpressionQueue {
 public:
  /** The queue clock T_x. */
  double time = 0;

  bool empty() const { return entries_.empty(); }
  /** Expressions in the queue, oldest first. */
  Vector<std::shared_ptr<const Expression>> expressions() const;
  /** 3m.1: older entries are asked to fade out; the new one is appended. */
  void start(std::shared_ptr<const Expression> expression);
  /** 3m.3: advances the queue by dt and writes the tracked values. */
  void advance(double dt, AnimationValues& values);

 private:
  struct Entry {
    std::shared_ptr<const Expression> expression;
    ExpressionContributions by_id;
    bool started = false;
    double f = 0;
    bool has_e = false;
    double e = 0;
    bool fade_out_requested = false;
  };
  struct Tracked {
    String id;
    double A = 0, M = 1, O = 0;
  };
  Vector<Entry> entries_;
  Vector<Tracked> tracked_;
  HashSet<String> tracked_ids_;
};

/**
 * Expressions added on top of the expression queue, several at once (not
 * reference behavior). Each layer fades in and, when removed, out with its
 * file's times, and applies the one-expression formula of 3m blended by its
 * weight w, in the order the layers were added: Add v + w·a, Multiply
 * v·(1 + w·(m − 1)), Overwrite v + w·(o − v).
 */
class ExpressionLayers {
 public:
  /** The layer clock. */
  double time = 0;

  bool empty() const { return layers_.empty(); }
  /** The layers that are not fading out, oldest first. */
  Vector<std::shared_ptr<const Expression>> active() const;
  /** Every layer, fading out ones included, oldest first. */
  Vector<std::shared_ptr<const Expression>> all() const;
  /**
   * Adds an expression (its label identifies it). Returns false, changing
   * nothing, when an active layer has the same label.
   */
  bool add(std::shared_ptr<const Expression> expression);
  /**
   * Fades out the active layers with this label (every one without a label),
   * over `fade_out` seconds (0.13.0) or, without it, the fade-out each was
   * added with; returns how many.
   */
  std::size_t remove(const String* label, const double* fade_out = nullptr);
  /** Removes every layer at once. */
  void clear() { layers_.clear(); }
  /** Advances the layer clock by dt and applies the layers. */
  void advance(double dt, AnimationValues& values);

 private:
  struct Layer {
    std::shared_ptr<const Expression> expression;
    ExpressionContributions by_id;
    bool has_f = false;
    double f = 0;
    bool has_e = false;
    double e = 0;
    /** The fade-out time removal uses: the expression's, or the one removal gave. */
    double out = 0;
  };
  Vector<Layer> layers_;
};

}  // namespace mochi2d::framework
