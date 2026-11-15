// The Vulkan backend's test tool: a headless Vulkan host (an instance, a
// device with a graphics queue, an RGBA8 image per frame size, read back
// through a buffer) that renders scenarios through the Vulkan backend, as
// `mochi2d-native render` does with the reference renderer.
//
//   mochi2d-vk-render info [--icd <json>]
//   mochi2d-vk-render render <scenario.json | folder>... --out <folder> [--models <folder>] [--icd <json>]
//                            [--max-texture-size N | device]
//   mochi2d-vk-render capi <model.moc3> <texture.png>... [--icd <json>]
//
// `--icd` picks the driver (VK_ICD_FILENAMES): SwiftShader's
// `vk_swiftshader_icd.json` beside Playwright's Chromium, the reference
// renders' driver, or Mesa's lavapipe (`lvp_icd.json`). `render` caps
// textures at 8192 by default, the reference configuration's limit (its
// TextureTooLarge), for conformance runs; `--max-texture-size device` takes
// the device's maxImageDimension2D, the backend's own default. Exit code 77 when no Vulkan 1.1 device can be made.
// Test code: the library makes no instance.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#include "conformance/render.hpp"
#include "mochi2d.h"
#include "render/vk/vk_renderer.hpp"
#include "support/image_compare.hpp"

extern "C" VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL vkGetInstanceProcAddr(VkInstance instance, const char* name);

namespace fs = std::filesystem;
using namespace mochi2d;
namespace rvk = mochi2d::render::vk;

namespace {

struct Host {
  PFN_vkGetInstanceProcAddr gipa = vkGetInstanceProcAddr;
  VkInstance instance = VK_NULL_HANDLE;
  VkPhysicalDevice physical = VK_NULL_HANDLE;
  VkDevice device = VK_NULL_HANDLE;
  VkQueue queue = VK_NULL_HANDLE;
  uint32_t family = 0;
  VkCommandPool pool = VK_NULL_HANDLE;
  String name, error;
#define M2D_HOST_FN(n) PFN_vk##n n = nullptr;
  M2D_HOST_FN(CreateInstance)
  M2D_HOST_FN(DestroyInstance)
  M2D_HOST_FN(EnumeratePhysicalDevices)
  M2D_HOST_FN(GetPhysicalDeviceProperties)
  M2D_HOST_FN(GetPhysicalDeviceQueueFamilyProperties)
  M2D_HOST_FN(GetPhysicalDeviceMemoryProperties)
  M2D_HOST_FN(CreateDevice)
  M2D_HOST_FN(DestroyDevice)
  M2D_HOST_FN(GetDeviceQueue)
  M2D_HOST_FN(DeviceWaitIdle)
  M2D_HOST_FN(CreateCommandPool)
  M2D_HOST_FN(DestroyCommandPool)
  M2D_HOST_FN(AllocateCommandBuffers)
  M2D_HOST_FN(FreeCommandBuffers)
  M2D_HOST_FN(BeginCommandBuffer)
  M2D_HOST_FN(EndCommandBuffer)
  M2D_HOST_FN(QueueSubmit)
  M2D_HOST_FN(QueueWaitIdle)
  M2D_HOST_FN(CreateImage)
  M2D_HOST_FN(DestroyImage)
  M2D_HOST_FN(GetImageMemoryRequirements)
  M2D_HOST_FN(BindImageMemory)
  M2D_HOST_FN(CreateImageView)
  M2D_HOST_FN(DestroyImageView)
  M2D_HOST_FN(CreateBuffer)
  M2D_HOST_FN(DestroyBuffer)
  M2D_HOST_FN(GetBufferMemoryRequirements)
  M2D_HOST_FN(BindBufferMemory)
  M2D_HOST_FN(AllocateMemory)
  M2D_HOST_FN(FreeMemory)
  M2D_HOST_FN(MapMemory)
  M2D_HOST_FN(UnmapMemory)
  M2D_HOST_FN(CmdCopyImageToBuffer)
  M2D_HOST_FN(CmdPipelineBarrier)
#undef M2D_HOST_FN

