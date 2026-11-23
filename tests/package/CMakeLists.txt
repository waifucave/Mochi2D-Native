# A consumer of the installed package: finds it with
# find_package(mochi2d CONFIG), builds the same C program against the shared
# library and against the static libraries, and each runs one model.
#
#   cmake -S tests/package -B <dir> -DCMAKE_PREFIX_PATH=<install prefix>
cmake_minimum_required(VERSION 3.16)
project(mochi2d_consumer LANGUAGES C CXX)
find_package(mochi2d 0.10 CONFIG REQUIRED)
add_executable(consumer_shared consumer.c)
target_link_libraries(consumer_shared PRIVATE mochi2d::mochi2d)
add_executable(consumer_static consumer.c)
target_link_libraries(consumer_static PRIVATE mochi2d::mochi2d_static)
# The static libraries are C++: link with the C++ driver.
set_target_properties(consumer_static PROPERTIES LINKER_LANGUAGE CXX)
