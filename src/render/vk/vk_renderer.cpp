#include "render/vk/vk_renderer.hpp"

#include <algorithm>
#include <cstring>

#include "render/shaders.hpp"
#include "render/vk/spirv.hpp"

namespace mochi2d::render::vk {

namespace {

using std::size_t;
size_t Z(int64_t i) { return static_cast<size_t>(i); }

constexpr VkFormat kInternalFormat = VK_FORMAT_R8G8B8A8_UNORM;
constexpr int kMaskProgram = static_cast<int>(ShaderProgram::Mask);
constexpr uint32_t kDescriptorSets = 512;

const char* result_name(VkResult r) {
  switch (r) {
    case VK_ERROR_OUT_OF_HOST_MEMORY:
      return "VK_ERROR_OUT_OF_HOST_MEMORY";
    case VK_ERROR_OUT_OF_DEVICE_MEMORY:
      return "VK_ERROR_OUT_OF_DEVICE_MEMORY";
    case VK_ERROR_DEVICE_LOST:
      return "VK_ERROR_DEVICE_LOST";
    case VK_ERROR_INITIALIZATION_FAILED:
      return "VK_ERROR_INITIALIZATION_FAILED";
    case VK_ERROR_FORMAT_NOT_SUPPORTED:
      return "VK_ERROR_FORMAT_NOT_SUPPORTED";
    case VK_ERROR_OUT_OF_POOL_MEMORY:
      return "VK_ERROR_OUT_OF_POOL_MEMORY";
    default:
      return "a Vulkan error";
  }
}

/** Where an image is read or written, for barriers. */
struct Access {
  VkPipelineStageFlags stage;
  VkAccessFlags access;
};
Access access_of(VkImageLayout layout) {
  switch (layout) {
    case VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL:
      return {VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
              VK_ACCESS_COLOR_ATTACHMENT_READ_BIT | VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT};
    case VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL:
      return {VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, VK_ACCESS_SHADER_READ_BIT};
    case VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL:
      return {VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_READ_BIT};
    case VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL:
      return {VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_WRITE_BIT};
    case VK_IMAGE_LAYOUT_UNDEFINED:
      return {VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, 0};
    default:
      // A layout of the host's: whatever it did before.
      return {VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_ACCESS_MEMORY_READ_BIT | VK_ACCESS_MEMORY_WRITE_BIT};
  }
}

void layout_barrier(const Api& vk, VkCommandBuffer cmd, VkImage image, VkImageLayout from, VkImageLayout to,
                    uint32_t levels = 1) {
  const Access a = access_of(from), b = access_of(to);
  VkImageMemoryBarrier m{};
  m.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER;
  m.srcAccessMask = a.access;
  m.dstAccessMask = b.access;
  m.oldLayout = from;
  m.newLayout = to;
  m.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
  m.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
  m.image = image;
  m.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, levels, 0, 1};
  vk.CmdPipelineBarrier(cmd, a.stage, b.stage, 0, 0, nullptr, 0, nullptr, 1, &m);
}

}  // namespace

bool load(Api& api, PFN_vkGetInstanceProcAddr gipa, VkInstance instance, VkDevice device, const char** missing) {
  if (!gipa) {
    if (missing) *missing = "vkGetInstanceProcAddr";
    return false;
  }
#define M2D_VK_LOAD_I(name)                                                                   \
  api.name = reinterpret_cast<PFN_vk##name>(gipa(instance, "vk" #name));                      \
  if (!api.name) {                                                                            \
    if (missing) *missing = "vk" #name;                                                       \
    return false;                                                                             \
  }
  M2D_VK_INSTANCE_FUNCTIONS(M2D_VK_LOAD_I)
#undef M2D_VK_LOAD_I
#define M2D_VK_LOAD_D(name)                                                                   \
  api.name = reinterpret_cast<PFN_vk##name>(api.GetDeviceProcAddr(device, "vk" #name));       \
  if (!api.name) {                                                                            \
    if (missing) *missing = "vk" #name;                                                       \
    return false;                                                                             \
  }
  M2D_VK_DEVICE_FUNCTIONS(M2D_VK_LOAD_D)
#undef M2D_VK_LOAD_D
  return true;
}

// ------------------------------------------------------------------ setup

