#include "pch.h"

#include <vector>

extern "C" HRESULT __stdcall PDMVirtualCameraSelfTest()
{
    wil::com_ptr_nothrow<IMFMediaType> mediaType;
    RETURN_IF_FAILED(MFCreateMediaType(&mediaType));
    RETURN_IF_FAILED(mediaType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
    RETURN_IF_FAILED(mediaType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32));
    RETURN_IF_FAILED(MFSetAttributeSize(mediaType.get(), MF_MT_FRAME_SIZE,
        pdm::virtual_camera::kWidth, pdm::virtual_camera::kHeight));

    SimpleFrameGenerator generator;
    RETURN_IF_FAILED(generator.Initialize(mediaType.get()));
    std::vector<BYTE> positive(pdm::virtual_camera::kFrameBytes, 0x7f);
    RETURN_IF_FAILED(generator.CreateFrame(positive.data(), static_cast<DWORD>(positive.size()),
        static_cast<LONG>(pdm::virtual_camera::kStride), 0x00ffffff));

    HANDLE mapping = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, pdm::virtual_camera::kMappingName);
    if (mapping)
    {
        auto* shared = static_cast<pdm::virtual_camera::SharedFrameHeader*>(
            MapViewOfFile(mapping, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, pdm::virtual_camera::kMappingBytes));
        if (!shared)
        {
            const HRESULT error = HRESULT_FROM_WIN32(GetLastError());
            CloseHandle(mapping);
            return error;
        }
        FillMemory(pdm::virtual_camera::BufferAt(shared, 0), pdm::virtual_camera::kFrameBytes, 0x42);
        InterlockedExchange(&shared->activeBuffer, 0);
        InterlockedExchange(&shared->sequence, 2);
        InterlockedExchange64(&shared->lastWriteTick, static_cast<LONGLONG>(GetTickCount64()));
        RETURN_IF_FAILED(generator.CreateFrame(positive.data(), static_cast<DWORD>(positive.size()),
            static_cast<LONG>(pdm::virtual_camera::kStride), 0x00ffffff));
        RETURN_HR_IF(E_FAIL, positive.front() != 0x42 || positive.back() != 0x42);

        InterlockedExchange(&shared->sequence, 3);
        FillMemory(pdm::virtual_camera::BufferAt(shared, 0), pdm::virtual_camera::kFrameBytes, 0x19);
        FillMemory(positive.data(), positive.size(), 0x7f);
        RETURN_IF_FAILED(generator.CreateFrame(positive.data(), static_cast<DWORD>(positive.size()),
            static_cast<LONG>(pdm::virtual_camera::kStride), 0x00ffffff));
        const bool heldLastFrame = positive.front() == 0x42 && positive.back() == 0x42;
        InterlockedExchange(&shared->sequence, 4);
        InterlockedExchange64(&shared->lastWriteTick, 0);
        UnmapViewOfFile(shared);
        CloseHandle(mapping);
        RETURN_HR_IF(E_FAIL, !heldLastFrame);
    }

    std::vector<BYTE> negative(pdm::virtual_camera::kFrameBytes, 0x7f);
    BYTE* lastLogicalRow = negative.data() + pdm::virtual_camera::kFrameBytes - pdm::virtual_camera::kStride;
    RETURN_IF_FAILED(generator.CreateFrame(lastLogicalRow, static_cast<DWORD>(negative.size()),
        -static_cast<LONG>(pdm::virtual_camera::kStride), 0x00ffffff));
    return S_OK;
}
