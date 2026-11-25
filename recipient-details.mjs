const limits = {employeeNumber:40, jobTitle:80, unit:120, email:254};

export function readRecipientDetails(input) {
  const details = {};
  for (const [field,max] of Object.entries(limits)) {
    const raw = input?.[field] ?? '';
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (value.length > max || /[\x00-\x1f]/.test(value)) return null;
    if (value) details[field] = value;
  }
  if (details.email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(details.email)) return null;
  return details;
}

export function recipientName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  return name.length <= 80 && !/[\x00-\x1f]/.test(name) ? name : '';
}
