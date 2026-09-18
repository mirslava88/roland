#pragma once

#include <windows.h>
#include <cstdint>

namespace pdm::virtual_camera
{
    constexpr wchar_t kMappingName[] = L"Global\\PDMVirtualCameraFrame_v1_BBEF2CB0";
    constexpr std::uint32_t kMagic = 0x314D4450; // PDM1
    constexpr std::uint32_t kVersion = 1;
    constexpr std::uint32_t kWidth = 1920;
    constexpr std::uint32_t kHeight = 1080;
    constexpr std::uint32_t kStride = kWidth * 4;
    constexpr std::uint32_t kFrameBytes = kStride * kHeight;
    constexpr std::uint64_t kStaleAfterMs = 2000;

    struct alignas(64) SharedFrameHeader
    {
        std::uint32_t magic;
        std::uint32_t version;
        std::uint32_t width;
        std::uint32_t height;
        std::uint32_t stride;
        std::uint32_t frameBytes;
        volatile LONG sequence;
        volatile LONG activeBuffer;
        volatile LONG writerPid;
        std::uint32_t reserved;
        volatile LONGLONG lastWriteTick;
        std::uint8_t padding[64 - 48];
    };

    static_assert(sizeof(SharedFrameHeader) == 64);
    constexpr std::size_t kMappingBytes = sizeof(SharedFrameHeader) + (static_cast<std::size_t>(kFrameBytes) * 2);

    inline std::uint8_t* BufferAt(SharedFrameHeader* header, LONG index)
    {
        return reinterpret_cast<std::uint8_t*>(header) + sizeof(SharedFrameHeader) +
            (static_cast<std::size_t>(index & 1) * kFrameBytes);
    }
}
