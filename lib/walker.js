// Incremental directory walker. Recurses through a
// FileSystemDirectoryHandle and emits batches of file entries, with the
// event loop yielded between batches. Per architecture (docs/architecture.md
// → Sync flow step 2 + Known constraints): walking a real DCIM with 10k+
// files will hang Android Chrome unless we batch + yield.
//
// Consumer:
//   for await (const batch of walkFolder(handle)) {
//     for (const entry of batch) {
//       // entry: { path, name, size, mtime, file }
//     }
//   }

const DEFAULT_BATCH_SIZE = 32;
const defaultYield = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Walk a directory handle, yielding batches of up to `batchSize` entries.
 *
 * @param {FileSystemDirectoryHandle} rootHandle
 * @param {{ batchSize?: number, yieldFn?: () => Promise<void> }} [options]
 */
export async function* walkFolder(rootHandle, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const yieldFn = options.yieldFn ?? defaultYield;

  let batch = [];
  for await (const entry of walkRecursive(rootHandle, '')) {
    batch.push(entry);
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
      await yieldFn();
    }
  }
  if (batch.length > 0) yield batch;
}

async function* walkRecursive(dirHandle, pathPrefix) {
  for await (const [name, handle] of dirHandle.entries()) {
    const path = pathPrefix ? `${pathPrefix}/${name}` : name;
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      yield {
        path,
        name,
        size: file.size,
        mtime: file.lastModified,
        file,
      };
    } else if (handle.kind === 'directory') {
      yield* walkRecursive(handle, path);
    }
  }
}
