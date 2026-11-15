// The Vulkan functions the Vulkan backend uses (Vulkan 1.1 core: 1.0 and a
// negative viewport height). The library links no Vulkan loader: the host
// hands over its vkGetInstanceProcAddr with its instance and device, and
// every function is fetched through them. Built where the Vulkan headers
// are found (vulkan/vulkan_core.h; VK_NO_PROTOTYPES).
#pragma once

#ifndef VK_NO_PROTOTYPES
#define VK_NO_PROTOTYPES
#endif
#include <vulkan/vulkan_core.h>

namespace mochi2d::render::vk {

#define M2D_VK_INSTANCE_FUNCTIONS(X)     \
  X(GetDeviceProcAddr)                   \
  X(GetPhysicalDeviceProperties)         \
  X(GetPhysicalDeviceMemoryProperties)   \
  X(GetPhysicalDeviceFormatProperties)

#define M2D_VK_DEVICE_FUNCTIONS(X) \
  X(CreateBuffer)                  \
  X(DestroyBuffer)                 \
  X(GetBufferMemoryRequirements)   \
  X(AllocateMemory)                \
  X(FreeMemory)                    \
  X(BindBufferMemory)              \
  X(MapMemory)                     \
  X(UnmapMemory)                   \
  X(CreateImage)                   \
  X(DestroyImage)                  \
  X(GetImageMemoryRequirements)    \
  X(BindImageMemory)               \
  X(CreateImageView)               \
  X(DestroyImageView)              \
  X(CreateSampler)                 \
  X(DestroySampler)                \
  X(CreateRenderPass)              \
  X(DestroyRenderPass)             \
  X(CreateFramebuffer)             \
  X(DestroyFramebuffer)            \
  X(CreateShaderModule)            \
  X(DestroyShaderModule)           \
  X(CreatePipelineLayout)          \
  X(DestroyPipelineLayout)         \
  X(CreateGraphicsPipelines)       \
  X(DestroyPipeline)               \
  X(CreateDescriptorSetLayout)     \
  X(DestroyDescriptorSetLayout)    \
  X(CreateDescriptorPool)          \
  X(DestroyDescriptorPool)         \
  X(ResetDescriptorPool)           \
  X(AllocateDescriptorSets)        \
  X(UpdateDescriptorSets)          \
  X(CreateCommandPool)             \
  X(DestroyCommandPool)            \
  X(AllocateCommandBuffers)        \
  X(FreeCommandBuffers)            \
  X(BeginCommandBuffer)            \
  X(EndCommandBuffer)              \
  X(QueueSubmit)                   \
  X(QueueWaitIdle)                 \
  X(DeviceWaitIdle)                \
  X(CmdPipelineBarrier)            \
  X(CmdCopyBufferToImage)          \
  X(CmdCopyImage)                  \
  X(CmdBeginRenderPass)            \
  X(CmdEndRenderPass)              \
  X(CmdBindPipeline)               \
  X(CmdBindDescriptorSets)         \
  X(CmdBindVertexBuffers)          \
  X(CmdBindIndexBuffer)            \
  X(CmdDrawIndexed)                \
  X(CmdDraw)                       \
  X(CmdPushConstants)              \
  X(CmdSetViewport)                \
  X(CmdSetScissor)                 \
  X(CmdClearAttachments)           \
  X(CmdUpdateBuffer)

struct Api {
#define M2D_VK_MEMBER(name) PFN_vk##name name = nullptr;
  M2D_VK_INSTANCE_FUNCTIONS(M2D_VK_MEMBER)
  M2D_VK_DEVICE_FUNCTIONS(M2D_VK_MEMBER)
#undef M2D_VK_MEMBER
};

/** Fetches every function; false with the name of the first that is missing. */
bool load(Api& api, PFN_vkGetInstanceProcAddr get_instance_proc_addr, VkInstance instance, VkDevice device,
          const char** missing);

}  // namespace mochi2d::render::vk
