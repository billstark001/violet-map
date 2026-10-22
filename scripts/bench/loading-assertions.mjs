import assert from 'node:assert/strict';

/** Check generated source cells using the service world ID, not the scoped diagnostic/cache identity. */
export function assertFullDetailCoverage(manager, world, sourceCoverage) {
  assert.ok(manager.world.endsWith(':' + world));
  const coverage = sourceCoverage.get(`${world}\0${manager.dimension}`);
  assert.ok(coverage, 'source coverage was not observed');
  const { center, fullDetailRadiusChunks } = manager.scheduling;
  assert.equal(fullDetailRadiusChunks, 8, 'default view distance lost its full-detail contract');
  const chunks = new Map(manager.chunks.map((c) => [`${c.cx},${c.cz}`, c]));
  const hasMasks = [...coverage.regions.values()].some((mask) => mask && mask.length >= 128);
  for (let dx = -8; dx <= 8; dx++) {
    for (let dz = -8; dz <= 8; dz++) {
      if (dx * dx + dz * dz > 64) continue;
      const cx = center.cx + dx,
        cz = center.cz + dz;
      if (!coverage.chunks.has(`${cx},${cz}`)) {
        const regionKey = `${Math.floor(cx / 32)},${Math.floor(cz / 32)}`;
        if (!coverage.regions.has(regionKey)) continue;
        const mask = coverage.regions.get(regionKey);
        const bit = (cx & 31) + ((cz & 31) << 5);
        if (hasMasks && (!mask || !(mask[bit >> 3] & (1 << (bit & 7))))) continue;
      }
      const chunk = chunks.get(`${cx},${cz}`);
      assert.ok(chunk, `full-detail chunk ${cx},${cz} was never admitted`);
      assert.ok(
        chunk.state === 'absent' || chunk.displayed === 'full',
        `full-detail chunk ${cx},${cz} remained coarse`,
      );
    }
  }
}
