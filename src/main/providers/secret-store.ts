import { spawn } from 'node:child_process';
import { join } from 'node:path';

export interface SecretEntry {
  reference: string;
  secret: string;
}

export interface SecretStore {
  get(reference: string): Promise<string | undefined>;
  set(reference: string, secret: string): Promise<void>;
  remove(reference: string): Promise<void>;
  /** Optional: enumerate every stored entry for portable export/import. */
  entries?(): Promise<SecretEntry[]>;
}

export class MemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  async get(reference: string): Promise<string | undefined> {
    return this.secrets.get(reference);
  }

  async set(reference: string, secret: string): Promise<void> {
    this.secrets.set(reference, secret);
  }

  async remove(reference: string): Promise<void> {
    this.secrets.delete(reference);
  }

  async entries(): Promise<SecretEntry[]> {
    return [...this.secrets.entries()].map(([reference, secret]) => ({ reference, secret }));
  }
}

const CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AiTerminalCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }

  [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);

  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

  [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

  [DllImport("Advapi32.dll", SetLastError = true)]
  private static extern void CredFree(IntPtr buffer);

  public static void Set(string target, string secret) {
    byte[] bytes = Encoding.Unicode.GetBytes(secret);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      CREDENTIAL credential = new CREDENTIAL {
        Type = 1,
        TargetName = target,
        UserName = "AI Terminal",
        CredentialBlob = blob,
        CredentialBlobSize = (UInt32)bytes.Length,
        Persist = 2
      };
      if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      for (int index = 0; index < bytes.Length; index++) bytes[index] = 0;
      if (blob != IntPtr.Zero) {
        Marshal.Copy(bytes, 0, blob, bytes.Length);
        Marshal.FreeHGlobal(blob);
      }
    }
  }

  public static string Get(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) {
      int code = Marshal.GetLastWin32Error();
      if (code == 1168) return null;
      throw new Win32Exception(code);
    }
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      byte[] bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      string value = Encoding.Unicode.GetString(bytes);
      for (int index = 0; index < bytes.Length; index++) bytes[index] = 0;
      return value;
    } finally {
      CredFree(pointer);
    }
  }

  public static void Remove(string target) {
    if (!CredDelete(target, 1, 0)) {
      int code = Marshal.GetLastWin32Error();
      if (code != 1168) throw new Win32Exception(code);
    }
  }
}
'@

$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
try {
  $value = $null
  switch ($payload.operation) {
    'get' { $value = [AiTerminalCredentialManager]::Get([string]$payload.reference) }
    'set' { [AiTerminalCredentialManager]::Set([string]$payload.reference, [string]$payload.secret) }
    'remove' { [AiTerminalCredentialManager]::Remove([string]$payload.reference) }
    default { throw 'Unsupported credential operation.' }
  }
  @{ ok = $true; value = $value } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
`;

interface CredentialResponse {
  ok: boolean;
  value?: string | null;
  error?: string;
}

export class WindowsCredentialStore implements SecretStore {
  async get(reference: string): Promise<string | undefined> {
    const response = await this.execute({ operation: 'get', reference });
    return response.value ?? undefined;
  }

  async set(reference: string, secret: string): Promise<void> {
    if (!secret) throw new Error('Credential cannot be empty.');
    if (Buffer.byteLength(secret, 'utf16le') > 2_560) {
      throw new Error('Credential exceeds the Windows Generic Credential size limit.');
    }
    await this.execute({ operation: 'set', reference, secret });
  }

  async remove(reference: string): Promise<void> {
    await this.execute({ operation: 'remove', reference });
  }

  private execute(payload: Record<string, string>): Promise<CredentialResponse> {
    if (process.platform !== 'win32') {
      return Promise.reject(new Error('Windows Credential Manager is only available on Windows.'));
    }
    const encodedScript = Buffer.from(CREDENTIAL_SCRIPT, 'utf16le').toString('base64');
    if (!isAllowedCredentialReference(payload.reference)) {
      return Promise.reject(new Error('Invalid credential reference.'));
    }
    return new Promise((resolve, reject) => {
      const powershellPath = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      const child = spawn(
        powershellPath,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Windows Credential Manager operation timed out.'));
      }, 10_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(stdout.trim()) as CredentialResponse;
          if (code !== 0 || !response.ok) {
            reject(new Error(response.error ?? stderr.trim() ?? 'Credential operation failed.'));
          } else {
            resolve(response);
          }
        } catch {
          reject(new Error(stderr.trim() || 'Credential Manager returned an invalid response.'));
        }
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }
}

const CREDENTIAL_REFERENCE_PATTERN = /^AI Terminal\/(?:provider|ssh)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAllowedCredentialReference(reference: string): boolean {
  return CREDENTIAL_REFERENCE_PATTERN.test(reference);
}
