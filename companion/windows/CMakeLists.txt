cmake_minimum_required(VERSION 3.20)
project(live_translator_companion LANGUAGES CXX)

add_executable(live-translator-companion WIN32
  src/main.cpp
)

target_compile_features(live-translator-companion PRIVATE cxx_std_17)
target_compile_definitions(live-translator-companion PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)

target_link_libraries(live-translator-companion PRIVATE
  ws2_32
  ole32
  avrt
  bcrypt
)
