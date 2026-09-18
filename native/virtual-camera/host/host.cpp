#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <aclapi.h>
#include <sddl.h>
#include <mfapi.h>
#include <mfvirtualcamera.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <string>
#include <thread>
#include <atomic>
#include <vector>
#include <iostream>
#include <algorithm>
#include <cstdint>
#include <memory>

#include "../source/PdmSharedFrame.h"

#pragma comment(lib, "mfplat")
#pragma comment(lib, "mfsensorgroup")
#pragma comment(lib, "advapi32")
#pragma comment(lib, "shell32")
#pragma comment(lib, "d3d11")
#pragma comment(lib, "dxgi")

using Microsoft::WRL::ComPtr;

namespace
{
    constexpr wchar_t kSourceClsid[] = L"{BBEF2CB0-96F5-4C1E-86F6-6B7670CAB609}";
    constexpr wchar_t kFriendlyName[] = L"PDM Virtual Camera";
    constexpr wchar_t kRegistryPath[] = L"SOFTWARE\\Classes\\CLSID\\{BBEF2CB0-96F5-4C1E-86F6-6B7670CAB609}\\InProcServer32";

    std::wstring InstalledSourceDirectory()
    {
        PWSTR programData = nullptr;
        if (FAILED(SHGetKnownFolderPath(FOLDERID_ProgramData, KF_FLAG_DEFAULT, nullptr, &programData))) return {};
        std::wstring directory = std::wstring(programData) + L"\\Presentation Display Manager\\VirtualCamera";
        CoTaskMemFree(programData);
        return directory;
    }

    std::wstring InstalledSourcePath()
    {
        const auto directory = InstalledSourceDirectory();
        return directory.empty() ? std::wstring{} : directory + L"\\PDMVirtualCameraSource.dll";
    }

    std::string JsonEscape(const std::string& input)
    {
        std::string output;
        output.reserve(input.size() + 16);
        for (const unsigned char value : input)
        {
            if (value == '\\' || value == '"') { output.push_back('\\'); output.push_back(static_cast<char>(value)); }
            else if (value == '\n') output += "\\n";
            else if (value == '\r') output += "\\r";
            else if (value >= 0x20) output.push_back(static_cast<char>(value));
        }
        return output;
    }

    std::string Utf8(const std::wstring& input)
    {
        if (input.empty()) return {};
        const int size = WideCharToMultiByte(CP_UTF8, 0, input.c_str(), static_cast<int>(input.size()), nullptr, 0, nullptr, nullptr);
        std::string output(static_cast<std::size_t>(size), '\0');
        WideCharToMultiByte(CP_UTF8, 0, input.c_str(), static_cast<int>(input.size()), output.data(), size, nullptr, nullptr);
        return output;
    }

