/* A consumer of the package: loads a .moc3, runs the animator for a second
 * on an instance, and draws a frame with the reference renderer, through
 * the C API only. Prints what it saw; exit code 1 on any error.
 *
 * usage: consumer <model.moc3>
 */
#include <stdio.h>
#include <stdlib.h>

#include "mochi2d.h"

static int fail(const char* what, const m2d_error* e) {
  fprintf(stderr, "consumer: %s: %s\n", what, e ? e->message : "");
  return 1;
}

int main(int argc, char** argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: consumer <model.moc3>\n");
    return 2;
  }
  FILE* f = fopen(argv[1], "rb");
  if (!f) return fail("cannot open the model", NULL);
  fseek(f, 0, SEEK_END);
  long size = ftell(f);
  fseek(f, 0, SEEK_SET);
  unsigned char* bytes = (unsigned char*)malloc((size_t)size);
  if (!bytes || fread(bytes, 1, (size_t)size, f) != (size_t)size) return fail("cannot read the model", NULL);
  fclose(f);
  m2d_error err;
  m2d_model* model = NULL;
  if (m2d_model_load(bytes, (size_t)size, 0, NULL, &model, &err) != M2D_OK) return fail("m2d_model_load", &err);
  free(bytes);
  m2d_instance* instance = NULL;
  m2d_animator* animator = NULL;
  m2d_renderer* renderer = NULL;
  if (m2d_instance_create(model, &instance, &err) != M2D_OK) return fail("m2d_instance_create", &err);
  if (m2d_animator_create(model, NULL, NULL, NULL, NULL, &animator, &err) != M2D_OK)
    return fail("m2d_animator_create", &err);
  m2d_frame frame;
  for (int k = 0; k < 30; k++)
    if (m2d_animator_update(animator, instance, 1.0 / 30, &frame, &err) != M2D_OK) return fail("update", &err);
  if (m2d_renderer_create(model, NULL, 0, NULL, &renderer, &err) != M2D_OK) return fail("m2d_renderer_create", &err);
  enum { W = 64, H = 64 };
  static unsigned char pixels[W * H * 4];
  m2d_render_frame rf;
  m2d_render_frame_default(&rf);
  rf.background[3] = 1;
  if (m2d_renderer_draw(renderer, instance, &rf, W, H, pixels, 0, &err) != M2D_OK) return fail("draw", &err);
  const uint32_t v = m2d_version();
  printf("mochi2d %u.%u.%u: %d parameters, %d parts, %d drawables; a frame of %dx%d drawn (alpha %d)\n",
         (unsigned)(v >> 16) & 255u, (unsigned)(v >> 8) & 255u, (unsigned)v & 255u,
         (int)m2d_model_parameter_count(model), (int)m2d_model_part_count(model),
         (int)m2d_model_drawable_count(model), W, H, pixels[3]);
  m2d_renderer_destroy(renderer);
  m2d_animator_destroy(animator);
  m2d_instance_destroy(instance);
  m2d_model_destroy(model);
  return 0;
}
