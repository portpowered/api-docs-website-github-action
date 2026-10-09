import { createCodeUsageGeneratorRegistry } from 'fumadocs-openapi/requests/generators';
import { registerDefault } from 'fumadocs-openapi/requests/generators/all';
import { curl } from 'fumadocs-openapi/requests/generators/curl';

// Some providers send JSON under a nonstandard media type. Keep the real header
// and body in both the playground and examples; aliases are explicitly opt-in.
export function createJSONMediaOptions(mediaTypes = []) {
  const mediaAdapters = Object.fromEntries(mediaTypes.map((name) => [name, jsonAdapter]));
  const codeUsages = registerDefault(createCodeUsageGeneratorRegistry());
  codeUsages.add('curl', {
    ...curl,
    generate(data) {
      if (Object.hasOwn(mediaAdapters, data.bodyMediaType)) {
        // The upstream cURL generator otherwise treats non-JSON object bodies as
        // XML. Encode the body once and quote it as a POSIX shell argument.
        const request = curl.generate({ ...data, body: undefined, bodyMediaType: undefined });
        const quoted = "'" + JSON.stringify(data.body, null, 2).replaceAll("'", "'\"'\"'") + "'";
        return request + ` \\\n  -H "Content-Type: ${data.bodyMediaType}" \\\n  --data-raw ${quoted}`;
      }
      return curl.generate(data);
    },
  });
  return { mediaAdapters, codeUsages };
}

const jsonAdapter = {
  encode({ body }) {
    return JSON.stringify(body);
  },
  generateExample({ body }, context) {
    const literal = JSON.stringify(JSON.stringify(body, null, 2));
    switch (context.lang) {
      case 'js': return `const body = ${literal};`;
      case 'python': return `body = ${literal}`;
      case 'go':
        context.addImport('strings');
        return `body := strings.NewReader(${literal})`;
      case 'java':
        context.addImport('java.net.http.HttpRequest.BodyPublishers');
        return `var body = BodyPublishers.ofString(${literal});`;
      case 'csharp': return `var body = new StringContent(${literal}, Encoding.UTF8);`;
      case 'rust': return `let body = ${literal};`;
      default: return undefined;
    }
  },
};
