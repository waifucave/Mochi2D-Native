# Runs mochi2d-native on the committed fixture scenarios and requires each
# result to be byte-identical to the reference's (the producer line aside).
# Portable (cmake -P), so it runs where Node is not installed.
#
#   cmake -DCLI=<mochi2d-native> -DFIXTURES=<tests/fixtures> -DOUT=<dir> -P compare.cmake
file(REMOVE_RECURSE "${OUT}")
execute_process(COMMAND "${CLI}" run "${FIXTURES}/scenarios" --out "${OUT}" --models "${FIXTURES}/models" --quiet
                OUTPUT_QUIET ERROR_QUIET)
file(GLOB expected RELATIVE "${FIXTURES}/expected" "${FIXTURES}/expected/*.result.json")
list(LENGTH expected total)
if(total EQUAL 0)
  message(FATAL_ERROR "no expected results in ${FIXTURES}/expected")
endif()
set(differ 0)
foreach(name IN LISTS expected)
  if(NOT EXISTS "${OUT}/${name}")
    message(STATUS "MISSING: ${name}")
    math(EXPR differ "${differ} + 1")
    continue()
  endif()
  file(READ "${FIXTURES}/expected/${name}" a)
  file(READ "${OUT}/${name}" b)
  string(REGEX REPLACE "\n  \"producer\": [^\n]*" "" a "${a}")
  string(REGEX REPLACE "\n  \"producer\": [^\n]*" "" b "${b}")
  if(NOT a STREQUAL b)
    message(STATUS "DIFFERS: ${name}")
    math(EXPR differ "${differ} + 1")
  endif()
endforeach()
math(EXPR same "${total} - ${differ}")
message(STATUS "fixtures: ${same}/${total} results byte-identical to the reference")
if(differ GREATER 0)
  message(FATAL_ERROR "${differ} fixture results differ from the reference")
endif()
