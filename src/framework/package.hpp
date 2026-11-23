// A model package: a settings file and its companions, read through the
// host (port of Mochi2D's src/runtime/bundle.ts and the path rules of
// src/core/io/file-source.ts, with the file caches of
// src/runtime/model-runtime.ts). The library reads no files itself: a
// FileSource does, by path.
//
// Paths are relative to the source's root, with forward slashes: Mochi2D's
// normalizePath turns backslashes into slashes, drops "." and empty
// segments, and resolves ".." without escaping the root. A file the
// settings name resolves against the settings file's folder.
#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string_view>

#include "core/moc/model.hpp"
#include "framework/expression.hpp"
#include "framework/lip_sync.hpp"
#include "framework/model_data.hpp"
#include "framework/motion.hpp"
#include "framework/motion_sync_driver.hpp"
#include "framework/physics.hpp"
#include "framework/pose.hpp"
#include "framework/settings.hpp"
#include "util/alloc.hpp"

namespace mochi2d::framework {

/** The folder part of a path ("" for a top-level file), as Mochi2D's dirnameOf. */
String dirname_of(std::string_view path);
/**
 * A reference resolved against a folder, as Mochi2D's joinPath: false, with
 * Mochi2D's message, when it escapes the root.
 */
bool join_path(std::string_view base, std::string_view ref, String& out, String* message = nullptr);

/** File kinds by name suffix (Mochi2D's classifyModelFile). */
enum class ModelFileKind : uint8_t {
  Settings,
  Moc,
  Texture,
  Motion,
  Expression,
  Physics,
  Pose,
  UserData,
  DisplayInfo,
  Sound,
  Other
};
ModelFileKind classify_model_file(std::string_view path);

/** What a FileSource read found. */
enum class ReadResult : uint8_t { Ok, Missing, TooLarge };

/** A read-only set of files by path (Mochi2D's FileSource). */
class FileSource {
 public:
  virtual ~FileSource() = default;
  /** Describes the source in messages, for example a folder name. */
  virtual String label() const = 0;
  /** Every file's path, when the source can list them; false when it cannot (HTTP). */
  virtual bool list(Vector<String>& out) const = 0;
  /**
   * Reads a whole file of at most `max_bytes` bytes. Missing when it does not
   * exist or cannot be read; TooLarge, with `size` its size, when it holds
   * more: nothing is kept, and a source that knows the size first does not
   * read it at all.
   */
  virtual ReadResult read(const String& path, String& bytes, uint64_t max_bytes, uint64_t& size) = 0;
};

/**
 * Caps on what a package reads (Mochi2D 0.24.0's FileLimits): one file's
 * size, and all files together, each counted once. The defaults are
 * Mochi2D's: 1 GiB a file, 2 GiB in all.
 */
struct FileLimits {
  uint64_t max_file_bytes = uint64_t{1} << 30;
  uint64_t max_total_bytes = uint64_t{1} << 31;
};

/** Settings files of a listable source, shallowest first (Mochi2D's findSettingsFiles). */
Vector<String> find_settings_files(const FileSource& source);
/**
 * Which settings file to load (Mochi2D's resolveSettingsPath): the given
 * path, or the shallowest `*.model3.json` of a listable source; false with
 * Mochi2D's message when there is none.
 */
bool resolve_settings_path(const FileSource& source, const String* given, String& out, String& message);

/** Why a package did not open. */
enum class PackageError : uint8_t {
  None,
  /** No settings file to load, a file that is missing, or a path that escapes the root. */
  File,
  /** The settings file cannot be used. */
  Settings,
  /** The `.moc3` cannot be loaded: `moc_error` says why. */
  Moc,
  /** The settings file or the `.moc3` is past a FileLimits cap (FileLimitError). */
  Limit,
};

/**
 * A model's files (Mochi2D's ModelBundle) and the files read later by path,
 * cached by resolved path as Mochi2D's model runtime caches them.
 */
class Package {
 public:
  /**
   * Opens the settings file (`settings_path`, or the shallowest one of a
   * listable source when null), the `.moc3` and the optional companions
   * (physics, pose, display info, user data, motion sync). Problems with optional files
   * become warnings, and the package opens without them; a missing or broken
   * settings file or `.moc3` is an error. `source` must outlive the package.
   */
  bool open(FileSource& source, const String* settings_path, const moc::LoadOptions& options, String& message,
            PackageError& error, moc::Error& moc_error, const FileLimits& limits = FileLimits());

