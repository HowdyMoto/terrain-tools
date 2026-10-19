# Read-only DXGI enumeration for a temporary Chrome test profile. Re-enumerate
# after every reboot; adapter LUIDs are not stable persistent identifiers.
# https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgifactory-enumadapters
# https://learn.microsoft.com/en-us/windows/win32/api/dxgi/ns-dxgi-dxgi_adapter_desc
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WaterAdapters {
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory(ref Guid id, out IntPtr factory);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAdapter(IntPtr self, uint index, out IntPtr adapter);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetDescription(IntPtr self, out Description desc);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Description {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Name;
    public uint Vendor,Device,Subsystem,Revision;
    public UIntPtr DedicatedVideo, DedicatedSystem, SharedSystem;
    public uint Low; public int High;
  }
  public static Description[] Read() {
    var result = new List<Description>();
    Guid id = new Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369");
    IntPtr factory;
    Marshal.ThrowExceptionForHR(CreateDXGIFactory(ref id,out factory));
    try {
      var enumerate=Marshal.GetDelegateForFunctionPointer<EnumAdapter>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(factory),7*IntPtr.Size));
      for(uint i=0;i<32;i++) {
        IntPtr adapter;
        int hr=enumerate(factory,i,out adapter);
        if (hr==unchecked((int)0x887a0002)) break;
        Marshal.ThrowExceptionForHR(hr);
        try {
          var describe=Marshal.GetDelegateForFunctionPointer<GetDescription>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(adapter),8*IntPtr.Size));
          Description desc; Marshal.ThrowExceptionForHR(describe(adapter,out desc));result.Add(desc);
        } finally {Marshal.Release(adapter);}
      }
    } finally {Marshal.Release(factory);}
    return result.ToArray();
  }
}
'@
[WaterAdapters]::Read() | Select-Object Name,Vendor,Device,Low,High | ConvertTo-Json
