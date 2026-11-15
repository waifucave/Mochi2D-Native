# The vendored musl float32 functions (third_party/musl), as this platform's
# compiler builds them, against the committed digests of musl's own build
# (tests/fixtures/libm32.txt: tests/crosscheck/libm32.sh's musl-gcc side,
# every 61st float32 input of atanf, sinf and cosf, and the atan2f pairs),
# for platforms without musl-gcc.
#
# cmake -DDUMP=<mochi2d_libm32_dump> -DEXPECTED=<tests/fixtures/libm32.txt> -DOUT=<file> -P libm32_compare.cmake
execute_process(COMMAND "${DUMP}" 61 OUTPUT_FILE "${OUT}" RESULT_VARIABLE status)
if(NOT status EQUAL 0)
  message(FATAL_ERROR "libm32 fixture: ${DUMP} failed (${status})")
endif()
file(STRINGS "${EXPECTED}" expected)
file(STRINGS "${OUT}" actual)
list(LENGTH expected n)
if(NOT expected STREQUAL actual)
  set(diff "")
  foreach(i RANGE 0 ${n})
    if(i LESS n)
      list(GET expected ${i} e)
      list(LENGTH actual m)
      if(i LESS m)
        list(GET actual ${i} a)
      else()
        set(a "(missing)")
      endif()
      if(NOT e STREQUAL a)
        string(APPEND diff "\n  musl: ${e}\n  here: ${a}")
      endif()
    endif()
  endforeach()
  message(FATAL_ERROR "libm32 fixture: the vendored functions differ from musl's build:${diff}")
endif()
message(STATUS "libm32 fixture: ${n} chunk digests identical to musl's build")
