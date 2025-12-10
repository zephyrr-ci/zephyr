/**
 * VM Warm Pool
 *
 * Maintains a pool of pre-booted, idle VMs ready for immediate use.
 * This dramatically reduces job startup time from ~125ms to near-instant.
 */

import { VmManager, type VmInstance } from "../firecracker/manager.ts";
import type { VmConfig } from "../firecracker/types.ts";
import { allocateNetwork, releaseNetwork, type VmNetworkConfig } from "../network/tap.ts";

/**
 * Callback for metrics reporting
 */
export interface WarmPoolMetricsCallback {
  /** Called when VM pool stats change */
  onStatsChange?: (idle: number, active: number) => void;
  /** Called when a VM is booted */
  onVmBooted?: (durationMs: number) => void;
}

export interface WarmPoolOptions {
  /** VM manager instance */
  vmManager: VmManager;
  /** Runtime directory for VM files */
  runtimeDir: string;
  /** Minimum idle VMs to keep ready */
  minIdle?: number;
  /** Maximum idle VMs */
  maxIdle?: number;
  /** Maximum total VMs (idle + in-use) */
  maxTotal?: number;
  /** Default VM configuration */
  defaultConfig: DefaultVmConfig;
  /** How often to check pool health (ms) */
  healthCheckInterval?: number;
  /** Max time a VM can be idle before recycling (ms) */
  maxIdleTime?: number;
  /** Network interface for NAT (e.g., "eth0") */
  natInterface?: string;
  /** Metrics callbacks */
  metricsCallback?: WarmPoolMetricsCallback;
}

export interface DefaultVmConfig {
  /** Path to kernel image */
  kernelPath: string;
  /** Path to rootfs image */
  rootfsPath: string;
  /** Default CPU cores */
  cpu?: number;
  /** Default memory (MB) */
  memory?: number;
}

interface PooledVm {
  instance: VmInstance;
  network: VmNetworkConfig;
  index: number;
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
}

type PoolState = "starting" | "running" | "stopping" | "stopped";

export class WarmPool {
  private options: Required<Omit<WarmPoolOptions, "natInterface" | "metricsCallback">> & Pick<WarmPoolOptions, "natInterface" | "metricsCallback">;
  private idleVms: Map<string, PooledVm> = new Map();
  private inUseVms: Map<string, PooledVm> = new Map();
  private state: PoolState = "stopped";
  private healthCheckTimer: Timer | null = null;
  private replenishPromise: Promise<void> | null = null;
  private nextIndex = 0;

  constructor(options: WarmPoolOptions) {
    this.options = {
      minIdle: options.minIdle ?? 2,
      maxIdle: options.maxIdle ?? 4,
      maxTotal: options.maxTotal ?? 8,
      healthCheckInterval: options.healthCheckInterval ?? 30000,
      maxIdleTime: options.maxIdleTime ?? 300000, // 5 minutes
      ...options,
    };
  }

  /**
   * Report current stats to metrics callback
   */
  private reportStats(): void {
    this.options.metricsCallback?.onStatsChange?.(this.idleVms.size, this.inUseVms.size);
  }

  /**
   * Start the warm pool
   */
  async start(): Promise<void> {
    if (this.state !== "stopped") {
      return;
    }

    this.state = "starting";

    // Pre-warm the pool
    await this.replenish();

    // Start health check timer
    this.healthCheckTimer = setInterval(() => {
      this.healthCheck();
    }, this.options.healthCheckInterval);

    this.state = "running";
  }

