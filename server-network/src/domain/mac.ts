/** MAC address normalization. MACs are identifiers only (spoofable) and are never treated as secrets. */
const HEX12 = /^[0-9A-F]{12}$/;

/** "aa-bb-cc-dd-ee-ff", "aabb.ccdd.eeff", "AABBCCDDEEFF" → "AA:BB:CC:DD:EE:FF"; null if invalid. */
export function normalizeMac(input: string): string | null {
  const hex = input.trim().toUpperCase().replace(/[:\-.\s]/g, '');
  if (!HEX12.test(hex)) return null;
  if (hex === '000000000000' || hex === 'FFFFFFFFFFFF') return null;
  return hex.match(/../g)!.join(':');
}
