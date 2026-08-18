// electron-builder `afterPack` hook.
//
// 1. node-pty's conpty.node loads conpty.dll from build/Release/conpty/ at
//    runtime, but @electron/rebuild only recompiles the .node files and skips
//    node-pty's postinstall (which normally copies conpty.dll + OpenConsole.exe
//    there). Copy them into the packaged app so the local Windows terminal works.
// 2. Strip node-pty's third_party/, prebuilds/ (Node-ABI) and compile
//    intermediates (*.iobj/*.ipdb/*.lib/*.exp/*.pdb/obj) to shrink the package.
const fs = require('fs');
const path = require('path');

function rmMatching(dir, extensions, skipDirs = new Set()) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) {
        fs.rmSync(full, { recursive: true, force: true });
      } else {
        rmMatching(full, extensions, skipDirs);
      }
    } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
      fs.rmSync(full, { force: true });
    }
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const appDir = path.join(context.appOutDir, 'resources', 'app');
  const nodePtyDir = path.join(appDir, 'node_modules', 'node-pty');
  const releaseDir = path.join(nodePtyDir, 'build', 'Release');
  const conptyRoot = path.join(nodePtyDir, 'third_party', 'conpty');

  if (fs.existsSync(conptyRoot)) {
    const versions = fs.readdirSync(conptyRoot);
    if (versions.length) {
      const arch = context.arch === 3 ? 'arm64' : 'x64';
      const sourceDir = path.join(conptyRoot, versions[0], `win10-${arch}`);
      const destDir = path.join(releaseDir, 'conpty');
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of ['conpty.dll', 'OpenConsole.exe']) {
        const source = path.join(sourceDir, file);
        const target = path.join(destDir, file);
        if (fs.existsSync(source)) {
          fs.copyFileSync(source, target);
          console.log(`afterPack: copied ${file} -> build/Release/conpty/`);
        }
      }
    }
  }

  // Drop Node-ABI prebuilds and the third-party source tree (no longer needed).
  for (const folder of ['third_party', 'prebuilds']) {
    fs.rmSync(path.join(nodePtyDir, folder), { recursive: true, force: true });
  }
  // Strip compile/link intermediates and debug symbols from build/Release.
  rmMatching(
    releaseDir,
    new Set(['.iobj', '.ipdb', '.lib', '.exp', '.pdb', '.map']),
    new Set(['obj']),
  );
  console.log('afterPack: stripped node-pty build intermediates.');
};
