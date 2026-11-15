// Port of Mochi2D's src/core/moc/io.ts (readMoc, checkMocDataShape, writeMoc).
#include "core/moc/io.hpp"

#include <algorithm>
#include <cstring>

namespace mochi2d::moc {

namespace {

Diagnostic error_diag(String code, String kind, String message,
                      std::optional<long long> index = std::nullopt,
                      std::optional<String> field = std::nullopt) {
  Diagnostic d;
  d.code = std::move(code);
  d.kind = std::move(kind);
  d.message = std::move(message);
  d.index = index;
  d.field = std::move(field);
  return d;
}

}  // namespace

bool read_moc(const uint8_t* bytes, std::size_t size, ReadResult& out, Error& err) {
  Sections s;
  if (!read_sections(bytes, size, true, s, err)) {
    // A set endianness byte with little-endian data (1b.7).
    if (size >= 64 && bytes[5] != 0) {
      Vector<uint8_t> copy(bytes, bytes + size);
      copy[5] = 0;
      Sections tmp;
      Error ignored;
      if (read_sections(copy.data(), copy.size(), true, tmp, ignored)) {
        err.code = "endianness";
        err.message = "the endianness byte (byte 5) is set, but the data is little-endian";
      }
    }
    return false;
  }
  out = ReadResult();
  for (const auto& i : s.issues) out.diagnostics.push_back(error_diag(i.code, "file", i.message));
  if (s.big_endian) {
    Diagnostic d = error_diag(
        "big-endian", "file",
        "big-endian file: Mochi2D and the official loader read it, but the official consistency check rejects it");
    d.warning = true;
    out.diagnostics.push_back(d);
  }
  out.version = s.version;
  out.data = std::move(s.data);
  // Placeholder arrays are not part of MocData.
  for (std::size_t fi = 0; fi < kFieldCount; fi++)
    if (all_fields()[fi].type == ElementType::Placeholder) out.data.fields[fi] = FieldArray{};
  return true;
}

Vector<Diagnostic> check_shape(const MocData& d, int version, Vector<int32_t>* counts_out) {
  Vector<Diagnostic> diags;
  if (!(version >= kMinVersion && version <= kMaxVersion)) {
    diags.push_back(error_diag("version", "file", "version " + to_str(version) + " is not a .moc3 version (1–6)"));
    return diags;
  }
  Vector<int32_t> counts(static_cast<std::size_t>(count_table_length(version)), 0);
  std::size_t ngroups;
  const GroupSpec* gs = groups(ngroups);
  auto check_names = [&](const GroupSpec& g, const FieldSpec& f, const String& label) {
    const auto& names = d.names(f.id);
    for (std::size_t i = 0; i < names.size(); i++) {
      const String& s = names[i];
      if (s.find('\0') != String::npos)
        diags.push_back(error_diag("name-nul", g.name, label + "[" + to_str(i) + "] contains a NUL character",
                                   static_cast<long long>(i), f.field ? std::optional<String>(f.field) : std::nullopt));
      else if (s.size() > 63)
        diags.push_back(error_diag("name-too-long", g.name,
                                   label + "[" + to_str(i) + "] \"" + s + "\" is " + to_str(s.size()) +
                                       " bytes in UTF-8; IDs are at most 63",
                                   static_cast<long long>(i), f.field ? std::optional<String>(f.field) : std::nullopt));
    }
  };
  for (std::size_t gi = 0; gi < ngroups; gi++) {
    const GroupSpec& g = gs[gi];
    bool any = false;
    for (std::size_t k = 0; k < g.field_count; k++) any = any || d[g.fields[k]].present;
    if (g.since > version) {
      if (any)
        diags.push_back(error_diag("field-not-in-version", g.name,
                                   String(g.name) + " needs version " + to_str(g.since) +
                                       " or later; version " + to_str(version) + " cannot hold it"));
      continue;
    }
    if (!any) {
      diags.push_back(error_diag("missing-field", g.name,
                                 String(g.name) + " is missing (version " + to_str(version) + " has it)"));
      continue;
    }
    if (g.pool) {
      const FieldSpec& f = spec(g.fields[0]);
      counts[static_cast<std::size_t>(g.count)] = static_cast<int32_t>(d.size(f.id));
      continue;
    }
    std::optional<std::size_t> length;
    String length_from;
    for (std::size_t k = 0; k < g.field_count; k++) {
      const FieldSpec& f = spec(g.fields[k]);
      const bool present = d[f.id].present;
      if (f.since > version) {
        if (present)
          diags.push_back(error_diag("field-not-in-version", g.name,
                                     String(g.name) + "." + f.field + " needs version " + to_str(f.since) +
                                         " or later; version " + to_str(version) + " cannot hold it",
                                     std::nullopt, String(f.field)));
        continue;
      }
      if (!present) {
        diags.push_back(error_diag("missing-field", g.name,
                                   String(g.name) + "." + f.field + " is missing (version " +
                                       to_str(version) + " has it)",
                                   std::nullopt, String(f.field)));
        continue;
      }
      if (f.type == ElementType::Name) check_names(g, f, String(g.name) + "." + f.field);
      const std::size_t n = d.size(f.id);
      if (!length) {
        length = n;
        length_from = f.field;
      } else if (n != *length) {
        diags.push_back(error_diag("length-mismatch", g.name,
                                   String(g.name) + "." + f.field + " has " + to_str(n) +
                                       " elements, but " + g.name + "." + length_from + " has " +
                                       to_str(*length) + ": the arrays of a group are parallel",
                                   std::nullopt, String(f.field)));
      }
    }
    if (length) counts[static_cast<std::size_t>(g.count)] = static_cast<int32_t>(*length);
  }
  for (std::size_t i = 0; i < counts.size(); i++)
    if (count_since(static_cast<int>(i)) > version) counts[i] = 0;
  if (diags.empty() && counts_out) *counts_out = std::move(counts);
  return diags;
}

namespace {

void put_u32(Vector<uint8_t>& b, std::size_t at, uint32_t v) {
  b[at] = static_cast<uint8_t>(v);
  b[at + 1] = static_cast<uint8_t>(v >> 8);
  b[at + 2] = static_cast<uint8_t>(v >> 16);
  b[at + 3] = static_cast<uint8_t>(v >> 24);
}

void put_f32(Vector<uint8_t>& b, std::size_t at, float f) {
  uint32_t u;
  std::memcpy(&u, &f, 4);
  put_u32(b, at, u);
}

Vector<uint8_t> encode(int version, const MocData& data, const Vector<int32_t>& counts) {
  const int slots = slot_table_length(version);
  const int count_entries = count_table_length(version);
  Vector<const FieldSpec*> fields;
  for (std::size_t i = 0; i < kFieldCount; i++)
    if (all_fields()[i].since <= version) fields.push_back(&all_fields()[i]);
  stable_sort(fields, [](const FieldSpec* a, const FieldSpec* b) { return a->slot < b->slot; });
  auto align = [](uint64_t x) { return (x + 63) / 64 * 64; };
  Vector<uint32_t> offsets(static_cast<std::size_t>(slots), 0);
  uint64_t end = kHeaderSize + static_cast<uint64_t>(slots) * 4;
  auto place = [&](uint64_t size, bool packed) -> uint64_t {
    const uint64_t start = packed && size > 0 ? end : align(end);
    if (size > 0) end = start + size;
    return start;
  };
  offsets[kCountTableSlot] = static_cast<uint32_t>(place(static_cast<uint64_t>(count_entries) * 4, false));
  offsets[kCanvasSlot] = static_cast<uint32_t>(place(kCanvasBlockSize, false));
  struct Placed {
    const FieldSpec* spec;
    uint64_t start;
    uint64_t count;
  };
  Vector<Placed> placed;
  for (const FieldSpec* f : fields) {
    const uint64_t count = static_cast<uint64_t>(counts[static_cast<std::size_t>(f->count)]);
    const uint64_t start = place(count * element_size(f->type), f->type == ElementType::Name);
    offsets[static_cast<std::size_t>(f->slot)] = static_cast<uint32_t>(start);
    placed.push_back({f, start, count});
  }
  Vector<uint8_t> bytes(static_cast<std::size_t>(align(end)), 0);
  std::memcpy(bytes.data(), "MOC3", 4);
  bytes[4] = static_cast<uint8_t>(version);
  for (int i = 0; i < slots; i++) put_u32(bytes, kHeaderSize + 4u * static_cast<unsigned>(i), offsets[static_cast<std::size_t>(i)]);
  for (int i = 0; i < count_entries; i++)
    put_u32(bytes, offsets[kCountTableSlot] + 4u * static_cast<unsigned>(i), static_cast<uint32_t>(counts[static_cast<std::size_t>(i)]));
  const std::size_t c = offsets[kCanvasSlot];
  put_f32(bytes, c, data.canvas.pixels_per_unit);
  put_f32(bytes, c + 4, data.canvas.origin_x);
  put_f32(bytes, c + 8, data.canvas.origin_y);
  put_f32(bytes, c + 12, data.canvas.width);
  put_f32(bytes, c + 16, data.canvas.height);
  bytes[c + 20] = data.canvas.flags;
  for (const auto& p : placed) {
    if (p.count == 0 || p.spec->type == ElementType::Placeholder) continue;
    const FieldArray& a = data[p.spec->id];
    const auto start = static_cast<std::size_t>(p.start);
    switch (p.spec->type) {
      case ElementType::Name:
        for (uint64_t i = 0; i < p.count; i++) {
          const String& s = a.names[i];
          std::memcpy(bytes.data() + start + i * 64, s.data(), std::min<std::size_t>(s.size(), 63));
        }
        break;
      case ElementType::I32:
        for (uint64_t i = 0; i < p.count; i++) put_u32(bytes, start + 4 * i, static_cast<uint32_t>(a.i32[i]));
        break;
      case ElementType::F32:
        for (uint64_t i = 0; i < p.count; i++) put_f32(bytes, start + 4 * i, a.f32[i]);
        break;
      case ElementType::U16:
        for (uint64_t i = 0; i < p.count; i++) {
          bytes[start + 2 * i] = static_cast<uint8_t>(a.u16[i]);
          bytes[start + 2 * i + 1] = static_cast<uint8_t>(a.u16[i] >> 8);
        }
        break;
      case ElementType::U8:
        std::memcpy(bytes.data() + start, a.u8.data(), p.count);
        break;
      default: break;
    }
  }
  return bytes;
}

bool checked_writable(int version, Vector<Diagnostic>& diags) {
  if (writable_version(version)) return true;
  diags.push_back(error_diag("version-unsupported", "file",
                             version == 6 ? "writing version 6 is not supported yet: writeMoc writes versions 1–5"
                                          : "cannot write version " + to_str(version) + ": writeMoc writes versions 1–5"));
  return false;
}

}  // namespace

bool write_moc(const MocData& data, int version, Vector<uint8_t>& out, Vector<Diagnostic>& diags) {
  diags.clear();
  if (!checked_writable(version, diags)) return false;
  Vector<int32_t> counts;
  diags = check_shape(data, version, &counts);
  if (!diags.empty()) return false;
  Report report(false);
  check_structure(data, version, report);
  if (report.errors()) {
    diags = std::move(report.list);
    return false;
  }
  out = encode(version, data, counts);
  return true;
}

bool write_moc_unchecked(const MocData& data, int version, Vector<uint8_t>& out, Vector<Diagnostic>& diags) {
  diags.clear();
  if (!checked_writable(version, diags)) return false;
  Vector<int32_t> counts;
  diags = check_shape(data, version, &counts);
  if (!diags.empty()) return false;
  out = encode(version, data, counts);
  return true;
}

}  // namespace mochi2d::moc