VkRenderer::VkRenderer(std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const Texture>> textures,
                       const VkContext& context, const VkOptions& options)
    : model_(std::move(model)), textures_(std::move(textures)), ctx_(context), options_(options), rm_(*model_) {
  const char* missing = nullptr;
  if (!ctx_.device || !ctx_.physical_device || !ctx_.queue) {
    fail("no device, physical device or queue", "vk-function");
    return;
  }
  if (!load(vk_, ctx_.get_instance_proc_addr, ctx_.instance, ctx_.device, &missing)) {
    fail((String("the context has no ") + missing).c_str(), "vk-function");
    return;
  }
  const VkDevice dev = ctx_.device;
  VkPhysicalDeviceProperties props{};
  vk_.GetPhysicalDeviceProperties(ctx_.physical_device, &props);
  if (props.apiVersion < VK_API_VERSION_1_1) {
    fail("the device is older than Vulkan 1.1 (a negative viewport height)", "vk-function");
    return;
  }
  if (props.limits.maxPushConstantsSize < static_cast<uint32_t>(kVulkanPushConstants)) {
    fail("the device has less than 128 bytes of push constants", "vk-function");
    return;
  }
  max_texture_size_ = static_cast<int>(props.limits.maxImageDimension2D);
  if (options_.max_texture_size > 0) max_texture_size_ = std::min(max_texture_size_, options_.max_texture_size);
  vk_.GetPhysicalDeviceMemoryProperties(ctx_.physical_device, &memory_);

  VkCommandPoolCreateInfo pool{};
  pool.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
  pool.flags = VK_COMMAND_POOL_CREATE_TRANSIENT_BIT;
  pool.queueFamilyIndex = ctx_.queue_family;
  if (!check(vk_.CreateCommandPool(dev, &pool, nullptr, &setup_pool_), "vkCreateCommandPool")) return;

  // Samplers: textures as Mochi2D's (trilinear, repeat), masks and layers
  // (bilinear, clamped: rule L), the destination copy (read with texelFetch).
  VkSamplerCreateInfo s{};
  s.sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO;
  s.magFilter = s.minFilter = VK_FILTER_LINEAR;
  s.mipmapMode = VK_SAMPLER_MIPMAP_MODE_LINEAR;
  s.addressModeU = s.addressModeV = s.addressModeW = VK_SAMPLER_ADDRESS_MODE_REPEAT;
  s.maxLod = VK_LOD_CLAMP_NONE;
  if (!check(vk_.CreateSampler(dev, &s, nullptr, &texture_sampler_), "vkCreateSampler")) return;
  s.mipmapMode = VK_SAMPLER_MIPMAP_MODE_NEAREST;
  s.addressModeU = s.addressModeV = s.addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
  s.maxLod = 0;
  if (!check(vk_.CreateSampler(dev, &s, nullptr, &mask_sampler_), "vkCreateSampler")) return;
  s.magFilter = s.minFilter = VK_FILTER_NEAREST;
  if (!check(vk_.CreateSampler(dev, &s, nullptr, &nearest_sampler_), "vkCreateSampler")) return;

  // One set layout for every program: uTex, uMask, uDst.
  VkDescriptorSetLayoutBinding bindings[3]{};
  for (uint32_t b = 0; b < 3; b++) {
    bindings[b].binding = b;
    bindings[b].descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
    bindings[b].descriptorCount = 1;
    bindings[b].stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT;
  }
  VkDescriptorSetLayoutCreateInfo sl{};
  sl.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
  sl.bindingCount = 3;
  sl.pBindings = bindings;
  if (!check(vk_.CreateDescriptorSetLayout(dev, &sl, nullptr, &set_layout_), "vkCreateDescriptorSetLayout")) return;
  VkPushConstantRange range{VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, 0,
                            static_cast<uint32_t>(kVulkanPushConstants)};
  VkPipelineLayoutCreateInfo pl{};
  pl.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
  pl.setLayoutCount = 1;
  pl.pSetLayouts = &set_layout_;
  pl.pushConstantRangeCount = 1;
  pl.pPushConstantRanges = &range;
  if (!check(vk_.CreatePipelineLayout(dev, &pl, nullptr, &pipeline_layout_), "vkCreatePipelineLayout")) return;
  VkDescriptorPoolSize size{VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, kDescriptorSets * 3};
  VkDescriptorPoolCreateInfo dp{};
  dp.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
  dp.maxSets = kDescriptorSets;
  dp.poolSizeCount = 1;
  dp.pPoolSizes = &size;
  if (!check(vk_.CreateDescriptorPool(dev, &dp, nullptr, &descriptor_pool_), "vkCreateDescriptorPool")) return;

  for (int p = 0; p < static_cast<int>(ShaderProgram::Count); p++)
    for (int st = 0; st < 2; st++) {
      const Spirv code = spirv(static_cast<ShaderProgram>(p), static_cast<ShaderStage>(st));
      VkShaderModuleCreateInfo m{};
      m.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
      m.codeSize = code.count * 4;
      m.pCode = code.words;
      if (!check(vk_.CreateShaderModule(dev, &m, nullptr, &modules_[p][st]), "vkCreateShaderModule")) return;
    }

  // Geometry: every mesh's vertices one after another, as the GL backend.
  const moc::Model& m = *model_;
  const size_t N = m.meshes.ids.size();
  uint32_t vertices = 0;
  Vector<uint32_t> all_indices;
  Vector<float> all_uvs;
  for (size_t i = 0; i < N; i++) {
    const uint32_t count = static_cast<uint32_t>(m.meshes.uvs[i].size() / 2);
    vertex_start_.push_back(vertices);
    index_start_.push_back(static_cast<uint32_t>(all_indices.size()));
    index_count_.push_back(static_cast<uint32_t>(rm_.triangles[i].size()));
    for (uint16_t k : rm_.triangles[i]) all_indices.push_back(vertices + k);
    // Rule V: v as the renderer samples it, flipped twice in float32.
    all_uvs.insert(all_uvs.end(), rm_.uvs[i].begin(), rm_.uvs[i].begin() + 2 * count);
    vertices += count;
  }
  staged_.assign(N, 0);
  const VkMemoryPropertyFlags host = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
  const auto filled = [&](Buffer& b, const void* data, size_t bytes, VkBufferUsageFlags usage) {
    if (!create_buffer(b, std::max<size_t>(bytes, 4), usage, host)) return false;
    void* p = nullptr;
    if (!check(vk_.MapMemory(dev, b.memory, 0, VK_WHOLE_SIZE, 0, &p), "vkMapMemory")) return false;
    if (bytes) std::memcpy(p, data, bytes);
    vk_.UnmapMemory(dev, b.memory);
    return true;
  };
  if (!filled(uvs_, all_uvs.data(), all_uvs.size() * 4, VK_BUFFER_USAGE_VERTEX_BUFFER_BIT) ||
      !filled(indices_, all_indices.data(), all_indices.size() * 4, VK_BUFFER_USAGE_INDEX_BUFFER_BIT) ||
      !create_buffer(positions_, std::max<VkDeviceSize>(VkDeviceSize{vertices} * 8, 4),
                     VK_BUFFER_USAGE_VERTEX_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                     VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT))
    return;
  if (!upload_textures()) return;
  created_ = ok_;
}

VkRenderer::~VkRenderer() {
  const VkDevice dev = ctx_.device;
  if (!dev || !vk_.DestroyImage) return;
  for (auto& t : host_targets_)
    if (t.framebuffer) vk_.DestroyFramebuffer(dev, t.framebuffer, nullptr);
  for (auto& p : passes_) {
    for (auto& a : p->pipelines)
      for (auto& b : a)
        for (VkPipeline q : b)
          if (q) vk_.DestroyPipeline(dev, q, nullptr);
    if (p->render_pass) vk_.DestroyRenderPass(dev, p->render_pass, nullptr);
  }
  for (auto& im : textures_gpu_) destroy_image(im);
  for (auto& im : layers_) destroy_image(im);
  destroy_image(dummy_);
  destroy_image(mask_target_);
  destroy_image(offscreen_mask_target_);
  destroy_image(dst_copy_);
  destroy_buffer(positions_);
  destroy_buffer(uvs_);
  destroy_buffer(indices_);
  for (auto& a : modules_)
    for (VkShaderModule m : a)
      if (m) vk_.DestroyShaderModule(dev, m, nullptr);
  if (descriptor_pool_) vk_.DestroyDescriptorPool(dev, descriptor_pool_, nullptr);
  if (pipeline_layout_) vk_.DestroyPipelineLayout(dev, pipeline_layout_, nullptr);
  if (set_layout_) vk_.DestroyDescriptorSetLayout(dev, set_layout_, nullptr);
  for (VkSampler s : {texture_sampler_, mask_sampler_, nearest_sampler_})
    if (s) vk_.DestroySampler(dev, s, nullptr);
  if (setup_pool_) vk_.DestroyCommandPool(dev, setup_pool_, nullptr);
}

bool VkRenderer::fail(const char* what, const char* code, VkResult result) {
  ok_ = false;
  error_code_ = code;
  error_ = what;
  if (result != VK_SUCCESS) error_ += String(": ") + result_name(result);
  return false;
}

bool VkRenderer::check(VkResult r, const char* what) {
  if (r == VK_SUCCESS) return true;
  return fail((String(what) + " fails").c_str(), "vk-error", r);
}

