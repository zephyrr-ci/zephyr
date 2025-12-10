/**
 * VM-based Job Executor
 *
 * Runs jobs inside Firecracker microVMs for isolation.
 */

import { VmManager, type VmInstance } from "./firecracker/manager.ts";
import type { VmConfig, MachineConfig } from "./firecracker/types.ts";
import {
  allocateNetwork,
  releaseNetwork,
  type VmNetworkConfig,
} from "./network/tap.ts";
import type { RunnerConfig } from "@zephyrr-ci/types";

export interface VmExecutorOptions {
  /** Path to Firecracker binary */
  firecrackerPath?: string;
  /** Path to kernel image */
  kernelPath: string;
  /** Path to rootfs image */
  rootfsPath: string;
  /** Runtime directory for sockets and logs */
  runtimeDir: string;
  /** External network interface for NAT */
  natInterface?: string;
  /** Enable debug logging */
  debug?: boolean;
}

export interface JobVmOptions {
  /** Job identifier */
  jobId: string;
  /** Runner configuration from job definition */
  runner: RunnerConfig;
  /** Source code to copy into the VM */
  sourceDir?: string;
  /** Environment variables */
  env?: Record<string, string>;
}

interface RunningVm {
  instance: VmInstance;
  network: VmNetworkConfig;
  agentUrl: string;
}

export class VmExecutor {
  private manager: VmManager;
  private options: VmExecutorOptions;
  private runningVms: Map<string, RunningVm> = new Map();
  private vmIndex = 0;

  constructor(options: VmExecutorOptions) {
    this.options = options;
    this.manager = new VmManager({
      firecrackerPath: options.firecrackerPath,
    });
  }

  /**
   * Create and start a VM for a job
   */
  async createJobVm(options: JobVmOptions): Promise<RunningVm> {
    const { jobId, runner } = options;
    const vmId = `job-${jobId}`;

    // Allocate network
    const network = await allocateNetwork(vmId, this.vmIndex++, {
      natInterface: this.options.natInterface,
    });

    // Create a copy of the rootfs for this VM
    const vmRootfsPath = `${this.options.runtimeDir}/${vmId}-rootfs.ext4`;
    await Bun.$`cp ${this.options.rootfsPath} ${vmRootfsPath}`;

    // Build VM configuration
    const machineConfig: MachineConfig = {
      vcpu_count: runner.cpu ?? 1,
      mem_size_mib: runner.memory ?? 1024,
    };

    const vmConfig: VmConfig = {
      boot_source: {
        kernel_image_path: this.options.kernelPath,
        boot_args: [
          "console=ttyS0",
          "reboot=k",
          "panic=1",
          "pci=off",
          "nomodules",
          "random.trust_cpu=on",
          "i8042.noaux",
          // Network configuration via kernel cmdline
          `ip=${network.guestIp}::${network.gateway}:255.255.255.252::eth0:off:${network.dns}`,
        ].join(" "),
      },
      drives: [
        {
          drive_id: "rootfs",
          path_on_host: vmRootfsPath,
          is_root_device: true,
          is_read_only: false,
        },
      ],
      machine_config: machineConfig,
      network_interfaces: [
        {
          iface_id: "eth0",
          host_dev_name: network.tap.name,
          guest_mac: network.guestMac,
        },
      ],
    };

    // Create and start VM
    const instance = await this.manager.create({
      id: vmId,
      runtimeDir: this.options.runtimeDir,
      config: vmConfig,
      debug: this.options.debug,
    });

    await this.manager.start(vmId);

    const agentUrl = `http://${network.guestIp}:8080`;

    const runningVm: RunningVm = {
      instance,
      network,
      agentUrl,
    };

    this.runningVms.set(jobId, runningVm);

    // Wait for agent to be ready
    await this.waitForAgent(agentUrl);

    return runningVm;
  }

  /**
   * Wait for the agent to be ready in the VM
   */
  private async waitForAgent(
    agentUrl: string,
    timeoutMs: number = 60000
  ): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(`${agentUrl}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          return;
        }
      } catch {
        // Agent not ready yet
      }
      await Bun.sleep(500);
    }

    throw new Error(`Agent not ready after ${timeoutMs}ms`);
  }

  /**
   * Execute a command in a VM
   */
  async executeCommand(
    jobId: string,
    command: string,
    options: {
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
    } = {}
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    duration: number;
  }> {
    const vm = this.runningVms.get(jobId);
    if (!vm) {
      throw new Error(`No VM found for job: ${jobId}`);
    }

    const response = await fetch(`${vm.agentUrl}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command,
        cwd: options.cwd ?? "/workspace",
        env: options.env,
        timeout: options.timeout,
      }),
    });

    if (!response.ok) {
      throw new Error(`Agent request failed: ${response.status}`);
    }

    return response.json() as Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
      duration: number;
    }>;
  }

  /**
   * Copy files into a VM
   */
  async copyToVm(
    jobId: string,
    localPath: string,
    remotePath: string
  ): Promise<void> {
    const vm = this.runningVms.get(jobId);
    if (!vm) {
      throw new Error(`No VM found for job: ${jobId}`);
    }

    // Read local file
    const content = await Bun.file(localPath).text();

    // Write to VM
    const response = await fetch(`${vm.agentUrl}/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "file_write",
        id: crypto.randomUUID(),
        path: remotePath,
        content,
        encoding: "utf8",
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to copy file to VM: ${response.status}`);
    }
  }

  /**
   * Destroy a job's VM
   */
  async destroyJobVm(jobId: string): Promise<void> {
    const vm = this.runningVms.get(jobId);
    if (!vm) {
      return;
    }

    const vmId = `job-${jobId}`;

    // Destroy VM
    await this.manager.destroy(vmId);

    // Release network
    await releaseNetwork(vm.network, this.options.natInterface);

    // Clean up rootfs copy
    const vmRootfsPath = `${this.options.runtimeDir}/${vmId}-rootfs.ext4`;
    try {
      await Bun.$`rm -f ${vmRootfsPath}`.quiet();
    } catch {
      // Ignore errors
    }

    this.runningVms.delete(jobId);
  }

  /**
   * Destroy all VMs
   */
  async destroyAll(): Promise<void> {
    const jobIds = Array.from(this.runningVms.keys());
    await Promise.all(jobIds.map((id) => this.destroyJobVm(id)));
    await this.manager.destroyAll();
  }
}
