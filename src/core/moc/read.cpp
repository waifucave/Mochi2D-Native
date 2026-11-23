// Port of Mochi2D's src/core/moc/read.ts and binary/byte-reader.ts.
#include <algorithm>
#include <cstring>

#include "core/moc/data.hpp"
#include "util/text.hpp"

namespace mochi2d::moc {

std::size_t MocData::group_size(const GroupSpec& g) const {
  return g.field_count ? size(g.fields[0]) : 0;
}

namespace {

bool fail(Error& e, const String& message, const char* code) {
  e.code = code;
  e.message = message;
  return false;
}

class Reader {
 public:
  Reader(const uint8_t* b, std::size_t /*n*/, bool little) : b_(b), little_(little) {}

  uint32_t u32(uint64_t o) const {
    uint32_t v;
    std::memcpy(&v, b_ + o, 4);
    return little_ ? v : swap32(v);
  }
  int32_t i32(uint64_t o) const {
    const uint32_t u = u32(o);
    int32_t v;
    std::memcpy(&v, &u, 4);
    return v;
  }
  float f32(uint64_t o) const {
    const uint32_t u = u32(o);
    float v;
    std::memcpy(&v, &u, 4);
    return v;
  }
  uint16_t u16(uint64_t o) const {
    uint16_t v;
    std::memcpy(&v, b_ + o, 2);
    return little_ ? v : static_cast<uint16_t>((v >> 8) | (v << 8));
  }
  uint8_t u8(uint64_t o) const { return b_[o]; }
  const uint8_t* at(uint64_t o) const { return b_ + o; }

