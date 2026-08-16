import { win32 } from 'node:path';

const WINDOWS_RESERVED_FILE_STEM = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;
const WINDOWS_DEVICE_NAMESPACE = /^(?:[\\/]{2}[?.][\\/]|[\\/]\?\?[\\/])/u;
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/u;

function windowsSegments(path: string): string[] {
  const withoutDrive = path.replace(/^[A-Za-z]:[\\/]?/u, '');
  return withoutDrive.split(/[\\/]/u).filter(Boolean);
}

function assertSafeSegments(path: string): void {
  for (const segment of windowsSegments(path)) {
    if (segment === '.' || segment === '..') continue;
    const withoutTrailingDotsOrSpaces = segment.replace(/[. ]+$/u, '');
    const stem = withoutTrailingDotsOrSpaces.split('.', 1)[0] ?? '';
    if (
      segment.includes(':')
      || withoutTrailingDotsOrSpaces !== segment
      || WINDOWS_RESERVED_FILE_STEM.test(stem)
    ) {
      throw new Error('文件路径包含 Windows 保留名称、尾随点/空格或备用数据流。');
    }
  }
}

/** Validate the caller-provided spelling before win32.resolve can reinterpret it. */
export function assertSafeWindowsRequestedPath(requestedPath: string): void {
  if (WINDOWS_DEVICE_NAMESPACE.test(requestedPath)) {
    throw new Error('文件路径不能使用 Windows 设备命名空间。');
  }
  if (WINDOWS_DRIVE_RELATIVE.test(requestedPath)) {
    throw new Error('文件路径不能使用 Windows 驱动器相对形式。');
  }
  assertSafeSegments(requestedPath);
}

/** Re-check the fully resolved target against the canonical Windows root. */
export function assertSafeWindowsResolvedPath(root: string, target: string): void {
  const canonicalRoot = win32.resolve(root);
  const canonicalTarget = win32.resolve(target);
  const candidate = win32.relative(canonicalRoot, canonicalTarget);
  if (
    candidate === '..'
    || candidate.startsWith('..\\')
    || win32.isAbsolute(candidate)
  ) throw new Error('文件路径超出当前会话工作目录。');
  assertSafeSegments(candidate);
}
