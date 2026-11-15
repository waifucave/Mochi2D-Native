// The Vulkan backend (docs/design.md §8.12): the frame plan (render/plan.hpp)
// executed with Vulkan 1.1, the GL backend's programs compiled to SPIR-V
// (render/vk/spirv.hpp), recorded into the host's command buffer and drawn
// into the host's image. The library makes no instance, device, queue or
// swap chain, and links no Vulkan loader.
//
// The host's side:
// - its vkGetInstanceProcAddr, instance, physical device, device, and a
//   queue with its family: the queue runs the one-time texture uploads at
//   creation (the renderer waits for them), so no other thread may use it
//   then;
// - per frame, a command buffer in the recording state, outside a render
//   pass, and the target: an image with a view, its format (any color
//   format the device can render to; RGBA8 for Mochi2D's results), its
//   layout before and the layout to leave it in. The image needs
//   COLOR_ATTACHMENT usage.
// - the command buffers it records are submitted in the order they were
//   recorded, to that queue (the renderer's vertex uploads and its own
//   images are ordered by barriers in them); one draw's command buffer is
//   submitted before the next draw records, and a draw at a frame size
//   larger than before waits for the device to be idle, then grows its
//   layers.
// - before it destroys a target view the renderer has drawn into, the
//   host calls forget_target (the renderer keeps a framebuffer per view).
//
// The image comes out with the top row first (flip_y, the default: a
// negative viewport height for the draws into it), premultiplied; inside,
// masks and layers are laid out as in OpenGL, so the programs are the GL
// backend's.
#pragma once

#include <cstdint>
#include <memory>

#include "render/plan.hpp"
#include "render/renderer.hpp"
#include "render/vk/vk_api.hpp"
#include "util/alloc.hpp"

namespace mochi2d::render::vk {

struct VkContext {
  PFN_vkGetInstanceProcAddr get_instance_proc_addr = nullptr;
  VkInstance instance = VK_NULL_HANDLE;
  VkPhysicalDevice physical_device = VK_NULL_HANDLE;
  VkDevice device = VK_NULL_HANDLE;
  VkQueue queue = VK_NULL_HANDLE;
  uint32_t queue_family = 0;
};

struct VkOptions {
  int mask_size = Renderer::kMaskSize;
  int offscreen_mask_size = Renderer::kOffscreenMaskSize;
  /** The largest texture side: 0 the device's maxImageDimension2D; n > 0 at most n. */
  int max_texture_size = 0;
  /** The top row first in the host's image (false: the bottom row first, as OpenGL's framebuffers). */
  bool flip_y = true;
};

struct VkTarget {
  VkImage image = VK_NULL_HANDLE;
  VkImageView view = VK_NULL_HANDLE;
  VkFormat format = VK_FORMAT_R8G8B8A8_UNORM;
  VkImageLayout old_layout = VK_IMAGE_LAYOUT_UNDEFINED;
  VkImageLayout new_layout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
};

class VkRenderer {
 public:
  VkRenderer(std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const Texture>> textures,
             const VkContext& context, const VkOptions& options = {});
  ~VkRenderer();
  VkRenderer(const VkRenderer&) = delete;
  VkRenderer& operator=(const VkRenderer&) = delete;

  bool ok() const { return created_; }
  const String& error() const { return error_; }
  /** "vk-function", "vk-texture-size", "vk-format" or "vk-error". */
  const char* error_code() const { return error_code_; }

  /**
   * Records the instance's latest evaluation, drawn into `target` of
   * framing.width × framing.height, into `cmd`. False with `error()` when
   * a Vulkan call fails or the target's format cannot be rendered to.
   */
  bool draw(const eval::Instance& instance, const FrameOptions& frame, VkCommandBuffer cmd, const VkTarget& target);
  /** Drops what the renderer keeps for a target view (call before destroying it). */
  void forget_target(VkImageView view);
  /**
   * Replaces texture `index`, or its region at (x, y) the size of the
   * straight-alpha image (w × h, rows `stride` bytes apart, 0 for 4·w), as
   * Mochi2D 0.14.0's updateTexture: the prepared levels recomputed where the
   * region reaches, and those rectangles copied into the image on the
   * context's queue (after the work already submitted to it, which a barrier
   * orders), waited for. Drawn from the next recorded frame. False for a
   * missing texture, a region that does not fit, or a Vulkan error.
   */
  bool update_texture(int index, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x, int y);

