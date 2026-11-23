using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace CwbWinHelper {
  public sealed class DebugPortArguments {
    public int[] Ports { get; set; }
    public bool Invalid { get; set; }
    public bool ProfileMatches { get; set; }
  }

  public static class DebugPortParser {
    private static bool IsAbsolutePath(string value) {
      return !String.IsNullOrEmpty(value) &&
        ((value.Length >= 3 && Char.IsLetter(value[0]) && value[1] == ':' &&
          (value[2] == '\\' || value[2] == '/')) || value.StartsWith(@"\\", StringComparison.Ordinal));
    }

    [DllImport("shell32.dll", SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(
      [MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int count);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static DebugPortArguments Parse(string commandLine, string expectedProfile) {
      var ports = new List<int>();
      int profileCount = 0;
      bool profileMatches = false;
      bool invalid = String.IsNullOrWhiteSpace(commandLine);
      if (invalid) return new DebugPortArguments { Ports = ports.ToArray(), Invalid = true, ProfileMatches = false };
      int count;
      IntPtr memory = CommandLineToArgvW(commandLine, out count);
      if (memory == IntPtr.Zero) throw new InvalidOperationException("Cannot parse process arguments");
      try {
        for (int index = 1; index < count; index++) {
          string argument = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, index * IntPtr.Size));
          if (argument == "--") break;
          string value;
          if (argument.StartsWith("--remote-debugging-port=", StringComparison.Ordinal)) {
            value = argument.Substring("--remote-debugging-port=".Length);
          } else if (argument == "--remote-debugging-port") {
            if (++index >= count) { invalid = true; break; }
            value = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, index * IntPtr.Size));
          } else if (!String.IsNullOrEmpty(expectedProfile) &&
            (argument.StartsWith("--user-data-dir=", StringComparison.Ordinal) || argument == "--user-data-dir")) {
            profileCount++;
            if (argument == "--user-data-dir") {
              if (++index >= count) { profileMatches = false; break; }
              value = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, index * IntPtr.Size));
            } else {
              value = argument.Substring("--user-data-dir=".Length);
            }
            try {
              profileMatches = IsAbsolutePath(value) && String.Equals(
                Path.GetFullPath(value).TrimEnd('\\', '/'),
                Path.GetFullPath(expectedProfile).TrimEnd('\\', '/'),
                StringComparison.OrdinalIgnoreCase);
            } catch {
              profileMatches = false;
            }
            continue;
          } else {
            continue;
          }
          int port;
          if (Int32.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out port)) {
            ports.Add(port);
          } else {
            invalid = true;
          }
        }
      } finally {
        LocalFree(memory);
      }
      return new DebugPortArguments {
        Ports = ports.ToArray(),
        Invalid = invalid,
        ProfileMatches = profileCount == 1 && profileMatches
      };
    }
  }

  public enum ActivateOptions {
    None = 0
  }

  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IApplicationActivationManager {
    int ActivateApplication(
      [In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      [In, MarshalAs(UnmanagedType.LPWStr)] string arguments,
      [In] ActivateOptions options,
      [Out] out uint processId
    );
  }

  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  public class ApplicationActivationManager { }

  internal static class TcpListeners {
    private const int AF_INET = 2;
    private const int AF_INET6 = 23;
    private const int TCP_TABLE_OWNER_PID_LISTENER = 3;
    private const uint NO_ERROR = 0;
    private const uint ERROR_INSUFFICIENT_BUFFER = 122;
    private const uint ERROR_NOT_SUPPORTED = 50;
    private const uint ERROR_NO_DATA = 232;
    private const uint MIB_TCP_STATE_LISTEN = 2;

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(
      IntPtr pTcpTable,
      ref int dwOutBufLen,
      bool sort,
      int ipVersion,
      int tblClass,
      uint reserved);

    [StructLayout(LayoutKind.Sequential)]
    private struct MibTcpRowOwnerPid {
      public uint dwState;
      public uint dwLocalAddr;
      public uint dwLocalPort;
      public uint dwRemoteAddr;
      public uint dwRemotePort;
      public uint dwOwningPid;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MibTcp6RowOwnerPid {
      [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
      public byte[] ucLocalAddr;
      public uint dwLocalScopeId;
      public uint dwLocalPort;
      [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
      public byte[] ucRemoteAddr;
      public uint dwRemoteScopeId;
      public uint dwRemotePort;
      public uint dwState;
      public uint dwOwningPid;
    }

    private static int DecodePort(uint rawPort) {
      return (int)(((rawPort & 0xFF) << 8) | ((rawPort >> 8) & 0xFF));
    }

    private static IntPtr FetchTable(int addressFamily, bool allowUnsupported, out int count) {
      count = 0;
      int bufferSize = 0;
      uint ret = GetExtendedTcpTable(IntPtr.Zero, ref bufferSize, false, addressFamily, TCP_TABLE_OWNER_PID_LISTENER, 0);
      if (allowUnsupported && (ret == ERROR_NOT_SUPPORTED || ret == ERROR_NO_DATA)) return IntPtr.Zero;
      if (ret != ERROR_INSUFFICIENT_BUFFER && ret != NO_ERROR) {
        throw new InvalidOperationException("GetExtendedTcpTable size query failed");
      }
      if (bufferSize < 4) return IntPtr.Zero;
      for (int attempt = 0; attempt < 4; attempt++) {
        IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
        bool keep = false;
        try {
          ret = GetExtendedTcpTable(buffer, ref bufferSize, false, addressFamily, TCP_TABLE_OWNER_PID_LISTENER, 0);
          if (ret == NO_ERROR) {
            count = Marshal.ReadInt32(buffer);
            keep = true;
            return buffer;
          }
          if (allowUnsupported && (ret == ERROR_NOT_SUPPORTED || ret == ERROR_NO_DATA)) return IntPtr.Zero;
          if (ret != ERROR_INSUFFICIENT_BUFFER) {
            throw new InvalidOperationException("GetExtendedTcpTable failed");
          }
        } finally {
          if (!keep) Marshal.FreeHGlobal(buffer);
        }
      }
      throw new InvalidOperationException("GetExtendedTcpTable buffer retry exhausted");
    }

    public static List<Dictionary<string, object>> FindByPort(int targetPort) {
      var results = new List<Dictionary<string, object>>();

      int v4Count;
      IntPtr v4Buffer = FetchTable(AF_INET, false, out v4Count);
      if (v4Buffer != IntPtr.Zero) {
        try {
          int rowSize = Marshal.SizeOf(typeof(MibTcpRowOwnerPid));
          long rowPtr = v4Buffer.ToInt64() + 4;
          for (int i = 0; i < v4Count; i++) {
            MibTcpRowOwnerPid row = (MibTcpRowOwnerPid)Marshal.PtrToStructure(new IntPtr(rowPtr + (long)i * rowSize), typeof(MibTcpRowOwnerPid));
            int port = DecodePort(row.dwLocalPort);
            if (port == targetPort && row.dwState == MIB_TCP_STATE_LISTEN) {
              var entry = new Dictionary<string, object>();
              entry["localAddress"] = new IPAddress((long)row.dwLocalAddr).ToString();
              entry["localPort"] = port;
              entry["owningProcess"] = (int)row.dwOwningPid;
              results.Add(entry);
            }
          }
        } finally {
          Marshal.FreeHGlobal(v4Buffer);
        }
      }

      int v6Count;
      IntPtr v6Buffer = FetchTable(AF_INET6, true, out v6Count);
      if (v6Buffer != IntPtr.Zero) {
        try {
          int rowSize = Marshal.SizeOf(typeof(MibTcp6RowOwnerPid));
          long rowPtr = v6Buffer.ToInt64() + 4;
          for (int i = 0; i < v6Count; i++) {
            MibTcp6RowOwnerPid row = (MibTcp6RowOwnerPid)Marshal.PtrToStructure(new IntPtr(rowPtr + (long)i * rowSize), typeof(MibTcp6RowOwnerPid));
            int port = DecodePort(row.dwLocalPort);
            if (port == targetPort && row.dwState == MIB_TCP_STATE_LISTEN) {
              var entry = new Dictionary<string, object>();
              entry["localAddress"] = new IPAddress(row.ucLocalAddr).ToString();
              entry["localPort"] = port;
              entry["owningProcess"] = (int)row.dwOwningPid;
              results.Add(entry);
            }
          }
        } finally {
          Marshal.FreeHGlobal(v6Buffer);
        }
      }

      return results;
    }
  }

  public static class Program {
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const int ProcessCommandLineInformation = 60;
    private const int STATUS_INFO_LENGTH_MISMATCH = unchecked((int)0xC0000004);
    private const int STATUS_BUFFER_TOO_SMALL = unchecked((int)0xC0000023);
    private const int STATUS_BUFFER_OVERFLOW = unchecked((int)0x80000005);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageName(IntPtr hProcess, int dwFlags, StringBuilder lpExeName, ref int lpdwSize);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
      IntPtr processHandle,
      int processInformationClass,
      IntPtr processInformation,
      int processInformationLength,
      out int returnLength);

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString {
      public ushort Length;
      public ushort MaximumLength;
      public IntPtr Buffer;
    }

    private static string TryGetProcessImagePath(int pid) {
      IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (handle == IntPtr.Zero) return null;
      try {
        var buffer = new StringBuilder(1024);
        int size = buffer.Capacity;
        if (QueryFullProcessImageName(handle, 0, buffer, ref size) && size > 0) {
          return buffer.ToString(0, size);
        }
        return null;
      } finally {
        CloseHandle(handle);
      }
    }

    private static string TryGetProcessCommandLine(int pid) {
      IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (handle == IntPtr.Zero) return null;
      try {
        int needed = 0;
        int status = NtQueryInformationProcess(handle, ProcessCommandLineInformation, IntPtr.Zero, 0, out needed);
        if (needed <= 0 && status != STATUS_INFO_LENGTH_MISMATCH && status != STATUS_BUFFER_TOO_SMALL && status != STATUS_BUFFER_OVERFLOW) {
          return null;
        }
        int bufSize = Math.Max(needed, 512);
        for (int attempt = 0; attempt < 3; attempt++) {
          IntPtr buffer = Marshal.AllocHGlobal(bufSize);
          try {
            status = NtQueryInformationProcess(handle, ProcessCommandLineInformation, buffer, bufSize, out needed);
            if (status == 0) {
              UnicodeString ustr = (UnicodeString)Marshal.PtrToStructure(buffer, typeof(UnicodeString));
              if (ustr.Buffer == IntPtr.Zero || ustr.Length == 0) return "";
              return Marshal.PtrToStringUni(ustr.Buffer, ustr.Length / 2);
            }
            if ((status == STATUS_INFO_LENGTH_MISMATCH || status == STATUS_BUFFER_TOO_SMALL || status == STATUS_BUFFER_OVERFLOW) && needed > bufSize) {
              bufSize = needed + 64;
              continue;
            }
            return null;
          } finally {
            Marshal.FreeHGlobal(buffer);
          }
        }
        return null;
      } finally {
        CloseHandle(handle);
      }
    }

    private static readonly JavaScriptSerializer Json = CreateSerializer();

    private static JavaScriptSerializer CreateSerializer() {
      var serializer = new JavaScriptSerializer();
      serializer.MaxJsonLength = 8 * 1024 * 1024;
      return serializer;
    }

    private static ManagementScope CreateWmiScope() {
      var scope = new ManagementScope(@"\\.\root\cimv2");
      scope.Connect();
      return scope;
    }

    private static Dictionary<string, object> QuerySingleProcess(ManagementScope scope, int pid, string fields) {
      using (var searcher = new ManagementObjectSearcher(scope, new ObjectQuery("SELECT " + fields + " FROM Win32_Process WHERE ProcessId = " + pid))) {
        using (ManagementObjectCollection results = searcher.Get()) {
          foreach (ManagementObject mo in results) {
            using (mo) {
              var dict = new Dictionary<string, object>(StringComparer.Ordinal);
              foreach (PropertyData prop in mo.Properties) {
                dict[prop.Name] = prop.Value;
              }
              return dict;
            }
          }
        }
      }
      return null;
    }

    private static long? ParseWmiCreationTicks(object rawCreationDate) {
      string text = rawCreationDate as string;
      if (String.IsNullOrEmpty(text)) return null;
      return ManagementDateTimeConverter.ToDateTime(text).ToUniversalTime().Ticks;
    }

    private static bool PathMatches(string candidatePath, string targetFullPath) {
      if (String.IsNullOrEmpty(candidatePath)) return false;
      try {
        return String.Equals(Path.GetFullPath(candidatePath), targetFullPath, StringComparison.OrdinalIgnoreCase);
      } catch {
        return false;
      }
    }

    private static int RunVerifyCdpOwner() {
      string queryStage = "initialize";
      try {
        string rawPort = Environment.GetEnvironmentVariable("CWB_CDP_OWNER_PORT");
        int targetPort = Int32.Parse(rawPort, CultureInfo.InvariantCulture);
        string rawExpected = Environment.GetEnvironmentVariable("CWB_CDP_EXPECTED_PROCESS");
        bool hasExpected = !String.IsNullOrEmpty(rawExpected);
        int expectedPid = 0;
        string expectedProfile = "";
        long expectedCreationTicks = 0;
        if (hasExpected) {
          var expectedObj = Json.DeserializeObject(rawExpected) as Dictionary<string, object>;
          if (expectedObj == null) throw new InvalidOperationException("Invalid expected process");
          expectedPid = Convert.ToInt32(expectedObj["pid"], CultureInfo.InvariantCulture);
          expectedProfile = Convert.ToString(expectedObj["profile"], CultureInfo.InvariantCulture) ?? "";
          string creationStr = Convert.ToString(expectedObj["creation"], CultureInfo.InvariantCulture);
          DateTime expectedCreation = DateTime.ParseExact(
            creationStr, "o", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
          expectedCreationTicks = expectedCreation.ToUniversalTime().Ticks;
        }

        queryStage = "listeners";
        var listeners = TcpListeners.FindByPort(targetPort);
        var ownerIdSet = new SortedSet<int>();
        for (int i = 0; i < listeners.Count; i++) {
          ownerIdSet.Add((int)listeners[i]["owningProcess"]);
        }
        var ownerIds = new List<int>(ownerIdSet);
        var owners = new List<Dictionary<string, object>>();
        bool creationMatches = false;
        bool profileMatches = false;

        ManagementScope scope = null;
        if (hasExpected) {
          scope = CreateWmiScope();
        }

        for (int i = 0; i < ownerIds.Count; i++) {
          int ownerId = ownerIds[i];
          queryStage = "owner";
          string commandLine = null;
          string executablePath = null;
          int processId = ownerId;
          long? wmiCreationTicks = null;

          if (!hasExpected) {
            executablePath = TryGetProcessImagePath(ownerId);
            commandLine = TryGetProcessCommandLine(ownerId);
          }
          if (hasExpected || String.IsNullOrEmpty(executablePath) || commandLine == null) {
            if (scope == null) scope = CreateWmiScope();
            string fields = hasExpected ? "ProcessId, ExecutablePath, CommandLine, CreationDate" : "ProcessId, ExecutablePath, CommandLine";
            var owner = QuerySingleProcess(scope, ownerId, fields);
            if (owner == null) throw new InvalidOperationException("Listener owner disappeared");
            commandLine = owner.ContainsKey("CommandLine") ? Convert.ToString(owner["CommandLine"], CultureInfo.InvariantCulture) : "";
            executablePath = owner.ContainsKey("ExecutablePath") ? Convert.ToString(owner["ExecutablePath"], CultureInfo.InvariantCulture) : "";
            processId = Convert.ToInt32(owner["ProcessId"], CultureInfo.InvariantCulture);
            if (hasExpected && owner.ContainsKey("CreationDate")) {
              wmiCreationTicks = ParseWmiCreationTicks(owner["CreationDate"]);
            }
          }

          queryStage = "native-parser";
          DebugPortArguments parsed = DebugPortParser.Parse(commandLine, expectedProfile);
          if (hasExpected && ownerId == expectedPid) {
            if (wmiCreationTicks.HasValue) {
              creationMatches = wmiCreationTicks.Value == expectedCreationTicks;
            }
            profileMatches = parsed.ProfileMatches;
          }
          var ownerRecord = new Dictionary<string, object>();
          ownerRecord["processId"] = processId;
          ownerRecord["executablePath"] = executablePath ?? "";
          ownerRecord["remoteDebuggingPorts"] = parsed.Ports;
          ownerRecord["hasInvalidRemoteDebuggingPort"] = parsed.Invalid;
          owners.Add(ownerRecord);
        }

        var evidence = new Dictionary<string, object>();
        evidence["listeners"] = listeners;
        evidence["owners"] = owners;

        if (hasExpected) {
          queryStage = "ancestry";
          var ancestorIds = new HashSet<int>();
          int cursor = Process.GetCurrentProcess().Id;
          bool notQueryAncestor = true;
          bool ancestorChainVerified = false;
          long? childCreationTicks = null;
          for (int depth = 0; depth < 32; depth++) {
            if (!ancestorIds.Add(cursor)) break;
            if (cursor == expectedPid) { notQueryAncestor = false; break; }
            var ancestor = QuerySingleProcess(scope, cursor, "ProcessId, ParentProcessId, CreationDate");
            if (ancestor == null || !ancestor.ContainsKey("ProcessId") || ancestor["ProcessId"] == null
              || Convert.ToInt32(ancestor["ProcessId"], CultureInfo.InvariantCulture) != cursor
              || !ancestor.ContainsKey("ParentProcessId") || ancestor["ParentProcessId"] == null
              || !ancestor.ContainsKey("CreationDate")) {
              throw new InvalidOperationException("Cannot verify query process ancestry");
            }
            long? ancestorCreationTicks = ParseWmiCreationTicks(ancestor["CreationDate"]);
            if (!ancestorCreationTicks.HasValue) {
              throw new InvalidOperationException("Cannot verify query process ancestry");
            }
            if (childCreationTicks.HasValue && ancestorCreationTicks.Value > childCreationTicks.Value) {
              throw new InvalidOperationException("Ancestor PID was reused");
            }
            if (ancestorCreationTicks.Value < expectedCreationTicks) {
              ancestorChainVerified = true;
              break;
            }
            int parentId = Convert.ToInt32(ancestor["ParentProcessId"], CultureInfo.InvariantCulture);
            if (parentId == 0) { ancestorChainVerified = true; break; }
            if (parentId < 0) break;
            childCreationTicks = ancestorCreationTicks;
            cursor = parentId;
          }
          var identity = new Dictionary<string, object>();
          identity["processIdMatches"] = ownerIds.Count == 1 && ownerIds[0] == expectedPid;
          identity["creationMatches"] = creationMatches;
          identity["profileMatches"] = profileMatches;
          identity["notQueryAncestor"] = notQueryAncestor;
          identity["ancestorChainVerified"] = ancestorChainVerified;
          evidence["independentIdentity"] = identity;
        }

        Console.WriteLine(Json.Serialize(evidence));
        return 0;
      } catch (Exception ex) {
        Exception cause = ex.GetBaseException() ?? ex;
        string queryKind = "query";
        int? nativeCode = null;
        var mgmtEx = cause as ManagementException;
        if (mgmtEx != null) {
          if (mgmtEx.ErrorCode == ManagementStatus.AccessDenied) {
            queryKind = "access";
            nativeCode = 2;
          } else {
            queryKind = "cim";
            int code = (int)mgmtEx.ErrorCode;
            if (code >= 0 && code <= 65535) nativeCode = code;
          }
        } else if (cause is UnauthorizedAccessException) {
          queryKind = "access";
        }
        var failure = new Dictionary<string, object>();
        failure["stage"] = queryStage;
        failure["kind"] = queryKind;
        failure["nativeCode"] = nativeCode;
        var wrapper = new Dictionary<string, object>();
        wrapper["queryFailure"] = failure;
        Console.WriteLine(Json.Serialize(wrapper));
        return 0;
      }
    }

    private static int RunActivateStoreApp() {
      string aumid = Environment.GetEnvironmentVariable("CWB_STORE_AUMID");
      string arguments = Environment.GetEnvironmentVariable("CWB_STORE_ARGS") ?? "";
      if (String.IsNullOrWhiteSpace(aumid)) {
        Console.Error.WriteLine("Missing Store AUMID");
        return 1;
      }
      var manager = (IApplicationActivationManager)(new ApplicationActivationManager());
      uint pid;
      int hr = manager.ActivateApplication(aumid, arguments, ActivateOptions.None, out pid);
      if (hr != 0) throw new COMException("ActivateApplication failed", hr);
      var result = new Dictionary<string, object>();
      result["processId"] = (int)pid;
      Console.WriteLine(Json.Serialize(result));
      return 0;
    }

    private static int RunListCodexProcesses() {
      string targetExe = Environment.GetEnvironmentVariable("CWB_TARGET_EXE");
      string targetPath = Path.GetFullPath(targetExe);
      var items = new List<Dictionary<string, object>>();
      Process[] processes = Process.GetProcessesByName("ChatGPT");
      bool needWmiFallback = false;
      for (int i = 0; i < processes.Length; i++) {
        using (Process proc = processes[i]) {
          int pid = proc.Id;
          string execPath = TryGetProcessImagePath(pid);
          if (String.IsNullOrEmpty(execPath)) { needWmiFallback = true; continue; }
          if (!PathMatches(execPath, targetPath)) continue;
          string commandLine = TryGetProcessCommandLine(pid);
          if (commandLine == null) { needWmiFallback = true; continue; }
          if (String.IsNullOrEmpty(commandLine)) continue;
          if (commandLine.IndexOf("--type=", StringComparison.OrdinalIgnoreCase) >= 0) continue;
          long mainWindowHandle = 0;
          string mainWindowTitle = "";
          try {
            mainWindowHandle = proc.MainWindowHandle.ToInt64();
            mainWindowTitle = proc.MainWindowTitle ?? "";
          } catch { }
          var entry = new Dictionary<string, object>();
          entry["ProcessId"] = pid;
          entry["CommandLine"] = commandLine;
          entry["MainWindowHandle"] = mainWindowHandle;
          entry["MainWindowTitle"] = mainWindowTitle;
          items.Add(entry);
        }
      }
      if (needWmiFallback) {
        items.Clear();
        var scope = CreateWmiScope();
        using (var searcher = new ManagementObjectSearcher(scope, new ObjectQuery("SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name = 'ChatGPT.exe'"))) {
          using (ManagementObjectCollection results = searcher.Get()) {
            foreach (ManagementObject mo in results) {
              using (mo) {
                string execPath = mo["ExecutablePath"] as string;
                string commandLine = mo["CommandLine"] as string;
                if (String.IsNullOrEmpty(execPath) || String.IsNullOrEmpty(commandLine)) continue;
                if (!PathMatches(execPath, targetPath)) continue;
                if (commandLine.IndexOf("--type=", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                int pid = Convert.ToInt32(mo["ProcessId"], CultureInfo.InvariantCulture);
                long mainWindowHandle = 0;
                string mainWindowTitle = "";
                try {
                  using (Process proc = Process.GetProcessById(pid)) {
                    mainWindowHandle = proc.MainWindowHandle.ToInt64();
                    mainWindowTitle = proc.MainWindowTitle ?? "";
                  }
                } catch { }
                var entry = new Dictionary<string, object>();
                entry["ProcessId"] = pid;
                entry["CommandLine"] = commandLine;
                entry["MainWindowHandle"] = mainWindowHandle;
                entry["MainWindowTitle"] = mainWindowTitle;
                items.Add(entry);
              }
            }
          }
        }
      }
      Console.WriteLine(Json.Serialize(items));
      return 0;
    }

    private static int RunListRunningCodex() {
      var items = new List<Dictionary<string, object>>();
      var versionCache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      Process[] processes = Process.GetProcessesByName("ChatGPT");
      for (int i = 0; i < processes.Length; i++) {
        using (Process proc = processes[i]) {
          int pid = proc.Id;
          string execPath = TryGetProcessImagePath(pid);
          if (String.IsNullOrEmpty(execPath)) continue;
          string version;
          if (!versionCache.TryGetValue(execPath, out version)) {
            version = "";
            try {
              version = FileVersionInfo.GetVersionInfo(execPath).ProductVersion ?? "";
            } catch { }
            versionCache[execPath] = version;
          }
          var entry = new Dictionary<string, object>();
          entry["ProcessId"] = pid;
          entry["ExecutablePath"] = execPath;
          entry["ProductVersion"] = version;
          items.Add(entry);
        }
      }
      Console.WriteLine(Json.Serialize(items));
      return 0;
    }

    private sealed class CodexProcRow {
      public int ProcessId;
      public string CommandLine;
    }

    private static List<CodexProcRow> FindTargetCodexProcesses(ref ManagementScope scope, string targetPath) {
      var list = new List<CodexProcRow>();
      Process[] processes = Process.GetProcessesByName("ChatGPT");
      bool needWmiFallback = false;
      for (int i = 0; i < processes.Length; i++) {
        using (Process proc = processes[i]) {
          int pid = proc.Id;
          string execPath = TryGetProcessImagePath(pid);
          if (String.IsNullOrEmpty(execPath)) { needWmiFallback = true; continue; }
          if (!PathMatches(execPath, targetPath)) continue;
          string commandLine = TryGetProcessCommandLine(pid);
          if (commandLine == null) { needWmiFallback = true; continue; }
          list.Add(new CodexProcRow {
            ProcessId = pid,
            CommandLine = commandLine
          });
        }
      }
      if (!needWmiFallback) return list;

      list.Clear();
      if (scope == null) scope = CreateWmiScope();
      using (var searcher = new ManagementObjectSearcher(scope, new ObjectQuery("SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name = 'ChatGPT.exe'"))) {
        using (ManagementObjectCollection results = searcher.Get()) {
          foreach (ManagementObject mo in results) {
            using (mo) {
              string execPath = mo["ExecutablePath"] as string;
              if (!PathMatches(execPath, targetPath)) continue;
              list.Add(new CodexProcRow {
                ProcessId = Convert.ToInt32(mo["ProcessId"], CultureInfo.InvariantCulture),
                CommandLine = mo["CommandLine"] as string ?? ""
              });
            }
          }
        }
      }
      return list;
    }

    private static int RunCloseCodexProcesses() {
      string targetExe = Environment.GetEnvironmentVariable("CWB_TARGET_EXE");
      string targetPath = Path.GetFullPath(targetExe);
      int closeTimeoutMs = 12000;
      int parsedTimeout;
      if (Int32.TryParse(Environment.GetEnvironmentVariable("CWB_CLOSE_TIMEOUT_MS"), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsedTimeout)) {
        closeTimeoutMs = Math.Max(1000, parsedTimeout);
      }
      string expectedJson = Environment.GetEnvironmentVariable("CWB_EXPECTED_PROCESSES");
      ManagementScope scope = null;
      var matched = FindTargetCodexProcesses(ref scope, targetPath);

      if (!String.IsNullOrEmpty(expectedJson)) {
        var expectedList = Json.DeserializeObject(expectedJson) as object[];
        if (expectedList == null) throw new InvalidOperationException("Invalid expected process list");
        var roots = new List<CodexProcRow>();
        for (int i = 0; i < matched.Count; i++) {
          if (!String.IsNullOrEmpty(matched[i].CommandLine)
            && matched[i].CommandLine.IndexOf("--type=", StringComparison.OrdinalIgnoreCase) < 0) {
            roots.Add(matched[i]);
          }
        }
        if (roots.Count != expectedList.Length) {
          throw new InvalidOperationException("Codex process set changed; takeover canceled");
        }
        for (int i = 0; i < expectedList.Length; i++) {
          var expectedEntry = expectedList[i] as Dictionary<string, object>;
          if (expectedEntry == null) throw new InvalidOperationException("Codex process identity changed; takeover canceled");
          int expectedPid = Convert.ToInt32(expectedEntry["processId"], CultureInfo.InvariantCulture);
          string expectedCmd = Convert.ToString(expectedEntry["commandLine"], CultureInfo.InvariantCulture) ?? "";
          int matchCount = 0;
          CodexProcRow foundRow = null;
          for (int j = 0; j < roots.Count; j++) {
            if (roots[j].ProcessId == expectedPid && String.Equals(roots[j].CommandLine, expectedCmd, StringComparison.Ordinal)) {
              matchCount++;
              foundRow = roots[j];
            }
          }
          if (matchCount != 1 || foundRow.CommandLine.IndexOf("--remote-debugging-port", StringComparison.OrdinalIgnoreCase) >= 0) {
            throw new InvalidOperationException("Codex process identity changed; takeover canceled");
          }
        }
        matched = roots;
      }

      var matchedProcessIds = new List<int>();
      for (int i = 0; i < matched.Count; i++) {
        matchedProcessIds.Add(matched[i].ProcessId);
      }
      for (int i = 0; i < matchedProcessIds.Count; i++) {
        try {
          using (Process proc = Process.GetProcessById(matchedProcessIds[i])) {
            proc.Kill();
          }
        } catch { }
      }

      DateTime deadline = DateTime.UtcNow.AddMilliseconds(closeTimeoutMs);
      List<CodexProcRow> remaining;
      while (true) {
        remaining = FindTargetCodexProcesses(ref scope, targetPath);
        if (remaining.Count == 0 || DateTime.UtcNow >= deadline) break;
        Thread.Sleep(100);
      }
      var remainingProcessIds = new List<int>();
      for (int i = 0; i < remaining.Count; i++) {
        remainingProcessIds.Add(remaining[i].ProcessId);
      }
      var output = new Dictionary<string, object>();
      output["matchedProcessIds"] = matchedProcessIds;
      output["remainingProcessIds"] = remainingProcessIds;
      Console.WriteLine(Json.Serialize(output));
      return 0;
    }

    [STAThread]
    public static int Main(string[] args) {
      Console.OutputEncoding = new UTF8Encoding(false);
      if (args == null || args.Length == 0) {
        Console.Error.WriteLine("Missing command");
        return 2;
      }
      try {
        switch (args[0]) {
          case "verify-cdp-owner":
            return RunVerifyCdpOwner();
          case "activate-store-app":
            return RunActivateStoreApp();
          case "list-codex-processes":
            return RunListCodexProcesses();
          case "list-running-codex":
            return RunListRunningCodex();
          case "close-codex-processes":
            return RunCloseCodexProcesses();
          default:
            Console.Error.WriteLine("Unknown command");
            return 2;
        }
      } catch (Exception ex) {
        Console.Error.WriteLine(ex.Message);
        return 1;
      }
    }
  }
}