bool VkRenderer::memory_type(uint32_t bits, VkMemoryPropertyFlags props, uint32_t& out) const {
  for (uint32_t i = 0; i < memory_.memoryTypeCount; i++)
    if ((bits & (1u << i)) && (memory_.memoryTypes[i].propertyFlags & props) == props) {
      out = i;
      return true;
    }
  return false;
}

bool VkRenderer::create_buffer(Buffer& b, VkDeviceSize size, VkBufferUsageFlags usage, VkMemoryPropertyFlags props) {
  const VkDevice dev = ctx_.device;
  VkBufferCreateInfo bi{};
  bi.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
  bi.size = size;
  bi.usage = usage;
  bi.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
  if (!check(vk_.CreateBuffer(dev, &bi, nullptr, &b.buffer), "vkCreateBuffer")) return false;
  VkMemoryRequirements req{};
  vk_.GetBufferMemoryRequirements(dev, b.buffer, &req);
  VkMemoryAllocateInfo ai{};
  ai.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
  ai.allocationSize = req.size;
  if (!memory_type(req.memoryTypeBits, props, ai.memoryTypeIndex)) return fail("no memory type for a buffer");
  if (!check(vk_.AllocateMemory(dev, &ai, nullptr, &b.memory), "vkAllocateMemory")) return false;
  return check(vk_.BindBufferMemory(dev, b.buffer, b.memory, 0), "vkBindBufferMemory");
}

void VkRenderer::destroy_buffer(Buffer& b) {
  if (b.buffer) vk_.DestroyBuffer(ctx_.device, b.buffer, nullptr);
  if (b.memory) vk_.FreeMemory(ctx_.device, b.memory, nullptr);
  b = Buffer();
}

bool VkRenderer::create_image(Image& im, int width, int height, uint32_t levels, VkImageUsageFlags usage,
                              bool framebuffer) {
  const VkDevice dev = ctx_.device;
  VkImageCreateInfo ii{};
  ii.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO;
  ii.imageType = VK_IMAGE_TYPE_2D;
  ii.format = kInternalFormat;
  ii.extent = {static_cast<uint32_t>(width), static_cast<uint32_t>(height), 1};
  ii.mipLevels = levels;
  ii.arrayLayers = 1;
  ii.samples = VK_SAMPLE_COUNT_1_BIT;
  ii.tiling = VK_IMAGE_TILING_OPTIMAL;
  ii.usage = usage;
  ii.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
  ii.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
  if (!check(vk_.CreateImage(dev, &ii, nullptr, &im.image), "vkCreateImage")) return false;
  VkMemoryRequirements req{};
  vk_.GetImageMemoryRequirements(dev, im.image, &req);
  VkMemoryAllocateInfo ai{};
  ai.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
  ai.allocationSize = req.size;
  if (!memory_type(req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, ai.memoryTypeIndex) &&
      !memory_type(req.memoryTypeBits, 0, ai.memoryTypeIndex))
    return fail("no memory type for an image");
  if (!check(vk_.AllocateMemory(dev, &ai, nullptr, &im.memory), "vkAllocateMemory") ||
      !check(vk_.BindImageMemory(dev, im.image, im.memory, 0), "vkBindImageMemory"))
    return false;
  VkImageViewCreateInfo vi{};
  vi.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO;
  vi.image = im.image;
  vi.viewType = VK_IMAGE_VIEW_TYPE_2D;
  vi.format = kInternalFormat;
  vi.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, levels, 0, 1};
  if (!check(vk_.CreateImageView(dev, &vi, nullptr, &im.view), "vkCreateImageView")) return false;
  im.width = width;
  im.height = height;
  im.layout = VK_IMAGE_LAYOUT_UNDEFINED;
  if (framebuffer) {
    Pass* p = pass_for(kInternalFormat, false);
    if (!p) return false;
    VkFramebufferCreateInfo fi{};
    fi.sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO;
    fi.renderPass = p->render_pass;
    fi.attachmentCount = 1;
    fi.pAttachments = &im.view;
    fi.width = static_cast<uint32_t>(width);
    fi.height = static_cast<uint32_t>(height);
    fi.layers = 1;
    if (!check(vk_.CreateFramebuffer(dev, &fi, nullptr, &im.framebuffer), "vkCreateFramebuffer")) return false;
  }
  return true;
}

void VkRenderer::destroy_image(Image& im) {
  const VkDevice dev = ctx_.device;
  if (im.framebuffer) vk_.DestroyFramebuffer(dev, im.framebuffer, nullptr);
  if (im.view) vk_.DestroyImageView(dev, im.view, nullptr);
  if (im.image) vk_.DestroyImage(dev, im.image, nullptr);
  if (im.memory) vk_.FreeMemory(dev, im.memory, nullptr);
  im = Image();
}

