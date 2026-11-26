/**
 * UK address parsing / extraction helpers for the Mistral replay script.
 * Shared and unit-tested.
 */

export const ADDRESSABLAB_UK = 'https://addresslab.net/zh/uk-address-generator/';

const zipRe = /^[A-Z]{2}\d[A-Z0-9 ]{2,7}$/;

/**
 * Parse an address string into billing.updateInfo fields.
 * Accepts:
 *   "1 Oxford St, London EC1A 1BB, United Kingdom"  (AddressLab style)
 *   "129 Union St, Aberdeen, AB10 1AB"               (HAR-captured style)
 *   "Aberdeen · AB10 1AB"                            (town · postcode style)
 */
export function parseAddress(s) {
  const clean = String(s).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const trySplit = (line1, rest) => {
    const m = rest.match(/^(.+?)[\s,]+([A-Z]{2}\d[A-Z0-9 ]{2,7})$/);
    if (m && zipRe.test(m[2])) return { address_line1: line1.trim(), city: m[1].trim(), zipcode: m[2].trim(), country: 'GB' };
    return null;
  };
  const noCountry = clean.replace(/[,\s]*(?:united kingdom|uk|great britain)[,\s]*$/i, '').replace(/^[\s,]+/, '');
  const parts = noCountry.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    const m2 = parts[0].match(/^([^·]+?)\s*·\s*([A-Z]{2}\d[A-Z0-9 ]{2,7})$/);
    if (m2 && zipRe.test(m2[2])) return { address_line1: m2[1].trim() + ' St', city: m2[1].trim(), zipcode: m2[2].trim(), country: 'GB' };
    const m3 = parts[0].match(/^(.*?),([A-Z]{2}\d[A-Z0-9 ]{2,7})$/);
    if (m3) return { address_line1: m3[1].trim(), city: m3[2].replace(/\s+/g, ''), zipcode: '', country: 'GB' };
    return { address_line1: parts[0], city: '', zipcode: '', country: 'GB' };
  }
  return trySplit(parts[0], parts.slice(1).join(' ')) ||
    { address_line1: parts[0].trim(), city: parts[1].trim(), zipcode: parts.slice(2).join(' ').trim(), country: 'GB' };
}

/** Extract the first parseable full address from AddressLab generator page HTML. */
export function extractAddressLab(html) {
  const strongs = [...new Set([...html.matchAll(/<strong>([^<]+)<\/strong>/g)].map(m => m[1].trim()))];
  for (const s of strongs) {
    const a = parseAddress(s);
    if (a && a.address_line1 && a.city && a.zipcode) return a;
  }
  return null;
}