  const FramePlan& plan() const { return plan_; }
  int max_texture_size() const { return max_texture_size_; }

 private:
  struct Image {
    VkImage image = VK_NULL_HANDLE;
    VkDeviceMemory memory = VK_NULL_HANDLE;
    VkImageView view = VK_NULL_HANDLE;
    VkFramebuffer framebuffer = VK_NULL_HANDLE;
    int width = 0, height = 0;
    VkImageLayout layout = VK_IMAGE_LAYOUT_UNDEFINED;
  };
  struct Buffer {
    VkBuffer buffer = VK_NULL_HANDLE;
    VkDeviceMemory memory = VK_NULL_HANDLE;
  };
  struct HostTarget {
    VkImageView view = VK_NULL_HANDLE;
    VkFramebuffer framebuffer = VK_NULL_HANDLE;
    VkFormat format = VK_FORMAT_UNDEFINED;
    int width = 0, height = 0;
  };
  /** Render pass and pipelines for one target format and orientation. */
  struct Pass {
    VkFormat format = VK_FORMAT_UNDEFINED;
    bool flipped = false;
    VkRenderPass render_pass = VK_NULL_HANDLE;
    /** [program][blend kind][cull]; the mask program's slot is blend 0. */
    VkPipeline pipelines[5][4][2] = {};
  };
  struct DescriptorKey {
    VkImageView tex, mask, dst;
    VkDescriptorSet set;
  };

  bool fail(const char* what, const char* code = "vk-error", VkResult result = VK_SUCCESS);
  bool check(VkResult r, const char* what);
  bool create_buffer(Buffer& b, VkDeviceSize size, VkBufferUsageFlags usage, VkMemoryPropertyFlags props);
  void destroy_buffer(Buffer& b);
  bool create_image(Image& im, int width, int height, uint32_t levels, VkImageUsageFlags usage, bool framebuffer);
  void destroy_image(Image& im);
  bool memory_type(uint32_t bits, VkMemoryPropertyFlags props, uint32_t& out) const;
  bool upload_textures();
  Pass* pass_for(VkFormat format, bool flipped);
  bool create_pipelines(Pass& p);
  VkDescriptorSet descriptor(VkImageView tex, VkImageView mask, VkImageView dst);
  // Recording.
  void barrier(Image& im, VkImageLayout layout);
  void end_pass();
  bool begin_pass(int32_t target);
  bool execute(const RenderOp& op);
  void upload_vertices(const eval::Instance& instance);

  std::shared_ptr<const moc::Model> model_;
  Vector<std::shared_ptr<const Texture>> textures_;
  Vector<uint8_t> own_texture_;
  VkContext ctx_;
  Api vk_;
  VkOptions options_;
  RenderModel rm_;
  bool ok_ = true, created_ = false;
  String error_;
  const char* error_code_ = "";
  int max_texture_size_ = 0;
  VkPhysicalDeviceMemoryProperties memory_{};

  VkCommandPool setup_pool_ = VK_NULL_HANDLE;
  VkSampler texture_sampler_ = VK_NULL_HANDLE, mask_sampler_ = VK_NULL_HANDLE, nearest_sampler_ = VK_NULL_HANDLE;
  VkDescriptorSetLayout set_layout_ = VK_NULL_HANDLE;
  VkPipelineLayout pipeline_layout_ = VK_NULL_HANDLE;
  VkDescriptorPool descriptor_pool_ = VK_NULL_HANDLE;
  Vector<DescriptorKey> descriptors_;
  VkShaderModule modules_[5][2] = {};
  Vector<std::shared_ptr<Pass>> passes_;

  Vector<Image> textures_gpu_;
  Vector<uint8_t> has_texture_;
  Image dummy_, mask_target_, offscreen_mask_target_, dst_copy_;
  Vector<Image> layers_;
  int layer_width_ = 0, layer_height_ = 0;
  Buffer positions_, uvs_, indices_;
  Vector<uint32_t> vertex_start_, index_start_, index_count_, staged_;
  uint64_t staged_for_ = 0;
  Vector<HostTarget> host_targets_;

  // The frame being recorded.
  VkCommandBuffer cmd_ = VK_NULL_HANDLE;
  const VkTarget* target_ = nullptr;
  HostTarget* host_ = nullptr;
  VkImageLayout host_layout_ = VK_IMAGE_LAYOUT_UNDEFINED;
  int32_t pass_target_ = -2;
  FramePlan plan_;
  Framing framing_;
};

}  // namespace mochi2d::render::vk