/** The textures' prepared levels as they are, the dummy image, the mask buffers: one submission, waited for. */
bool VkRenderer::upload_textures() {
  const VkDevice dev = ctx_.device;
  const VkImageUsageFlags sampled = VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT;
  VkDeviceSize staging_size = 4;
  for (size_t i = 0; i < textures_.size(); i++) {
    const auto& t = textures_[i];
    if (!t || t->levels.empty()) continue;
    if (t->width > max_texture_size_ || t->height > max_texture_size_)
      return fail((String("texture ") + to_str(static_cast<long long>(i)) + " is " + to_str(t->width) + "×" +
                   to_str(t->height) + ", larger than the maximum texture size " + to_str(max_texture_size_))
                      .c_str(),
                  "vk-texture-size");
    for (const auto& lv : t->levels) staging_size += lv.rgba.size();
  }
  Buffer staging;
  if (!create_buffer(staging, staging_size, VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                     VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT))
    return false;
  uint8_t* mapped = nullptr;
  if (!check(vk_.MapMemory(dev, staging.memory, 0, VK_WHOLE_SIZE, 0, reinterpret_cast<void**>(&mapped)),
             "vkMapMemory")) {
    destroy_buffer(staging);
    return false;
  }
  VkCommandBufferAllocateInfo ca{};
  ca.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
  ca.commandPool = setup_pool_;
  ca.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
  ca.commandBufferCount = 1;
  VkCommandBuffer cmd = VK_NULL_HANDLE;
  bool good = check(vk_.AllocateCommandBuffers(dev, &ca, &cmd), "vkAllocateCommandBuffers");
  VkCommandBufferBeginInfo bi{};
  bi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
  bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
  good = good && check(vk_.BeginCommandBuffer(cmd, &bi), "vkBeginCommandBuffer");
  VkDeviceSize at = 0;
  for (size_t i = 0; good && i < textures_.size(); i++) {
    textures_gpu_.push_back(Image());
    const auto& t = textures_[i];
    has_texture_.push_back(t && !t->levels.empty() ? 1 : 0);
    if (!has_texture_.back()) continue;
    Image& im = textures_gpu_.back();
    const uint32_t levels = static_cast<uint32_t>(t->levels.size());
    if (!create_image(im, t->width, t->height, levels, sampled, false)) {
      good = false;
      break;
    }
    layout_barrier(vk_, cmd, im.image, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, levels);
    for (uint32_t l = 0; l < levels; l++) {
      const auto& lv = t->levels[l];
      std::memcpy(mapped + at, lv.rgba.data(), lv.rgba.size());
      VkBufferImageCopy region{};
      region.bufferOffset = at;
      region.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, l, 0, 1};
      region.imageExtent = {static_cast<uint32_t>(lv.width), static_cast<uint32_t>(lv.height), 1};
      vk_.CmdCopyBufferToImage(cmd, staging.buffer, im.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
      at += lv.rgba.size();
    }
    layout_barrier(vk_, cmd, im.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
                   levels);
    im.layout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
  }
  // A 1 × 1 image for the bindings a program does not read.
  if (good && create_image(dummy_, 1, 1, 1, sampled, false)) {
    const uint32_t zero = 0;
    std::memcpy(mapped + at, &zero, 4);
    layout_barrier(vk_, cmd, dummy_.image, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);
    VkBufferImageCopy region{};
    region.bufferOffset = at;
    region.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    region.imageExtent = {1, 1, 1};
    vk_.CmdCopyBufferToImage(cmd, staging.buffer, dummy_.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
    layout_barrier(vk_, cmd, dummy_.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                   VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL);
    dummy_.layout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
  } else {
    good = false;
  }
  if (good) good = check(vk_.EndCommandBuffer(cmd), "vkEndCommandBuffer");
  if (good) {
    VkSubmitInfo si{};
    si.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    si.commandBufferCount = 1;
    si.pCommandBuffers = &cmd;
    good = check(vk_.QueueSubmit(ctx_.queue, 1, &si, VK_NULL_HANDLE), "vkQueueSubmit") &&
           check(vk_.QueueWaitIdle(ctx_.queue), "vkQueueWaitIdle");
  }
  if (cmd) vk_.FreeCommandBuffers(dev, setup_pool_, 1, &cmd);
  vk_.UnmapMemory(dev, staging.memory);
  destroy_buffer(staging);
  if (!good) return false;
  const VkImageUsageFlags target = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_SAMPLED_BIT;
  return create_image(mask_target_, options_.mask_size, options_.mask_size, 1, target, true) &&
         create_image(offscreen_mask_target_, options_.offscreen_mask_size, options_.offscreen_mask_size, 1, target,
                      true);
}

/** The render pass and pipelines of a target format and orientation (made on first use; the pointer stays valid). */
VkRenderer::Pass* VkRenderer::pass_for(VkFormat format, bool flipped) {
  for (auto& p : passes_)
    if (p->format == format && p->flipped == flipped) return p->render_pass ? p.get() : nullptr;
  auto p = std::allocate_shared<Pass>(Allocator<Pass>());
  p->format = format;
  p->flipped = flipped;
  passes_.push_back(p);
  if (!create_pipelines(*p)) return nullptr;
  return p.get();
}

/** The render pass (load and store, the image in COLOR_ATTACHMENT_OPTIMAL throughout) and every pipeline. */
bool VkRenderer::create_pipelines(Pass& p) {
  const VkDevice dev = ctx_.device;
  VkFormatProperties fp{};
  vk_.GetPhysicalDeviceFormatProperties(ctx_.physical_device, p.format, &fp);
  if (!(fp.optimalTilingFeatures & VK_FORMAT_FEATURE_COLOR_ATTACHMENT_BLEND_BIT))
    return fail("the target's format cannot be rendered to with blending", "vk-format");
  VkAttachmentDescription att{};
  att.format = p.format;
  att.samples = VK_SAMPLE_COUNT_1_BIT;
  att.loadOp = VK_ATTACHMENT_LOAD_OP_LOAD;
  att.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
  att.stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
  att.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
  att.initialLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
  att.finalLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
  VkAttachmentReference ref{0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
  VkSubpassDescription sub{};
  sub.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
  sub.colorAttachmentCount = 1;
  sub.pColorAttachments = &ref;
  VkRenderPassCreateInfo rp{};
  rp.sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO;
  rp.attachmentCount = 1;
  rp.pAttachments = &att;
  rp.subpassCount = 1;
  rp.pSubpasses = &sub;
  if (!check(vk_.CreateRenderPass(dev, &rp, nullptr, &p.render_pass), "vkCreateRenderPass")) return false;

  VkVertexInputBindingDescription vb[2] = {{0, 8, VK_VERTEX_INPUT_RATE_VERTEX}, {1, 8, VK_VERTEX_INPUT_RATE_VERTEX}};
  VkVertexInputAttributeDescription va[2] = {{0, 0, VK_FORMAT_R32G32_SFLOAT, 0}, {1, 1, VK_FORMAT_R32G32_SFLOAT, 0}};
  VkPipelineInputAssemblyStateCreateInfo ia{};
  ia.sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO;
  ia.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
  // Layers: a quad over the viewport as a triangle strip (rule L).
  VkPipelineInputAssemblyStateCreateInfo strip = ia;
  strip.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP;
  VkPipelineViewportStateCreateInfo vp{};
  vp.sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO;
  vp.viewportCount = 1;
  vp.scissorCount = 1;
  VkPipelineMultisampleStateCreateInfo ms{};
  ms.sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO;
  ms.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT;
  VkDynamicState dyn[2] = {VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR};
  VkPipelineDynamicStateCreateInfo ds{};
  ds.sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO;
  ds.dynamicStateCount = 2;
  ds.pDynamicStates = dyn;

  for (int prog = 0; prog < static_cast<int>(ShaderProgram::Count); prog++) {
    const bool mesh_input = prog != static_cast<int>(ShaderProgram::Layer) &&
                            prog != static_cast<int>(ShaderProgram::LayerAdvanced);
    const bool advanced = prog == static_cast<int>(ShaderProgram::MeshAdvanced) ||
                          prog == static_cast<int>(ShaderProgram::LayerAdvanced);
    for (int blend = 0; blend < 4; blend++) {
      // Advanced programs draw without blending (kind 3); the others with the three fixed modes; the mask one with its own.
      if (advanced != (blend == 3)) continue;
      if (prog == kMaskProgram && blend != 0) continue;
      for (int cull = 0; cull < 2; cull++) {
        if (!mesh_input && cull) continue;
        VkPipelineShaderStageCreateInfo stages[2]{};
        for (int st = 0; st < 2; st++) {
          stages[st].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
          stages[st].stage = st == 0 ? VK_SHADER_STAGE_VERTEX_BIT : VK_SHADER_STAGE_FRAGMENT_BIT;
          stages[st].module = modules_[prog][st];
          stages[st].pName = "main";
        }
        VkPipelineVertexInputStateCreateInfo vi{};
        vi.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO;
        if (mesh_input) {
          vi.vertexBindingDescriptionCount = 2;
          vi.pVertexBindingDescriptions = vb;
          vi.vertexAttributeDescriptionCount = 2;
          vi.pVertexAttributeDescriptions = va;
        }
        VkPipelineRasterizationStateCreateInfo rs{};
        rs.sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO;
        rs.polygonMode = VK_POLYGON_MODE_FILL;
        rs.cullMode = cull ? VK_CULL_MODE_BACK_BIT : VK_CULL_MODE_NONE;
        // OpenGL's counter-clockwise front faces: Vulkan's area has the other sign, a flipped viewport flips it back.
        rs.frontFace = p.flipped ? VK_FRONT_FACE_COUNTER_CLOCKWISE : VK_FRONT_FACE_CLOCKWISE;
        rs.lineWidth = 1;
        VkPipelineColorBlendAttachmentState cb{};
        cb.colorWriteMask = VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT | VK_COLOR_COMPONENT_B_BIT |
                            VK_COLOR_COMPONENT_A_BIT;
        cb.colorBlendOp = cb.alphaBlendOp = VK_BLEND_OP_ADD;
        if (prog == kMaskProgram) {
          cb.blendEnable = VK_TRUE;
          cb.srcColorBlendFactor = cb.srcAlphaBlendFactor = VK_BLEND_FACTOR_ZERO;
          cb.dstColorBlendFactor = cb.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
          cb.colorWriteMask = VK_COLOR_COMPONENT_R_BIT;
        } else if (blend == 0) {
          cb.blendEnable = VK_TRUE;
          cb.srcColorBlendFactor = cb.srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
          cb.dstColorBlendFactor = cb.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
        } else if (blend == 1) {
          cb.blendEnable = VK_TRUE;
          cb.srcColorBlendFactor = VK_BLEND_FACTOR_ONE;
          cb.dstColorBlendFactor = VK_BLEND_FACTOR_ONE;
          cb.srcAlphaBlendFactor = VK_BLEND_FACTOR_ZERO;
          cb.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
        } else if (blend == 2) {
          cb.blendEnable = VK_TRUE;
          cb.srcColorBlendFactor = VK_BLEND_FACTOR_DST_COLOR;
          cb.dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
          cb.srcAlphaBlendFactor = VK_BLEND_FACTOR_ZERO;
          cb.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
        }
        VkPipelineColorBlendStateCreateInfo cbs{};
        cbs.sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO;
        cbs.attachmentCount = 1;
        cbs.pAttachments = &cb;
        VkGraphicsPipelineCreateInfo gp{};
        gp.sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO;
        gp.stageCount = 2;
        gp.pStages = stages;
        gp.pVertexInputState = &vi;
        gp.pInputAssemblyState = mesh_input ? &ia : &strip;
        gp.pViewportState = &vp;
        gp.pRasterizationState = &rs;
        gp.pMultisampleState = &ms;
        gp.pColorBlendState = &cbs;
        gp.pDynamicState = &ds;
        gp.layout = pipeline_layout_;
        gp.renderPass = p.render_pass;
        if (!check(vk_.CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gp, nullptr, &p.pipelines[prog][blend][cull]),
                   "vkCreateGraphicsPipelines"))
          return false;
      }
    }
  }
  return true;
}

VkDescriptorSet VkRenderer::descriptor(VkImageView tex, VkImageView mask, VkImageView dst) {
  for (const auto& d : descriptors_)
    if (d.tex == tex && d.mask == mask && d.dst == dst) return d.set;
  if (descriptors_.size() >= kDescriptorSets) {
    fail("more texture combinations than the descriptor pool holds");
    return VK_NULL_HANDLE;
  }
  VkDescriptorSetAllocateInfo ai{};
  ai.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
  ai.descriptorPool = descriptor_pool_;
  ai.descriptorSetCount = 1;
  ai.pSetLayouts = &set_layout_;
  VkDescriptorSet set = VK_NULL_HANDLE;
  if (!check(vk_.AllocateDescriptorSets(ctx_.device, &ai, &set), "vkAllocateDescriptorSets")) return VK_NULL_HANDLE;
  // The model's textures sample trilinear and repeat; layers bilinear and clamped (rule L).
  bool texture = false;
  for (const auto& t : textures_gpu_) texture = texture || t.view == tex;
  VkDescriptorImageInfo info[3] = {
      {texture ? texture_sampler_ : mask_sampler_, tex, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL},
      {mask_sampler_, mask, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL},
      {nearest_sampler_, dst, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL}};
  VkWriteDescriptorSet w[3]{};
  for (uint32_t b = 0; b < 3; b++) {
    w[b].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
    w[b].dstSet = set;
    w[b].dstBinding = b;
    w[b].descriptorCount = 1;
    w[b].descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
    w[b].pImageInfo = &info[b];
  }
  vk_.UpdateDescriptorSets(ctx_.device, 3, w, 0, nullptr);
  descriptors_.push_back({tex, mask, dst, set});
  return set;
}

void VkRenderer::forget_target(VkImageView view) {
  for (size_t i = 0; i < host_targets_.size(); i++)
    if (host_targets_[i].view == view) {
      if (host_targets_[i].framebuffer) vk_.DestroyFramebuffer(ctx_.device, host_targets_[i].framebuffer, nullptr);
      host_targets_.erase(host_targets_.begin() + static_cast<std::ptrdiff_t>(i));
      return;
    }
}

bool VkRenderer::update_texture(int index, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x,
                                int y) {
  if (!created_) return false;
  ok_ = true;
  error_.clear();
  error_code_ = "";
  if (index < 0 || Z(index) >= textures_.size() || !textures_[Z(index)] || !has_texture_[Z(index)]) return false;
  const Texture& cur = *textures_[Z(index)];
  if (w < 1 || h < 1 || x < 0 || y < 0 || x > cur.width - w || y > cur.height - h) return false;
  auto t = own_copy(textures_, own_texture_, Z(index));
  Vector<TextureRegion> changed;
  if (!update_texture_in(*t, straight, w, h, stride, x, y, &changed)) return false;
  const VkDevice dev = ctx_.device;
  VkDeviceSize bytes = 4;
  for (const TextureRegion& r : changed) bytes += VkDeviceSize{4} * Z(r.width) * Z(r.height);
  Buffer staging;
  if (!create_buffer(staging, bytes, VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                     VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT))
    return false;
  uint8_t* mapped = nullptr;
  bool good = check(vk_.MapMemory(dev, staging.memory, 0, VK_WHOLE_SIZE, 0, reinterpret_cast<void**>(&mapped)),
                    "vkMapMemory");
  Vector<VkBufferImageCopy> regions;
  VkDeviceSize at = 0;
  for (const TextureRegion& r : changed) {
    if (!good) break;
    const Texture::Level& lv = t->levels[Z(r.level)];
    const size_t row = Z(r.width) * 4;
    for (int j = 0; j < r.height; j++)
      std::memcpy(mapped + at + row * Z(j), lv.rgba.data() + (Z(r.y + j) * Z(lv.width) + Z(r.x)) * 4, row);
    VkBufferImageCopy c{};
    c.bufferOffset = at;
    c.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, static_cast<uint32_t>(r.level), 0, 1};
    c.imageOffset = {r.x, r.y, 0};
    c.imageExtent = {static_cast<uint32_t>(r.width), static_cast<uint32_t>(r.height), 1};
    regions.push_back(c);
    at += VkDeviceSize{row} * Z(r.height);
  }
  if (mapped) vk_.UnmapMemory(dev, staging.memory);
  VkCommandBufferAllocateInfo ca{};
  ca.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
  ca.commandPool = setup_pool_;
  ca.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
  ca.commandBufferCount = 1;
  VkCommandBuffer cmd = VK_NULL_HANDLE;
  good = good && check(vk_.AllocateCommandBuffers(dev, &ca, &cmd), "vkAllocateCommandBuffers");
  VkCommandBufferBeginInfo bi{};
  bi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
  bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
  good = good && check(vk_.BeginCommandBuffer(cmd, &bi), "vkBeginCommandBuffer");
  if (good) {
    Image& im = textures_gpu_[Z(index)];
    const uint32_t levels = static_cast<uint32_t>(t->levels.size());
    // The frames already submitted read it first (a barrier orders everything before it on the queue).
    layout_barrier(vk_, cmd, im.image, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                   levels);
    vk_.CmdCopyBufferToImage(cmd, staging.buffer, im.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                             static_cast<uint32_t>(regions.size()), regions.data());
    layout_barrier(vk_, cmd, im.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
                   levels);
    good = check(vk_.EndCommandBuffer(cmd), "vkEndCommandBuffer");
  }
  if (good) {
    VkSubmitInfo si{};
    si.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    si.commandBufferCount = 1;
    si.pCommandBuffers = &cmd;
    good = check(vk_.QueueSubmit(ctx_.queue, 1, &si, VK_NULL_HANDLE), "vkQueueSubmit") &&
           check(vk_.QueueWaitIdle(ctx_.queue), "vkQueueWaitIdle");
  }
  if (cmd) vk_.FreeCommandBuffers(dev, setup_pool_, 1, &cmd);
  destroy_buffer(staging);
  return good;
}