  /** The caps the package reads within, and the bytes it has read, each file once. */
  const FileLimits& limits() const { return limits_; }
  uint64_t read_bytes() const { return total_; }
  /** Whether the last failed read of motion, expression, sound or motion_sync_sound was past a cap. */
  bool last_too_large() const { return last_too_large_; }

  /** The settings file's path in the source. */
  const String& settings_path() const { return settings_path_; }
  /** The settings file's folder: what its paths resolve against. */
  const String& dir() const { return dir_; }
  std::shared_ptr<const ModelSettings> settings;
  std::shared_ptr<const moc::Model> model;
  /** Null when the settings name none, or it could not be used (see warnings). */
  std::shared_ptr<const PhysicsFile> physics;
  std::shared_ptr<const PoseFile> pose;
  /** The motion-sync file (`FileReferences.MotionSync`), read leniently: its warnings are in `warnings`. */
  std::shared_ptr<const MotionSyncFile> motion_sync;
  std::optional<DisplayInfo> display_info;
  std::optional<UserData> user_data;
  /** Problems with optional files and the `.moc3`'s load warnings, one line each. */
  Vector<String> warnings;

  /** A path the settings name, resolved against the settings file's folder. */
  bool resolve(std::string_view path, String& out, String* message = nullptr) const;
  /**
   * A motion file by its path relative to the settings file, read and
   * validated once (Mochi2D's loadMotion; a failure is not cached).
   */
  std::shared_ptr<const Motion> motion(std::string_view path, String& message);
  /** An expression file, likewise (Mochi2D's loadExpression). */
  std::shared_ptr<const Expression> expression(std::string_view path, String& message);
  /**
   * A sound, read and decoded once (Mochi2D's loadSound): null, with the
   * reason, when it cannot be read or decoded (Mochi2D then stops lip sync);
   * the failure is cached too. `bytes` receives the file's bytes for playback
   * (empty when it could not be read).
   */
  std::shared_ptr<const WavSound> sound(std::string_view path, String& message, const String** bytes = nullptr);
  /**
   * A sound decoded for motion sync (decodeMotionSyncWav), by its path
   * relative to the settings file, read and decoded once (Mochi2D's runtime
   * keeps motionSyncSounds by resolved path). Null when the file cannot be
   * read (`message`, `decoded` false), or cannot be decoded: then `message`
   * gives the reason and `decoded` is true the first time only, as Mochi2D
   * warns once.
   */
  std::shared_ptr<const MotionSyncSound> motion_sync_sound(std::string_view path, String& message, bool& first);

 private:
  FileSource* source_ = nullptr;
  String settings_path_, dir_;
  HashMap<String, std::shared_ptr<const Motion>> motions_;
  HashMap<String, std::shared_ptr<const Expression>> expressions_;
  struct SoundEntry {
    String bytes;
    std::shared_ptr<const WavSound> sound;
    String message;
    bool too_large = false;
  };
  HashMap<String, SoundEntry> sounds_;
  struct SyncSoundEntry {
    std::shared_ptr<const MotionSyncSound> sound;
    String message;
  };
  HashMap<String, SyncSoundEntry> sync_sounds_;
  FileLimits limits_;
  HashMap<String, uint64_t> counted_;
  uint64_t total_ = 0;
  bool last_too_large_ = false;
  /** Reads a file within the caps: Mochi2D's messages for a missing file and for one past a cap. */
  ReadResult fetch(const String& path, String& bytes, String& message);
  bool read(const String& path, String& bytes, String& message);
};

}  // namespace mochi2d::framework
