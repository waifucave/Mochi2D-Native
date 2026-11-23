cmake_minimum_required(VERSION 3.16)
project(mochi2d_native VERSION 0.10.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
# Only the C API's functions (M2D_API) leave the shared library: every
# library is built with hidden symbols (static linking is unaffected).
set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_OBJCXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)

option(MOCHI2D_BUILD_TESTS "Build the unit tests" ON)
option(MOCHI2D_BUILD_CLI "Build the mochi2d-native command-line tool" ON)
option(MOCHI2D_SHARED "Also build the C API as a shared library" ON)
option(MOCHI2D_FUZZ "Build the fuzz targets with libFuzzer, ASan and UBSan (Clang)" OFF)
option(MOCHI2D_NO_EXCEPTIONS "Build the libraries (core, framework, C API) with C++ exceptions off" OFF)
option(MOCHI2D_THREADS "Let the renderer draw on worker threads (m2d_renderer_options.threads); OFF builds it without threads" ON)
option(MOCHI2D_SIMD "SSE2 for the warp mapping where the target has it (OFF: the scalar path, with the same results)" ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# Bit-exact float32 evaluation: every operation is a single IEEE float32
# operation. No fused multiply-adds, no fast-math, SSE2 rather than x87.
if(MSVC)
  # VS 2022 does not contract under /fp:precise (contraction needs /fp:contract).
  set(MOCHI2D_FP_FLAGS /fp:precise /utf-8)
  if(CMAKE_SIZEOF_VOID_P EQUAL 4)
    list(APPEND MOCHI2D_FP_FLAGS /arch:SSE2)
  endif()
  set(MOCHI2D_WARN_FLAGS /W4 /permissive- /utf-8)
else()
  set(MOCHI2D_FP_FLAGS -ffp-contract=off -fno-fast-math)
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(i.86|x86)$")
    list(APPEND MOCHI2D_FP_FLAGS -msse2 -mfpmath=sse)
  endif()
  set(MOCHI2D_WARN_FLAGS -Wall -Wextra -Wno-unused-parameter)
endif()

# The libraries never throw; engines often build without exceptions.
set(MOCHI2D_LIB_FLAGS)
if(MOCHI2D_NO_EXCEPTIONS)
  if(MSVC)
    set(MOCHI2D_LIB_FLAGS /EHs-c- /D_HAS_EXCEPTIONS=0)
  else()
    set(MOCHI2D_LIB_FLAGS -fno-exceptions)
  endif()
endif()

if(MOCHI2D_FUZZ)
  if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang" OR NOT CMAKE_C_COMPILER_ID MATCHES "Clang")
    message(FATAL_ERROR "MOCHI2D_FUZZ needs Clang as the C and C++ compiler (libFuzzer): CC=clang CXX=clang++")
  endif()
  add_compile_options(-fsanitize=fuzzer-no-link,address,undefined -fno-sanitize-recover=undefined -fno-omit-frame-pointer -g)
  add_link_options(-fsanitize=address,undefined)
endif()

set(MOCHI2D_CORE_SOURCES
  src/util/text.cpp
  src/util/json.cpp
  src/util/alloc.cpp
  src/core/moc/schema.cpp
  src/core/moc/read.cpp
  src/core/moc/io.cpp
  src/core/moc/structure.cpp
  src/core/moc/validate.cpp
  src/core/moc/model.cpp
  src/core/eval/instance.cpp
  src/core/eval/render_order.cpp
  src/core/eval/fp_check.cpp
  third_party/fdlibm/fdlibm.cpp
  src/core/snapshot.cpp
)

set(MOCHI2D_FRAMEWORK_SOURCES
  src/framework/jsutil.cpp
  src/framework/settings.cpp
  src/framework/values.cpp
  src/framework/motion.cpp
  src/framework/motion_queue.cpp
  src/framework/expression.cpp
  src/framework/physics.cpp
  src/framework/pose.cpp
  src/framework/effects.cpp
  src/framework/lip_sync.cpp
  src/framework/model_data.cpp
  src/framework/animator.cpp
  src/framework/animation_scenario.cpp
  src/framework/tints.cpp
  src/framework/package.cpp
  src/framework/live_input.cpp
  src/framework/motion_sync.cpp
  src/framework/motion_sync_analysis.cpp
  src/framework/motion_sync_neutral.cpp
  src/framework/motion_sync_driver.cpp
  src/framework/motion_sync_runtime.cpp
)

# musl's float32 arctangent, sine and cosine (third_party/musl, unchanged C
# sources), with the same floating-point flags as the libraries.
add_library(mochi2d_libm32 OBJECT
  third_party/musl/src/math/atan2f.c
  third_party/musl/src/math/atanf.c
  third_party/musl/src/math/sinf.c
  third_party/musl/src/math/cosf.c
  third_party/musl/src/math/__sindf.c
  third_party/musl/src/math/__cosdf.c
  third_party/musl/src/math/__rem_pio2f.c
  third_party/musl/src/math/__rem_pio2_large.c)
set_target_properties(mochi2d_libm32 PROPERTIES C_STANDARD 99 C_STANDARD_REQUIRED ON C_EXTENSIONS OFF
                                                C_VISIBILITY_PRESET hidden)
target_include_directories(mochi2d_libm32 PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/third_party/musl/include)
target_compile_options(mochi2d_libm32 PRIVATE ${MOCHI2D_FP_FLAGS})

add_library(mochi2d_core STATIC ${MOCHI2D_CORE_SOURCES} $<TARGET_OBJECTS:mochi2d_libm32>)
target_include_directories(mochi2d_core PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>
                           $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
                           $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/third_party/fdlibm>
                           $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/third_party/musl> $<INSTALL_INTERFACE:include>)
target_compile_options(mochi2d_core PRIVATE ${MOCHI2D_FP_FLAGS} ${MOCHI2D_WARN_FLAGS} ${MOCHI2D_LIB_FLAGS})
target_compile_options(mochi2d_core INTERFACE ${MOCHI2D_FP_FLAGS})
if(NOT MOCHI2D_SIMD)
  target_compile_definitions(mochi2d_core PRIVATE MOCHI2D_NO_SIMD)
endif()

# The reference renderer (docs/design.md §8): a software rasterizer, standard C++ and,
# for its optional worker threads, the platform's threads (POSIX or Windows).
add_library(mochi2d_render STATIC src/render/renderer.cpp src/render/workers.cpp src/render/plan.cpp src/render/mask_matrix.cpp
                           src/render/shaders.cpp src/render/vk/spirv.cpp
                           src/render/gpu/cross_sources.cpp)
target_link_libraries(mochi2d_render PUBLIC mochi2d_core)
target_compile_options(mochi2d_render PRIVATE ${MOCHI2D_FP_FLAGS} ${MOCHI2D_WARN_FLAGS} ${MOCHI2D_LIB_FLAGS})
if(MOCHI2D_THREADS)
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(mochi2d_render PUBLIC Threads::Threads)
else()
  target_compile_definitions(mochi2d_render PRIVATE MOCHI2D_NO_THREADS)
endif()

# The OpenGL backend (docs/design.md §8.10): OpenGL ES 3.0 or desktop OpenGL
# 3.3 core, executing the frame plan in the host's context. It links no GL
# library and includes no GL header: the host hands over its loader.
add_library(mochi2d_render_gl STATIC src/render/gl/gl_renderer.cpp)
target_link_libraries(mochi2d_render_gl PUBLIC mochi2d_render)
target_compile_options(mochi2d_render_gl PRIVATE ${MOCHI2D_FP_FLAGS} ${MOCHI2D_WARN_FLAGS} ${MOCHI2D_LIB_FLAGS})

# The Vulkan backend (docs/design.md §8.12): Vulkan 1.1, the programs as
# committed SPIR-V (src/render/vk/spirv.inc), in the host's device and
# command buffer. It links no Vulkan loader; it needs the Vulkan headers
# (vulkan/vulkan_core.h) to build, and is left out without them.
option(MOCHI2D_VULKAN "Build the Vulkan backend where the Vulkan headers are found" ON)
set(MOCHI2D_HAS_VULKAN OFF)
if(MOCHI2D_VULKAN)
  find_path(MOCHI2D_VULKAN_INCLUDE vulkan/vulkan_core.h PATHS ENV VULKAN_SDK PATH_SUFFIXES include)
  if(MOCHI2D_VULKAN_INCLUDE)
    set(MOCHI2D_HAS_VULKAN ON)
    add_library(mochi2d_render_vk STATIC src/render/vk/vk_renderer.cpp)
    target_include_directories(mochi2d_render_vk PUBLIC $<BUILD_INTERFACE:${MOCHI2D_VULKAN_INCLUDE}>)
    target_link_libraries(mochi2d_render_vk PUBLIC mochi2d_render)
    target_compile_options(mochi2d_render_vk PRIVATE ${MOCHI2D_FP_FLAGS} ${MOCHI2D_WARN_FLAGS} ${MOCHI2D_LIB_FLAGS})
  endif()
endif()

# The Metal backend (docs/design.md §8.13): the programs in MSL (committed,
# src/render/gpu/cross_sources.inc, compiled by Metal at run time), in the
# host's device and command buffer. Apple platforms; Objective-C++ with ARC.
option(MOCHI2D_METAL "Build the Metal backend on Apple platforms" ON)
set(MOCHI2D_HAS_METAL OFF)
if(MOCHI2D_METAL AND APPLE)
  enable_language(OBJCXX)
  set(MOCHI2D_HAS_METAL ON)
  add_library(mochi2d_render_mtl STATIC src/render/mtl/mtl_renderer.mm)
  set_target_properties(mochi2d_render_mtl PROPERTIES OBJCXX_STANDARD 17 OBJCXX_STANDARD_REQUIRED ON)
  target_link_libraries(mochi2d_render_mtl PUBLIC mochi2d_render "-framework Metal" "-framework Foundation")
  target_compile_options(mochi2d_render_mtl PRIVATE -fobjc-arc ${MOCHI2D_FP_FLAGS} ${MOCHI2D_WARN_FLAGS}
                                                    ${MOCHI2D_LIB_FLAGS})
endif()

# The Direct3D 11 backend (docs/design.md §8.14): the programs' committed
# HLSL (src/render/gpu/hlsl/) compiled by fxc, the Windows SDK's shader
# compiler, when the library is built; in the host's device and context. It
# links no Direct3D library. Windows, where fxc is found.
option(MOCHI2D_D3D11 "Build the Direct3D 11 backend on Windows where fxc is found" ON)
set(MOCHI2D_HAS_D3D11 OFF)
if(MOCHI2D_D3D11 AND WIN32)
  set(_fxc_hints "")
  set(_kits "C:/Program Files (x86)/Windows Kits/10/bin")
  if(DEFINED ENV{WindowsSdkDir})
    file(TO_CMAKE_PATH "$ENV{WindowsSdkDir}/bin" _sdk_bin)
    list(INSERT _kits 0 "${_sdk_bin}")
  endif()
  foreach(kits IN LISTS _kits)
    file(GLOB _versions LIST_DIRECTORIES true "${kits}/10.*")
    list(SORT _versions COMPARE NATURAL ORDER DESCENDING)
    foreach(v IN LISTS _versions)
      list(APPEND _fxc_hints "${v}/x64" "${v}/x86")
    endforeach()
    list(APPEND _fxc_hints "${kits}/x64")
  endforeach()
  find_program(MOCHI2D_FXC fxc HINTS ${_fxc_hints})
  if(MOCHI2D_FXC)
    set(MOCHI2D_HAS_D3D11 ON)
    set(_dxbc_dir ${CMAKE_CURRENT_BINARY_DIR}/d3d11)
    set(_dxbc "")
    foreach(program mesh mesh_advanced layer layer_advanced mask)
      foreach(stage vert frag)
        if(stage STREQUAL vert)
          set(_profile vs_5_0)
        else()
          set(_profile ps_5_0)
        endif()
        set(_hlsl ${CMAKE_CURRENT_SOURCE_DIR}/src/render/gpu/hlsl/${program}.${stage}.hlsl)
        set(_out ${_dxbc_dir}/d3d11_dxbc/${program}_${stage}.h)
        file(TO_NATIVE_PATH "${_hlsl}" _hlsl_native)
        file(TO_NATIVE_PATH "${_out}" _out_native)
        add_custom_command(OUTPUT ${_out}
                           COMMAND ${CMAKE_COMMAND} -E make_directory ${_dxbc_dir}/d3d11_dxbc
                           COMMAND ${MOCHI2D_FXC} /nologo /T ${_profile} /E main /Gis /Vn kDxbc_${program}_${stage}
                                   /Fh ${_out_native} ${_hlsl_native}
                           DEPENDS ${_hlsl} VERBATIM)
        list(APPEND _dxbc ${_out})
      endforeach()
    endforeach()
    add_library(mochi2d_render_d3d11 STATIC src/render/d3d11/d3d11_renderer.cpp ${_dxbc})
    target_include_directories(mochi2d_render_d3d11 PRIVATE ${_dxbc_dir})
    target_link_libraries(mochi2d_render_d3d11 PUBLIC mochi2d_render)
    target_compile_options(mochi2d_render_d3d11 PRIVATE ${MOCHI2D_FP_FLAGS} ${MOCHI2D_WARN_FLAGS} ${MOCHI2D_LIB_FLAGS})
  else()
    message(STATUS "fxc not found: the Direct3D 11 backend is left out")
  endif()
endif()

add_library(mochi2d_framework STATIC ${MOCHI2D_FRAMEWORK_SOURCES})
target_link_libraries(mochi2d_framework PUBLIC mochi2d_core)
target_compile_options(mochi2d_framework PRIVATE ${MOCHI2D_FP_FLAGS} ${MOCHI2D_WARN_FLAGS} ${MOCHI2D_LIB_FLAGS})

# Scenario files, model folders and result files: the conformance runner of
# the CLI and the tests (uses std::filesystem, so it is kept out of core and
# framework, which need nothing but standard C++17 without platform headers).
add_library(mochi2d_conformance STATIC src/conformance/scenario.cpp src/conformance/formats.cpp
                                       src/conformance/render.cpp)
target_compile_definitions(mochi2d_conformance PRIVATE MOCHI2D_VERSION="${PROJECT_VERSION}")
target_link_libraries(mochi2d_conformance PUBLIC mochi2d_framework mochi2d_render)
target_include_directories(mochi2d_conformance PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/third_party/stb)
target_compile_options(mochi2d_conformance PRIVATE ${MOCHI2D_FP_FLAGS} ${MOCHI2D_WARN_FLAGS})

# The C API (include/mochi2d.h) over the libraries.
add_library(mochi2d_static STATIC src/capi/mochi2d_c.cpp src/capi/framework_c.cpp src/capi/render_c.cpp)
target_link_libraries(mochi2d_static PUBLIC mochi2d_framework mochi2d_render mochi2d_render_gl)
target_compile_options(mochi2d_static PRIVATE ${MOCHI2D_FP_FLAGS} ${MOCHI2D_WARN_FLAGS} ${MOCHI2D_LIB_FLAGS})
target_compile_definitions(mochi2d_static PUBLIC M2D_STATIC)
set(MOCHI2D_VERSION_DEFS M2D_VERSION_MAJOR=${PROJECT_VERSION_MAJOR} M2D_VERSION_MINOR=${PROJECT_VERSION_MINOR}
                         M2D_VERSION_PATCH=${PROJECT_VERSION_PATCH})
target_compile_definitions(mochi2d_static PRIVATE ${MOCHI2D_VERSION_DEFS})
if(MOCHI2D_HAS_VULKAN)
  target_link_libraries(mochi2d_static PUBLIC mochi2d_render_vk)
  target_compile_definitions(mochi2d_static PRIVATE MOCHI2D_HAS_VULKAN)
endif()
if(MOCHI2D_HAS_METAL)
  target_link_libraries(mochi2d_static PUBLIC mochi2d_render_mtl)
  target_compile_definitions(mochi2d_static PRIVATE MOCHI2D_HAS_METAL)
endif()
if(MOCHI2D_HAS_D3D11)
  target_link_libraries(mochi2d_static PUBLIC mochi2d_render_d3d11)
  target_compile_definitions(mochi2d_static PRIVATE MOCHI2D_HAS_D3D11)
endif()

if(MOCHI2D_SHARED)
  add_library(mochi2d SHARED src/capi/mochi2d_c.cpp src/capi/framework_c.cpp src/capi/render_c.cpp)
  target_link_libraries(mochi2d PRIVATE mochi2d_framework mochi2d_render mochi2d_render_gl)
  target_include_directories(mochi2d PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
                                            $<INSTALL_INTERFACE:include>)
  target_compile_definitions(mochi2d PRIVATE M2D_BUILDING ${MOCHI2D_VERSION_DEFS})
  target_compile_options(mochi2d PRIVATE ${MOCHI2D_FP_FLAGS} ${MOCHI2D_WARN_FLAGS} ${MOCHI2D_LIB_FLAGS})
  set_target_properties(mochi2d PROPERTIES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)
  # Before 1.0 a minor release may change the API (docs/api-stability.md): the soname names the minor.
  set_target_properties(mochi2d PROPERTIES VERSION ${PROJECT_VERSION}
                                           SOVERSION ${PROJECT_VERSION_MAJOR}.${PROJECT_VERSION_MINOR})
  # The C API's functions only: also the C++ library's weak symbols that its headers keep visible.
  if(APPLE)
    target_link_options(mochi2d PRIVATE "LINKER:-exported_symbols_list,${CMAKE_CURRENT_SOURCE_DIR}/src/capi/mochi2d.exports")
  elseif(NOT WIN32)
    target_link_options(mochi2d PRIVATE "LINKER:--version-script=${CMAKE_CURRENT_SOURCE_DIR}/src/capi/mochi2d.map")
  endif()
  set_target_properties(mochi2d PROPERTIES LINK_DEPENDS
                        "${CMAKE_CURRENT_SOURCE_DIR}/src/capi/mochi2d.map;${CMAKE_CURRENT_SOURCE_DIR}/src/capi/mochi2d.exports")
  if(MOCHI2D_HAS_VULKAN)
    target_link_libraries(mochi2d PRIVATE mochi2d_render_vk)
    target_compile_definitions(mochi2d PRIVATE MOCHI2D_HAS_VULKAN)
  endif()
  if(MOCHI2D_HAS_METAL)
    target_link_libraries(mochi2d PRIVATE mochi2d_render_mtl)
    target_compile_definitions(mochi2d PRIVATE MOCHI2D_HAS_METAL)
  endif()
  if(MOCHI2D_HAS_D3D11)
    target_link_libraries(mochi2d PRIVATE mochi2d_render_d3d11)
    target_compile_definitions(mochi2d PRIVATE MOCHI2D_HAS_D3D11)
  endif()
endif()

# The package: `cmake --install` puts the header, the shared
# library (mochi2d::mochi2d), the static libraries (mochi2d::mochi2d_static,
# which brings its component libraries), a CMake package config, LICENSE and
# THIRD_PARTY_NOTICES.md under the prefix. find_package(mochi2d CONFIG).
if(CMAKE_SOURCE_DIR STREQUAL PROJECT_SOURCE_DIR)
  set(_install_default ON)
else()
  set(_install_default OFF)
endif()
option(MOCHI2D_INSTALL "Install the C API's libraries, header and CMake package config" ${_install_default})
if(MOCHI2D_INSTALL)
  include(GNUInstallDirs)
  include(CMakePackageConfigHelpers)
  set(_static_parts mochi2d_static mochi2d_core mochi2d_framework mochi2d_render mochi2d_render_gl)
  foreach(backend vk mtl d3d11)
    if(TARGET mochi2d_render_${backend})
      list(APPEND _static_parts mochi2d_render_${backend})
    endif()
  endforeach()
  set(_installed ${_static_parts})
  if(TARGET mochi2d)
    list(APPEND _installed mochi2d)
  endif()
  install(TARGETS ${_installed} EXPORT mochi2dTargets
          ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR} LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
          RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR} INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
  install(FILES include/mochi2d.h DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
  install(EXPORT mochi2dTargets NAMESPACE mochi2d:: DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/mochi2d)
  set(MOCHI2D_PACKAGE_THREADS ${MOCHI2D_THREADS})
  configure_package_config_file(cmake/mochi2dConfig.cmake.in ${CMAKE_CURRENT_BINARY_DIR}/mochi2dConfig.cmake
                                INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/mochi2d)
  write_basic_package_version_file(${CMAKE_CURRENT_BINARY_DIR}/mochi2dConfigVersion.cmake
                                   COMPATIBILITY SameMinorVersion)
  install(FILES ${CMAKE_CURRENT_BINARY_DIR}/mochi2dConfig.cmake ${CMAKE_CURRENT_BINARY_DIR}/mochi2dConfigVersion.cmake
          DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/mochi2d)
  install(FILES LICENSE THIRD_PARTY_NOTICES.md DESTINATION ${CMAKE_INSTALL_DATADIR}/mochi2d)
  # The license texts of the code compiled into the libraries (THIRD_PARTY_NOTICES.md lists them);
  # stb_image is in the command-line tool only, which is not installed.
  install(FILES third_party/fdlibm/LICENSE DESTINATION ${CMAKE_INSTALL_DATADIR}/mochi2d/third_party/fdlibm)
  install(FILES third_party/musl/COPYRIGHT DESTINATION ${CMAKE_INSTALL_DATADIR}/mochi2d/third_party/musl)
endif()

if(MOCHI2D_BUILD_CLI)
  add_executable(mochi2d-native tools/cli/main.cpp)
  target_link_libraries(mochi2d-native PRIVATE mochi2d_conformance mochi2d_static)
  target_compile_options(mochi2d-native PRIVATE ${MOCHI2D_FP_FLAGS} ${MOCHI2D_WARN_FLAGS})
endif()

if(MOCHI2D_BUILD_TESTS OR MOCHI2D_FUZZ)
  add_subdirectory(fuzz)
endif()

if(MOCHI2D_BUILD_TESTS)
  enable_testing()
  add_subdirectory(tests)
endif()
