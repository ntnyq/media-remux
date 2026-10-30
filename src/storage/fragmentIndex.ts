export { createDiskFragmentStore as createDiskFragmentIndex } from './fragmentStore'
export type {
  /**
   * Positional backing file for one track's TFRA index; uses FragmentStoreFile's
   * write, read, seal, and close contracts.
   */
  FragmentStoreFile as FragmentIndexFile,

  /**
   * Per-track TFRA byte store; uses FragmentStore's append and bounded read contracts.
   */
  FragmentStore as FragmentIndexStore,
} from './fragmentStore'
