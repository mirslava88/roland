//
// Copyright (C) Microsoft Corporation. All rights reserved.
//
#include "pch.h"

#include <sddl.h>

SimpleFrameGenerator::~SimpleFrameGenerator()
{
    if (m_sharedFrame) UnmapViewOfFile(m_sharedFrame);
    if (m_mapping) CloseHandle(m_mapping);
}

HRESULT SimpleFrameGenerator::EnsureMapping()
{
    if (m_sharedFrame) return S_OK;

    PSECURITY_DESCRIPTOR descriptor = nullptr;
    SECURITY_ATTRIBUTES attributes{ sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE };
    if (ConvertStringSecurityDescriptorToSecurityDescriptorW(
        L"D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)", SDDL_REVISION_1, &descriptor, nullptr))
    {
        attributes.lpSecurityDescriptor = descriptor;
    }

    const auto high = static_cast<DWORD>((pdm::virtual_camera::kMappingBytes >> 32) & 0xffffffffu);
    const auto low = static_cast<DWORD>(pdm::virtual_camera::kMappingBytes & 0xffffffffu);
    m_mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, descriptor ? &attributes : nullptr,
        PAGE_READWRITE, high, low, pdm::virtual_camera::kMappingName);
    if (descriptor) LocalFree(descriptor);
    if (!m_mapping) return HRESULT_FROM_WIN32(GetLastError());

    const bool existed = GetLastError() == ERROR_ALREADY_EXISTS;
    m_sharedFrame = static_cast<pdm::virtual_camera::SharedFrameHeader*>(
        MapViewOfFile(m_mapping, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, pdm::virtual_camera::kMappingBytes));
    if (!m_sharedFrame)
    {
        const auto error = GetLastError();
        CloseHandle(m_mapping);
        m_mapping = nullptr;
        return HRESULT_FROM_WIN32(error);
    }

    if (!existed || m_sharedFrame->magic != pdm::virtual_camera::kMagic ||
        m_sharedFrame->version != pdm::virtual_camera::kVersion)
    {
        ZeroMemory(m_sharedFrame, pdm::virtual_camera::kMappingBytes);
        m_sharedFrame->magic = pdm::virtual_camera::kMagic;
        m_sharedFrame->version = pdm::virtual_camera::kVersion;
        m_sharedFrame->width = pdm::virtual_camera::kWidth;
        m_sharedFrame->height = pdm::virtual_camera::kHeight;
        m_sharedFrame->stride = pdm::virtual_camera::kStride;
        m_sharedFrame->frameBytes = pdm::virtual_camera::kFrameBytes;
    }
    return S_OK;
}

HRESULT SimpleFrameGenerator::Initialize(_In_ IMFMediaType* pMediaType)
{
    RETURN_HR_IF_NULL(E_INVALIDARG, pMediaType);

    RETURN_IF_FAILED(pMediaType->GetGUID(MF_MT_SUBTYPE, &m_subType));
    if (m_subType != MFVideoFormat_RGB32 && m_subType != MFVideoFormat_NV12)
    {
        RETURN_HR_MSG(MF_E_UNSUPPORTED_FORMAT, "Unsupported format: %s", winrt::to_hstring(m_subType).data());
    }
    MFGetAttributeSize(pMediaType, MF_MT_FRAME_SIZE, &m_width, &m_height);
    m_lastFrame.resize(pdm::virtual_camera::kFrameBytes);
    m_candidateFrame.resize(pdm::virtual_camera::kFrameBytes);
    m_hasLastFrame = false;

    return S_OK;
}