// -------------------------------------------------------------- recording

void VkRenderer::barrier(Image& im, VkImageLayout layout) {
  // Also within one layout: an attachment drawn in an earlier render pass is loaded by the next one.
  if (im.layout == layout && layout != VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL) return;
  layout_barrier(vk_, cmd_, im.image, im.layout, layout);
  im.layout = layout;
}

void VkRenderer::end_pass() {
  if (pass_target_ != -2) vk_.CmdEndRenderPass(cmd_);
  pass_target_ = -2;
}

/** Opens the render pass of `target` (-1 the host's image, k layer k, -3/-4 the mask buffers). */
bool VkRenderer::begin_pass(int32_t target) {
  if (pass_target_ == target) return true;
  end_pass();
  VkFramebuffer fb = VK_NULL_HANDLE;
  Pass* pass = nullptr;
  int w = 0, h = 0;
  bool flipped = false;
  if (target == -1) {
    layout_barrier(vk_, cmd_, target_->image, host_layout_, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL);
    host_layout_ = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
    flipped = options_.flip_y;
    pass = pass_for(target_->format, flipped);
    fb = host_->framebuffer;
    w = framing_.width;
    h = framing_.height;
  } else {
    Image& im = target >= 0 ? layers_[Z(target)] : target == -3 ? mask_target_ : offscreen_mask_target_;
    barrier(im, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL);
    pass = pass_for(kInternalFormat, false);
    fb = im.framebuffer;
    w = target >= 0 ? framing_.width : im.width;
    h = target >= 0 ? framing_.height : im.height;
  }
  if (!pass) return false;
  VkRenderPassBeginInfo bi{};
  bi.sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO;
  bi.renderPass = pass->render_pass;
  bi.framebuffer = fb;
  bi.renderArea = {{0, 0}, {static_cast<uint32_t>(w), static_cast<uint32_t>(h)}};
  vk_.CmdBeginRenderPass(cmd_, &bi, VK_SUBPASS_CONTENTS_INLINE);
  // Into the host's image the top row first: y from the bottom of the viewport.
  VkViewport v{0, 0, static_cast<float>(w), static_cast<float>(h), 0, 1};
  if (flipped) {
    v.y = static_cast<float>(h);
    v.height = -static_cast<float>(h);
  }
  vk_.CmdSetViewport(cmd_, 0, 1, &v);
  VkRect2D scissor{{0, 0}, {static_cast<uint32_t>(w), static_cast<uint32_t>(h)}};
  vk_.CmdSetScissor(cmd_, 0, 1, &scissor);
  pass_target_ = target;
  return true;
}

