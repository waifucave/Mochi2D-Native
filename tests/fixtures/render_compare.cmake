# The render fixtures (tests/fixtures/README.md): renders the committed render
# scenarios with one thread and with four, and compares every PNG's SHA-256
# with the other thread count's and with the committed list, so the images
# are the same bytes on any number of threads and on every platform.
#
# cmake -DCLI=<mochi2d-native> -DFIXTURES=<tests/fixtures> -DOUT=<dir> -P render_compare.cmake
file(REMOVE_RECURSE "${OUT}")
foreach(threads 1 4)
  execute_process(COMMAND "${CLI}" render "${FIXTURES}/render/scenarios" --out "${OUT}/${threads}"
                          --models "${FIXTURES}/render/models" --threads ${threads} --quiet
                  OUTPUT_QUIET ERROR_QUIET)
endforeach()
file(STRINGS "${FIXTURES}/render/expected.sha256" lines)
set(count 0)
set(failures "")
foreach(line IN LISTS lines)
  if(NOT line MATCHES "^([0-9a-f]+)  (.+)$")
    continue()
  endif()
  set(expected "${CMAKE_MATCH_1}")
  set(name "${CMAKE_MATCH_2}")
  math(EXPR count "${count} + 1")
  if(NOT EXISTS "${OUT}/1/${name}" OR NOT EXISTS "${OUT}/4/${name}")
    string(APPEND failures "\n  ${name}: not rendered")
    continue()
  endif()
  file(SHA256 "${OUT}/1/${name}" one)
  file(SHA256 "${OUT}/4/${name}" four)
  if(NOT one STREQUAL four)
    string(APPEND failures "\n  ${name}: four threads give other bytes than one")
  elseif(NOT one STREQUAL expected)
    string(APPEND failures "\n  ${name}: not the committed bytes")
  endif()
endforeach()
if(count EQUAL 0)
  message(FATAL_ERROR "render fixtures: no hashes in ${FIXTURES}/render/expected.sha256")
endif()
if(failures)
  message(FATAL_ERROR "render fixtures: ${count} renders, these differ:${failures}")
endif()
message(STATUS "render fixtures: ${count} renders, the same bytes with 1 and 4 threads and as committed")