/*:
   Writes to a buffer representing a 2D image.
   Writes a different constant to each line based on row number and current time.
   Assumes top down image, no negative stride and pBuf points to the begnning of the buffer of length len.
   Param:
   pBuf - pointer to beginning of buffer
   pitch - line length in bytes
   len - length of buffer in bytes
*/
HRESULT SimpleFrameGenerator::CreateFrame(
    _Inout_updates_bytes_(len) BYTE* pBuf,
    _In_ DWORD len,
    _In_ LONG pitch,
    _In_ ULONG rgbMask)
{
    if (m_subType == MFVideoFormat_RGB32)
    {
        DEBUG_MSG(L"RGB32 frames %s\n", winrt::to_hstring(MFVideoFormat_RGB32).data());

        RETURN_IF_FAILED(_CreateRGB32Frame(pBuf, len, pitch, m_width, m_height, rgbMask));
    }
    else if(m_subType == MFVideoFormat_NV12)
    {
        DEBUG_MSG(L"NV12 frames %s \n", winrt::to_hstring(MFVideoFormat_NV12).data());

        DWORD frameBuffLen = m_width * m_height * 4;
        wil::unique_cotaskmem_ptr<BYTE[]> spBuff = wil::make_unique_cotaskmem_nothrow<BYTE[]>(frameBuffLen);
        RETURN_IF_NULL_ALLOC(spBuff.get());

        RETURN_IF_FAILED(_CreateRGB32Frame(spBuff.get(), frameBuffLen, m_width * 4, m_width, m_height, rgbMask));
        RETURN_IF_FAILED(RGB32ToNV12Frame(spBuff.get(), frameBuffLen, m_width * 4, m_width, m_height, pBuf, len, pitch));
    }
    else
    {
        return MF_E_UNSUPPORTED_FORMAT;
    }

    return S_OK;
}

//////////////////////////////////////////////////
// private

HRESULT SimpleFrameGenerator::_CreateRGB32Frame(
    _Inout_updates_bytes_(len) BYTE* pBuf,
    _In_ DWORD len,
    _In_ LONG pitch,
    _In_ DWORD width,
    _In_ DWORD height,
    _In_ ULONG rgbMask )
{
    RETURN_HR_IF_NULL(E_INVALIDARG, pBuf);
    const auto absolutePitch = static_cast<DWORD>(pitch < 0 ? -static_cast<LONGLONG>(pitch) : pitch);
    if (absolutePitch < width * 4 || len < (absolutePitch * height))
    {
        return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
    }

    const auto clearDestination = [&]() {
        for (DWORD row = 0; row < height; ++row)
        {
            BYTE* destination = pBuf + (static_cast<std::ptrdiff_t>(row) * static_cast<std::ptrdiff_t>(pitch));
            ZeroMemory(destination, width * 4);
        }
    };
    const auto copyToDestination = [&](const BYTE* frame) {
        for (DWORD row = 0; row < height; ++row)
        {
            BYTE* destination = pBuf + (static_cast<std::ptrdiff_t>(row) * static_cast<std::ptrdiff_t>(pitch));
            CopyMemory(destination,
                frame + (static_cast<std::size_t>(row) * pdm::virtual_camera::kStride),
                pdm::virtual_camera::kStride);
        }
    };
    if (width != pdm::virtual_camera::kWidth || height != pdm::virtual_camera::kHeight)
    {
        clearDestination();
        return S_OK;
    }
    if (FAILED(EnsureMapping()) || !m_sharedFrame)
    {
        clearDestination();
        m_hasLastFrame = false;
        return S_OK;
    }

    const auto now = GetTickCount64();
    const auto writtenAt = static_cast<ULONGLONG>(InterlockedCompareExchange64(&m_sharedFrame->lastWriteTick, 0, 0));
    if (!writtenAt || now < writtenAt || now - writtenAt > pdm::virtual_camera::kStaleAfterMs)
    {
        clearDestination();
        m_hasLastFrame = false;
        return S_OK;
    }

    for (int attempt = 0; attempt < 8; ++attempt)
    {
        const LONG sequenceBefore = InterlockedCompareExchange(&m_sharedFrame->sequence, 0, 0);
        if (sequenceBefore & 1)
        {
            SwitchToThread();
            continue;
        }
        const LONG active = InterlockedCompareExchange(&m_sharedFrame->activeBuffer, 0, 0) & 1;
        const BYTE* source = pdm::virtual_camera::BufferAt(m_sharedFrame, active);
        CopyMemory(m_candidateFrame.data(), source, pdm::virtual_camera::kFrameBytes);
        MemoryBarrier();
        const LONG sequenceAfter = InterlockedCompareExchange(&m_sharedFrame->sequence, 0, 0);
        if (sequenceBefore == sequenceAfter && !(sequenceAfter & 1))
        {
            m_lastFrame.swap(m_candidateFrame);
            m_hasLastFrame = true;
            break;
        }
    }

    // A media sample must never become black merely because it arrived while
    // the next frame was being committed. Hold the last complete frame until
    // a new stable buffer is available; genuine stale output still clears.
    if (m_hasLastFrame) copyToDestination(m_lastFrame.data());
    else clearDestination();

    return S_OK;
}