void VkRenderer::upload_vertices(const eval::Instance& inst) {
  // A new instance can take a destroyed one's address: its serial tells them apart.
  const bool fresh = inst.serial.value != staged_for_;
  staged_for_ = inst.serial.value;
  bool any = false;
  for (size_t i = 0; i < vertex_start_.size(); i++) {
    const uint32_t version = i < inst.drawable_vertex_version.size() ? inst.drawable_vertex_version[i] : 0;
    if (!fresh && staged_[i] == version) continue;
    const auto& v = inst.drawable_vertices[i];
    const size_t floats = std::min(v.size(), model_->meshes.uvs[i].size());
    staged_[i] = version;
    if (!floats) continue;
    if (!any) {
      // The previous frames' vertex reads before these writes.
      VkMemoryBarrier mb{VK_STRUCTURE_TYPE_MEMORY_BARRIER, nullptr, VK_ACCESS_VERTEX_ATTRIBUTE_READ_BIT,
                         VK_ACCESS_TRANSFER_WRITE_BIT};
      vk_.CmdPipelineBarrier(cmd_, VK_PIPELINE_STAGE_VERTEX_INPUT_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 1, &mb, 0,
                             nullptr, 0, nullptr);
      any = true;
    }
    // vkCmdUpdateBuffer takes at most 65536 bytes at a time, recorded into the command buffer.
    for (size_t at = 0; at < floats; at += 16384) {
      const size_t n = std::min<size_t>(16384, floats - at);
      vk_.CmdUpdateBuffer(cmd_, positions_.buffer, (VkDeviceSize{vertex_start_[i]} * 2 + at) * 4, n * 4,
                          v.data() + at);
    }
  }
  if (any) {
    VkMemoryBarrier mb{VK_STRUCTURE_TYPE_MEMORY_BARRIER, nullptr, VK_ACCESS_TRANSFER_WRITE_BIT,
                       VK_ACCESS_VERTEX_ATTRIBUTE_READ_BIT};
    vk_.CmdPipelineBarrier(cmd_, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_VERTEX_INPUT_BIT, 0, 1, &mb, 0,
                           nullptr, 0, nullptr);
  }
}

