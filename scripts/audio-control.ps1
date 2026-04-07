param(
    [ValidateSet('list', 'set', 'get-default')]
    [string]$Action = 'list',
    [string]$DeviceId = ''
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace AudioControl {
    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        int GetState(out int pdwState);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceCollection {
        int GetCount(out int pcDevices);
        int Item(int nDevice, out IMMDevice ppDevice);
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection ppDevices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
    }

    [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        int GetCount(out int cProps);
        int GetAt(int iProp, out PropertyKey pkey);
        int GetValue(ref PropertyKey key, out PropVariant pv);
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey {
        public Guid fmtid;
        public int pid;
        public PropertyKey(Guid fmtid, int pid) { this.fmtid = fmtid; this.pid = pid; }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PropVariant {
        public short vt;
        public short wReserved1, wReserved2, wReserved3;
        public IntPtr val1;
        public IntPtr val2;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumerator { }

    [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
    public class PolicyConfigClient { }

    [Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPolicyConfig {
        [PreserveSig] int GetMixFormat(string pszDeviceName, IntPtr ppFormat);
        [PreserveSig] int GetDeviceFormat(string pszDeviceName, int bDefault, IntPtr ppFormat);
        [PreserveSig] int ResetDeviceFormat(string pszDeviceName);
        [PreserveSig] int SetDeviceFormat(string pszDeviceName, IntPtr pEndpointFormat, IntPtr mixFormat);
        [PreserveSig] int GetProcessingPeriod(string pszDeviceName, int bDefault, IntPtr pmftDefaultPeriod, IntPtr pmftMinimumPeriod);
        [PreserveSig] int SetProcessingPeriod(string pszDeviceName, IntPtr pmftPeriod);
        [PreserveSig] int GetShareMode(string pszDeviceName, IntPtr pMode);
        [PreserveSig] int SetShareMode(string pszDeviceName, IntPtr mode);
        [PreserveSig] int GetPropertyValue(string pszDeviceName, IntPtr key, IntPtr pv);
        [PreserveSig] int SetPropertyValue(string pszDeviceName, IntPtr key, IntPtr pv);
        [PreserveSig] int SetDefaultEndpoint(string pszDeviceName, int role);
        [PreserveSig] int SetEndpointVisibility(string pszDeviceName, int bVisible);
    }

    public class AudioManager {
        static readonly Guid PKEY_fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");

        private static IMMDeviceEnumerator GetEnumerator() {
            return (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        }

        public static string GetDeviceName(IMMDevice device) {
            IPropertyStore store;
            device.OpenPropertyStore(0, out store);
            var key = new PropertyKey(PKEY_fmtid, 14);
            PropVariant value;
            store.GetValue(ref key, out value);
            return Marshal.PtrToStringUni(value.val1) ?? "Unknown";
        }

        public static string ListDevices() {
            var enumerator = GetEnumerator();
            IMMDevice defaultDev;
            enumerator.GetDefaultAudioEndpoint(0, 0, out defaultDev);
            string defaultId = null;
            if (defaultDev != null) defaultDev.GetId(out defaultId);

            IMMDeviceCollection collection;
            enumerator.EnumAudioEndpoints(0, 1, out collection);
            int count;
            collection.GetCount(out count);

            var sb = new System.Text.StringBuilder("[");
            for (int i = 0; i < count; i++) {
                IMMDevice device;
                collection.Item(i, out device);
                string id;
                device.GetId(out id);
                string name = GetDeviceName(device);
                bool isDefault = (id == defaultId);
                if (i > 0) sb.Append(",");
                sb.AppendFormat("{{\"id\":\"{0}\",\"name\":\"{1}\",\"isDefault\":{2}}}",
                    id.Replace("\\", "\\\\").Replace("\"", "\\\""),
                    name.Replace("\\", "\\\\").Replace("\"", "\\\""),
                    isDefault ? "true" : "false");
            }
            sb.Append("]");
            return sb.ToString();
        }

        public static string GetDefault() {
            var enumerator = GetEnumerator();
            IMMDevice defaultDev;
            enumerator.GetDefaultAudioEndpoint(0, 0, out defaultDev);
            string id;
            defaultDev.GetId(out id);
            string name = GetDeviceName(defaultDev);
            return string.Format("{{\"id\":\"{0}\",\"name\":\"{1}\"}}",
                id.Replace("\\", "\\\\").Replace("\"", "\\\""),
                name.Replace("\\", "\\\\").Replace("\"", "\\\""));
        }

        public static void SetDefaultDevice(string deviceId) {
            var config = (IPolicyConfig)(new PolicyConfigClient());
            config.SetDefaultEndpoint(deviceId, 0);
            config.SetDefaultEndpoint(deviceId, 1);
        }
    }
}
'@

if ($Action -eq 'list') {
    [AudioControl.AudioManager]::ListDevices()
}
elseif ($Action -eq 'get-default') {
    [AudioControl.AudioManager]::GetDefault()
}
elseif ($Action -eq 'set') {
    if ($DeviceId -eq '') {
        Write-Error "DeviceId required"
        exit 1
    }
    [AudioControl.AudioManager]::SetDefaultDevice($DeviceId)
    Write-Output '{"Status":"ok"}'
}
