// Cheap heuristic device-tier detection — no WebGL capability probing, just
// enough signal to pick a sane default before the user overrides it in the HUD.
export function detectQualityTier() {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (isMobile || cores <= 4 || mem <= 4) return 'low';
  if (cores <= 8 || mem <= 8) return 'medium';
  return 'high';
}