  /**
   * Stop the warm pool and clean up all VMs
   */
  async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "stopping") {
      return;
    }

    this.state = "stopping";

    // Stop health check timer
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Wait for any replenish in progress
    if (this.replenishPromise) {
      await this.replenishPromise;
    }

    // Destroy all idle VMs
    const idleIds = Array.from(this.idleVms.keys());
    await Promise.all(idleIds.map((id) => this.destroyVm(id, true)));

    // Destroy all in-use VMs (force)
    const inUseIds = Array.from(this.inUseVms.keys());
    await Promise.all(inUseIds.map((id) => this.destroyVm(id, false)));

    this.state = "stopped";
  }

  /**
   * Acquire a VM from the pool
   */
  async acquire(): Promise<{ vm: VmInstance; network: VmNetworkConfig }> {
    if (this.state !== "running") {
      throw new Error("Warm pool is not running");
    }

    // Try to get an idle VM
    const idleEntry = this.idleVms.entries().next();
    if (!idleEntry.done) {
      const [id, pooledVm] = idleEntry.value;
      this.idleVms.delete(id);
      pooledVm.lastUsedAt = Date.now();
      pooledVm.useCount++;
      this.inUseVms.set(id, pooledVm);

      // Report stats change
      this.reportStats();

      // Trigger async replenish
      this.scheduleReplenish();

      return {
        vm: pooledVm.instance,
        network: pooledVm.network,
      };
    }

    // No idle VMs available, check if we can create one
    if (this.totalCount >= this.options.maxTotal) {
      throw new Error("Pool exhausted: maximum VMs reached");
    }

    // Create a new VM on-demand
    const pooledVm = await this.createVm();
    pooledVm.lastUsedAt = Date.now();
    pooledVm.useCount++;
    this.inUseVms.set(pooledVm.instance.id, pooledVm);

    // Report stats change
    this.reportStats();

    return {
      vm: pooledVm.instance,
      network: pooledVm.network,
    };
  }

  /**
   * Release a VM back to the pool
   */
  async release(vmId: string, options?: { destroy?: boolean }): Promise<void> {
    const pooledVm = this.inUseVms.get(vmId);
    if (!pooledVm) {
      return;
    }

    this.inUseVms.delete(vmId);

    // If requested or pool is full, destroy the VM
    if (options?.destroy || this.idleVms.size >= this.options.maxIdle) {
      await this.destroyVm(vmId, false, pooledVm);
      this.reportStats();
      return;
    }

    // Return to idle pool
    pooledVm.lastUsedAt = Date.now();
    this.idleVms.set(vmId, pooledVm);
    this.reportStats();
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    state: PoolState;
    idle: number;
    inUse: number;
    total: number;
    maxTotal: number;
  } {
    return {
      state: this.state,
      idle: this.idleVms.size,
      inUse: this.inUseVms.size,
      total: this.totalCount,
      maxTotal: this.options.maxTotal,
    };
  }

  private get totalCount(): number {
    return this.idleVms.size + this.inUseVms.size;
  }

  /**
   * Create a new VM for the pool
   */
  private async createVm(): Promise<PooledVm> {
    const bootStartTime = Date.now();
    const index = this.nextIndex++;
    const id = `warm-${index}-${crypto.randomUUID().slice(0, 8)}`;

    // Allocate network resources
    const network = await allocateNetwork(id, index, {
      natInterface: this.options.natInterface,
    });

    // Build VM config
    const config: VmConfig = {
      boot_source: {
        kernel_image_path: this.options.defaultConfig.kernelPath,
        boot_args: "console=ttyS0 reboot=k panic=1 pci=off init=/init",
      },
      machine_config: {
        vcpu_count: this.options.defaultConfig.cpu ?? 1,
        mem_size_mib: this.options.defaultConfig.memory ?? 512,
      },
      drives: [
        {
          drive_id: "rootfs",
          path_on_host: this.options.defaultConfig.rootfsPath,
          is_root_device: true,
          is_read_only: false,
        },
      ],
      network_interfaces: [
        {
          iface_id: "eth0",
          host_dev_name: network.tap.name,
          guest_mac: network.guestMac,
        },
      ],
    };

    // Create and start the VM
    const instance = await this.options.vmManager.create({
      id,
      runtimeDir: this.options.runtimeDir,
      config,
    });

    await this.options.vmManager.start(id);

    // Report boot time metric
    const bootDuration = Date.now() - bootStartTime;
    this.options.metricsCallback?.onVmBooted?.(bootDuration);

    return {
      instance,
      network,
      index,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      useCount: 0,
    };
  }

  /**
   * Destroy a VM and release its resources
   */
  private async destroyVm(
    id: string,
    isIdle: boolean,
    pooledVm?: PooledVm
  ): Promise<void> {
    const vm = pooledVm ?? (isIdle ? this.idleVms.get(id) : this.inUseVms.get(id));

    if (isIdle) {
      this.idleVms.delete(id);
    } else {
      this.inUseVms.delete(id);
    }

    if (vm) {
      // Destroy VM
      await this.options.vmManager.destroy(id);

      // Release network resources
      await releaseNetwork(vm.network, this.options.natInterface);
    }
  }

  /**
   * Replenish the pool to minimum idle count
   */
  private async replenish(): Promise<void> {
    const needed = this.options.minIdle - this.idleVms.size;
    const canCreate = this.options.maxTotal - this.totalCount;
    const toCreate = Math.min(needed, canCreate);

    if (toCreate <= 0) {
      return;
    }

    const promises: Promise<void>[] = [];
    for (let i = 0; i < toCreate; i++) {
      promises.push(
        this.createVm()
          .then((pooledVm) => {
            this.idleVms.set(pooledVm.instance.id, pooledVm);
          })
          .catch((err) => {
            console.error("Failed to create warm pool VM:", err);
          })
      );
    }

    await Promise.all(promises);
  }

  /**
   * Schedule an async replenish
   */
  private scheduleReplenish(): void {
    if (this.replenishPromise) {
      return;
    }

    this.replenishPromise = this.replenish().finally(() => {
      this.replenishPromise = null;
    });
  }

  /**
   * Health check - remove stale VMs, replenish pool
   */
  private async healthCheck(): Promise<void> {
    if (this.state !== "running") {
      return;
    }

    const now = Date.now();
    const maxIdleTime = this.options.maxIdleTime;

    // Find and remove stale idle VMs (beyond minIdle)
    const staleIds: string[] = [];
    let idleCount = 0;

    for (const [id, vm] of this.idleVms) {
      idleCount++;
      if (idleCount > this.options.minIdle && now - vm.lastUsedAt > maxIdleTime) {
        staleIds.push(id);
      }
    }

    // Destroy stale VMs
    await Promise.all(staleIds.map((id) => this.destroyVm(id, true)));

    // Replenish if needed
    await this.replenish();
  }
}