  bool open(const std::string& icd) {
    if (!icd.empty()) setenv("VK_ICD_FILENAMES", icd.c_str(), 1);
#define M2D_LOAD_G(n) n = reinterpret_cast<PFN_vk##n>(gipa(instance, "vk" #n));
    M2D_LOAD_G(CreateInstance)
    if (!CreateInstance) return fail("no Vulkan loader");
    VkApplicationInfo app{};
    app.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    app.pApplicationName = "mochi2d-vk-render";
    app.apiVersion = VK_API_VERSION_1_1;
    VkInstanceCreateInfo ii{};
    ii.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    ii.pApplicationInfo = &app;
    if (CreateInstance(&ii, nullptr, &instance) != VK_SUCCESS) return fail("vkCreateInstance fails");
#define M2D_LOAD_I(n) n = reinterpret_cast<PFN_vk##n>(gipa(instance, "vk" #n));
    M2D_LOAD_I(DestroyInstance)
    M2D_LOAD_I(EnumeratePhysicalDevices)
    M2D_LOAD_I(GetPhysicalDeviceProperties)
    M2D_LOAD_I(GetPhysicalDeviceQueueFamilyProperties)
    M2D_LOAD_I(GetPhysicalDeviceMemoryProperties)
    M2D_LOAD_I(CreateDevice)
    uint32_t n = 0;
    EnumeratePhysicalDevices(instance, &n, nullptr);
    if (n == 0) return fail("no Vulkan device");
    std::vector<VkPhysicalDevice> devices(n);
    EnumeratePhysicalDevices(instance, &n, devices.data());
    for (VkPhysicalDevice d : devices) {
      VkPhysicalDeviceProperties p{};
      GetPhysicalDeviceProperties(d, &p);
      if (p.apiVersion < VK_API_VERSION_1_1) continue;
      uint32_t q = 0;
      GetPhysicalDeviceQueueFamilyProperties(d, &q, nullptr);
      std::vector<VkQueueFamilyProperties> qs(q);
      GetPhysicalDeviceQueueFamilyProperties(d, &q, qs.data());
      for (uint32_t i = 0; i < q; i++)
        if (qs[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) {
          physical = d;
          family = i;
          name = String(p.deviceName) + " (Vulkan " + to_str(static_cast<long long>(VK_API_VERSION_MAJOR(p.apiVersion))) +
                 "." + to_str(static_cast<long long>(VK_API_VERSION_MINOR(p.apiVersion))) + ")";
          break;
        }
      if (physical) break;
    }
    if (!physical) return fail("no Vulkan 1.1 device with a graphics queue");
    const float priority = 1;
    VkDeviceQueueCreateInfo qi{};
    qi.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
    qi.queueFamilyIndex = family;
    qi.queueCount = 1;
    qi.pQueuePriorities = &priority;
    VkDeviceCreateInfo di{};
    di.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    di.queueCreateInfoCount = 1;
    di.pQueueCreateInfos = &qi;
    if (CreateDevice(physical, &di, nullptr, &device) != VK_SUCCESS) return fail("vkCreateDevice fails");
    auto gdpa = reinterpret_cast<PFN_vkGetDeviceProcAddr>(gipa(instance, "vkGetDeviceProcAddr"));
#define M2D_LOAD_D(n) n = reinterpret_cast<PFN_vk##n>(gdpa(device, "vk" #n));
    M2D_LOAD_D(DestroyDevice)
    M2D_LOAD_D(GetDeviceQueue)
    M2D_LOAD_D(DeviceWaitIdle)
    M2D_LOAD_D(CreateCommandPool)
    M2D_LOAD_D(DestroyCommandPool)
    M2D_LOAD_D(AllocateCommandBuffers)
    M2D_LOAD_D(FreeCommandBuffers)
    M2D_LOAD_D(BeginCommandBuffer)
    M2D_LOAD_D(EndCommandBuffer)
    M2D_LOAD_D(QueueSubmit)
    M2D_LOAD_D(QueueWaitIdle)
    M2D_LOAD_D(CreateImage)
    M2D_LOAD_D(DestroyImage)
    M2D_LOAD_D(GetImageMemoryRequirements)
    M2D_LOAD_D(BindImageMemory)
    M2D_LOAD_D(CreateImageView)
    M2D_LOAD_D(DestroyImageView)
    M2D_LOAD_D(CreateBuffer)
    M2D_LOAD_D(DestroyBuffer)
    M2D_LOAD_D(GetBufferMemoryRequirements)
    M2D_LOAD_D(BindBufferMemory)
    M2D_LOAD_D(AllocateMemory)
    M2D_LOAD_D(FreeMemory)
    M2D_LOAD_D(MapMemory)
    M2D_LOAD_D(UnmapMemory)
    M2D_LOAD_D(CmdCopyImageToBuffer)
    M2D_LOAD_D(CmdPipelineBarrier)
    GetDeviceQueue(device, family, 0, &queue);
    VkCommandPoolCreateInfo pi{};
    pi.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
    pi.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    pi.queueFamilyIndex = family;
    if (CreateCommandPool(device, &pi, nullptr, &pool) != VK_SUCCESS) return fail("vkCreateCommandPool fails");
    return true;
  }
  bool fail(const char* what) {
    error = what;
    return false;
  }
  ~Host() {
    if (device) {
      DeviceWaitIdle(device);
      if (pool) DestroyCommandPool(device, pool, nullptr);
      DestroyDevice(device, nullptr);
    }
    if (instance) DestroyInstance(instance, nullptr);
  }
  rvk::VkContext context() const {
    rvk::VkContext c;
    c.get_instance_proc_addr = gipa;
    c.instance = instance;
    c.physical_device = physical;
    c.device = device;
    c.queue = queue;
    c.queue_family = family;
    return c;
  }
  uint32_t memory_type(uint32_t bits, VkMemoryPropertyFlags props) const {
    VkPhysicalDeviceMemoryProperties m{};
    GetPhysicalDeviceMemoryProperties(physical, &m);
    for (uint32_t i = 0; i < m.memoryTypeCount; i++)
      if ((bits & (1u << i)) && (m.memoryTypes[i].propertyFlags & props) == props) return i;
    return 0;
  }
};

/** The host's target: an RGBA8 image with a view, and a buffer the frame is read back through. */
struct Target {
  Host& h;
  int width = 0, height = 0;
  VkImage image = VK_NULL_HANDLE;
  VkImageView view = VK_NULL_HANDLE;
  VkDeviceMemory image_memory = VK_NULL_HANDLE, buffer_memory = VK_NULL_HANDLE;
  VkBuffer buffer = VK_NULL_HANDLE;
  VkCommandBuffer cmd = VK_NULL_HANDLE;
  explicit Target(Host& host) : h(host) {}
  ~Target() { release(); }
  void release() {
    if (!h.device) return;
    h.DeviceWaitIdle(h.device);
    if (view) h.DestroyImageView(h.device, view, nullptr);
    if (image) h.DestroyImage(h.device, image, nullptr);
    if (buffer) h.DestroyBuffer(h.device, buffer, nullptr);
    if (image_memory) h.FreeMemory(h.device, image_memory, nullptr);
    if (buffer_memory) h.FreeMemory(h.device, buffer_memory, nullptr);
    if (cmd) h.FreeCommandBuffers(h.device, h.pool, 1, &cmd);
    view = VK_NULL_HANDLE;
    image = VK_NULL_HANDLE;
    buffer = VK_NULL_HANDLE;
    image_memory = buffer_memory = VK_NULL_HANDLE;
    cmd = VK_NULL_HANDLE;
    width = height = 0;
  }
  bool make(int w, int h_) {
    release();
    width = w;
    height = h_;
    VkImageCreateInfo ii{};
    ii.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO;
    ii.imageType = VK_IMAGE_TYPE_2D;
    ii.format = VK_FORMAT_R8G8B8A8_UNORM;
    ii.extent = {static_cast<uint32_t>(w), static_cast<uint32_t>(h_), 1};
    ii.mipLevels = ii.arrayLayers = 1;
    ii.samples = VK_SAMPLE_COUNT_1_BIT;
    ii.tiling = VK_IMAGE_TILING_OPTIMAL;
    ii.usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
    if (h.CreateImage(h.device, &ii, nullptr, &image) != VK_SUCCESS) return false;
    VkMemoryRequirements req{};
    h.GetImageMemoryRequirements(h.device, image, &req);
    VkMemoryAllocateInfo ai{};
    ai.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    ai.allocationSize = req.size;
    ai.memoryTypeIndex = h.memory_type(req.memoryTypeBits, 0);
    if (h.AllocateMemory(h.device, &ai, nullptr, &image_memory) != VK_SUCCESS ||
        h.BindImageMemory(h.device, image, image_memory, 0) != VK_SUCCESS)
      return false;
    VkImageViewCreateInfo vi{};
    vi.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO;
    vi.image = image;
    vi.viewType = VK_IMAGE_VIEW_TYPE_2D;
    vi.format = VK_FORMAT_R8G8B8A8_UNORM;
    vi.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    if (h.CreateImageView(h.device, &vi, nullptr, &view) != VK_SUCCESS) return false;
    VkBufferCreateInfo bi{};
    bi.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
    bi.size = static_cast<VkDeviceSize>(w) * static_cast<VkDeviceSize>(h_) * 4;
    bi.usage = VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    if (h.CreateBuffer(h.device, &bi, nullptr, &buffer) != VK_SUCCESS) return false;
    h.GetBufferMemoryRequirements(h.device, buffer, &req);
    ai.allocationSize = req.size;
    ai.memoryTypeIndex = h.memory_type(req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
                                                                VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    if (h.AllocateMemory(h.device, &ai, nullptr, &buffer_memory) != VK_SUCCESS ||
        h.BindBufferMemory(h.device, buffer, buffer_memory, 0) != VK_SUCCESS)
      return false;
    VkCommandBufferAllocateInfo ca{};
    ca.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
    ca.commandPool = h.pool;
    ca.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    ca.commandBufferCount = 1;
    return h.AllocateCommandBuffers(h.device, &ca, &cmd) == VK_SUCCESS;
  }
  bool begin() {
    VkCommandBufferBeginInfo bi{};
    bi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    return h.BeginCommandBuffer(cmd, &bi) == VK_SUCCESS;
  }
  /** The image (in TRANSFER_SRC_OPTIMAL) copied to the buffer, submitted, waited for, read rows as they are. */
  bool finish(Vector<uint8_t>& rgba) {
    VkBufferImageCopy region{};
    region.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    region.imageExtent = {static_cast<uint32_t>(width), static_cast<uint32_t>(height), 1};
    h.CmdCopyImageToBuffer(cmd, image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, buffer, 1, &region);
    VkMemoryBarrier mb{VK_STRUCTURE_TYPE_MEMORY_BARRIER, nullptr, VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_HOST_READ_BIT};
    h.CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_HOST_BIT, 0, 1, &mb, 0, nullptr, 0,
                         nullptr);
    if (h.EndCommandBuffer(cmd) != VK_SUCCESS) return false;
    VkSubmitInfo si{};
    si.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    si.commandBufferCount = 1;
    si.pCommandBuffers = &cmd;
    if (h.QueueSubmit(h.queue, 1, &si, VK_NULL_HANDLE) != VK_SUCCESS || h.QueueWaitIdle(h.queue) != VK_SUCCESS)
      return false;
    void* p = nullptr;
    if (h.MapMemory(h.device, buffer_memory, 0, VK_WHOLE_SIZE, 0, &p) != VK_SUCCESS) return false;
    rgba.assign(static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4, 0);
    std::memcpy(rgba.data(), p, rgba.size());
    h.UnmapMemory(h.device, buffer_memory);
    return true;
  }
};

class VkDrawer : public conformance::Drawer {
 public:
  VkDrawer(Host& h, std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const render::Texture>> textures,
           const rvk::VkOptions& options)
      : h_(h), r_(std::move(model), std::move(textures), h.context(), options), target_(h), options_(options) {}
  ~VkDrawer() override {
    if (target_.view) r_.forget_target(target_.view);
    target_.release();
  }
  bool ok(String& error) const {
    if (!r_.ok()) error = r_.error();
    return r_.ok();
  }
  bool draw(const eval::Instance& instance, const render::FrameOptions& frame, render::Image& out,
            String& error) override {
    const int w = frame.framing.width, h = frame.framing.height;
    if (w != target_.width || h != target_.height) {
      if (target_.view) r_.forget_target(target_.view);
      if (!target_.make(w, h)) {
        error = "the host's image cannot be made";
        return false;
      }
    }
    if (!target_.begin()) {
      error = "vkBeginCommandBuffer fails";
      return false;
    }
    rvk::VkTarget t;
    t.image = target_.image;
    t.view = target_.view;
    t.format = VK_FORMAT_R8G8B8A8_UNORM;
    t.old_layout = VK_IMAGE_LAYOUT_UNDEFINED;
    t.new_layout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
    if (!r_.draw(instance, frame, target_.cmd, t)) {
      error = r_.error();
      h_.EndCommandBuffer(target_.cmd);
      return false;
    }
    out.width = w;
    out.height = h;
    if (!target_.finish(out.rgba)) {
      error = "the frame cannot be read back";
      return false;
    }
    return true;
  }
  const render::FrameStats& stats() const override { return r_.plan().stats; }
  int mask_size() const override { return options_.mask_size; }
  int offscreen_mask_size() const override { return options_.offscreen_mask_size; }
  String name() const override { return "mochi2d-native Vulkan backend (" + h_.name + ")"; }

