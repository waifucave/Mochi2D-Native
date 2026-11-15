add_executable(mochi2d_tests unit/main.cpp support/motion_sync_support.cpp)
target_include_directories(mochi2d_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
find_package(Threads REQUIRED)
target_link_libraries(mochi2d_tests PRIVATE mochi2d_static mochi2d_conformance Threads::Threads)
target_compile_options(mochi2d_tests PRIVATE ${MOCHI2D_FP_FLAGS})
target_compile_definitions(mochi2d_tests PRIVATE MOCHI2D_FIXTURES="${PROJECT_SOURCE_DIR}/tests/fixtures")
add_test(NAME unit COMMAND mochi2d_tests)

# Fuzz targets replayed on seed inputs (and, after the cross-check, on its files).
add_test(NAME fuzz-seeds COMMAND mochi2d_tests --write-seeds ${CMAKE_BINARY_DIR}/fuzz-seeds)
set_tests_properties(fuzz-seeds PROPERTIES FIXTURES_SETUP seeds)
if(NOT MOCHI2D_FUZZ)
  add_test(NAME fuzz-replay-moc COMMAND fuzz_moc ${CMAKE_BINARY_DIR}/fuzz-seeds/moc)
  add_test(NAME fuzz-replay-json COMMAND fuzz_json ${CMAKE_BINARY_DIR}/fuzz-seeds/json)
  add_test(NAME fuzz-replay-anim COMMAND fuzz_anim ${CMAKE_BINARY_DIR}/fuzz-seeds/anim)
  add_test(NAME fuzz-replay-model COMMAND fuzz_model ${CMAKE_BINARY_DIR}/fuzz-seeds/model)
  set_tests_properties(fuzz-replay-moc fuzz-replay-json fuzz-replay-anim fuzz-replay-model PROPERTIES
                       FIXTURES_REQUIRED seeds)
  # The committed corpora (fuzz/corpus/README.md).
  foreach(target moc json anim model)
    add_test(NAME fuzz-corpus-${target} COMMAND fuzz_${target} ${PROJECT_SOURCE_DIR}/fuzz/corpus/${target})
  endforeach()
endif()

add_executable(mochi2d_check_validate crosscheck/check_validate.cpp)
target_link_libraries(mochi2d_check_validate PRIVATE mochi2d_conformance)

# Bit-exactness against Mochi2D itself (needs Node and `npm ci` in the
# reference folder; skipped otherwise).
option(MOCHI2D_CROSSCHECK "Register the cross-check against the reference as a test" ON)
if(MOCHI2D_CROSSCHECK AND NOT WIN32)
  add_test(NAME crosscheck
           COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/crosscheck/run.sh ${CMAKE_BINARY_DIR} 120 300)
  set_tests_properties(crosscheck PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 1200)
  # Motion sync against Mochi2D's driver and analysis (traces of synthetic sounds), and on
  # a synthetic package against its model runtime (tests/crosscheck/motion_sync*.sh).
  add_test(NAME motion-sync-check COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/crosscheck/motion_sync.sh ${CMAKE_BINARY_DIR})
  add_test(NAME motion-sync-model-check
           COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/crosscheck/motion_sync_model.sh ${CMAKE_BINARY_DIR})
  set_tests_properties(motion-sync-check motion-sync-model-check PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 900)
  # Renders against the reference's WebGL2 renderer (needs Playwright's Chromium).
  add_test(NAME rendercheck COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/crosscheck/render.sh ${CMAKE_BINARY_DIR} 12 7)
  set_tests_properties(rendercheck PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 900)
endif()
# The vendored musl functions against musl's own build (needs musl-gcc): every
# 61st float32 here; tests/crosscheck/libm32.sh <build> 1 runs every input.
if(NOT WIN32)
  add_test(NAME libm32 COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/crosscheck/libm32.sh ${CMAKE_BINARY_DIR} 61)
  set_tests_properties(libm32 PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 900)
endif()

add_executable(mochi2d_check_libm32 crosscheck/check_libm32.cpp)
target_link_libraries(mochi2d_check_libm32 PRIVATE mochi2d_core)
add_executable(mochi2d_check_math crosscheck/check_math.cpp)
target_link_libraries(mochi2d_check_math PRIVATE mochi2d_core)

add_executable(mochi2d_check_json crosscheck/check_json.cpp)
target_link_libraries(mochi2d_check_json PRIVATE mochi2d_conformance)
add_executable(mochi2d_check_map crosscheck/check_map.cpp)
target_link_libraries(mochi2d_check_map PRIVATE mochi2d_conformance)
add_executable(mochi2d_check_idle crosscheck/check_idle.cpp)
target_link_libraries(mochi2d_check_idle PRIVATE mochi2d_conformance)
add_executable(mochi2d_check_eval crosscheck/check_eval.cpp)
target_link_libraries(mochi2d_check_eval PRIVATE mochi2d_conformance)
add_executable(mochi2d_check_live crosscheck/check_live.cpp)
target_link_libraries(mochi2d_check_live PRIVATE mochi2d_conformance)
# The neutral voice profile's table (tests/motion_sync/README.md).
add_executable(mochi2d_make_neutral motion_sync/make_neutral.cpp support/motion_sync_support.cpp)
target_include_directories(mochi2d_make_neutral PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(mochi2d_make_neutral PRIVATE mochi2d_conformance)
target_compile_options(mochi2d_make_neutral PRIVATE ${MOCHI2D_FP_FLAGS})
add_executable(mochi2d_bench bench/bench.cpp)
target_link_libraries(mochi2d_bench PRIVATE mochi2d_core)
add_executable(mochi2d_render_bench bench/render_bench.cpp)
target_link_libraries(mochi2d_render_bench PRIVATE mochi2d_render)

# The vendored musl functions against the committed digests of musl's own build
# (every 61st input), for platforms without musl-gcc (tests/fixtures/README.md).
add_executable(mochi2d_libm32_dump crosscheck/libm32_dump.c $<TARGET_OBJECTS:mochi2d_libm32>)
target_compile_definitions(mochi2d_libm32_dump PRIVATE VENDORED)
set_target_properties(mochi2d_libm32_dump PROPERTIES C_STANDARD 99 C_STANDARD_REQUIRED ON C_EXTENSIONS OFF)
target_compile_options(mochi2d_libm32_dump PRIVATE ${MOCHI2D_FP_FLAGS})
if(UNIX AND NOT APPLE)
  target_link_libraries(mochi2d_libm32_dump PRIVATE m)
endif()
add_test(NAME libm32-fixture
         COMMAND ${CMAKE_COMMAND} -DDUMP=$<TARGET_FILE:mochi2d_libm32_dump>
                 -DEXPECTED=${PROJECT_SOURCE_DIR}/tests/fixtures/libm32.txt -DOUT=${CMAKE_BINARY_DIR}/libm32-fixture.txt
                 -P ${PROJECT_SOURCE_DIR}/tests/fixtures/libm32_compare.cmake)

# The render fixtures: the same PNG bytes with 1 and 4 threads, and as committed.
if(TARGET mochi2d-native)
  add_test(NAME render-fixtures
           COMMAND ${CMAKE_COMMAND} -DCLI=$<TARGET_FILE:mochi2d-native> -DFIXTURES=${PROJECT_SOURCE_DIR}/tests/fixtures
                   -DOUT=${CMAKE_BINARY_DIR}/render-fixtures-out -P ${PROJECT_SOURCE_DIR}/tests/fixtures/render_compare.cmake)
endif()

# Bit-exactness on the committed fixtures (tests/fixtures/README.md): the
# reference's results for synthetic scenarios, compared without Node.
if(TARGET mochi2d-native)
  add_test(NAME fixtures
           COMMAND ${CMAKE_COMMAND} -DCLI=$<TARGET_FILE:mochi2d-native> -DFIXTURES=${PROJECT_SOURCE_DIR}/tests/fixtures
                   -DOUT=${CMAKE_BINARY_DIR}/fixtures-out -P ${PROJECT_SOURCE_DIR}/tests/fixtures/compare.cmake)
endif()

# SwiftShader's Vulkan driver, beside Playwright's Chromium (the reference renders' driver).
file(GLOB _swiftshader_icds /opt/pw-browsers/chromium*/chrome-linux*/vk_swiftshader_icd.json
     $ENV{HOME}/.cache/ms-playwright/chromium*/chrome-linux*/vk_swiftshader_icd.json)
set(_swiftshader_icd "")
if(_swiftshader_icds)
  list(SORT _swiftshader_icds ORDER DESCENDING)
  list(GET _swiftshader_icds 0 _swiftshader_icd)
endif()
set(MOCHI2D_SWIFTSHADER_ICD "${_swiftshader_icd}" CACHE FILEPATH "SwiftShader's Vulkan ICD (vk_swiftshader_icd.json)")

# The OpenGL backend in a headless EGL context (Mesa's surfaceless platform
# where it is present): the render fixtures through OpenGL ES 3.0 and desktop
# OpenGL 3.3 core, compared with the reference renderer's committed renders.
# Skipped (77) when there is no such context; not built without EGL.
find_path(MOCHI2D_EGL_INCLUDE EGL/egl.h)
if(MOCHI2D_EGL_INCLUDE AND TARGET mochi2d-native AND NOT WIN32 AND NOT APPLE)
  add_executable(mochi2d-gl-render gl/gl_render.cpp support/image_compare.cpp)
  target_include_directories(mochi2d-gl-render PRIVATE ${MOCHI2D_EGL_INCLUDE} ${CMAKE_CURRENT_SOURCE_DIR})
  target_link_libraries(mochi2d-gl-render PRIVATE mochi2d_conformance mochi2d_static ${CMAKE_DL_LIBS})
  foreach(api es desktop)
    add_test(NAME gl-render-${api}
             COMMAND ${CMAKE_COMMAND} -DGL=$<TARGET_FILE:mochi2d-gl-render> -DCLI=$<TARGET_FILE:mochi2d-native>
                     -DAPI=${api} -DFIXTURES=${PROJECT_SOURCE_DIR}/tests/fixtures
                     -DOUT=${CMAKE_BINARY_DIR}/gl-render-${api} -P ${CMAKE_CURRENT_SOURCE_DIR}/gl/gl_compare.cmake)
    # The C API path on a model with masks and one with offscreens and blend codes.
    foreach(model render02-v3 render05-v6)
      set(dir ${PROJECT_SOURCE_DIR}/tests/fixtures/render/models/${model})
      file(GLOB textures ${dir}/tex*.png)
      add_test(NAME gl-capi-${api}-${model} COMMAND mochi2d-gl-render capi ${dir}/${model}.moc3 ${textures} --api ${api})
      set_tests_properties(gl-capi-${api}-${model} PROPERTIES SKIP_RETURN_CODE 77)
    endforeach()
    set_tests_properties(gl-render-${api} PROPERTIES SKIP_REGULAR_EXPRESSION "GL-SKIP")
  endforeach()
  # On ANGLE over SwiftShader's Vulkan driver (the reference renders' own
  # configuration; ANGLE built by tests/gl/build_angle.sh): the fixtures and
  # the C API, and the judge against Mochi2D's renders.
  set(MOCHI2D_ANGLE_DIR "" CACHE PATH "ANGLE's libEGL.so and libGLESv2.so (tests/gl/build_angle.sh)")
  if(MOCHI2D_ANGLE_DIR AND EXISTS "${MOCHI2D_ANGLE_DIR}/libEGL.so" AND MOCHI2D_SWIFTSHADER_ICD)
    add_test(NAME gl-render-es-angle
             COMMAND ${CMAKE_COMMAND} -DGL=$<TARGET_FILE:mochi2d-gl-render> -DCLI=$<TARGET_FILE:mochi2d-native>
                     "-DAPI=--api;es;--egl;${MOCHI2D_ANGLE_DIR}/libEGL.so" -DFIXTURES=${PROJECT_SOURCE_DIR}/tests/fixtures
                     -DOUT=${CMAKE_BINARY_DIR}/gl-render-es-angle -P ${CMAKE_CURRENT_SOURCE_DIR}/gl/gl_compare.cmake)
    set_tests_properties(gl-render-es-angle PROPERTIES SKIP_REGULAR_EXPRESSION "GL-SKIP"
                         ENVIRONMENT "VK_ICD_FILENAMES=${MOCHI2D_SWIFTSHADER_ICD}")
    foreach(model render02-v3 render05-v6)
      set(dir ${PROJECT_SOURCE_DIR}/tests/fixtures/render/models/${model})
      file(GLOB textures ${dir}/tex*.png)
      add_test(NAME gl-capi-es-angle-${model}
               COMMAND mochi2d-gl-render capi ${dir}/${model}.moc3 ${textures} --api es --egl ${MOCHI2D_ANGLE_DIR}/libEGL.so)
      set_tests_properties(gl-capi-es-angle-${model} PROPERTIES SKIP_RETURN_CODE 77
                           ENVIRONMENT "VK_ICD_FILENAMES=${MOCHI2D_SWIFTSHADER_ICD}")
    endforeach()
    if(MOCHI2D_CROSSCHECK)
      add_test(NAME rendercheck-gl-es-angle
               COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/crosscheck/render.sh ${CMAKE_BINARY_DIR} 12 7 gl-es-angle)
      set_tests_properties(rendercheck-gl-es-angle PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 900
                           ENVIRONMENT "MOCHI2D_ANGLE=${MOCHI2D_ANGLE_DIR};MOCHI2D_SWIFTSHADER_ICD=${MOCHI2D_SWIFTSHADER_ICD}")
    endif()
  endif()
  # The GL backend's renders judged against Mochi2D's own on the same driver
  # (ANGLE over the system's OpenGL ES), its numbers against the SwiftShader
  # renders reported (tests/crosscheck/render.sh; needs Playwright's Chromium).
  if(MOCHI2D_CROSSCHECK AND NOT WIN32)
    foreach(api es desktop)
      add_test(NAME rendercheck-gl-${api}
               COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/crosscheck/render.sh ${CMAKE_BINARY_DIR} 12 7 gl-${api})
      set_tests_properties(rendercheck-gl-${api} PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 900)
    endforeach()
  endif()
endif()

# The Vulkan dialect of the GPU programs, for tests/vk/make_spirv.sh.
add_executable(mochi2d-shader-sources vk/shader_sources.cpp)
target_link_libraries(mochi2d-shader-sources PRIVATE mochi2d_render)

# The Vulkan backend headless: on SwiftShader's Vulkan driver (the one beside
# Playwright's Chromium, the reference renders' driver) and on Mesa's
# lavapipe, where found. The committed SPIR-V is checked against the shaders.
if(MOCHI2D_HAS_VULKAN)
  find_library(MOCHI2D_VULKAN_LIBRARY NAMES vulkan vulkan-1)
  find_file(MOCHI2D_LAVAPIPE_ICD lvp_icd.json PATHS /usr/share/vulkan/icd.d NO_DEFAULT_PATH)
  if(MOCHI2D_VULKAN_LIBRARY AND TARGET mochi2d-native)
    add_executable(mochi2d-vk-render vk/vk_render.cpp support/image_compare.cpp)
    target_include_directories(mochi2d-vk-render PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_link_libraries(mochi2d-vk-render PRIVATE mochi2d_conformance mochi2d_static ${MOCHI2D_VULKAN_LIBRARY})
    set(_drivers "")
    if(MOCHI2D_SWIFTSHADER_ICD)
      list(APPEND _drivers swiftshader)
      set(_icd_swiftshader "${MOCHI2D_SWIFTSHADER_ICD}")
    endif()
    if(MOCHI2D_LAVAPIPE_ICD)
      list(APPEND _drivers lavapipe)
      set(_icd_lavapipe "${MOCHI2D_LAVAPIPE_ICD}")
    endif()
    foreach(driver IN LISTS _drivers)
      add_test(NAME vk-render-${driver}
               COMMAND ${CMAKE_COMMAND} -DGL=$<TARGET_FILE:mochi2d-vk-render> -DCLI=$<TARGET_FILE:mochi2d-native>
                       "-DAPI=--icd;${_icd_${driver}}" -DFIXTURES=${PROJECT_SOURCE_DIR}/tests/fixtures
                       -DOUT=${CMAKE_BINARY_DIR}/vk-render-${driver} -P ${CMAKE_CURRENT_SOURCE_DIR}/gl/gl_compare.cmake)
      set_tests_properties(vk-render-${driver} PROPERTIES SKIP_REGULAR_EXPRESSION "GL-SKIP")
      foreach(model render02-v3 render05-v6)
        set(dir ${PROJECT_SOURCE_DIR}/tests/fixtures/render/models/${model})
        file(GLOB textures ${dir}/tex*.png)
        add_test(NAME vk-capi-${driver}-${model}
                 COMMAND mochi2d-vk-render capi ${dir}/${model}.moc3 ${textures} --icd ${_icd_${driver}})
        set_tests_properties(vk-capi-${driver}-${model} PROPERTIES SKIP_RETURN_CODE 77)
      endforeach()
    endforeach()
    # The judge against Mochi2D's own renders (SwiftShader, the reference configuration's driver).
    if(MOCHI2D_CROSSCHECK AND NOT WIN32 AND MOCHI2D_SWIFTSHADER_ICD)
      add_test(NAME rendercheck-vk COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/crosscheck/render.sh ${CMAKE_BINARY_DIR} 12 7 vk)
      set_tests_properties(rendercheck-vk PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 900)
    endif()
  endif()
  # The committed SPIR-V (src/render/vk/spirv.inc) against the shaders, where glslangValidator is.
  add_test(NAME vk-spirv COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/vk/check_spirv.sh ${CMAKE_BINARY_DIR})
  set_tests_properties(vk-spirv PROPERTIES SKIP_RETURN_CODE 77)
endif()

# The Metal and Direct3D 11 backends' committed MSL and HLSL against the
# shaders, where glslangValidator and spirv-cross are (tests/gpu/make_shaders.sh).
if(NOT WIN32)
  add_test(NAME gpu-shaders COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/gpu/check_shaders.sh ${CMAKE_BINARY_DIR})
  set_tests_properties(gpu-shaders PROPERTIES SKIP_RETURN_CODE 77)
endif()

# The Metal and Direct3D 11 backends headless (tests/gpu/gpu_tool.hpp): the
# render fixtures against the software renderer, two frames through the C
# API on a model with masks and one with offscreens and blend codes.
set(_gpu_tools "")
if(MOCHI2D_HAS_METAL AND TARGET mochi2d-native)
  add_executable(mochi2d-mtl-render mtl/mtl_render.mm gpu/gpu_tool.cpp support/image_compare.cpp)
  set_target_properties(mochi2d-mtl-render PROPERTIES OBJCXX_STANDARD 17 OBJCXX_STANDARD_REQUIRED ON)
  target_compile_options(mochi2d-mtl-render PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
  target_link_libraries(mochi2d-mtl-render PRIVATE mochi2d_conformance mochi2d_static "-framework Metal"
                                                   "-framework Foundation" "-framework CoreGraphics")
  list(APPEND _gpu_tools mtl)
  set(_gpu_device_mtl "")
endif()
if(MOCHI2D_HAS_D3D11 AND TARGET mochi2d-native)
  add_executable(mochi2d-d3d11-render d3d11/d3d11_render.cpp gpu/gpu_tool.cpp support/image_compare.cpp)
  target_link_libraries(mochi2d-d3d11-render PRIVATE mochi2d_conformance mochi2d_static d3d11 dxgi)
  list(APPEND _gpu_tools d3d11)
  set(_gpu_device_d3d11 warp)
endif()
foreach(api IN LISTS _gpu_tools)
  target_include_directories(mochi2d-${api}-render PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  add_test(NAME ${api}-render
           COMMAND ${CMAKE_COMMAND} -DGL=$<TARGET_FILE:mochi2d-${api}-render> -DCLI=$<TARGET_FILE:mochi2d-native>
                   "-DAPI=--device;${_gpu_device_${api}}" -DFIXTURES=${PROJECT_SOURCE_DIR}/tests/fixtures
                   -DOUT=${CMAKE_BINARY_DIR}/${api}-render -P ${CMAKE_CURRENT_SOURCE_DIR}/gl/gl_compare.cmake)
  set_tests_properties(${api}-render PROPERTIES SKIP_REGULAR_EXPRESSION "GL-SKIP")
  foreach(model render02-v3 render05-v6)
    set(dir ${PROJECT_SOURCE_DIR}/tests/fixtures/render/models/${model})
    file(GLOB textures ${dir}/tex*.png)
    add_test(NAME ${api}-capi-${model} COMMAND mochi2d-${api}-render capi ${dir}/${model}.moc3 ${textures}
                                               --device "${_gpu_device_${api}}")
    set_tests_properties(${api}-capi-${model} PROPERTIES SKIP_RETURN_CODE 77)
  endforeach()
endforeach()

# The C API's stability list (docs/api-stability.md) against the header, and
# the shared library's exports: the header's functions, nothing but m2d_
# symbols (tests/api/api_list.py; Python 3, and nm or dumpbin).
find_package(Python3 COMPONENTS Interpreter QUIET)
if(Python3_Interpreter_FOUND)
  add_test(NAME api-list COMMAND Python3::Interpreter ${CMAKE_CURRENT_SOURCE_DIR}/api/api_list.py --check)
  # The public files cite no private records (the public copy ships without cleanroom/).
  add_test(NAME public-text COMMAND Python3::Interpreter ${CMAKE_CURRENT_SOURCE_DIR}/api/public_text.py ${PROJECT_SOURCE_DIR})
  if(TARGET mochi2d)
    if(WIN32)
      get_filename_component(_linker_dir "${CMAKE_LINKER}" DIRECTORY)
      find_program(MOCHI2D_DUMPBIN dumpbin HINTS "${_linker_dir}")
      set(_tool --dumpbin "${MOCHI2D_DUMPBIN}")
      set(_have_tool ${MOCHI2D_DUMPBIN})
    else()
      set(_tool --nm "${CMAKE_NM}")
      set(_have_tool ${CMAKE_NM})
    endif()
    if(_have_tool)
      add_test(NAME api-exports COMMAND Python3::Interpreter ${CMAKE_CURRENT_SOURCE_DIR}/api/api_list.py
                                        --exports $<TARGET_FILE:mochi2d> ${_tool})
    endif()
  endif()
endif()
