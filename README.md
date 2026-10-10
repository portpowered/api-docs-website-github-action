# API Docs Website GitHub Action

Generate a static API reference from OpenAPI, AsyncAPI, and GraphQL schema files, then publish it with GitHub Pages.

The action builds a static Next.js site with the default Fumadocs theme and the official Fumadocs OpenAPI and AsyncAPI integrations. Each operation has its own page with the integrations' schema views, request and response details, and code examples. GraphQL SDL is converted into navigable Fumadocs pages. The exported files run on GitHub Pages without a server.

## Reusable Pages workflow

Add a workflow to the library repository:

```yaml
name: API documentation

on:
  push:
    branches: [main]
    paths:
      - "api/**"
      - ".github/workflows/api-docs.yml"
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  publish:
    uses: portpowered/api-docs-website-github-action/.github/workflows/publish.yml@v0.3.1
    with:
      title: go-ring API Reference
      openapi: api/openapi.yaml
      asyncapi: api/asyncapi.yaml
      discover: false
      guides-directory: docs/guides
      base-path: /go-ring
```

The caller repository must enable GitHub Pages with **GitHub Actions** as the build and deployment source. The reusable workflow checks out the caller's source, generates the site, uploads the Pages artifact, and deploys it.

## Composite action

Use the action in an existing workflow when deployment is managed separately:

```yaml
- uses: portpowered/api-docs-website-github-action@v0.3.1
  with:
    title: My Library API
    openapi: "api/openapi.yaml, api/admin/*.json"
    asyncapi: api/events.yaml
    graphql: "schema/**/*.graphql"
    discover: false
    guides-directory: docs/guides
    base-path: /my-library
    output: api-docs-out
```

Inputs accept comma-separated paths or globs relative to `source-directory`. If no paths are given for a type, discovery recognizes OpenAPI and AsyncAPI documents by their `openapi` or `asyncapi` version field and includes `.graphql` and `.gql` files. Discovery skips common dependency and build directories. Set `discover: false` to use only explicitly listed files.

AsyncAPI 2 documents are adapted to AsyncAPI 3 only in the generated presentation;
the source files remain unchanged. Explicit operation IDs are preserved. Otherwise,
IDs combine `publish_` or `subscribe_` with the channel address, for example
`publish_v2_connection` for `/v2/{connection}`. Publish maps to application send;
subscribe maps to application receive. Duplicate IDs fail the build. Security AND,
anonymous and scoped requirements that cannot be preserved fail explicitly.
External AsyncAPI 2 channel/operation references also fail explicitly.
Local non-JSON payload references such as protobuf render their exact source text,
relative filename and schema format instead of an invented JSON schema. Ordinary
JSON payloads keep the default schema view.

OpenAPI and AsyncAPI presentation files share a derived local reference graph.
Actual schema references point to derived copies, preserving recursive schemas.
Inside vendor extensions, `$ref` becomes `x-documentation-reference` with the
exact original filename and fragment. This keeps provenance such as protobuf
enum references available without asking the JSON schema bundler to parse them.
The canonical contracts and wire values remain unchanged.

Use the optional `guides-directory` input to add Markdown or MDX guides alongside the generated API reference. The path is relative to `source-directory` and must point to a directory inside it. Its contents are copied to the Fumadocs `Guides` section at `/docs/guides`; nested pages, static assets, and an optional Fumadocs `meta.json` are preserved. For example:

```text
docs/guides/
├── meta.json       # optional section title and page order
├── enumerate.mdx
└── devices/
    └── turn-on.md
```

The optional `meta.json` is the normal Fumadocs folder metadata file. For example, `{ "title": "Device guides", "pages": ["enumerate", "devices/turn-on"] }` controls the section label and order. Guide files use Fumadocs' built-in Markdown/MDX renderer and supported components.

The `output` directory contains the static site and its assets. On GitHub Actions, the base path defaults to the repository name for project Pages sites. Set `base-path` explicitly for a custom path or a different hosting setup.

Some providers send a JSON request entity with a nonstandard Content-Type. Set
`json-media-types: plain/text` (or a comma-separated list) only when the checked-in
contract explicitly describes that behavior. The renderer keeps the original
media type in the reference, playground and generated requests while encoding
the body as JSON. This input is available on the composite action and reusable
workflow; other media types retain their default behavior.
Parameters are supported, for example
`json-media-types: 'plain/text,text/plain;charset=UTF-8,*/*'`. Keep the exact media
type spelling from the schema, including parameter values; generated Content-Type
headers preserve it. Fumadocs dispatches encoders by the normalized base media
type, so the JSON encoder also applies to other parameter variants of that base
type in the rendered schemas. Invalid media types and malformed
parameters fail before the site is generated.

For recursive contracts with nested `allOf`/`oneOf` constraints, set
`schema-view: references`. The reference renders the canonical conjunctions,
alternatives, required fields, examples and bounds without multiplying their
intersections. Named components appear once per body/response, with links to
their rendered anchors. Request snippets and the playground remain available;
TypeScript definitions are omitted in this mode. The default `native` view keeps
the standard Fumadocs tables. Static rendering uses two workers to bound CI load.
