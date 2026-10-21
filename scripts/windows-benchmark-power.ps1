param([switch]$Hold)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TerrainBenchmarkPower {
  [StructLayout(LayoutKind.Sequential)]
  public struct Status {
    public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
    public int BatteryLifeTime, BatteryFullLifeTime;
  }
  [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out Status value);
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
}
'@
$benchmarkPowerStatus = New-Object TerrainBenchmarkPower+Status
if (-not [TerrainBenchmarkPower]::GetSystemPowerStatus([ref]$benchmarkPowerStatus)) { throw 'Cannot read system power status.' }
$benchmarkHeld = $false
try {
  if ($Hold) {
    $benchmarkHeld = [TerrainBenchmarkPower]::SetThreadExecutionState([uint32]2147483651) -ne 0
    if (-not $benchmarkHeld) { throw 'Cannot request benchmark keep-awake state.' }
  }
  @{ ac = [int]$benchmarkPowerStatus.ACLineStatus; batteryPercent = [int]$benchmarkPowerStatus.BatteryLifePercent; keepAwake = $benchmarkHeld } | ConvertTo-Json -Compress
  if ($Hold) { [Console]::ReadLine() | Out-Null }
} finally {
  if ($benchmarkHeld) { [TerrainBenchmarkPower]::SetThreadExecutionState([uint32]2147483648) | Out-Null }
}
