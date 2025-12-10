// Firecracker client and types
export { FirecrackerClient, type FirecrackerClientOptions } from "./firecracker/client.ts";
export type {
  BootSource,
  Drive,
  NetworkInterface,
  MachineConfig,
  Vsock,
  Logger,
  Metrics,
  MmdsConfig,
  InstanceActionInfo,
  InstanceInfo,
  SnapshotCreateParams,
  SnapshotLoadParams,
  Balloon,
  BalloonStats,
  VmConfig,
  FirecrackerError,
} from "./firecracker/types.ts";

// VM Manager
export { VmManager, type VmOptions, type VmInstance } from "./firecracker/manager.ts";

// Network utilities
export {
  createTap,
  deleteTap,
  tapExists,
  enableIpForwarding,
  setupNat,
  teardownNat,
  allocateNetwork,
  releaseNetwork,
  generateMac,
  type TapDevice,
  type TapOptions,
  type VmNetworkConfig,
} from "./network/tap.ts";

// VM Executor
export { VmExecutor, type VmExecutorOptions, type JobVmOptions } from "./executor.ts";

// Warm Pool
export {
  WarmPool,
  type WarmPoolOptions,
  type DefaultVmConfig,
  type WarmPoolMetricsCallback,
} from "./pool/warm-pool.ts";
