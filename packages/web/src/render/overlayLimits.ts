/** First-release viewer budgets. Pressure acceptance exercises suppression and last-owner cleanup. */
export const OVERLAY_LIMITS = Object.freeze({
  activeFeatures: 512,
  curvePointsPerFeature: 65_536,
  curvePointsTotal: 200_000,
  curveDepth: 18,
  curveToleranceCssPixels: 0.5,
  maskPixels: 4096,
  mediaTexturePixels: 4096,
  mediaBytes: 128 * 1024 ** 2,
  downloadBytes: 64 * 1024 ** 2,
  mediaVersions: 32,
  parallelMediaLoads: 4,
});