//////////////////////////////////////////////////
// pixelFormatConverter

void SimpleFrameGenerator::RGB24ToYUY2(int R, int G, int B, BYTE* pY, BYTE* pU, BYTE* pV)
{
    *pY = ((66 * R + 129 * G + 25 * B + 128) >> 8) + 16;
    *pU = ((-38 * R - 74 * G + 112 * B + 128) >> 8) + 128;
    *pV = ((112 * R - 94 * G - 18 * B + 128) >> 8) + 128;
}

void SimpleFrameGenerator::RGB24ToY(int R, int G, int B, BYTE* pY)
{
    *pY = ((66 * R + 129 * G + 25 * B + 128) >> 8) + 16;
}

void SimpleFrameGenerator::RGB32ToNV12(BYTE RGB1[8], BYTE RGB2[8], BYTE* pY1, BYTE* pY2, BYTE* pUV)
{
    RGB24ToYUY2(RGB1[2], RGB1[1], RGB1[0], pY1, pUV, pUV + 1);
    RGB24ToY(RGB1[6], RGB1[5], RGB1[4], pY1 + 1);
    RGB24ToYUY2(RGB2[2], RGB2[1], RGB2[0], pY2, pUV, pUV + 1);
    RGB24ToY(RGB2[6], RGB2[5], RGB2[4], pY2 + 1);
};

//////////////////////////////////////////////////
// FrameFormatConverter

HRESULT SimpleFrameGenerator::RGB32ToNV12Frame(_Inout_updates_bytes_(len) BYTE* pbBuff, ULONG cbBuff, long stride, UINT width, UINT height, BYTE* pbBuffOut, ULONG cbBuffOut, long strideOut)
{
    do
    {
        RETURN_HR_IF(E_UNEXPECTED, width * 4 * height > cbBuff);
        RETURN_HR_IF(E_UNEXPECTED, width * 1.5 * height > cbBuffOut);
        RETURN_HR_IF_NULL(E_INVALIDARG, pbBuff);

        RETURN_HR_IF_NULL(E_INVALIDARG, pbBuffOut);
        for (DWORD h = 0; h < height - 1; h += 2)
        {
            BYTE* pRGB1 = h * stride + pbBuff;
            BYTE* pRGB2 = (h + 1) * stride + pbBuff;
            BYTE* pY1 = h * strideOut + pbBuffOut;
            BYTE* pY2 = (h + 1) * strideOut + pbBuffOut;
            BYTE* pUV = (h / 2 + height) * strideOut + pbBuffOut;

            for (DWORD w = 0; w < width; w += 2)
            {
                RGB32ToNV12(pRGB1, pRGB2, pY1, pY2, pUV);
                pRGB1 += 8;
                pRGB2 += 8;
                pY1 += 2;
                pY2 += 2;
                pUV += 2;
            }
        }
    } while (FALSE);

    return S_OK;
}
