#include "framework/package.hpp"

#include <algorithm>
#include <charconv>

namespace mochi2d::framework {

String dirname_of(std::string_view path) {
  const auto i = path.rfind('/');
  return i == std::string_view::npos ? String() : String(path.substr(0, i));
}

bool join_path(std::string_view base, std::string_view ref, String& out, String* message) {
  String joined = base.empty() ? String(ref) : String(base) + "/" + String(ref);
  if (normalize_path(joined, out)) return true;
  if (message) *message = "Path escapes the source root: \"" + joined + "\"";
  return false;
}

namespace {

String ascii_lower(std::string_view s) {
  String out(s);
  for (auto& c : out)
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return out;
}

bool ends_with(std::string_view s, std::string_view suffix) {
  return s.size() >= suffix.size() && s.substr(s.size() - suffix.size()) == suffix;
}

/** "zip", "rar", "7z" or "" by name (Mochi2D's archiveKind without the file's head). */
const char* archive_kind(std::string_view name) {
  String lower = ascii_lower(name);
  const auto q = lower.find_first_of("?#");
  if (q != String::npos) lower.resize(q);
  if (ends_with(lower, ".zip")) return "zip";
  if (ends_with(lower, ".rar")) return "rar";
  if (ends_with(lower, ".7z")) return "7z";
  return "";
}

/** A byte count as Mochi2D prints it (an integer; past 2^53 it would print the nearest double). */
String bytes_str(uint64_t n) {
  char buf[24];
  const auto r = std::to_chars(buf, buf + sizeof buf, n);
  return String(buf, r.ptr);
}

std::size_t depth(const String& p) { return static_cast<std::size_t>(std::count(p.begin(), p.end(), '/')) + 1; }

/** Parses an optional companion file into `out`; a warning, as Mochi2D words it, on failure. */
template <class T, class Read, class Parse>
void companion(Read read, const String& dir, const String& path, T& out, bool& has, Vector<String>& warnings,
               Parse parse) {
  has = false;
  if (path.empty()) return;
  String full, message, bytes;
  if (!join_path(dir, path, full, &message)) {
    warnings.push_back(path + ": " + message);
    return;
  }
  if (read(full, bytes, message) != ReadResult::Ok) {
    warnings.push_back(path + ": " + message);
    return;
  }
  FormatError error;
  if (!parse(bytes, path, out, error)) {
    warnings.push_back(path + ": " + error.message);
    return;
  }
  has = true;
}

}  // namespace

ModelFileKind classify_model_file(std::string_view path) {
  static const std::pair<const char*, ModelFileKind> kSuffixes[] = {
      {".model3.json", ModelFileKind::Settings},  {".moc3", ModelFileKind::Moc},
      {".motion3.json", ModelFileKind::Motion},   {".exp3.json", ModelFileKind::Expression},
      {".physics3.json", ModelFileKind::Physics}, {".pose3.json", ModelFileKind::Pose},
      {".userdata3.json", ModelFileKind::UserData}, {".cdi3.json", ModelFileKind::DisplayInfo},
      {".png", ModelFileKind::Texture},           {".wav", ModelFileKind::Sound},
      {".mp3", ModelFileKind::Sound},             {".ogg", ModelFileKind::Sound},
  };
  const String lower = ascii_lower(path);
  for (const auto& [suffix, kind] : kSuffixes)
    if (ends_with(lower, suffix)) return kind;
  return ModelFileKind::Other;
}

Vector<String> find_settings_files(const FileSource& source) {
  Vector<String> files, out;
  if (!source.list(files)) return out;
  for (auto& f : files)
    if (classify_model_file(f) == ModelFileKind::Settings) out.push_back(f);
  // Shallowest first; Mochi2D breaks ties with localeCompare, Mochi2D Native by code point.
  mochi2d::stable_sort(out, [](const String& a, const String& b) {
    const std::size_t da = depth(a), db = depth(b);
    return da != db ? da < db : a < b;
  });
  return out;
}

bool resolve_settings_path(const FileSource& source, const String* given, String& out, String& message) {
  if (given && !given->empty()) {
    out = *given;
    return true;
  }
  const Vector<String> found = find_settings_files(source);
  if (!found.empty()) {
    out = found[0];
    return true;
  }
  Vector<String> listed;
  const String label = source.label();
  if (!source.list(listed)) {
    message = label + ": name the *.model3.json file to load (this source cannot list its files)";
    return false;
  }
  // A folder that holds only the model's archive.
  for (const auto& p : listed) {
    const String kind = archive_kind(p);
    if (kind.empty()) continue;
    if (kind == "zip")
      message = label + ": no *.model3.json file found; open the zip archive \"" + p + "\" itself";
    else
      message = label + ": no *.model3.json file found; \"" + p + "\" is a " + (kind == "rar" ? "RAR" : "7z") +
                " archive: extract it first, then open the extracted folder";
    return false;
  }
  message = label + ": no *.model3.json file found";
  return false;
}

ReadResult Package::fetch(const String& path, String& bytes, String& message) {
  // Mochi2D's FileBudget: a file read before may be read again in full; a new
  // one must also fit what is left of the total.
  const auto counted = counted_.find(path);
  const uint64_t left = total_ < limits_.max_total_bytes ? limits_.max_total_bytes - total_ : 0;
  const uint64_t allowed = counted != counted_.end() ? limits_.max_file_bytes : std::min(limits_.max_file_bytes, left);
  uint64_t size = 0;
  bytes.clear();
  const ReadResult r = source_->read(path, bytes, allowed, size);
  if (r == ReadResult::Missing) {
    message = "File not found: \"" + path + "\" in " + source_->label();
  } else if (r == ReadResult::TooLarge) {
    bytes.clear();
    // FileLimitError's messages.
    if (size > limits_.max_file_bytes)
      message = "\"" + path + "\" holds " + bytes_str(size) + " bytes or more, more than the " +
                bytes_str(limits_.max_file_bytes) + " allowed for one file";
    else
      message = "\"" + path + "\": reading it takes the files read to " +
                bytes_str(total_ + size) + " bytes, more than the " +
                bytes_str(limits_.max_total_bytes) + " allowed in total";
  } else if (counted == counted_.end()) {
    counted_.emplace(path, bytes.size());
    total_ += bytes.size();
  }
  return r;
}

bool Package::read(const String& path, String& bytes, String& message) {
  const ReadResult r = fetch(path, bytes, message);
  last_too_large_ = r == ReadResult::TooLarge;
  return r == ReadResult::Ok;
}

bool Package::open(FileSource& source, const String* settings_path, const moc::LoadOptions& options, String& message,
                   PackageError& error, moc::Error& moc_error, const FileLimits& limits) {
  source_ = &source;
  limits_ = limits;
  counted_.clear();
  total_ = 0;
  error = PackageError::None;
  warnings.clear();
  String path;
  if (!resolve_settings_path(source, settings_path, path, message)) {
    error = PackageError::File;
    return false;
  }
  String bytes;
  String normalized;
  // Mochi2D reads the path as given, and its sources normalize it.
  if (!normalize_path(path, normalized)) {
    message = "Path escapes the source root: \"" + path + "\"";
    error = PackageError::File;
    return false;
  }
  switch (fetch(normalized, bytes, message)) {
    case ReadResult::Ok: break;
    case ReadResult::Missing:
      message = "File not found: \"" + path + "\" in " + source.label();
      error = PackageError::File;
      return false;
    case ReadResult::TooLarge:
      error = PackageError::Limit;
      return false;
  }
  auto s = std::allocate_shared<ModelSettings>(Allocator<ModelSettings>());
  if (!parse_model_settings(bytes, path, *s, message)) {
    error = PackageError::Settings;
    return false;
  }
  settings_path_ = path;
  dir_ = dirname_of(path);
  String moc_path;
  if (!join_path(dir_, s->moc, moc_path, &message)) {
    error = PackageError::File;
    return false;
  }
  if (!read(moc_path, bytes, message)) {
    error = last_too_large_ ? PackageError::Limit : PackageError::File;
    return false;
  }
  auto m = std::allocate_shared<moc::Model>(Allocator<moc::Model>());
  if (!moc::load_moc(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), options, *m, moc_error)) {
    message = moc_error.message;
    error = PackageError::Moc;
    return false;
  }
  // Optional files, in Mochi2D's order: physics, pose, display info, user data, motion sync.
  Vector<String> optional;
  auto read_companion = [this](const String& p, String& b, String& m) { return fetch(p, b, m); };
  {
    auto physics_file = std::allocate_shared<PhysicsFile>(Allocator<PhysicsFile>());
    bool has = false;
    companion(read_companion, dir_, s->physics, *physics_file, has, optional,
              [](const String& b, const String& l, PhysicsFile& o, FormatError& e) { return parse_physics(b, l, o, e); });
    if (has) physics = physics_file;
  }
  {
    auto pose_file = std::allocate_shared<PoseFile>(Allocator<PoseFile>());
    bool has = false;
    companion(read_companion, dir_, s->pose, *pose_file, has, optional,
              [](const String& b, const String& l, PoseFile& o, FormatError& e) { return parse_pose(b, l, o, e); });
    if (has) pose = pose_file;
  }
  {
    DisplayInfo info;
    bool has = false;
    companion(read_companion, dir_, s->display_info, info, has, optional,
              [](const String& b, const String& l, DisplayInfo& o, FormatError& e) { return parse_display_info(b, l, o, e); });
    if (has) display_info = std::move(info);
  }
  {
    UserData data;
    bool has = false;
    companion(read_companion, dir_, s->user_data, data, has, optional,
              [](const String& b, const String& l, UserData& o, FormatError& e) { return parse_user_data(b, l, o, e); });
    if (has) user_data = std::move(data);
  }
  {
    auto sync = std::allocate_shared<MotionSyncFile>(Allocator<MotionSyncFile>());
    bool has = false;
    companion(read_companion, dir_, s->motion_sync, *sync, has, optional,
              [](const String& b, const String& l, MotionSyncFile& o, FormatError& e) {
                return parse_motion_sync(b, l, o, e);
              });
    if (has) motion_sync = sync;
  }
  for (const auto& w : m->load_warnings) warnings.push_back(s->moc + ": " + w);
  for (auto& w : optional) warnings.push_back(std::move(w));
  if (motion_sync)
    for (const auto& w : motion_sync->warnings) warnings.push_back(w);
  settings = s;
  model = m;
  return true;
}