    std::wstring ErrorMessage(HRESULT result)
    {
        wchar_t* raw = nullptr;
        FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
            nullptr, static_cast<DWORD>(result), 0, reinterpret_cast<wchar_t*>(&raw), 0, nullptr);
        std::wstring message = raw ? raw : L"Unknown error";
        if (raw) LocalFree(raw);
        while (!message.empty() && (message.back() == L'\r' || message.back() == L'\n')) message.pop_back();
        return message + L" (0x" + [] (HRESULT value) {
            wchar_t buffer[12]{};
            swprintf_s(buffer, L"%08X", static_cast<unsigned>(value));
            return std::wstring(buffer);
        }(result) + L")";
    }

    void PrintStatus(const char* phase, const std::string& message = {})
    {
        std::cout << "{\"phase\":\"" << phase << "\",\"message\":\"" << JsonEscape(message) << "\"}" << std::endl;
    }

    bool SourceRegistered(std::wstring* dllPath = nullptr)
    {
        HKEY key = nullptr;
        if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, kRegistryPath, 0, KEY_READ | KEY_WOW64_64KEY, &key) != ERROR_SUCCESS) return false;
        wchar_t value[32768]{};
        DWORD bytes = sizeof(value);
        DWORD type = 0;
        const auto result = RegQueryValueExW(key, nullptr, nullptr, &type, reinterpret_cast<BYTE*>(value), &bytes);
        RegCloseKey(key);
        if (result != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ)) return false;
        if (dllPath) *dllPath = value;
        return GetFileAttributesW(value) != INVALID_FILE_ATTRIBUTES;
    }

    DWORD ApplySourceAcl(const std::wstring& path, bool directory)
    {
        // FrameServer loads the COM source as LocalService. Keep the installed
        // component immutable for ordinary users while allowing camera hosts
        // and packaged applications to read and execute it.
        const wchar_t* sddl = directory
            ? L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;LS)(A;OICI;GRGX;;;BU)(A;OICI;GRGX;;;AC)(A;OICI;GRGX;;;S-1-15-2-2)"
            : L"D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;LS)(A;;GRGX;;;BU)(A;;GRGX;;;AC)(A;;GRGX;;;S-1-15-2-2)";
        PSECURITY_DESCRIPTOR descriptor = nullptr;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl, SDDL_REVISION_1, &descriptor, nullptr)) {
            return GetLastError();
        }
        BOOL daclPresent = FALSE;
        BOOL daclDefaulted = FALSE;
        PACL dacl = nullptr;
        if (!GetSecurityDescriptorDacl(descriptor, &daclPresent, &dacl, &daclDefaulted) || !daclPresent || !dacl) {
            const DWORD error = GetLastError() == ERROR_SUCCESS ? ERROR_INVALID_SECURITY_DESCR : GetLastError();
            LocalFree(descriptor);
            return error;
        }
        const DWORD result = SetNamedSecurityInfoW(
            const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            nullptr, nullptr, dacl, nullptr);
        LocalFree(descriptor);
        return result;
    }

    int InstallSource(const std::wstring& dllPath)
    {
        wchar_t absolutePath[32768]{};
        const DWORD resolvedLength = GetFullPathNameW(dllPath.c_str(), static_cast<DWORD>(std::size(absolutePath)), absolutePath, nullptr);
        if (!resolvedLength || resolvedLength >= std::size(absolutePath)) return ERROR_INVALID_NAME;
        const DWORD attrs = GetFileAttributesW(absolutePath);
        if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_DIRECTORY)) return ERROR_FILE_NOT_FOUND;
        const auto installedDirectory = InstalledSourceDirectory();
        const auto installedPath = InstalledSourcePath();
        if (installedDirectory.empty() || installedPath.empty()) return ERROR_PATH_NOT_FOUND;
        const int createResult = SHCreateDirectoryExW(nullptr, installedDirectory.c_str(), nullptr);
        if (createResult != ERROR_SUCCESS && createResult != ERROR_ALREADY_EXISTS) return createResult;
        const DWORD directoryAclResult = ApplySourceAcl(installedDirectory, true);
        if (directoryAclResult != ERROR_SUCCESS) return static_cast<int>(directoryAclResult);
        if (_wcsicmp(absolutePath, installedPath.c_str()) != 0 && !CopyFileW(absolutePath, installedPath.c_str(), FALSE)) {
            return static_cast<int>(GetLastError());
        }
        const DWORD fileAclResult = ApplySourceAcl(installedPath, false);
        if (fileAclResult != ERROR_SUCCESS) return static_cast<int>(fileAclResult);
        HKEY key = nullptr;
        DWORD disposition = 0;
        LSTATUS status = RegCreateKeyExW(HKEY_LOCAL_MACHINE, kRegistryPath, 0, nullptr, 0,
            KEY_WRITE | KEY_WOW64_64KEY, nullptr, &key, &disposition);
        if (status != ERROR_SUCCESS) return status;
        status = RegSetValueExW(key, nullptr, 0, REG_SZ, reinterpret_cast<const BYTE*>(installedPath.c_str()),
            static_cast<DWORD>((installedPath.size() + 1) * sizeof(wchar_t)));
        if (status == ERROR_SUCCESS)
        {
            constexpr wchar_t threading[] = L"Both";
            status = RegSetValueExW(key, L"ThreadingModel", 0, REG_SZ, reinterpret_cast<const BYTE*>(threading), sizeof(threading));
        }
        RegCloseKey(key);
        return status;
    }

    int UninstallSource()
    {
        const LSTATUS status = RegDeleteTreeW(HKEY_LOCAL_MACHINE,
            L"SOFTWARE\\Classes\\CLSID\\{BBEF2CB0-96F5-4C1E-86F6-6B7670CAB609}");
        const auto installedPath = InstalledSourcePath();
        const auto installedDirectory = InstalledSourceDirectory();
        if (!installedPath.empty()) DeleteFileW(installedPath.c_str());
        if (!installedDirectory.empty()) RemoveDirectoryW(installedDirectory.c_str());
        return status == ERROR_FILE_NOT_FOUND ? ERROR_SUCCESS : status;
    }

    int Elevate(const std::wstring& verb, const std::wstring& dllPath = {})
    {
        wchar_t executable[MAX_PATH]{};
        if (!GetModuleFileNameW(nullptr, executable, MAX_PATH)) return static_cast<int>(GetLastError());
        const std::wstring parameters = verb + (dllPath.empty() ? L"" : L" \"" + dllPath + L"\"");
        SHELLEXECUTEINFOW info{ sizeof(info) };
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = L"runas";
        info.lpFile = executable;
        info.lpParameters = parameters.c_str();
        info.nShow = SW_HIDE;
        if (!ShellExecuteExW(&info)) return static_cast<int>(GetLastError());
        WaitForSingleObject(info.hProcess, INFINITE);
        DWORD exitCode = ERROR_GEN_FAILURE;
        GetExitCodeProcess(info.hProcess, &exitCode);
        CloseHandle(info.hProcess);
        return static_cast<int>(exitCode);
    }

    int TestMediaSource(const std::wstring& dllPath)
    {
        HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        const bool uninitialize = SUCCEEDED(result);
        if (FAILED(result) && result != RPC_E_CHANGED_MODE) return 31;
        result = MFStartup(MF_VERSION);
        if (FAILED(result)) { if (uninitialize) CoUninitialize(); return 32; }
        HMODULE module = LoadLibraryW(dllPath.c_str());
        if (!module) { MFShutdown(); if (uninitialize) CoUninitialize(); return 33; }
        using DllGetClassObjectFn = HRESULT(STDAPICALLTYPE*)(REFCLSID, REFIID, LPVOID*);
        const auto getClassObject = reinterpret_cast<DllGetClassObjectFn>(GetProcAddress(module, "DllGetClassObject"));
        CLSID clsid{};
        ComPtr<IClassFactory> factory;
        ComPtr<IMFActivate> activate;
        ComPtr<IMFMediaSource> source;
        ComPtr<IMFPresentationDescriptor> descriptor;
        using SelfTestFn = HRESULT(STDAPICALLTYPE*)();
        const auto selfTest = reinterpret_cast<SelfTestFn>(GetProcAddress(module, "PDMVirtualCameraSelfTest"));
        if (!getClassObject) result = E_NOINTERFACE;
        if (SUCCEEDED(result) && !selfTest) result = E_NOINTERFACE;
        if (SUCCEEDED(result)) result = selfTest();
        if (SUCCEEDED(result)) result = CLSIDFromString(kSourceClsid, &clsid);
        if (SUCCEEDED(result)) result = getClassObject(clsid, IID_PPV_ARGS(&factory));
        if (SUCCEEDED(result)) result = factory->CreateInstance(nullptr, IID_PPV_ARGS(&activate));
        if (SUCCEEDED(result)) result = activate->ActivateObject(IID_PPV_ARGS(&source));
        if (SUCCEEDED(result)) result = source->CreatePresentationDescriptor(&descriptor);
        DWORD streamCount = 0;
        if (SUCCEEDED(result)) result = descriptor->GetStreamDescriptorCount(&streamCount);
        if (source) source->Shutdown();
        if (activate) activate->ShutdownObject();
        descriptor.Reset(); source.Reset(); activate.Reset(); factory.Reset();
        FreeLibrary(module);
        MFShutdown();
        if (uninitialize) CoUninitialize();
        std::cout << "{\"ok\":" << (SUCCEEDED(result) && streamCount == 1 ? "true" : "false")
            << ",\"streams\":" << streamCount << ",\"hresult\":" << static_cast<unsigned>(result) << "}" << std::endl;
        return SUCCEEDED(result) && streamCount == 1 ? 0 : 34;
    }

    struct MappingWriter
    {
        HANDLE mapping = nullptr;
        pdm::virtual_camera::SharedFrameHeader* header = nullptr;

        ~MappingWriter() { Close(); }

        void Close()
        {
            if (header) UnmapViewOfFile(header);
            if (mapping) CloseHandle(mapping);
            header = nullptr;
            mapping = nullptr;
        }

        bool EnsureOpen()
        {
            if (header) return true;
            mapping = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, pdm::virtual_camera::kMappingName);
            if (!mapping) return false;
            header = static_cast<pdm::virtual_camera::SharedFrameHeader*>(
                MapViewOfFile(mapping, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, pdm::virtual_camera::kMappingBytes));
            if (!header)
            {
                CloseHandle(mapping);
                mapping = nullptr;
                return false;
            }
            if (header->magic != pdm::virtual_camera::kMagic || header->version != pdm::virtual_camera::kVersion)
            {
                Close();
                return false;
            }
            return true;
        }

        bool Write(const std::uint8_t* frame)
        {
            if (!EnsureOpen()) return false;
            const LONG next = (InterlockedCompareExchange(&header->activeBuffer, 0, 0) ^ 1) & 1;

            // Camera applications commonly mirror only their local preview.
            // Publish the program frame unchanged so remote participants see
            // presentations and text in their original orientation.
            // The inactive buffer can be filled while sequence remains even:
            // readers still consume the other buffer. The odd commit section
            // below therefore contains only the atomic buffer swap/metadata.
            CopyMemory(
                pdm::virtual_camera::BufferAt(header, next),
                frame, pdm::virtual_camera::kFrameBytes);
            MemoryBarrier();
            InterlockedIncrement(&header->sequence);
            InterlockedExchange(&header->activeBuffer, next);
            InterlockedExchange(&header->writerPid, static_cast<LONG>(GetCurrentProcessId()));
            InterlockedExchange64(&header->lastWriteTick, static_cast<LONGLONG>(GetTickCount64()));
            MemoryBarrier();
            InterlockedIncrement(&header->sequence);
            return true;
        }
    };

    bool ReadExact(HANDLE input, std::uint8_t* destination, DWORD bytes)
    {
        DWORD offset = 0;
        while (offset < bytes)
        {
            DWORD read = 0;
            if (!ReadFile(input, destination + offset, bytes - offset, &read, nullptr) || read == 0) return false;
            offset += read;
        }
        return true;
    }

    struct DisplayCapture
    {
        HDC memoryDc = nullptr;
        HBITMAP bitmap = nullptr;
        HGDIOBJ previous = nullptr;
        std::uint8_t* pixels = nullptr;
        ComPtr<ID3D11Device> device;
        ComPtr<ID3D11DeviceContext> context;
        ComPtr<IDXGIOutputDuplication> duplication;
        ComPtr<ID3D11Texture2D> stagingTexture;
        DXGI_OUTPUT_DESC outputDescription{};
        std::vector<std::uint8_t> sourcePixels;
        UINT stagingWidth = 0;
        UINT stagingHeight = 0;
        bool hasFrame = false;

        ~DisplayCapture()
        {
            if (memoryDc && previous) SelectObject(memoryDc, previous);
            if (bitmap) DeleteObject(bitmap);
            if (memoryDc) DeleteDC(memoryDc);
        }

        bool InitializeOutputBitmap()
        {
            memoryDc = CreateCompatibleDC(nullptr);
            BITMAPINFO info{};
            info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
            info.bmiHeader.biWidth = pdm::virtual_camera::kWidth;
            info.bmiHeader.biHeight = -static_cast<LONG>(pdm::virtual_camera::kHeight);
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB;
            bitmap = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS, reinterpret_cast<void**>(&pixels), nullptr, 0);
            if (!memoryDc || !bitmap || !pixels) return false;
            previous = SelectObject(memoryDc, bitmap);
            SetStretchBltMode(memoryDc, HALFTONE);
            SetBrushOrgEx(memoryDc, 0, 0, nullptr);
            return true;
        }

        bool InitializeDuplication(int x, int y, int width, int height)
        {
            stagingTexture.Reset();
            duplication.Reset();
            context.Reset();
            device.Reset();
            stagingWidth = 0;
            stagingHeight = 0;

            ComPtr<IDXGIFactory1> factory;
            if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return false;
            for (UINT adapterIndex = 0;; ++adapterIndex)
            {
                ComPtr<IDXGIAdapter1> adapter;
                if (factory->EnumAdapters1(adapterIndex, &adapter) == DXGI_ERROR_NOT_FOUND) break;
                for (UINT outputIndex = 0;; ++outputIndex)
                {
                    ComPtr<IDXGIOutput> output;
                    if (adapter->EnumOutputs(outputIndex, &output) == DXGI_ERROR_NOT_FOUND) break;
                    DXGI_OUTPUT_DESC description{};
                    if (FAILED(output->GetDesc(&description))) continue;
                    const RECT& bounds = description.DesktopCoordinates;
                    if (x < bounds.left || y < bounds.top || x + width > bounds.right || y + height > bounds.bottom) continue;

                    D3D_FEATURE_LEVEL featureLevel{};
                    if (FAILED(D3D11CreateDevice(
                        adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                        D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
                        &device, &featureLevel, &context))) return false;
                    ComPtr<IDXGIOutput1> output1;
                    if (FAILED(output.As(&output1))) return false;
                    if (FAILED(output1->DuplicateOutput(device.Get(), &duplication))) return false;
                    outputDescription = description;
                    sourcePixels.resize(static_cast<std::size_t>(width) * height * 4);
                    return true;
                }
            }
            return false;
        }

        bool Initialize(int x, int y, int width, int height)
        {
            return InitializeOutputBitmap() && InitializeDuplication(x, y, width, height);
        }

        bool EnsureStagingTexture(ID3D11Texture2D* source)
        {
            D3D11_TEXTURE2D_DESC description{};
            source->GetDesc(&description);
            if (stagingTexture && stagingWidth == description.Width && stagingHeight == description.Height) return true;
            description.BindFlags = 0;
            description.MiscFlags = 0;
            description.Usage = D3D11_USAGE_STAGING;
            description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            stagingTexture.Reset();
            if (FAILED(device->CreateTexture2D(&description, nullptr, &stagingTexture))) return false;
            stagingWidth = description.Width;
            stagingHeight = description.Height;
            return true;
        }

        bool DrawCapturedPixels(int width, int height)
        {
            if (width <= 0 || height <= 0) return false;
            if (width == static_cast<int>(pdm::virtual_camera::kWidth) &&
                height == static_cast<int>(pdm::virtual_camera::kHeight))
            {
                CopyMemory(pixels, sourcePixels.data(), pdm::virtual_camera::kFrameBytes);
                return true;
            }
            PatBlt(memoryDc, 0, 0, pdm::virtual_camera::kWidth, pdm::virtual_camera::kHeight, BLACKNESS);
            const double scale = std::min(
                static_cast<double>(pdm::virtual_camera::kWidth) / width,
                static_cast<double>(pdm::virtual_camera::kHeight) / height);
            const int targetWidth = std::max(1, static_cast<int>(width * scale + 0.5));
            const int targetHeight = std::max(1, static_cast<int>(height * scale + 0.5));
            const int left = (static_cast<int>(pdm::virtual_camera::kWidth) - targetWidth) / 2;
            const int top = (static_cast<int>(pdm::virtual_camera::kHeight) - targetHeight) / 2;
            BITMAPINFO sourceInfo{};
            sourceInfo.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
            sourceInfo.bmiHeader.biWidth = width;
            sourceInfo.bmiHeader.biHeight = -height;
            sourceInfo.bmiHeader.biPlanes = 1;
            sourceInfo.bmiHeader.biBitCount = 32;
            sourceInfo.bmiHeader.biCompression = BI_RGB;
            return StretchDIBits(memoryDc, left, top, targetWidth, targetHeight,
                0, 0, width, height, sourcePixels.data(), &sourceInfo,
                DIB_RGB_COLORS, SRCCOPY) != GDI_ERROR;
        }

        bool Capture(int x, int y, int width, int height)
        {
            if (!duplication || !context || width <= 0 || height <= 0) return false;
            DXGI_OUTDUPL_FRAME_INFO frameInfo{};
            ComPtr<IDXGIResource> resource;
            HRESULT result = duplication->AcquireNextFrame(16, &frameInfo, &resource);
            if (result == DXGI_ERROR_WAIT_TIMEOUT) return hasFrame;
            if (result == DXGI_ERROR_ACCESS_LOST)
            {
                hasFrame = false;
                InitializeDuplication(x, y, width, height);
                return false;
            }
            if (FAILED(result)) return false;

            bool captured = false;
            ComPtr<ID3D11Texture2D> texture;
            if (SUCCEEDED(resource.As(&texture)) && EnsureStagingTexture(texture.Get()))
            {
                context->CopyResource(stagingTexture.Get(), texture.Get());
                D3D11_MAPPED_SUBRESOURCE mapped{};
                if (SUCCEEDED(context->Map(stagingTexture.Get(), 0, D3D11_MAP_READ, 0, &mapped)))
                {
                    const int sourceX = x - outputDescription.DesktopCoordinates.left;
                    const int sourceY = y - outputDescription.DesktopCoordinates.top;
                    if (sourceX >= 0 && sourceY >= 0 && sourceX + width <= static_cast<int>(stagingWidth) &&
                        sourceY + height <= static_cast<int>(stagingHeight))
                    {
                        const auto* mappedBytes = static_cast<const std::uint8_t*>(mapped.pData);
                        const std::size_t rowBytes = static_cast<std::size_t>(width) * 4;
                        for (int row = 0; row < height; ++row)
                        {
                            CopyMemory(
                                sourcePixels.data() + (static_cast<std::size_t>(row) * rowBytes),
                                mappedBytes + (static_cast<std::size_t>(sourceY + row) * mapped.RowPitch) +
                                    (static_cast<std::size_t>(sourceX) * 4),
                                rowBytes);
                        }
                        captured = DrawCapturedPixels(width, height);
                    }
                    context->Unmap(stagingTexture.Get(), 0);
                }
            }
            duplication->ReleaseFrame();
            hasFrame = captured;
            return captured;
        }
    };

    int ArgInt(int argc, wchar_t** argv, const wchar_t* name, int fallback)
    {
        for (int index = 1; index + 1 < argc; ++index) if (_wcsicmp(argv[index], name) == 0) return _wtoi(argv[index + 1]);
        return fallback;
    }

    bool HasArg(int argc, wchar_t** argv, const wchar_t* name)
    {
        for (int index = 1; index < argc; ++index) if (_wcsicmp(argv[index], name) == 0) return true;
        return false;
    }

    int RunCamera(int argc, wchar_t** argv)
    {
        if (!SourceRegistered()) { PrintStatus("error", "Компонент виртуальной камеры не установлен."); return 21; }
        HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        const bool uninitialize = SUCCEEDED(result);
        if (FAILED(result) && result != RPC_E_CHANGED_MODE) { PrintStatus("error", Utf8(ErrorMessage(result))); return 22; }
        result = MFStartup(MF_VERSION);
        if (FAILED(result)) { if (uninitialize) CoUninitialize(); PrintStatus("error", Utf8(ErrorMessage(result))); return 23; }

        ComPtr<IMFVirtualCamera> camera;
        PrintStatus("starting", "create");
        result = MFCreateVirtualCamera(MFVirtualCameraType_SoftwareCameraSource,
            MFVirtualCameraLifetime_Session, MFVirtualCameraAccess_CurrentUser,
            kFriendlyName, kSourceClsid, nullptr, 0, &camera);
        if (SUCCEEDED(result)) {
            PrintStatus("starting", "register");
            result = camera->Start(nullptr);
        }
        if (FAILED(result))
        {
            if (result == E_ACCESSDENIED)
            {
                PrintStatus("error", "Windows запретила доступ к камере. Откройте Параметры → Конфиденциальность и безопасность → Камера и разрешите доступ классическим приложениям.");
            }
            else
            {
                PrintStatus("error", Utf8(ErrorMessage(result)));
            }
            if (camera)
            {
                camera->Remove();
                camera.Reset();
            }
            MFShutdown();
            if (uninitialize) CoUninitialize();
            return 24;
        }

        const bool displayMode = HasArg(argc, argv, L"--display");
        std::atomic_bool stop{ false };
        MappingWriter writer;
        std::thread captureThread;
        std::unique_ptr<DisplayCapture> displayCapture;
        if (displayMode)
        {
            const int x = ArgInt(argc, argv, L"--x", 0);
            const int y = ArgInt(argc, argv, L"--y", 0);
            const int width = ArgInt(argc, argv, L"--width", 1920);
            const int height = ArgInt(argc, argv, L"--height", 1080);
            displayCapture = std::make_unique<DisplayCapture>();
            if (!displayCapture->Initialize(x, y, width, height))
            {
                PrintStatus("error", "Не удалось подготовить захват эфирного экрана.");
                camera->Stop();
                camera->Shutdown();
                camera.Reset();
                MFShutdown();
                if (uninitialize) CoUninitialize();
                return 25;
            }
            captureThread = std::thread([&, x, y, width, height] {
                const auto frameInterval = std::chrono::milliseconds(33);
                while (!stop.load())
                {
                    const auto started = std::chrono::steady_clock::now();
                    if (displayCapture->Capture(x, y, width, height)) writer.Write(displayCapture->pixels);
                    std::this_thread::sleep_until(started + frameInterval);
                }
            });
        }

        PrintStatus("running", displayMode ? "display" : "internal");
        HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
        if (displayMode)
        {
            std::uint8_t byte = 0;
            DWORD read = 0;
            while (ReadFile(input, &byte, 1, &read, nullptr) && read > 0) {}
        }
        else
        {
            std::vector<std::uint8_t> frame(pdm::virtual_camera::kFrameBytes);
            while (ReadExact(input, frame.data(), pdm::virtual_camera::kFrameBytes)) writer.Write(frame.data());
        }

        stop.store(true);
        if (captureThread.joinable()) captureThread.join();
        camera->Stop();
        camera->Shutdown();
        camera.Reset();
        MFShutdown();
        if (uninitialize) CoUninitialize();
        return 0;
    }
}

