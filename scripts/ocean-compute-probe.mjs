/** Inject only into a dedicated benchmark profile. Measures the ocean's compute
 * pass directly; it does not change the runtime or normal editor rendering. */
export function installOceanComputeProbe() {
  const createEncoder = GPUDevice.prototype.createCommandEncoder;
  const submit = GPUQueue.prototype.submit;
  const pools = new WeakMap(),
    owned = [],
    commands = new WeakMap();
  const profile = (window.oceanComputeProfile = {
    supported: false,
    samples: [],
    errors: [],
    async flush() {
      await Promise.all(owned.flatMap((pool) => pool.map((slot) => slot.work)));
    },
    async dispose() {
      await this.flush();
      for (const pool of owned)
        for (const slot of pool) {
          slot.queries.destroy();
          slot.resolve.destroy();
          slot.read.destroy();
        }
      GPUDevice.prototype.createCommandEncoder = createEncoder;
      GPUQueue.prototype.submit = submit;
    },
  });
  GPUDevice.prototype.createCommandEncoder = function (descriptor) {
    const encoder = createEncoder.call(this, descriptor);
    if (
      descriptor?.label !== 'web-ocean simulation' ||
      !this.features.has('timestamp-query')
    )
      return encoder;
    profile.supported = true;
    let pool = pools.get(this);
    if (!pool) {
      pool = Array.from({ length: 3 }, () => ({
        queries: this.createQuerySet({ type: 'timestamp', count: 2 }),
        resolve: this.createBuffer({
          size: 16,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
          label: 'benchmark ocean timestamp resolve',
        }),
        read: this.createBuffer({
          size: 16,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          label: 'benchmark ocean timestamp read',
        }),
        pending: false,
        work: Promise.resolve(),
      }));
      pools.set(this, pool);
      owned.push(pool);
    }
    const slot = pool.find((slot) => !slot.pending);
    if (!slot) return encoder;
    slot.pending = true;
    const begin = encoder.beginComputePass,
      finish = encoder.finish;
    encoder.beginComputePass = function (descriptor) {
      return begin.call(this, {
        ...descriptor,
        timestampWrites: {
          querySet: slot.queries,
          beginningOfPassWriteIndex: 0,
          endOfPassWriteIndex: 1,
        },
      });
    };
    encoder.finish = function (descriptor) {
      this.resolveQuerySet(slot.queries, 0, 2, slot.resolve, 0);
      this.copyBufferToBuffer(slot.resolve, 0, slot.read, 0, 16);
      const command = finish.call(this, descriptor);
      commands.set(command, slot);
      return command;
    };
    return encoder;
  };
  GPUQueue.prototype.submit = function (iterable) {
    const buffers = Array.from(iterable),
      result = submit.call(this, buffers);
    for (const buffer of buffers) {
      const slot = commands.get(buffer);
      if (!slot) continue;
      commands.delete(buffer);
      slot.work = slot.read
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const timestamps = new BigUint64Array(slot.read.getMappedRange());
          profile.samples.push(Number(timestamps[1] - timestamps[0]) / 1e6);
          slot.read.unmap();
        })
        .catch((error) => profile.errors.push(String(error)))
        .finally(() => {
          slot.pending = false;
        });
    }
    return result;
  };
}