 private:
  static uint32_t swap32(uint32_t v) {
    return (v >> 24) | ((v >> 8) & 0xff00u) | ((v << 8) & 0xff0000u) | (v << 24);
  }
  const uint8_t* b_;
  bool little_;
};

struct Section {
  int slot;
  String what;
  uint64_t start;
  uint64_t end;
};

String slot_order_problem(Vector<Section> sections, uint64_t table_end) {
  stable_sort(sections, [](const Section& a, const Section& b) { return a.slot < b.slot; });
  Section prev{-1, "the offset table", 0, table_end};
  for (const auto& s : sections) {
    if (s.start < prev.end)
      return s.what + " (slot " + to_str(s.slot) + ") starts at byte " + to_str(s.start) +
             ", before the end (" + to_str(prev.end) + ") of " +
             (prev.slot >= 0 ? prev.what + " (slot " + to_str(prev.slot) + ")" : prev.what) +
             ": sections must be in slot order without overlaps";
    prev = s;
  }
  return {};
}

}  // namespace

bool read_sections(const uint8_t* bytes, std::size_t byte_length, bool lenient, Sections& out, Error& err) {
  out = Sections();
  out.byte_length = byte_length;
  if (byte_length < kHeaderSize)
    return fail(err, "file is " + to_str(byte_length) + " bytes, shorter than the 64-byte header", "file-length");
  if (std::memcmp(bytes, "MOC3", 4) != 0) {
    String magic(reinterpret_cast<const char*>(bytes), 4);
    // JSON.stringify of the four characters (each byte as one UTF-16 unit).
    String q = "\"";
    for (unsigned char c : magic) {
      if (c == '"') q += "\\\"";
      else if (c == '\\') q += "\\\\";
      else if (c < 0x20) {
        char u[8];
        const char* esc = c == '\b' ? "\\b" : c == '\f' ? "\\f" : c == '\n' ? "\\n" : c == '\r' ? "\\r" : c == '\t' ? "\\t" : nullptr;
        if (esc) q += esc;
        else {
          std::snprintf(u, sizeof u, "\\u%04x", c);
          q += u;
        }
      } else if (c < 0x80) q.push_back(static_cast<char>(c));
      else {
        q.push_back(static_cast<char>(0xc0 | (c >> 6)));
        q.push_back(static_cast<char>(0x80 | (c & 63)));
      }
    }
    q += "\"";
    return fail(err, "bad magic " + q + " (expected \"MOC3\")", "magic");
  }
  const int version = bytes[4];
  if (version < kMinVersion || version > kMaxVersion)
    return fail(err, "unsupported file version " + to_str(version) + " (supported 1–6)", "version");
  if (byte_length % 64 != 0) {
    const String message = "file length " + to_str(byte_length) + " is not a multiple of 64";
    if (!lenient) return fail(err, message, "file-length");
    out.issues.push_back({"file-length", message});
  }
  const bool big = bytes[5] != 0;
  out.version = version;
  out.big_endian = big;
  Reader r(bytes, byte_length, !big);

  const int slot_count = slot_table_length(version);
  if (kHeaderSize + static_cast<uint64_t>(slot_count) * 4 > byte_length)
    return fail(err, "offset table (" + to_str(slot_count) + " slots) extends past end of file", "section-bounds");
  Vector<uint32_t> slots(static_cast<std::size_t>(slot_count));
  for (int i = 0; i < slot_count; i++) slots[static_cast<std::size_t>(i)] = r.u32(kHeaderSize + 4u * static_cast<unsigned>(i));

  const uint64_t count_offset = slots[kCountTableSlot];
  const int count_entries = count_table_length(version);
  if (count_offset + static_cast<uint64_t>(count_entries) * 4 > byte_length)
    return fail(err, "count table at " + to_str(count_offset) + " extends past end of file", "section-bounds");
  out.counts.assign(static_cast<std::size_t>(count_entries), 0);
  for (int i = 0; i < count_entries; i++) {
    if (count_since(i) > version) continue;
    const int32_t n = r.i32(count_offset + 4u * static_cast<unsigned>(i));
    if (n < 0)
      return fail(err, "negative count " + to_str(n) + " for " +
               (i < kCountKinds ? String(count_name(i)) : "count " + to_str(i)),
           "negative-count");
    out.counts[static_cast<std::size_t>(i)] = n;
  }

  const uint64_t canvas_offset = slots[kCanvasSlot];
  if (canvas_offset + kCanvasBlockSize > byte_length)
    return fail(err, "canvas block at " + to_str(canvas_offset) + " extends past end of file", "section-bounds");
  Canvas& c = out.data.canvas;
  c.pixels_per_unit = r.f32(canvas_offset);
  c.origin_x = r.f32(canvas_offset + 4);
  c.origin_y = r.f32(canvas_offset + 8);
  c.width = r.f32(canvas_offset + 12);
  c.height = r.f32(canvas_offset + 16);
  c.flags = r.u8(canvas_offset + 20);

  Vector<Section> sections;
  sections.push_back({kCountTableSlot, "count table", count_offset, count_offset + static_cast<uint64_t>(count_entries) * 4});
  sections.push_back({kCanvasSlot, "canvas block", canvas_offset, canvas_offset + kCanvasBlockSize});
  const FieldSpec* fields = all_fields();
  // First every field's bounds and names, in field order (the errors Mochi2D
  // meets as it reads), and the slot order, before any array is allocated:
  // sections that overlap could otherwise make one file count many times.
  uint64_t claimed = count_offset + static_cast<uint64_t>(count_entries) * 4 + kCanvasBlockSize;
  for (std::size_t fi = 0; fi < kFieldCount; fi++) {
    const FieldSpec& f = fields[fi];
    if (f.since > version) continue;
    const uint64_t count = static_cast<uint64_t>(out.count(f.count));
    const uint64_t offset = slots[static_cast<std::size_t>(f.slot)];
    const uint64_t esize = element_size(f.type);
    const uint64_t size = count * esize;
    if (count > 0 && offset + size > byte_length)
      return fail(err, "section " + String(f.key) + " (slot " + to_str(f.slot) + ", " + to_str(count) +
               " × " + to_str(esize) + " bytes at " + to_str(offset) +
               ") extends past end of file (" + to_str(byte_length) + " bytes)",
           "section-bounds");
    if (size > 0) sections.push_back({f.slot, String("section ") + f.key, offset, offset + size});
    claimed += size;
    if (f.type == ElementType::Name)
      for (uint64_t i = 0; i < count; i++)
        if (!std::memchr(r.at(offset + i * 64), 0, 64))
          return fail(err, String(f.key) + "[" + to_str(i) + "]: name has no NUL terminator within 64 bytes",
               "name-terminator");
  }
  const String order = slot_order_problem(sections, kHeaderSize + static_cast<uint64_t>(slot_count) * 4);
  if (!order.empty()) {
    if (!lenient) return fail(err, order, "slot-order");
    out.issues.push_back({"slot-order", order});
    // Overlapping sections are read as they are (as Mochi2D reads them), up to a bound.
    if (claimed > kMaxClaimedLengths * static_cast<uint64_t>(byte_length))
      return fail(err, order + "; together the sections claim " + to_str(claimed) + " bytes of a file of " +
                       to_str(byte_length) + ", more than " + to_str(static_cast<long long>(kMaxClaimedLengths)) +
                       " times its length, and Mochi2D Native reads no further",
                  "slot-order");
  }
  for (std::size_t fi = 0; fi < kFieldCount; fi++) {
    const FieldSpec& f = fields[fi];
    if (f.since > version) continue;
    const uint64_t count = static_cast<uint64_t>(out.count(f.count));
    const uint64_t offset = slots[static_cast<std::size_t>(f.slot)];
    FieldArray& a = out.data[f.id];
    a.present = true;
    switch (f.type) {
      case ElementType::Placeholder: break;
      case ElementType::Name:
        a.names.resize(count);
        for (uint64_t i = 0; i < count; i++) {
          const uint8_t* raw = r.at(offset + i * 64);
          const auto len = static_cast<std::size_t>(static_cast<const uint8_t*>(std::memchr(raw, 0, 64)) - raw);
          a.names[i] = text::sanitize_utf8(std::string_view(reinterpret_cast<const char*>(raw), len));
        }
        break;
      case ElementType::I32:
        a.i32.resize(count);
        for (uint64_t i = 0; i < count; i++) a.i32[i] = r.i32(offset + 4 * i);
        break;
      case ElementType::F32:
        a.f32.resize(count);
        for (uint64_t i = 0; i < count; i++) a.f32[i] = r.f32(offset + 4 * i);
        break;
      case ElementType::U16:
        a.u16.resize(count);
        for (uint64_t i = 0; i < count; i++) a.u16[i] = r.u16(offset + 2 * i);
        break;
      case ElementType::U8:
        a.u8.assign(r.at(offset), r.at(offset) + count);
        break;
    }
  }
  return true;
}

}  // namespace mochi2d::moc