int wmain(int argc, wchar_t** argv)
{
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if (HasArg(argc, argv, L"--source-registered"))
    {
        std::wstring path;
        const bool registered = SourceRegistered(&path);
        std::cout << "{\"registered\":" << (registered ? "true" : "false") << ",\"path\":\""
            << JsonEscape(Utf8(path)) << "\"}" << std::endl;
        return registered ? 0 : 1;
    }
    if (HasArg(argc, argv, L"--install-source")) return argc >= 3 ? InstallSource(argv[2]) : ERROR_INVALID_PARAMETER;
    if (HasArg(argc, argv, L"--uninstall-source")) return UninstallSource();
    if (HasArg(argc, argv, L"--elevate-install")) return argc >= 3 ? Elevate(L"--install-source", argv[2]) : ERROR_INVALID_PARAMETER;
    if (HasArg(argc, argv, L"--elevate-uninstall")) return Elevate(L"--uninstall-source");
    if (HasArg(argc, argv, L"--test-source")) return argc >= 3 ? TestMediaSource(argv[2]) : ERROR_INVALID_PARAMETER;
    if (HasArg(argc, argv, L"--self-test"))
    {
        const double wideScale = std::min(1920.0 / 1024.0, 1080.0 / 768.0);
        const bool geometryOk = static_cast<int>(1024 * wideScale + 0.5) == 1440 && static_cast<int>(768 * wideScale + 0.5) == 1080;
        const bool ok = geometryOk;
        std::cout << "{\"ok\":" << (ok ? "true" : "false") << ",\"width\":1920,\"height\":1080,\"fps\":30}" << std::endl;
        return ok ? 0 : 2;
    }
    return RunCamera(argc, argv);
}
