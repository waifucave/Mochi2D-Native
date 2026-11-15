// A synthetic model folder (as Mochi2D 0.16.0's fuzzing's modelFiles): a
// settings file, a small version-5 .moc3 (tiny_model.hpp), physics, pose,
// display info, user data, motion sync, an expression, two motions and a
// sound. The `model` fuzz target loads it through the package helper and
// steps it; the unit test binary writes one seed per file of it.
#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "support/tiny_model.hpp"

namespace mochi2d::testing {

/** A 16-bit mono PCM WAV of `frames` frames of a quiet square wave. */
inline std::string folder_wav(uint32_t rate, uint32_t frames) {
  std::string w;
  const auto u32 = [&](uint32_t v) {
    for (int k = 0; k < 4; k++) w.push_back(static_cast<char>((v >> (8 * k)) & 255));
  };
  const auto u16 = [&](uint32_t v) {
    for (int k = 0; k < 2; k++) w.push_back(static_cast<char>((v >> (8 * k)) & 255));
  };
  w += "RIFF";
  u32(36 + frames * 2);
  w += "WAVEfmt ";
  u32(16);
  u16(1);
  u16(1);
  u32(rate);
  u32(rate * 2);
  u16(2);
  u16(16);
  w += "data";
  u32(frames * 2);
  for (uint32_t i = 0; i < frames; i++) u16((i / 40) % 2 ? 6000 : static_cast<uint16_t>(-6000));
  return w;
}

/** The folder's files, by name; the settings file first. */
inline std::vector<std::pair<std::string, std::string>> model_folder() {
  const auto moc = written(tiny_model(5, true), 5);
  const char* const motion =
      R"({"Version":3,"Meta":{"Duration":2,"Fps":30,"Loop":true,"AreBeziersRestricted":true,"CurveCount":2,)"
      R"("TotalSegmentCount":3,"TotalPointCount":5,"UserDataCount":1,"TotalUserDataSize":2},"Curves":[{"Target":)"
      R"("Parameter","Id":"ParamX","Segments":[0,0,1,0.3,0.2,0.6,0.5,1,1,0,2,0.2]},{"Target":"PartOpacity","Id":"Root",)"
      R"("Segments":[0,1,0,2,0.5]}],"UserData":[{"Time":1,"Value":"u"}]})";
  return {
      {"m.model3.json",
       R"({"Version":3,"FileReferences":{"Moc":"m.moc3","Textures":[],"Physics":"m.physics3.json","Pose":"m.pose3.json",)"
       R"("DisplayInfo":"m.cdi3.json","UserData":"m.userdata3.json","MotionSync":"m.motionsync3.json",)"
       R"("Expressions":[{"Name":"e","File":"e.exp3.json"}],"Motions":{"Idle":[{"File":"idle.motion3.json"}],)"
       R"("Tap":[{"File":"tap.motion3.json","Sound":"s.wav","FadeInTime":0.2}]}},)"
       R"("Groups":[{"Target":"Parameter","Name":"EyeBlink","Ids":["ParamX"]},{"Target":"Parameter","Name":"LipSync","Ids":["ParamX"]}],)"
       R"("HitAreas":[{"Id":"Mesh","Name":"Body"}]})"},
      {"m.moc3", std::string(moc.begin(), moc.end())},
      {"m.physics3.json",
       R"({"Version":3,"Meta":{"PhysicsSettingCount":1,"TotalInputCount":1,"TotalOutputCount":1,"VertexCount":2,"Fps":30,)"
       R"("PhysicsDictionary":[{"Id":"S","Name":"Hair"}]},"PhysicsSettings":[{"Id":"S","Input":[{"Source":{"Target":"Parameter",)"
       R"("Id":"ParamX"},"Weight":100,"Type":"X","Reflect":false}],"Output":[{"Destination":{"Target":"Parameter","Id":"ParamX"},)"
       R"("VertexIndex":1,"Scale":0.1,"Weight":50,"Type":"Angle","Reflect":false}],"Vertices":[{"Position":{"X":0,"Y":0},)"
       R"("Mobility":1,"Delay":1,"Acceleration":1,"Radius":0},{"Position":{"X":0,"Y":3},"Mobility":0.9,"Delay":0.8,)"
       R"("Acceleration":1.5,"Radius":3}],"Normalization":{"Position":{"Minimum":-10,"Default":0,"Maximum":10},)"
       R"("Angle":{"Minimum":-10,"Default":0,"Maximum":10}}}]})"},
      {"m.pose3.json", R"({"Type":"Live2D Pose","FadeInTime":0.4,"Groups":[[{"Id":"Root","Link":[]}]]})"},
      {"m.cdi3.json",
       R"({"Version":3,"Parameters":[{"Id":"ParamX","GroupId":"G","Name":"X"}],"ParameterGroups":[{"Id":"G","GroupId":"",)"
       R"("Name":"Group"}],"Parts":[{"Id":"Root","Name":"R"}],"CombinedParameters":[["ParamX","ParamX"]]})"},
      {"m.userdata3.json",
       R"({"Version":3,"Meta":{"UserDataCount":1,"TotalUserDataSize":1},"UserData":[{"Target":"ArtMesh","Id":"Mesh","Value":"v"}]})"},
      {"m.motionsync3.json",
       R"({"Version":1,"Meta":{"SettingCount":1,"Dictionary":[{"Id":"S","Name":"s"}]},"Settings":[{"Id":"S",)"
       R"("AnalysisType":"CRI","UseCase":"Mouth","CubismParameters":[{"Name":"X","Id":"ParamX","Min":0,"Max":1,)"
       R"("Damper":0.01,"Smooth":20}],"AudioParameters":[{"Name":"S","Id":"Silence","Min":0,"Max":1,"Scale":1,)"
       R"("Enabled":true},{"Name":"A","Id":"A","Min":0,"Max":1,"Scale":2,"Enabled":true}],"Mappings":[{"Type":)"
       R"("Shape","Id":"Silence","Targets":[{"Id":"ParamX","Value":0}]},{"Type":"Shape","Id":"A","Targets":)"
       R"([{"Id":"ParamX","Value":1}]}],"PostProcessing":{"BlendRatio":0.5,"Smoothing":3,"SampleRate":60}}]})"},
      {"e.exp3.json",
       R"({"Type":"Live2D Expression","FadeInTime":0.3,"FadeOutTime":0.2,"Parameters":[{"Id":"ParamX","Value":0.5,"Blend":"Add"}]})"},
      {"idle.motion3.json", motion},
      {"tap.motion3.json", motion},
      {"s.wav", folder_wav(16000, 1600)},
  };
}

}  // namespace mochi2d::testing
