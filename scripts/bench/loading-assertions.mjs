import assert from 'node:assert/strict';

/** Independently decode the service's exact coverage protocol for quality checks. */
export function sourceCoverageFromResponse(payload) {
  assert.ok(Array.isArray(payload?.regions) && Array.isArray(payload?.chunks), 'invalid source coverage arrays');
  const chunks = new Set();
  const regions = new Map();
  for (const chunk of payload.chunks) {
    assert.ok(Number.isSafeInteger(chunk?.cx) && Number.isSafeInteger(chunk?.cz), 'invalid source chunk coordinate');
    chunks.add(`${chunk.cx},${chunk.cz}`);
  }
  for (const region of payload.regions) {
    assert.ok(Number.isSafeInteger(region?.x) && Number.isSafeInteger(region?.z), 'invalid source region coordinate');
    assert.ok(
      typeof region.mask === 'string' && /^[A-Za-z0-9+/]{171}=$/.test(region.mask),
      'invalid source region mask',
    );
    const mask = Buffer.from(region.mask, 'base64');
    assert.equal(mask.length, 128, 'invalid source region mask size');
    const key = `${region.x},${region.z}`;
    assert.ok(!regions.has(key), 'duplicate source region');
    regions.set(key, mask);
  }
  return { chunks, regions };
}

/** Check generated source cells using the service world ID, not the scoped diagnostic/cache identity. */
export function assertFullDetailCoverage(manager, world, sourceCoverage) {
  assert.ok(manager.world.endsWith(':' + world));
  const coverage = sourceCoverage.get(`${world}\0${manager.dimension}`);
  assert.ok(coverage, 'source coverage was not observed');
  const { center, fullDetailRadiusChunks } = manager.scheduling;
  assert.equal(fullDetailRadiusChunks, 8, 'default view distance lost its full-detail contract');
  const chunks = new Map(manager.chunks.map((c) => [`${c.cx},${c.cz}`, c]));
  for (const mask of coverage.regions.values())
    assert.ok(mask instanceof Uint8Array && mask.length === 128, 'invalid source region mask');
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
        if (!(mask[bit >> 3] & (1 << (bit & 7)))) continue;
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
