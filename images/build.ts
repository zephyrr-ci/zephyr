#!/usr/bin/env bun
/**
 * Build Zephyr CI VM images
 *
 * This script:
 * 1. Builds the agent binary
 * 2. Creates an Alpine-based rootfs with the agent
 * 3. Downloads/builds a Linux kernel suitable for Firecracker
 *
 * Requirements:
 *   - Docker
 *   - sudo access (for mounting ext4 filesystem during rootfs creation)
 *   - mkfs.ext4 (usually in e2fsprogs package)
 *
 * Usage:
 *   bun run images/build.ts [--agent]   # Build agent binary only
 *   bun run images/build.ts --kernel    # Download kernel only (no sudo needed)
 *   bun run images/build.ts --rootfs    # Build rootfs (requires sudo)
 *   bun run images/build.ts --all       # Build everything (requires sudo)
 */

const IMAGES_DIR = import.meta.dir;
const PROJECT_ROOT = `${IMAGES_DIR}/..`;
const ROOTFS_DIR = `${IMAGES_DIR}/rootfs`;
const KERNELS_DIR = `${IMAGES_DIR}/kernels`;

// Firecracker-compatible kernel URL (pre-built)
// Using latest v1.13 kernel - see https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md
const KERNEL_URL =
  "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.13/x86_64/vmlinux-6.1.141";

async function buildAgent(): Promise<string> {
  console.log("Building agent binary...");

  const agentDir = `${PROJECT_ROOT}/agent`;
  const outputPath = `${ROOTFS_DIR}/zephyr-agent`;

  // Build the agent as a standalone binary
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      `${agentDir}/src/index.ts`,
      "--compile",
      "--minify",
      "--outfile",
      outputPath,
    ],
    {
      cwd: agentDir,
      stdout: "inherit",
      stderr: "inherit",
    }
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to build agent: exit code ${exitCode}`);
  }

  console.log(`Agent built: ${outputPath}`);
  return outputPath;
}

async function buildRootfs(): Promise<string> {
  console.log("Building rootfs...");

  // First build the agent
  await buildAgent();

  const outputPath = `${ROOTFS_DIR}/alpine-rootfs.ext4`;
  const dockerfilePath = `${ROOTFS_DIR}/Dockerfile.alpine`;
  const imageName = "zephyr-rootfs:alpine";

  // Build Docker image
  console.log("Building Docker image...");
  let proc = Bun.spawn(
    ["docker", "build", "-t", imageName, "-f", dockerfilePath, ROOTFS_DIR],
    {
      cwd: ROOTFS_DIR,
      stdout: "inherit",
      stderr: "inherit",
    }
  );

  let exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to build Docker image: exit code ${exitCode}`);
  }

  // Create and export container filesystem
  console.log("Exporting container filesystem...");

  // Create a container (don't start it)
  proc = Bun.spawn(["docker", "create", "--name", "zephyr-rootfs-temp", imageName], {
    stdout: "inherit",
    stderr: "inherit",
  });
  exitCode = await proc.exited;
  if (exitCode !== 0) {
    // Clean up if container already exists
    await Bun.$`docker rm -f zephyr-rootfs-temp`.quiet().catch(() => {});
    proc = Bun.spawn(["docker", "create", "--name", "zephyr-rootfs-temp", imageName], {
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error("Failed to create container");
    }
  }

  // Copy the agent binary into the container
  const agentPath = `${ROOTFS_DIR}/zephyr-agent`;
  await Bun.$`docker cp ${agentPath} zephyr-rootfs-temp:/usr/local/bin/zephyr-agent`;

  // Export filesystem to tar
  const tarPath = `${ROOTFS_DIR}/rootfs.tar`;
  proc = Bun.spawn(["docker", "export", "-o", tarPath, "zephyr-rootfs-temp"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  exitCode = await proc.exited;

  // Clean up container
  await Bun.$`docker rm -f zephyr-rootfs-temp`.quiet();

  if (exitCode !== 0) {
    throw new Error("Failed to export container filesystem");
  }

  // Create ext4 filesystem image
  console.log("Creating ext4 filesystem image...");

  // Create a 2GB sparse file
  const sizeBytes = 2 * 1024 * 1024 * 1024; // 2GB
  await Bun.$`dd if=/dev/zero of=${outputPath} bs=1 count=0 seek=${sizeBytes}`.quiet();

  // Format as ext4
  await Bun.$`mkfs.ext4 -F ${outputPath}`.quiet();

  // Mount and extract tar
  const mountPoint = `${ROOTFS_DIR}/mnt`;
  await Bun.$`mkdir -p ${mountPoint}`;
  await Bun.$`sudo mount -o loop ${outputPath} ${mountPoint}`;
  await Bun.$`sudo tar -xf ${tarPath} -C ${mountPoint}`;
  await Bun.$`sudo umount ${mountPoint}`;
  await Bun.$`rmdir ${mountPoint}`;

  // Clean up tar
  await Bun.$`rm -f ${tarPath}`;

  console.log(`Rootfs created: ${outputPath}`);
  return outputPath;
}

async function downloadKernel(): Promise<string> {
  console.log("Downloading kernel...");

  const outputPath = `${KERNELS_DIR}/vmlinux`;

  // Check if kernel already exists
  if (await Bun.file(outputPath).exists()) {
    console.log(`Kernel already exists: ${outputPath}`);
    return outputPath;
  }

  // Download kernel
  const response = await fetch(KERNEL_URL);
  if (!response.ok) {
    throw new Error(`Failed to download kernel: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  await Bun.write(outputPath, buffer);

  // Make executable
  await Bun.$`chmod +x ${outputPath}`;

  console.log(`Kernel downloaded: ${outputPath}`);
  return outputPath;
}

async function main() {
  const args = new Set(Bun.argv.slice(2));

  const buildAll = args.has("--all") || args.size === 0;
  const buildRootfsFlag = args.has("--rootfs") || buildAll;
  const downloadKernelFlag = args.has("--kernel") || buildAll;
  const buildAgentOnly = args.has("--agent");

  if (buildAgentOnly) {
    await buildAgent();
    return;
  }

  if (downloadKernelFlag) {
    await downloadKernel();
  }

  if (buildRootfsFlag) {
    await buildRootfs();
  }

  console.log("\nBuild complete!");
  console.log(`Rootfs: ${ROOTFS_DIR}/alpine-rootfs.ext4`);
  console.log(`Kernel: ${KERNELS_DIR}/vmlinux`);
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
