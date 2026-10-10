const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const quoted = '"(?:[\\t !#-\\[\\]-~]|\\\\[\\t -~])*"';
const mediaTypePattern = new RegExp(`^(?:${token}/${token}|\\*/\\*)(?:[ \\t]*;[ \\t]*${token}=(?:${token}|${quoted}))*$`);

// Retain the exact provider media spelling for adapter lookup and request headers.
export function parseJSONMediaTypes(input = '') {
  if (/[\r\n]/.test(input)) throw new Error(`Invalid JSON media type: ${input}`);
  const values = [];
  let start = 0;
  let inQuotes = false;
  let escaped = false;
  for (let index = 0; index <= input.length; index++) {
    const character = input[index];
    if (index === input.length || (character === ',' && !inQuotes)) {
      const value = input.slice(start, index).trim();
      if (value) {
        const base = value.split(';', 1)[0];
        if (!mediaTypePattern.test(value) || (base !== '*/*' && base.includes('*'))) {
          throw new Error(`Invalid JSON media type: ${value}`);
        }
        values.push(value);
      }
      start = index + 1;
    } else if (escaped) {
      escaped = false;
    } else if (inQuotes && character === '\\') {
      escaped = true;
    } else if (character === '"') {
      inQuotes = !inQuotes;
    }
  }
  return values;
}
