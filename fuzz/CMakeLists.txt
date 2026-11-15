# Fuzz targets: the .moc3 reader, the JSON parsers, the
# framework's file readers with the animator, and a whole model folder
# through the C API (as Mochi2D 0.16.0's `model` target).
#
# With Clang and -DMOCHI2D_FUZZ=ON they link libFuzzer with AddressSanitizer
# and UndefinedBehaviorSanitizer; otherwise they build with a standalone main
# that replays corpus files (used by the unit tests on any compiler).
foreach(target moc json anim model)
  if(MOCHI2D_FUZZ)
    add_executable(fuzz_${target} fuzz_${target}.cpp)
    target_compile_options(fuzz_${target} PRIVATE -fsanitize=fuzzer,address,undefined -fno-sanitize-recover=undefined)
    target_link_options(fuzz_${target} PRIVATE -fsanitize=fuzzer,address,undefined)
  else()
    add_executable(fuzz_${target} fuzz_${target}.cpp standalone_main.cpp)
  endif()
  target_link_libraries(fuzz_${target} PRIVATE mochi2d_conformance mochi2d_static)
  target_include_directories(fuzz_${target} PRIVATE ${PROJECT_SOURCE_DIR}/tests)
endforeach()
