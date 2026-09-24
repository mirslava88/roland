#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <aclapi.h>
#include <sddl.h>
#include <bcrypt.h>
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
#include <cstring>
#include <memory>
#include <mutex>

#include "../source/PdmSharedFrame.h"

#pragma comment(lib, "mfplat")
#pragma comment(lib, "mfsensorgroup")
#pragma comment(lib, "advapi32")
#pragma comment(lib, "bcrypt")
#pragma comment(lib, "shell32")
#pragma comment(lib, "d3d11")
#pragma comment(lib, "dxgi")

using Microsoft::WRL::ComPtr;

namespace
{
    constexpr wchar_t kSourceClsid[] = L"{BBEF2CB0-96F5-4C1E-86F6-6B7670CAB609}";
    constexpr wchar_t kFriendlyName[] = L"PDM Virtual Camera";
    constexpr wchar_t kRegistryPath[] = L"SOFTWARE\\Classes\\CLSID\\{BBEF2CB0-96F5-4C1E-86F6-6B7670CAB609}\\InProcServer32";
    constexpr wchar_t kOwnersRegistryPath[] = L"SOFTWARE\\Presentation Display Manager\\VirtualCamera\\Owners";
    constexpr wchar_t kStandardOwner[] = L"com.roland.presentation-display-manager";
    constexpr wchar_t kStreamOwner[] = L"com.roland.presentation-display-manager.stream";
    constexpr char kPipeControlMagic[] = "PDMVCR01";
    constexpr std::uint32_t kPipeCommandUseDisplay = 1;

    std::int32_t ReadPipeInt32(const std::uint8_t* packet, std::size_t offset)
    {
        std::int32_t value = 0;
        CopyMemory(&value, packet + offset, sizeof(value));
        return value;
    }

    bool IsPipeControlPacket(const std::vector<std::uint8_t>& packet)
    {
        return packet.size() >= 28 &&
            memcmp(packet.data(), kPipeControlMagic, sizeof(kPipeControlMagic) - 1) == 0;
    }

    std::wstring InstalledSourceDirectory()
    {
        PWSTR programData = nullptr;
        if (FAILED(SHGetKnownFolderPath(FOLDERID_ProgramData, KF_FLAG_DEFAULT, nullptr, &programData))) return {};
        std::wstring directory = std::wstring(programData) + L"\\Presentation Display Manager\\VirtualCamera";
        CoTaskMemFree(programData);
        return directory;
    }

    std::wstring LegacyInstalledSourcePath()
    {
        const auto directory = InstalledSourceDirectory();
        return directory.empty() ? std::wstring{} : directory + L"\\PDMVirtualCameraSource.dll";
    }

