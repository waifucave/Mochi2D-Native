# The GL backend on the render fixtures (tests/fixtures/README.md): renders
# the committed render scenarios through the GL backend (mochi2d-gl-render,
# headless EGL) and through the reference renderer (mochi2d-native render),
# and compares the images. The backend follows Mochi2D's WebGL2 renderer, not
# the software rasterizer's exact arithmetic, so the comparison has a bound
# rather than equality: RMS ≤ MAX_RMS and every channel within MAX_DIFF.
# No context (exit 77): prints GL-SKIP, which ctest reads as skipped.
#
# Also the Vulkan backend's: -DGL=<mochi2d-vk-render> with -DAPI="--icd;<json>".
#
# cmake -DGL=<mochi2d-gl-render> -DCLI=<mochi2d-native> -DAPI=es|desktop -DFIXTURES=<tests/fixtures> -DOUT=<dir>
#       [-DMAX_RMS=<x>] [-DMAX_DIFF=<n>] -P gl_compare.cmake
if(NOT DEFINED MAX_RMS)
  set(MAX_RMS 3.0)
endif()
if(NOT DEFINED MAX_DIFF)
  set(MAX_DIFF 255)
endif()
file(REMOVE_RECURSE "${OUT}")
if(API MATCHES "^--")
  set(api_args ${API})
else()
  set(api_args --api ${API})
endif()
execute_process(COMMAND "${GL}" info ${api_args} RESULT_VARIABLE info OUTPUT_VARIABLE context ERROR_VARIABLE why)
if(info EQUAL 77)
  message("GL-SKIP: ${why}")
  return()
elseif(NOT info EQUAL 0)
  message(FATAL_ERROR "gl render: info fails: ${why}")
endif()
message(STATUS "context: ${context}")
execute_process(COMMAND "${GL}" render "${FIXTURES}/render/scenarios" --out "${OUT}/gl" --models "${FIXTURES}/render/models"
                        ${api_args} RESULT_VARIABLE r OUTPUT_VARIABLE o ERROR_VARIABLE e)
if(NOT r EQUAL 0)
  message(FATAL_ERROR "gl render: rendering fails:\n${o}${e}")
endif()
execute_process(COMMAND "${CLI}" render "${FIXTURES}/render/scenarios" --out "${OUT}/software"
                        --models "${FIXTURES}/render/models" --quiet OUTPUT_QUIET ERROR_QUIET)
execute_process(COMMAND "${GL}" compare "${OUT}/software" "${OUT}/gl" --max-rms ${MAX_RMS} --max-diff ${MAX_DIFF}
                RESULT_VARIABLE c OUTPUT_VARIABLE report)
message("${report}")
if(NOT c EQUAL 0)
  message(FATAL_ERROR "gl render: the GL backend's renders differ from the reference renderer's beyond the bound")
endif()