 private:
  Host& h_;
  rvk::VkRenderer r_;
  Target target_;
  rvk::VkOptions options_;
};

const char* const kUsage =
    "usage:\n"
    "  mochi2d-vk-render info [--icd <json>]\n"
    "  mochi2d-vk-render render <scenario.json | folder>... --out <folder> [--models <folder>] [--icd <json>]\n"
    "                           [--max-texture-size N | device]\n"
    "  mochi2d-vk-render capi <model.moc3> <texture.png>... [--icd <json>]\n"
    "  mochi2d-vk-render compare <folder a> <folder b> [--max-rms <x>] [--max-diff <n>]\n";

struct Args {
  std::vector<std::string> positional;
  std::string out, models, icd;
  /** The reference configuration's cap by default (conformance runs); 0 (`device`) the driver's limit. */
  int max_texture_size = M2D_MAX_TEXTURE_SIZE;
  double max_rms = -1, max_diff = -1;
};

/** The C API path: create, two frames (with a change between them), stats, refusals. */
int capi(const Args& a, Host& h) {
  if (a.positional.empty()) {
    std::cerr << kUsage;
    return 2;
  }
  String bytes;
  if (!test::read_file(fs::u8path(a.positional[0]), bytes)) return 1;
  int failures = 0;
  const auto check = [&](bool ok, const char* what) {
    if (!ok) {
      std::cout << "FAIL " << what << "\n";
      failures++;
    }
  };
  m2d_error err;
  m2d_model* model = nullptr;
  if (m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err) != M2D_OK) return 1;
  std::vector<m2d_texture*> textures;
  std::vector<std::vector<uint8_t>> images;
  std::vector<std::pair<int, int>> sizes;
  for (std::size_t i = 1; i < a.positional.size(); i++) {
    String png, why;
    Vector<uint8_t> rgba;
    int w = 0, hh = 0;
    m2d_texture* t = nullptr;
    if (!test::read_file(fs::u8path(a.positional[i]), png) || !conformance::decode_png(png, w, hh, rgba, why) ||
        m2d_texture_create(rgba.data(), w, hh, 0, nullptr, &t, &err) != M2D_OK)
      return 1;
    textures.push_back(t);
    images.emplace_back(rgba.begin(), rgba.end());
    sizes.emplace_back(w, hh);
  }
  const auto count = static_cast<int32_t>(textures.size());
  check(m2d_vk_available() == 1, "m2d_vk_available");
  m2d_vk_context ctx{};
  ctx.size = sizeof ctx;
  ctx.queue_family = h.family;
  ctx.get_instance_proc_addr = reinterpret_cast<void*>(h.gipa);
  ctx.instance = h.instance;
  ctx.physical_device = h.physical;
  ctx.device = h.device;
  ctx.queue = h.queue;
  m2d_vk_renderer* vk = nullptr;
  check(m2d_vk_renderer_create(model, textures.data(), count, &ctx, nullptr, &vk, &err) == M2D_OK,
        "m2d_vk_renderer_create");
  m2d_renderer* sw = nullptr;
  check(m2d_renderer_create(model, textures.data(), count, nullptr, &sw, &err) == M2D_OK, "m2d_renderer_create");
  for (m2d_texture* t : textures) m2d_texture_destroy(t);
  m2d_instance* inst = nullptr;
  check(m2d_instance_create(model, &inst, &err) == M2D_OK, "m2d_instance_create");
  if (!vk || !sw || !inst) {
    std::cout << "create: " << err.message << "\n";
    return 1;
  }
  // The texture limit: the device's maxImageDimension2D by
  // default, M2D_MAX_TEXTURE_SIZE (8192, the reference configuration's) on request.
  {
    VkPhysicalDeviceProperties p{};
    h.GetPhysicalDeviceProperties(h.physical, &p);
    const int device_limit = static_cast<int>(p.limits.maxImageDimension2D);
    check(m2d_vk_renderer_max_texture_size(vk) == device_limit, "the default limit is the device's");
    std::vector<uint8_t> wide(4 * 9000 * 2, 200);
    m2d_texture* big = nullptr;
    check(m2d_texture_create(wide.data(), 9000, 2, 0, nullptr, &big, &err) == M2D_OK, "a 9000-wide texture");
    m2d_vk_renderer* taken = nullptr;
    const m2d_status st = m2d_vk_renderer_create(model, &big, 1, &ctx, nullptr, &taken, &err);
    check(device_limit >= 9000 ? st == M2D_OK : std::strcmp(err.code, "vk-texture-size") == 0,
          "the device's limit decides");
    m2d_vk_renderer_destroy(taken);
    m2d_vk_options capped;
    m2d_vk_options_default(&capped);
    capped.max_texture_size = M2D_MAX_TEXTURE_SIZE;
    m2d_vk_renderer* refused = nullptr;
    check(m2d_vk_renderer_create(model, &big, 1, &ctx, &capped, &refused, &err) == M2D_INTERNAL_ERROR &&
              std::strcmp(err.code, "vk-texture-size") == 0 && refused == nullptr,
          "M2D_MAX_TEXTURE_SIZE caps it");
    const std::string refusal = err.message;
    m2d_vk_renderer* capped_vk = nullptr;
    check(m2d_vk_renderer_create(model, nullptr, 0, &ctx, &capped, &capped_vk, &err) == M2D_OK &&
              m2d_vk_renderer_max_texture_size(capped_vk) == std::min(device_limit, M2D_MAX_TEXTURE_SIZE),
          "the capped limit");
    m2d_vk_renderer_destroy(capped_vk);
    std::cout << "texture limit: the device's " << device_limit << "; 9000 wide "
              << (st == M2D_OK ? "taken" : "refused") << ", refused under the cap: " << refusal << "\n";
    m2d_texture_destroy(big);
  }
  const int W = 160, H = 120;
  Target target(h);
  check(target.make(W, H), "the host's image");
  m2d_render_frame frame;
  m2d_render_frame_default(&frame);
  frame.background[0] = 0.25;
  frame.background[3] = 1;
  std::vector<uint8_t> b_px(static_cast<std::size_t>(W * H * 4));
  for (int pass = 0; pass < 2; pass++) {
    if (pass == 1 && m2d_model_parameter_count(model) > 0) {
      float range[3];
      m2d_model_parameter_range(model, 0, range);
      m2d_instance_set_parameter(inst, 0, range[1]);
    }
    check(m2d_instance_evaluate(inst, &err) == M2D_OK, "m2d_instance_evaluate");
    check(target.begin(), "vkBeginCommandBuffer");
    m2d_vk_target t{};
    t.size = sizeof t;
    t.format = VK_FORMAT_R8G8B8A8_UNORM;
    t.image = reinterpret_cast<uint64_t>(target.image);
    t.view = reinterpret_cast<uint64_t>(target.view);
    t.old_layout = VK_IMAGE_LAYOUT_UNDEFINED;
    t.new_layout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
    check(m2d_vk_renderer_draw(vk, inst, &frame, W, H, target.cmd, &t, &err) == M2D_OK, "m2d_vk_renderer_draw");
    Vector<uint8_t> a_px;
    check(target.finish(a_px), "the read-back");
    check(m2d_renderer_draw(sw, inst, &frame, W, H, b_px.data(), 0, &err) == M2D_OK, "m2d_renderer_draw");
    double sum = 0;
    for (std::size_t i = 0; i < a_px.size() && i < b_px.size(); i++) {
      const double d = static_cast<double>(a_px[i]) - static_cast<double>(b_px[i]);
      sum += d * d;
    }
    const double rms = std::sqrt(sum / static_cast<double>(b_px.size()));
    m2d_render_stats vs, ss;
    m2d_vk_renderer_stats(vk, &vs);
    m2d_renderer_stats(sw, &ss);
    std::cout << "frame " << pass << ": RMS " << rms << " against the reference renderer; drawn " << vs.drawn
              << ", masked " << vs.masked << ", layers " << vs.layers << "\n";
    check(a_px.size() == b_px.size() && rms <= 3.0, "the frame differs from the reference renderer's beyond RMS 3");
    check(vs.drawn == ss.drawn && vs.masked == ss.masked && vs.mask_builds == ss.mask_builds &&
              vs.layers == ss.layers && vs.advanced_draws == ss.advanced_draws && vs.layered == ss.layered,
          "the statistics differ from the reference renderer's");
  }
  // A texture updated in place (0.14.0) draws as a renderer made with the new image, byte for byte.
  if (!images.empty()) {
    const int tw = sizes[0].first, th = sizes[0].second;
    const int pw = std::max(1, tw / 2), ph = std::max(1, th / 3), px = tw / 4, py = th / 4;
    std::vector<uint8_t> patch(static_cast<std::size_t>(4 * pw * ph));
    for (std::size_t i = 0; i < patch.size(); i++) patch[i] = static_cast<uint8_t>((i * 53 + 17) & 255);
    std::vector<uint8_t> patched = images[0];
    for (int j = 0; j < ph; j++)
      std::memcpy(&patched[static_cast<std::size_t>(((py + j) * tw + px) * 4)], &patch[static_cast<std::size_t>(j * pw * 4)],
                  static_cast<std::size_t>(pw * 4));
    std::vector<m2d_texture*> fresh_textures;
    for (std::size_t i = 0; i < images.size(); i++) {
      m2d_texture* t = nullptr;
      m2d_texture_create(i == 0 ? patched.data() : images[i].data(), sizes[i].first, sizes[i].second, 0, nullptr, &t,
                         &err);
      fresh_textures.push_back(t);
    }
    m2d_vk_renderer* fresh = nullptr;
    check(m2d_vk_renderer_create(model, fresh_textures.data(), count, &ctx, nullptr, &fresh, &err) == M2D_OK,
          "a renderer with the patched image");
    for (m2d_texture* t : fresh_textures) m2d_texture_destroy(t);
    const auto grab = [&](m2d_vk_renderer* r) {
      Vector<uint8_t> out;
      check(target.begin(), "vkBeginCommandBuffer");
      m2d_vk_target t{};
      t.size = sizeof t;
      t.format = VK_FORMAT_R8G8B8A8_UNORM;
      t.image = reinterpret_cast<uint64_t>(target.image);
      t.view = reinterpret_cast<uint64_t>(target.view);
      t.old_layout = VK_IMAGE_LAYOUT_UNDEFINED;
      t.new_layout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
      check(m2d_vk_renderer_draw(r, inst, &frame, W, H, target.cmd, &t, &err) == M2D_OK, "a draw");
      check(target.finish(out), "the read-back");
      return std::vector<uint8_t>(out.begin(), out.end());
    };
    const auto before = grab(vk);
    check(m2d_vk_renderer_update_texture(vk, 0, patch.data(), pw, ph, 0, px, py, &err) == M2D_OK,
          "m2d_vk_renderer_update_texture");
    const auto updated = grab(vk), made = grab(fresh);
    check(updated == made, "a texture updated in place draws as one made with the new image");
    check(updated != before, "the update changes the picture");
    check(m2d_vk_renderer_update_texture(vk, 0, patch.data(), pw, ph, 0, tw - pw + 1, 0, &err) == M2D_INVALID_ARGUMENT,
          "a region that does not fit is refused");
    std::cout << "texture update: " << pw << "×" << ph << " at (" << px << ", " << py << "), "
              << (updated == made ? "the same bytes" : "DIFFERENT") << " as a renderer made with it\n";
    m2d_vk_renderer_forget_target(fresh, reinterpret_cast<uint64_t>(target.view));
    h.DeviceWaitIdle(h.device);
    m2d_vk_renderer_destroy(fresh);
  }
  m2d_vk_target bad{};
  check(m2d_vk_renderer_draw(vk, inst, &frame, W, H, target.cmd, &bad, &err) == M2D_INVALID_ARGUMENT,
        "a target without its size is refused");
  m2d_vk_renderer_forget_target(vk, reinterpret_cast<uint64_t>(target.view));
  target.release();
  h.DeviceWaitIdle(h.device);
  m2d_vk_renderer_destroy(vk);
  m2d_renderer_destroy(sw);
  m2d_instance_destroy(inst);
  m2d_model_destroy(model);
  std::cout << (failures ? "FAILED" : "ok") << "\n";
  return failures ? 1 : 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << kUsage;
    return 2;
  }
  const std::string cmd = argv[1];
  Args a;
  for (int i = 2; i < argc; i++) {
    const std::string s = argv[i];
    const auto value = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (s == "--out") a.out = value();
    else if (s == "--models") a.models = value();
    else if (s == "--icd") a.icd = value();
    else if (s == "--max-texture-size") {
      const std::string v = value();
      a.max_texture_size = v == "device" ? 0 : std::atoi(v.c_str());
    }
    else if (s == "--max-rms") a.max_rms = std::atof(value().c_str());
    else if (s == "--max-diff") a.max_diff = std::atof(value().c_str());
    else a.positional.push_back(s);
  }
  if (cmd == "compare") {
    if (a.positional.size() != 2) {
      std::cerr << kUsage;
      return 2;
    }
    return test::compare_folders(a.positional[0], a.positional[1], a.max_rms, a.max_diff);
  }
  Host h;
  if (!h.open(a.icd)) {
    std::cerr << "mochi2d-vk-render: " << h.error.c_str() << " (skipped)\n";
    return 77;
  }
  if (cmd == "info") {
    std::cout << h.name.c_str() << "\n";
    return 0;
  }
  if (cmd == "capi") return capi(a, h);
  if (cmd != "render" || a.out.empty() || a.positional.empty()) {
    std::cerr << kUsage;
    return 2;
  }
  conformance::RenderOptions options;
  rvk::VkOptions vo;
  vo.max_texture_size = a.max_texture_size;
  options.drawer = [&](std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const render::Texture>> textures,
                       String& error) -> std::unique_ptr<conformance::Drawer> {
    auto d = std::make_unique<VkDrawer>(h, std::move(model), std::move(textures), vo);
    if (!d->ok(error)) return nullptr;
    return d;
  };
  {
    // The runner's TextureTooLarge limit: the device's, as the backend takes it.
    rvk::Api probe;
    VkPhysicalDeviceProperties p{};
    h.GetPhysicalDeviceProperties(h.physical, &p);
    options.max_texture_size = static_cast<int>(p.limits.maxImageDimension2D);
    if (a.max_texture_size > 0) options.max_texture_size = std::min(options.max_texture_size, a.max_texture_size);
    (void)probe;
  }
  conformance::ModelCache cache(conformance::model_search_dirs(fs::current_path(), fs::u8path(a.models)));
  Vector<String> inputs;
  for (const auto& p : a.positional) inputs.push_back(String(p.c_str()));
  std::cerr << "device: " << h.name.c_str() << "\n";
  const auto summary = conformance::run_render(inputs, fs::u8path(a.out), cache, conformance::producer_id(), options,
                                               [](const String& line) { std::cerr << line.c_str() << "\n"; });
  std::cout << summary.total << " scenarios, " << summary.failed << " failed\n";
  return summary.total == 0 || summary.failed ? 1 : 0;
}