bool Package::resolve(std::string_view path, String& out, String* message) const {
  return join_path(dir_, path, out, message);
}

std::shared_ptr<const Motion> Package::motion(std::string_view path, String& message) {
  last_too_large_ = false;
  String p, bytes;
  if (!resolve(path, p, &message)) return nullptr;
  if (auto it = motions_.find(p); it != motions_.end()) return it->second;
  if (!read(p, bytes, message)) return nullptr;
  auto m = std::allocate_shared<Motion>(Allocator<Motion>());
  FormatError error;
  if (!parse_motion(bytes, p, *m, error)) {
    message = error.message;
    return nullptr;
  }
  motions_[p] = m;
  return m;
}

std::shared_ptr<const Expression> Package::expression(std::string_view path, String& message) {
  last_too_large_ = false;
  String p, bytes;
  if (!resolve(path, p, &message)) return nullptr;
  if (auto it = expressions_.find(p); it != expressions_.end()) return it->second;
  if (!read(p, bytes, message)) return nullptr;
  auto e = std::allocate_shared<Expression>(Allocator<Expression>());
  FormatError error;
  if (!parse_expression(bytes, p, *e, error)) {
    message = error.message;
    return nullptr;
  }
  expressions_[p] = e;
  return e;
}

std::shared_ptr<const WavSound> Package::sound(std::string_view path, String& message, const String** bytes) {
  last_too_large_ = false;
  String p;
  if (bytes) *bytes = nullptr;
  if (!resolve(path, p, &message)) return nullptr;
  auto it = sounds_.find(p);
  if (it == sounds_.end()) {
    SoundEntry entry;
    // A file that cannot be read decodes as no bytes (Mochi2D's loadSound).
    if (!read(p, entry.bytes, entry.message)) {
      entry.bytes.clear();
      entry.too_large = last_too_large_;
    }
    auto sound = std::allocate_shared<WavSound>(Allocator<WavSound>());
    String decode;
    if (decode_wav(reinterpret_cast<const uint8_t*>(entry.bytes.data()), entry.bytes.size(), *sound, decode))
      entry.sound = sound;
    else if (entry.message.empty())
      entry.message = decode;
    it = sounds_.emplace(p, std::move(entry)).first;
  }
  if (bytes) *bytes = &it->second.bytes;
  if (!it->second.sound) message = it->second.message;
  last_too_large_ = !it->second.sound && it->second.too_large;
  return it->second.sound;
}

std::shared_ptr<const MotionSyncSound> Package::motion_sync_sound(std::string_view path, String& message, bool& first) {
  first = false;
  last_too_large_ = false;
  String p, bytes;
  if (!resolve(path, p, &message)) return nullptr;
  if (auto it = sync_sounds_.find(p); it != sync_sounds_.end()) {
    message = it->second.message;
    return it->second.sound;
  }
  // Mochi2D decodes the bytes its sound loader read: a file that cannot be
  // read gets no motion sync, and no entry.
  if (!read(p, bytes, message)) return nullptr;
  auto s = std::allocate_shared<MotionSyncSound>(Allocator<MotionSyncSound>());
  SyncSoundEntry entry;
  if (decode_motion_sync_wav(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), *s, entry.message)) {
    s->prepare();
    entry.sound = s;
  }
  first = !entry.sound;
  message = entry.message;
  auto sound = entry.sound;
  sync_sounds_.emplace(p, std::move(entry));
  return sound;
}

}  // namespace mochi2d::framework