bool VkRenderer::execute(const RenderOp& op) {
  const moc::Model& m = *model_;
  const Framing& f = framing_;
  VulkanPushConstants pc{};
  pc.turn[0] = 1;
  pc.height = static_cast<float>(f.height);
  const auto colors = [&]() {
    for (size_t k = 0; k < 3; k++) {
      pc.multiply[k] = op.multiply[k];
      pc.screen[k] = op.screen[k];
      pc.tint[k] = op.tint[k];
    }
    pc.opacity = op.opacity;
    pc.mask_mode = op.mask.buffer < 0 ? 0 : op.mask.inverted ? 2 : 1;
    // No mask: the zero matrix (its coordinate is never sampled), as Mochi2D sets it.
    for (size_t k = 0; k < 8; k++) pc.mask_rows[k] = op.mask.buffer < 0 ? 0.0f : op.mask.matrix[k];
    pc.color_fn = op.color_fn;
    pc.alpha_mode = op.alpha_mode;
    pc.flip = op.target == -1 && options_.flip_y ? 1.0f : 0.0f;
  };
  // What the op samples must be readable before its pass begins.
  const auto mask_view = [&]() -> VkImageView {
    if (op.mask.buffer < 0) return dummy_.view;
    Image& im = op.mask.buffer == 0 ? mask_target_ : offscreen_mask_target_;
    if (im.layout != VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL) {
      end_pass();
      barrier(im, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL);
    }
    return im.view;
  };
  const auto dst_view = [&]() -> VkImageView {
    if (op.blend != BlendKind::Advanced) return dummy_.view;
    if (dst_copy_.layout != VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL) {
      end_pass();
      barrier(dst_copy_, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL);
    }
    return dst_copy_.view;
  };
  const auto pass = [&]() -> Pass* {
    return op.target == -1 ? pass_for(target_->format, options_.flip_y) : pass_for(kInternalFormat, false);
  };
  switch (op.kind) {
    case RenderOp::Kind::Clear: {
      if (!begin_pass(-1)) return false;
      VkClearAttachment ca{};
      ca.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
      ca.colorAttachment = 0;
      for (size_t k = 0; k < 4; k++) ca.clearValue.color.float32[k] = static_cast<float>(op.color[k]);
      VkClearRect cr{{{0, 0}, {static_cast<uint32_t>(f.width), static_cast<uint32_t>(f.height)}}, 0, 1};
      vk_.CmdClearAttachments(cmd_, 1, &ca, 1, &cr);
      return true;
    }
    case RenderOp::Kind::BuildMask: {
      const int32_t target = op.buffer == 0 ? -3 : -4;
      Image& im = op.buffer == 0 ? mask_target_ : offscreen_mask_target_;
      if (im.width != op.size) return fail("a mask buffer of another size than the renderer's");
      if (!begin_pass(target)) return false;
      // The scissor's numbers are OpenGL's: the same rows here (masks are laid out as in OpenGL).
      const int32_t x0 = std::max(0, op.scissor[0]), y0 = std::max(0, op.scissor[1]);
      const int32_t x1 = std::min(op.size, op.scissor[0] + op.scissor[2]);
      const int32_t y1 = std::min(op.size, op.scissor[1] + op.scissor[3]);
      if (x1 <= x0 || y1 <= y0) return true;
      const VkRect2D rect{{x0, y0}, {static_cast<uint32_t>(x1 - x0), static_cast<uint32_t>(y1 - y0)}};
      vk_.CmdSetScissor(cmd_, 0, 1, &rect);
      VkClearAttachment ca{};
      ca.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
      for (size_t k = 0; k < 4; k++) ca.clearValue.color.float32[k] = 1;
      VkClearRect cr{rect, 0, 1};
      vk_.CmdClearAttachments(cmd_, 1, &ca, 1, &cr);
      VulkanPushConstants mp{};
      for (size_t k = 0; k < 8; k++) mp.mask_rows[k] = op.mask.matrix[k];
      vk_.CmdPushConstants(cmd_, pipeline_layout_, VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, 0,
                           sizeof mp, &mp);
      const VkBuffer vbs[2] = {positions_.buffer, uvs_.buffer};
      const VkDeviceSize offs[2] = {0, 0};
      vk_.CmdBindVertexBuffers(cmd_, 0, 2, vbs, offs);
      vk_.CmdBindIndexBuffer(cmd_, indices_.buffer, 0, VK_INDEX_TYPE_UINT32);
      Pass* p = pass_for(kInternalFormat, false);
      for (uint32_t k = 0; k < op.count; k++) {
        const int32_t mm = plan_.mask_meshes[op.first + k];
        const int32_t tex = m.meshes.texture[Z(mm)];
        if (tex < 0 || Z(tex) >= textures_gpu_.size() || !has_texture_[Z(tex)] || !index_count_[Z(mm)]) continue;
        const VkDescriptorSet set = descriptor(textures_gpu_[Z(tex)].view, dummy_.view, dummy_.view);
        if (!set) return false;
        const int cull = (m.meshes.flags[Z(mm)] & 4) == 0 ? 1 : 0;
        vk_.CmdBindPipeline(cmd_, VK_PIPELINE_BIND_POINT_GRAPHICS, p->pipelines[kMaskProgram][0][cull]);
        vk_.CmdBindDescriptorSets(cmd_, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline_layout_, 0, 1, &set, 0, nullptr);
        vk_.CmdDrawIndexed(cmd_, index_count_[Z(mm)], 1, index_start_[Z(mm)], 0, 0);
      }
      end_pass();
      return true;
    }
    case RenderOp::Kind::OpenLayer: {
      if (!begin_pass(op.layer)) return false;
      VkClearAttachment ca{};
      ca.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
      VkClearRect cr{{{0, 0}, {static_cast<uint32_t>(f.width), static_cast<uint32_t>(f.height)}}, 0, 1};
      vk_.CmdClearAttachments(cmd_, 1, &ca, 1, &cr);
      return true;
    }
    case RenderOp::Kind::CopyDestination: {
      end_pass();
      Image& src = layers_[Z(op.target)];
      barrier(src, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
      barrier(dst_copy_, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);
      VkImageCopy region{};
      region.srcSubresource = region.dstSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
      region.extent = {static_cast<uint32_t>(f.width), static_cast<uint32_t>(f.height), 1};
      vk_.CmdCopyImage(cmd_, src.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, dst_copy_.image,
                       VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
      return true;
    }
    case RenderOp::Kind::DrawMesh: {
      const int32_t d = op.index;
      const int32_t tex = m.meshes.texture[Z(d)];
      if (tex < 0 || Z(tex) >= textures_gpu_.size() || !has_texture_[Z(tex)] || !index_count_[Z(d)]) return true;
      const VkImageView mv = mask_view(), dv = dst_view();
      if (op.target >= 0 && layers_[Z(op.target)].layout != VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL) end_pass();
      const VkDescriptorSet set = descriptor(textures_gpu_[Z(tex)].view, mv, dv);
      if (!set || !begin_pass(op.target)) return false;
      colors();
      for (size_t k = 0; k < 4; k++) pc.view[k] = static_cast<float>(plan_.view[k]);
      Pass* p = pass();
      const int prog = static_cast<int>(op.blend == BlendKind::Advanced ? ShaderProgram::MeshAdvanced
                                                                         : ShaderProgram::Mesh);
      vk_.CmdBindPipeline(cmd_, VK_PIPELINE_BIND_POINT_GRAPHICS,
                          p->pipelines[prog][static_cast<int>(op.blend)][op.cull ? 1 : 0]);
      vk_.CmdBindDescriptorSets(cmd_, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline_layout_, 0, 1, &set, 0, nullptr);
      vk_.CmdPushConstants(cmd_, pipeline_layout_, VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, 0,
                           sizeof pc, &pc);
      const VkBuffer vbs[2] = {positions_.buffer, uvs_.buffer};
      const VkDeviceSize offs[2] = {0, 0};
      vk_.CmdBindVertexBuffers(cmd_, 0, 2, vbs, offs);
      vk_.CmdBindIndexBuffer(cmd_, indices_.buffer, 0, VK_INDEX_TYPE_UINT32);
      vk_.CmdDrawIndexed(cmd_, index_count_[Z(d)], 1, index_start_[Z(d)], 0, 0);
      return true;
    }
    case RenderOp::Kind::Composite: {
      Image& layer = layers_[Z(op.layer)];
      if (layer.layout != VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL) {
        end_pass();
        barrier(layer, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL);
      }
      const VkImageView mv = mask_view(), dv = dst_view();
      if (op.target >= 0 && layers_[Z(op.target)].layout != VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL) end_pass();
      const VkDescriptorSet set = descriptor(layer.view, mv, dv);
      if (!set || !begin_pass(op.target)) return false;
      colors();
      Pass* p = pass();
      const int prog = static_cast<int>(op.blend == BlendKind::Advanced ? ShaderProgram::LayerAdvanced
                                                                         : ShaderProgram::Layer);
      vk_.CmdBindPipeline(cmd_, VK_PIPELINE_BIND_POINT_GRAPHICS, p->pipelines[prog][static_cast<int>(op.blend)][0]);
      vk_.CmdBindDescriptorSets(cmd_, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline_layout_, 0, 1, &set, 0, nullptr);
      vk_.CmdPushConstants(cmd_, pipeline_layout_, VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, 0,
                           sizeof pc, &pc);
      // Rule L: a quad over the viewport, a triangle strip of 4 vertices.
      vk_.CmdDraw(cmd_, 4, 1, 0, 0);
      return true;
    }
  }
  return true;
}

bool VkRenderer::draw(const eval::Instance& instance, const FrameOptions& frame, VkCommandBuffer cmd,
                      const VkTarget& target) {
  if (!created_) return false;
  ok_ = true;
  if (!cmd || !target.image || !target.view) return fail("no command buffer or target");
  framing_ = frame.framing;
  const int w = framing_.width, h = framing_.height;
  if (w < 1 || h < 1) return fail("an empty frame");
  plan_frame(rm_, *model_, instance, frame, options_.mask_size, options_.offscreen_mask_size, has_texture_, plan_);
  // Layers and the destination copy have the frame's size (rule L samples a whole layer, 0 to 1):
  // another size waits for the device.
  if (plan_.layers > 0 && (w != layer_width_ || h != layer_height_ || layers_.size() < Z(plan_.layers))) {
    if (w != layer_width_ || h != layer_height_) {
      if (!check(vk_.DeviceWaitIdle(ctx_.device), "vkDeviceWaitIdle")) return false;
      for (auto& im : layers_) destroy_image(im);
      layers_.clear();
      destroy_image(dst_copy_);
      // Descriptor sets name the old views.
      descriptors_.clear();
      if (!check(vk_.ResetDescriptorPool(ctx_.device, descriptor_pool_, 0), "vkResetDescriptorPool")) return false;
      layer_width_ = w;
      layer_height_ = h;
    }
    const VkImageUsageFlags usage =
        VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
    while (layers_.size() < Z(plan_.layers)) {
      layers_.push_back(Image());
      if (!create_image(layers_.back(), layer_width_, layer_height_, 1, usage, true)) return false;
    }
    if (!dst_copy_.image &&
        !create_image(dst_copy_, layer_width_, layer_height_, 1,
                      VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, false))
      return false;
  }
  // The host's view: a framebuffer kept per view.
  host_ = nullptr;
  for (auto& t : host_targets_)
    if (t.view == target.view) host_ = &t;
  if (host_ && (host_->width != w || host_->height != h || host_->format != target.format)) {
    forget_target(target.view);
    host_ = nullptr;
  }
  if (!host_) {
    Pass* p = pass_for(target.format, options_.flip_y);
    if (!p) return false;
    HostTarget t;
    t.view = target.view;
    t.format = target.format;
    t.width = w;
    t.height = h;
    VkFramebufferCreateInfo fi{};
    fi.sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO;
    fi.renderPass = p->render_pass;
    fi.attachmentCount = 1;
    fi.pAttachments = &t.view;
    fi.width = static_cast<uint32_t>(w);
    fi.height = static_cast<uint32_t>(h);
    fi.layers = 1;
    if (!check(vk_.CreateFramebuffer(ctx_.device, &fi, nullptr, &t.framebuffer), "vkCreateFramebuffer")) return false;
    host_targets_.push_back(t);
    host_ = &host_targets_.back();
  }
  cmd_ = cmd;
  target_ = &target;
  host_layout_ = target.old_layout;
  pass_target_ = -2;
  upload_vertices(instance);
  for (const RenderOp& op : plan_.ops) {
    if (!execute(op)) break;
  }
  end_pass();
  // The host's image in the layout it asked for (also when nothing was drawn).
  if (host_layout_ != target.new_layout && target.new_layout != VK_IMAGE_LAYOUT_UNDEFINED) {
    if (host_layout_ == VK_IMAGE_LAYOUT_UNDEFINED) {
      layout_barrier(vk_, cmd_, target.image, host_layout_, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL);
      host_layout_ = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
    }
    layout_barrier(vk_, cmd_, target.image, host_layout_, target.new_layout);
  }
  cmd_ = VK_NULL_HANDLE;
  target_ = nullptr;
  host_ = nullptr;
  return ok_;
}

}  // namespace mochi2d::render::vk
