const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const packageDir = path.join(root, "backup-agent-windows");
const zipPath = path.join(root, "backup-agent-windows.zip");
const shaPath = path.join(root, "backup-agent-windows.sha256");

function copyRecursive(source, target) {
  fs.cpSync(source, target, { recursive: true, force: true });
}

function removeNativeArtifacts(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeNativeArtifacts(fullPath);
    } else if (/\.(node|dll|dylib|so)$/i.test(entry.name)) {
      fs.rmSync(fullPath, { force: true });
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    stdio: options.stdio || "pipe"
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function findNodeExecutable() {
  const configured = process.env.WINDOWS_NODE_RUNTIME_DIR
    ? path.resolve(process.env.WINDOWS_NODE_RUNTIME_DIR)
    : null;
  const candidates = [configured, path.join(root, ".runtime", "windows-node")].filter(Boolean);
  for (const candidate of candidates) {
    const executable = candidate.toLowerCase().endsWith("node.exe")
      ? candidate
      : path.join(candidate, "node.exe");
    if (fs.existsSync(executable)) {
      return executable;
    }
  }
  throw new Error(
    "Windows node.exe was not found. Set WINDOWS_NODE_RUNTIME_DIR or place it in .runtime/windows-node."
  );
}

function zipPackage() {
  fs.rmSync(zipPath, { force: true });
  if (process.platform === "win32") {
    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -Path '${packageDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
    ]);
  } else {
    run("zip", ["-qr", zipPath, "backup-agent-windows"]);
  }
}

function writeSha256() {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
  fs.writeFileSync(shaPath, `${hash}  backup-agent-windows.zip\n`, "utf8");
}

const nodeExecutable = findNodeExecutable();
if (!fs.existsSync(path.join(root, "node_modules"))) {
  throw new Error("node_modules was not found. Run npm ci before packaging.");
}

fs.rmSync(packageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(packageDir, "node"), { recursive: true });
fs.mkdirSync(path.join(packageDir, "app"), { recursive: true });

fs.copyFileSync(nodeExecutable, path.join(packageDir, "node", "node.exe"));
copyRecursive(path.join(root, "src"), path.join(packageDir, "app", "src"));
copyRecursive(path.join(root, "node_modules"), path.join(packageDir, "app", "node_modules"));

for (const file of ["package.json", "package-lock.json"]) {
  fs.copyFileSync(path.join(root, file), path.join(packageDir, "app", file));
}
for (const file of [".env.example", "README.md", "LICENSE", "install.ps1", "uninstall.ps1", "backup-agent.cmd"]) {
  fs.copyFileSync(path.join(root, file), path.join(packageDir, file));
}

fs.rmSync(path.join(packageDir, "app", "node_modules", "cpu-features"), { recursive: true, force: true });
fs.rmSync(path.join(packageDir, "app", "node_modules", "ssh2", "lib", "protocol", "crypto", "build"), {
  recursive: true,
  force: true
});
removeNativeArtifacts(path.join(packageDir, "app", "node_modules"));

zipPackage();
writeSha256();

console.log(`Wrote ${zipPath}`);
console.log(`Wrote ${shaPath}`);
