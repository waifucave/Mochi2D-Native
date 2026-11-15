// The OpenGL functions and constants the GL backend uses: the common subset
// of OpenGL ES 3.0 and desktop OpenGL 3.3 (core profile). The library links
// no GL library and needs no GL headers: the host hands over a loader
// (eglGetProcAddress, SDL_GL_GetProcAddress, wglGetProcAddress, glfwGetProcAddress…)
// for its current context, and every function is fetched through it.
#pragma once

#include <cstddef>
#include <cstdint>

#if defined(_WIN32) && !defined(_WIN64)
#define M2D_GLAPI __stdcall
#else
#define M2D_GLAPI
#endif

namespace mochi2d::render::gl {

using GLenum = unsigned int;
using GLuint = unsigned int;
using GLint = int;
using GLsizei = int;
using GLboolean = unsigned char;
using GLbitfield = unsigned int;
using GLfloat = float;
using GLchar = char;
using GLubyte = unsigned char;
using GLintptr = std::ptrdiff_t;
using GLsizeiptr = std::ptrdiff_t;

enum : GLenum {
  GL_NO_ERROR = 0,
  GL_FALSE_ = 0,
  GL_TRUE_ = 1,
  GL_TRIANGLES = 0x0004,
  GL_TRIANGLE_STRIP = 0x0005,
  GL_ZERO = 0,
  GL_ONE = 1,
  GL_SRC_ALPHA = 0x0302,
  GL_ONE_MINUS_SRC_ALPHA = 0x0303,
  GL_DST_COLOR = 0x0306,
  GL_FUNC_ADD = 0x8006,
  GL_FRONT = 0x0404,
  GL_BACK = 0x0405,
  GL_CW = 0x0900,
  GL_CCW = 0x0901,
  GL_CULL_FACE = 0x0B44,
  GL_DEPTH_TEST = 0x0B71,
  GL_STENCIL_TEST = 0x0B90,
  GL_VIEWPORT = 0x0BA2,
  GL_DITHER = 0x0BD0,
  GL_BLEND = 0x0BE2,
  GL_SCISSOR_TEST = 0x0C11,
  GL_UNPACK_ALIGNMENT = 0x0CF5,
  GL_PACK_ALIGNMENT = 0x0D05,
  GL_MAX_TEXTURE_SIZE = 0x0D33,
  GL_TEXTURE_2D = 0x0DE1,
  GL_UNSIGNED_BYTE = 0x1401,
  GL_UNSIGNED_INT = 0x1405,
  GL_FLOAT = 0x1406,
  GL_RGBA = 0x1908,
  GL_RENDERER = 0x1F01,
  GL_VERSION = 0x1F02,
  GL_NEAREST = 0x2600,
  GL_LINEAR = 0x2601,
  GL_LINEAR_MIPMAP_LINEAR = 0x2703,
  GL_TEXTURE_MAG_FILTER = 0x2800,
  GL_TEXTURE_MIN_FILTER = 0x2801,
  GL_TEXTURE_WRAP_S = 0x2802,
  GL_TEXTURE_WRAP_T = 0x2803,
  GL_REPEAT = 0x2901,
  GL_COLOR_BUFFER_BIT = 0x4000,
  GL_CLAMP_TO_EDGE = 0x812F,
  GL_TEXTURE_BASE_LEVEL = 0x813C,
  GL_TEXTURE_MAX_LEVEL = 0x813D,
  GL_RGBA8 = 0x8058,
  GL_TEXTURE0 = 0x84C0,
  GL_ARRAY_BUFFER = 0x8892,
  GL_ELEMENT_ARRAY_BUFFER = 0x8893,
  GL_STATIC_DRAW = 0x88E4,
  GL_DYNAMIC_DRAW = 0x88E8,
  GL_FRAGMENT_SHADER = 0x8B30,
  GL_VERTEX_SHADER = 0x8B31,
  GL_COMPILE_STATUS = 0x8B81,
  GL_LINK_STATUS = 0x8B82,
  GL_INFO_LOG_LENGTH = 0x8B84,
  GL_READ_FRAMEBUFFER = 0x8CA8,
  GL_DRAW_FRAMEBUFFER = 0x8CA9,
  GL_FRAMEBUFFER_COMPLETE = 0x8CD5,
  GL_COLOR_ATTACHMENT0 = 0x8CE0,
  GL_FRAMEBUFFER = 0x8D40,
};

/** The functions, fetched by name through the host's loader. */
struct Api {
#define M2D_GL_FUNCTIONS(X)                                                                       \
  X(GLenum, GetError, (void))                                                                     \
  X(const GLubyte*, GetString, (GLenum))                                                          \
  X(void, GetIntegerv, (GLenum, GLint*))                                                          \
  X(void, Enable, (GLenum))                                                                       \
  X(void, Disable, (GLenum))                                                                      \
  X(void, Viewport, (GLint, GLint, GLsizei, GLsizei))                                             \
  X(void, Scissor, (GLint, GLint, GLsizei, GLsizei))                                              \
  X(void, ClearColor, (GLfloat, GLfloat, GLfloat, GLfloat))                                       \
  X(void, Clear, (GLbitfield))                                                                    \
  X(void, ColorMask, (GLboolean, GLboolean, GLboolean, GLboolean))                                \
  X(void, BlendEquation, (GLenum))                                                                \
  X(void, BlendFuncSeparate, (GLenum, GLenum, GLenum, GLenum))                                    \
  X(void, FrontFace, (GLenum))                                                                    \
  X(void, CullFace, (GLenum))                                                                     \
  X(GLuint, CreateShader, (GLenum))                                                               \
  X(void, ShaderSource, (GLuint, GLsizei, const GLchar* const*, const GLint*))                    \
  X(void, CompileShader, (GLuint))                                                                \
  X(void, GetShaderiv, (GLuint, GLenum, GLint*))                                                  \
  X(void, GetShaderInfoLog, (GLuint, GLsizei, GLsizei*, GLchar*))                                 \
  X(void, DeleteShader, (GLuint))                                                                 \
  X(GLuint, CreateProgram, (void))                                                                \
  X(void, AttachShader, (GLuint, GLuint))                                                         \
  X(void, LinkProgram, (GLuint))                                                                  \
  X(void, GetProgramiv, (GLuint, GLenum, GLint*))                                                 \
  X(void, GetProgramInfoLog, (GLuint, GLsizei, GLsizei*, GLchar*))                                \
  X(void, DeleteProgram, (GLuint))                                                                \
  X(void, UseProgram, (GLuint))                                                                   \
  X(GLint, GetUniformLocation, (GLuint, const GLchar*))                                           \
  X(void, Uniform1i, (GLint, GLint))                                                              \
  X(void, Uniform1f, (GLint, GLfloat))                                                            \
  X(void, Uniform2f, (GLint, GLfloat, GLfloat))                                                   \
  X(void, Uniform3f, (GLint, GLfloat, GLfloat, GLfloat))                                          \
  X(void, Uniform4f, (GLint, GLfloat, GLfloat, GLfloat, GLfloat))                                 \
  X(void, UniformMatrix4fv, (GLint, GLsizei, GLboolean, const GLfloat*))                         \
  X(void, GenBuffers, (GLsizei, GLuint*))                                                         \
  X(void, DeleteBuffers, (GLsizei, const GLuint*))                                                \
  X(void, BindBuffer, (GLenum, GLuint))                                                           \
  X(void, BufferData, (GLenum, GLsizeiptr, const void*, GLenum))                                  \
  X(void, BufferSubData, (GLenum, GLintptr, GLsizeiptr, const void*))                             \
  X(void, GenVertexArrays, (GLsizei, GLuint*))                                                    \
  X(void, DeleteVertexArrays, (GLsizei, const GLuint*))                                           \
  X(void, BindVertexArray, (GLuint))                                                              \
  X(void, EnableVertexAttribArray, (GLuint))                                                      \
  X(void, VertexAttribPointer, (GLuint, GLint, GLenum, GLboolean, GLsizei, const void*))          \
  X(void, DrawElements, (GLenum, GLsizei, GLenum, const void*))                                   \
  X(void, DrawArrays, (GLenum, GLint, GLsizei))                                                   \
  X(void, GenTextures, (GLsizei, GLuint*))                                                        \
  X(void, DeleteTextures, (GLsizei, const GLuint*))                                               \
  X(void, BindTexture, (GLenum, GLuint))                                                          \
  X(void, ActiveTexture, (GLenum))                                                                \
  X(void, TexImage2D, (GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void*)) \
  X(void, TexSubImage2D, (GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, const void*)) \
  X(void, TexParameteri, (GLenum, GLenum, GLint))                                                 \
  X(void, PixelStorei, (GLenum, GLint))                                                           \
  X(void, GenFramebuffers, (GLsizei, GLuint*))                                                    \
  X(void, DeleteFramebuffers, (GLsizei, const GLuint*))                                           \
  X(void, BindFramebuffer, (GLenum, GLuint))                                                      \
  X(void, FramebufferTexture2D, (GLenum, GLenum, GLenum, GLuint, GLint))                          \
  X(GLenum, CheckFramebufferStatus, (GLenum))                                                     \
  X(void, BlitFramebuffer, (GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLbitfield, GLenum)) \
  X(void, ReadPixels, (GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void*))

#define M2D_GL_MEMBER(ret, name, args) ret(M2D_GLAPI* name) args = nullptr;
  M2D_GL_FUNCTIONS(M2D_GL_MEMBER)
#undef M2D_GL_MEMBER
};

/** The host's loader: the address of a GL function of its current context, or null. */
using Loader = void* (*)(const char* name, void* user);

/** Fetches every function; false with the name of the first that is missing. */
bool load(Api& api, Loader loader, void* user, const char** missing);

}  // namespace mochi2d::render::gl
