// PromptPay QR payload (Thai QR / EMVCo). id: mobile number, 13-digit national/tax ID or e-wallet ID.
const tlv = (id, value) => id + String(value.length).padStart(2, '0') + value;

function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function promptPayPayload(id, amount) {
  const digits = String(id || '').replace(/\D/g, '');
  let target;
  if (digits.length >= 15) target = tlv('03', digits);
  else if (digits.length >= 13) target = tlv('02', digits);
  else target = tlv('01', ('0000000000000' + digits.replace(/^0/, '66')).slice(-13));
  const amt = Number(amount);
  let payload = tlv('00', '01')
    + tlv('01', amt > 0 ? '12' : '11')
    + tlv('29', tlv('00', 'A000000677010111') + target)
    + tlv('58', 'TH')
    + tlv('53', '764')
    + (amt > 0 ? tlv('54', amt.toFixed(2)) : '');
  payload += '6304';
  return payload + crc16(payload);
}