    DWORD SourceFingerprint(const std::wstring& path, std::wstring& fingerprint)
    {
        HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file == INVALID_HANDLE_VALUE) return GetLastError();
        LARGE_INTEGER size{};
        if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart > 64 * 1024 * 1024)
        {
            CloseHandle(file);
            return ERROR_FILE_TOO_LARGE;
        }
        std::vector<UCHAR> bytes(static_cast<std::size_t>(size.QuadPart));
        DWORD read = 0;
        const BOOL readOk = ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr);
        const DWORD readError = readOk ? ERROR_SUCCESS : GetLastError();
        CloseHandle(file);
        if (readError != ERROR_SUCCESS) return readError;
        if (read != bytes.size()) return ERROR_HANDLE_EOF;
        BCRYPT_ALG_HANDLE algorithm = nullptr;
        if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0)
            return ERROR_GEN_FAILURE;
        UCHAR digest[32]{};
        const NTSTATUS hashResult = BCryptHash(algorithm, nullptr, 0, bytes.data(),
            static_cast<ULONG>(bytes.size()), digest, sizeof(digest));
        BCryptCloseAlgorithmProvider(algorithm, 0);
        if (hashResult < 0) return ERROR_GEN_FAILURE;
        wchar_t hex[3]{};
        fingerprint.clear();
        for (const UCHAR value : digest)
        {
            swprintf_s(hex, L"%02x", value);
            fingerprint += hex;
        }
        return ERROR_SUCCESS;
    }

    DWORD StageSource(const std::wstring& source, const std::wstring& directory, std::wstring& installedPath)
    {
        std::wstring fingerprint;
        const DWORD hashResult = SourceFingerprint(source, fingerprint);
        if (hashResult != ERROR_SUCCESS) return hashResult;
        installedPath = directory + L"\\PDMVirtualCameraSource-" + fingerprint + L".dll";
        if (_wcsicmp(source.c_str(), installedPath.c_str()) == 0) return ERROR_SUCCESS;
        if (CopyFileW(source.c_str(), installedPath.c_str(), TRUE)) return ERROR_SUCCESS;
        const DWORD copyError = GetLastError();
        if (copyError != ERROR_FILE_EXISTS && copyError != ERROR_ALREADY_EXISTS) return copyError;
        std::wstring existingFingerprint;
        const DWORD existingResult = SourceFingerprint(installedPath, existingFingerprint);
        if (existingResult != ERROR_SUCCESS) return existingResult;
        return existingFingerprint == fingerprint ? ERROR_SUCCESS : ERROR_FILE_EXISTS;
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

    void PrintStatus(const char* phase, const std::string& message = {}, std::uint32_t requestId = 0)
    {
        static std::mutex statusMutex;
        std::lock_guard<std::mutex> lock(statusMutex);
        std::cout << "{\"phase\":\"" << phase << "\",\"message\":\"" << JsonEscape(message)
            << "\",\"requestId\":" << requestId << "}" << std::endl;
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

    bool ValidOwner(const std::wstring& owner)
    {
        return owner == kStandardOwner || owner == kStreamOwner;
    }

    LSTATUS RecordOwner(const std::wstring& owner)
    {
        HKEY key = nullptr;
        DWORD disposition = 0;
        LSTATUS status = RegCreateKeyExW(HKEY_LOCAL_MACHINE, kOwnersRegistryPath, 0, nullptr, 0,
            KEY_WRITE | KEY_WOW64_64KEY, nullptr, &key, &disposition);
        if (status != ERROR_SUCCESS) return status;
        const wchar_t present[] = L"1";
        status = RegSetValueExW(key, owner.c_str(), 0, REG_SZ,
            reinterpret_cast<const BYTE*>(present), sizeof(present));
        RegCloseKey(key);
        return status;
    }

    LSTATUS RemoveOwner(const std::wstring& owner, DWORD& remaining)
    {
        remaining = 0;
        HKEY key = nullptr;
        LSTATUS status = RegOpenKeyExW(HKEY_LOCAL_MACHINE, kOwnersRegistryPath, 0,
            KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_WOW64_64KEY, &key);
        if (status == ERROR_FILE_NOT_FOUND) return ERROR_SUCCESS;
        if (status != ERROR_SUCCESS) return status;
        status = RegDeleteValueW(key, owner.c_str());
        if (status == ERROR_FILE_NOT_FOUND) status = ERROR_SUCCESS;
        if (status == ERROR_SUCCESS) status = RegQueryInfoKeyW(key, nullptr, nullptr, nullptr,
            nullptr, nullptr, nullptr, &remaining, nullptr, nullptr, nullptr, nullptr);
        RegCloseKey(key);
        return status;
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

    int InstallSource(const std::wstring& dllPath, const std::wstring& owner)
    {
        if (!ValidOwner(owner)) return ERROR_INVALID_PARAMETER;
        wchar_t absolutePath[32768]{};
        const DWORD resolvedLength = GetFullPathNameW(dllPath.c_str(), static_cast<DWORD>(std::size(absolutePath)), absolutePath, nullptr);
        if (!resolvedLength || resolvedLength >= std::size(absolutePath)) return ERROR_INVALID_NAME;
        const DWORD attrs = GetFileAttributesW(absolutePath);
        if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_DIRECTORY)) return ERROR_FILE_NOT_FOUND;
        const auto installedDirectory = InstalledSourceDirectory();
        if (installedDirectory.empty()) return ERROR_PATH_NOT_FOUND;
        const int createResult = SHCreateDirectoryExW(nullptr, installedDirectory.c_str(), nullptr);
        if (createResult != ERROR_SUCCESS && createResult != ERROR_ALREADY_EXISTS) return createResult;
        const DWORD directoryAclResult = ApplySourceAcl(installedDirectory, true);
        if (directoryAclResult != ERROR_SUCCESS) return static_cast<int>(directoryAclResult);
        std::wstring installedPath;
        const DWORD stageResult = StageSource(absolutePath, installedDirectory, installedPath);
        if (stageResult != ERROR_SUCCESS) return static_cast<int>(stageResult);
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
        if (status == ERROR_SUCCESS) status = RecordOwner(owner);
        return status;
    }

    int UninstallSource(const std::wstring& owner)
    {
        if (!ValidOwner(owner)) return ERROR_INVALID_PARAMETER;
        DWORD remaining = 0;
        const LSTATUS ownerStatus = RemoveOwner(owner, remaining);
        if (ownerStatus != ERROR_SUCCESS) return ownerStatus;
        if (remaining > 0) return ERROR_SUCCESS;
        std::wstring registeredPath;
        SourceRegistered(&registeredPath);
        const LSTATUS status = RegDeleteTreeW(HKEY_LOCAL_MACHINE,
            L"SOFTWARE\\Classes\\CLSID\\{BBEF2CB0-96F5-4C1E-86F6-6B7670CAB609}");
        const auto installedDirectory = InstalledSourceDirectory();
        if (!registeredPath.empty() && !installedDirectory.empty() &&
            _wcsnicmp(registeredPath.c_str(), (installedDirectory + L"\\").c_str(), installedDirectory.size() + 1) == 0)
            DeleteFileW(registeredPath.c_str());
        const auto legacyPath = LegacyInstalledSourcePath();
        if (!legacyPath.empty()) DeleteFileW(legacyPath.c_str());
        if (!installedDirectory.empty()) RemoveDirectoryW(installedDirectory.c_str());
        return status == ERROR_FILE_NOT_FOUND ? ERROR_SUCCESS : status;
    }

    int TestStageSource(const std::wstring& dllPath, const std::wstring& directory)
    {
        // Reproduce the previous sharing violation: the legacy destination is
        // open without write/delete sharing while the replacement is staged.
        const std::wstring legacyPath = directory + L"\\PDMVirtualCameraSource.dll";
        HANDLE lockedLegacy = CreateFileW(legacyPath.c_str(), GENERIC_READ, FILE_SHARE_READ,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (lockedLegacy == INVALID_HANDLE_VALUE) return static_cast<int>(GetLastError());
        std::wstring stagedPath;
        const DWORD result = StageSource(dllPath, directory, stagedPath);
        CloseHandle(lockedLegacy);
        std::cout << "{\"ok\":" << (result == ERROR_SUCCESS ? "true" : "false")
            << ",\"path\":\"" << JsonEscape(Utf8(stagedPath)) << "\",\"code\":" << result << "}" << std::endl;
        return static_cast<int>(result);
    }

    int Elevate(const std::wstring& verb, const std::wstring& argument = {}, const std::wstring& owner = {})
    {
        wchar_t executable[MAX_PATH]{};
        if (!GetModuleFileNameW(nullptr, executable, MAX_PATH)) return static_cast<int>(GetLastError());
        const std::wstring parameters = verb + (argument.empty() ? L"" : L" \"" + argument + L"\"") +
            (owner.empty() ? L"" : L" \"" + owner + L"\"");
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
        HRESULT captureError = S_OK;
        ULONGLONG retryAfter = 0;
        ULONGLONG initializedAt = 0;
        std::uint64_t duplicationAttempts = 0;

        void InvalidateDuplication(HRESULT error)
        {
            stagingTexture.Reset();
            duplication.Reset();
            context.Reset();
            device.Reset();
            stagingWidth = 0;
            stagingHeight = 0;
            // An old frame cannot confirm a newly selected physical route.
            hasFrame = false;
            initializedAt = 0;
            captureError = error;
            retryAfter = GetTickCount64() + 500;
        }

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
            InvalidateDuplication(DXGI_ERROR_NOT_FOUND);
            ++duplicationAttempts;
            if (width <= 0 || height <= 0) { captureError = E_INVALIDARG; return false; }

            ComPtr<IDXGIFactory1> factory;
            captureError = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
            if (FAILED(captureError)) return false;
            for (UINT adapterIndex = 0;; ++adapterIndex)
            {
                ComPtr<IDXGIAdapter1> adapter;
                captureError = factory->EnumAdapters1(adapterIndex, &adapter);
                if (captureError == DXGI_ERROR_NOT_FOUND) break;
                if (FAILED(captureError)) return false;
                for (UINT outputIndex = 0;; ++outputIndex)
                {
                    ComPtr<IDXGIOutput> output;
                    captureError = adapter->EnumOutputs(outputIndex, &output);
                    if (captureError == DXGI_ERROR_NOT_FOUND) break;
                    if (FAILED(captureError)) return false;
                    DXGI_OUTPUT_DESC description{};
                    if (FAILED(output->GetDesc(&description))) continue;
                    if (!description.AttachedToDesktop) continue;
                    const RECT& bounds = description.DesktopCoordinates;
                    if (x < bounds.left || y < bounds.top || x + width > bounds.right || y + height > bounds.bottom) continue;

                    D3D_FEATURE_LEVEL featureLevel{};
                    captureError = D3D11CreateDevice(
                        adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                        D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
                        &device, &featureLevel, &context);
                    if (FAILED(captureError)) return false;
                    ComPtr<IDXGIOutput1> output1;
                    captureError = output.As(&output1);
                    if (FAILED(captureError)) return false;
                    captureError = output1->DuplicateOutput(device.Get(), &duplication);
                    if (FAILED(captureError)) return false;
                    outputDescription = description;
                    sourcePixels.resize(static_cast<std::size_t>(width) * height * 4);
                    initializedAt = GetTickCount64();
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
            captureError = device->CreateTexture2D(&description, nullptr, &stagingTexture);
            if (FAILED(captureError)) return false;
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
            if (width <= 0 || height <= 0) return false;
            // DWM may not be ready on the first retry after fullscreen/lock/
            // topology changes. A failed rebuild must not strand this camera
            // forever with a null duplication object and a 'running' status.
            if (!duplication || !context)
            {
                if (GetTickCount64() < retryAfter) return false;
                if (!InitializeDuplication(x, y, width, height)) return false;
            }
            DXGI_OUTDUPL_FRAME_INFO frameInfo{};
            ComPtr<IDXGIResource> resource;
            HRESULT result = duplication->AcquireNextFrame(16, &frameInfo, &resource);
            if (result == DXGI_ERROR_WAIT_TIMEOUT)
            {
                // An unchanged desktop is normal. Only a session which has
                // never yielded its first frame needs a bounded restart.
                if (!hasFrame && GetTickCount64() - initializedAt > 3000)
                    InvalidateDuplication(DXGI_ERROR_WAIT_TIMEOUT);
                return hasFrame;
            }
            if (FAILED(result))
            {
                InvalidateDuplication(result);
                return false;
            }

            bool captured = false;
            ComPtr<ID3D11Texture2D> texture;
            captureError = resource.As(&texture);
            if (SUCCEEDED(captureError) && EnsureStagingTexture(texture.Get()))
            {
                context->CopyResource(stagingTexture.Get(), texture.Get());
                D3D11_MAPPED_SUBRESOURCE mapped{};
                captureError = context->Map(stagingTexture.Get(), 0, D3D11_MAP_READ, 0, &mapped);
                if (SUCCEEDED(captureError))
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
            const HRESULT released = duplication->ReleaseFrame();
            if (!captured || FAILED(released))
            {
                InvalidateDuplication(FAILED(captureError) ? captureError : FAILED(released) ? released : E_FAIL);
                return false;
            }
            captureError = S_OK;
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

    // Read-only capture regression: does not create a virtual camera or write
    // its shared mapping. Faults exercise the actual DXGI recovery path.
    int TestDisplayRecovery(int argc, wchar_t** argv)
    {
        const int x = ArgInt(argc, argv, L"--x", 0);
        const int y = ArgInt(argc, argv, L"--y", 0);
        const int width = ArgInt(argc, argv, L"--width", 1920);
        const int height = ArgInt(argc, argv, L"--height", 1080);
        DisplayCapture capture;
        if (!capture.Initialize(x, y, width, height))
        {
            PrintStatus("error", Utf8(ErrorMessage(capture.captureError)));
            return 31;
        }
        const auto waitForFrame = [&]() {
            const auto deadline = GetTickCount64() + 6000;
            while (GetTickCount64() < deadline)
            {
                if (capture.Capture(x, y, width, height)) return true;
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
            }
            return false;
        };
        if (!waitForFrame()) return 32;
        for (const HRESULT fault : { DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_DEVICE_REMOVED, E_ACCESSDENIED })
        {
            capture.InvalidateDuplication(fault);
            if (capture.hasFrame) return 33;
            // First rebuild fails while the old target is temporarily absent.
            capture.retryAfter = 0;
            if (capture.Capture(x + 100000, y, width, height)) return 34;
            const auto attempts = capture.duplicationAttempts;
            for (int index = 0; index < 10; ++index)
                if (capture.Capture(x, y, width, height)) return 35;
            if (capture.duplicationAttempts != attempts) return 36; // bounded retry
            if (!waitForFrame()) return 37; // retry must survive the failed rebuild
            if (capture.duplicationAttempts <= attempts) return 38;
        }
        // An unchanged desktop must keep a valid cached frame rather than
        // interpreting every AcquireNextFrame timeout as a disconnected source.
        for (int index = 0; index < 5; ++index)
            if (!capture.Capture(x, y, width, height)) return 39;
        PrintStatus("test-pass", "DXGI first frame, access lost/device removed/access denied, failed rebuild, bounded retry and static frame");
        return 0;
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
        std::atomic_bool internalFramesActive{ !displayMode };
        std::atomic_bool physicalCaptureActive{ displayMode };
        std::atomic_bool physicalFramePending{ false };
        std::uint32_t sourceRequestId = static_cast<std::uint32_t>(ArgInt(argc, argv, L"--request-id", 0)); // protected by writerMutex
        MappingWriter writer;
        std::mutex writerMutex;
        std::thread captureThread;
        auto displayCapture = std::make_unique<DisplayCapture>();
        int captureX = ArgInt(argc, argv, L"--x", 0);
        int captureY = ArgInt(argc, argv, L"--y", 0);
        int captureWidth = ArgInt(argc, argv, L"--width", 1920);
        int captureHeight = ArgInt(argc, argv, L"--height", 1080);
        const bool captureInitialized = displayMode
            ? displayCapture->Initialize(captureX, captureY, captureWidth, captureHeight)
            : displayCapture->InitializeOutputBitmap();
        if (!captureInitialized)
        {
            PrintStatus("error", "Не удалось подготовить захват эфирного экрана.");
            camera->Stop();
            camera->Shutdown();
            camera.Reset();
            MFShutdown();
            if (uninitialize) CoUninitialize();
            return 25;
        }
        captureThread = std::thread([&] {
            const auto frameInterval = std::chrono::milliseconds(33);
            bool recovering = false;
            ULONGLONG lastRecoveryNotice = 0;
            while (!stop.load())
            {
                const auto started = std::chrono::steady_clock::now();
                if (physicalCaptureActive.load() && !internalFramesActive.load())
                {
                    std::lock_guard<std::mutex> lock(writerMutex);
                    if (physicalCaptureActive.load() && !internalFramesActive.load())
                    {
                        if (displayCapture->Capture(captureX, captureY, captureWidth, captureHeight))
                        {
                            writer.Write(displayCapture->pixels);
                            if (recovering) PrintStatus("capture-recovered", "display", sourceRequestId);
                            recovering = false;
                            if (physicalFramePending.exchange(false)) PrintStatus("source", "display", sourceRequestId);
                        }
                        else if (FAILED(displayCapture->captureError) &&
                            (!recovering || GetTickCount64() - lastRecoveryNotice >= 5000))
                        {
                            recovering = true;
                            lastRecoveryNotice = GetTickCount64();
                            PrintStatus("capture-retrying", Utf8(ErrorMessage(displayCapture->captureError)), sourceRequestId);
                        }
                    }
                }
                std::this_thread::sleep_until(started + frameInterval);
            }
        });

        PrintStatus("running", displayMode ? "display" : "internal");
        HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
        // Every pipe message has exactly one video-frame worth of bytes. A
        // tiny magic header marks route-control messages; ordinary BGRA frames
        // remain backwards-compatible with the existing high-throughput path.
        // This lets a running camera return from the internal fallback to the
        // reconnected physical Program display without removing the device
        // from conferencing applications.
        std::vector<std::uint8_t> frame(pdm::virtual_camera::kFrameBytes);
        while (ReadExact(input, frame.data(), pdm::virtual_camera::kFrameBytes))
        {
            if (IsPipeControlPacket(frame))
            {
                std::uint32_t command = 0;
                CopyMemory(&command, frame.data() + 8, sizeof(command));
                if (command != kPipeCommandUseDisplay) continue;
                const int nextX = ReadPipeInt32(frame.data(), 12);
                const int nextY = ReadPipeInt32(frame.data(), 16);
                const int nextWidth = ReadPipeInt32(frame.data(), 20);
                const int nextHeight = ReadPipeInt32(frame.data(), 24);
                std::lock_guard<std::mutex> lock(writerMutex);
                CopyMemory(&sourceRequestId, frame.data() + 28, sizeof(sourceRequestId));
                const bool ready = nextWidth > 0 && nextHeight > 0 &&
                    displayCapture->InitializeDuplication(nextX, nextY, nextWidth, nextHeight);
                if (ready)
                {
                    captureX = nextX;
                    captureY = nextY;
                    captureWidth = nextWidth;
                    captureHeight = nextHeight;
                    physicalCaptureActive.store(true);
                    internalFramesActive.store(false);
                    physicalFramePending.store(true);
                }
                else
                {
                    PrintStatus("source-error", "Не удалось вернуться к захвату эфирного экрана.", sourceRequestId);
                }
                continue;
            }
            internalFramesActive.store(true);
            std::lock_guard<std::mutex> lock(writerMutex);
            writer.Write(frame.data());
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
    if (HasArg(argc, argv, L"--install-source")) return argc >= 4 ? InstallSource(argv[2], argv[3]) : ERROR_INVALID_PARAMETER;
    if (HasArg(argc, argv, L"--uninstall-source")) return argc >= 3 ? UninstallSource(argv[2]) : ERROR_INVALID_PARAMETER;
    if (HasArg(argc, argv, L"--elevate-install")) return argc >= 4 ? Elevate(L"--install-source", argv[2], argv[3]) : ERROR_INVALID_PARAMETER;
    if (HasArg(argc, argv, L"--elevate-uninstall")) return argc >= 3 ? Elevate(L"--uninstall-source", argv[2]) : ERROR_INVALID_PARAMETER;
    if (HasArg(argc, argv, L"--test-source")) return argc >= 3 ? TestMediaSource(argv[2]) : ERROR_INVALID_PARAMETER;
    if (HasArg(argc, argv, L"--test-stage-source")) return argc >= 4 ? TestStageSource(argv[2], argv[3]) : ERROR_INVALID_PARAMETER;
    if (HasArg(argc, argv, L"--test-display-recovery")) return TestDisplayRecovery(argc, argv);
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
