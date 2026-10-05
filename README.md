# API Docs Website GitHub Action

Generate a static API reference from OpenAPI, AsyncAPI, and GraphQL schema files, then publish it with GitHub Pages.

The action builds a static Next.js site with the default Fumadocs theme and the official Fumadocs OpenAPI and AsyncAPI integrations. Each operation has its own page with request and response details; supported media types also get Fumadocs schema views and code examples. Operations using `application/x-protobuf` get a static page that preserves the media type and links to binary schema components without generating payload bytes. GraphQL SDL is converted into navigable Fumadocs pages. The exported files run on GitHub Pages without a server.

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

The reusable workflow defaults `action-ref` to the current stable generator tag. Set `action-ref` to a verified full commit SHA when a docs change needs a specific generator revision; the workflow checks out that exact generator source and runs it locally.

## Composite action

Use the action in an existing workflow when deployment is managed separately:

```yaml
- uses: portpowered/api-docs-website-github-action@v0.3.1
  with:
    title: My Library API
    openapi: "api/openapi.yaml, api/admin/*.json"
    asyncapi: api/events.yaml
    graphql: "schema/**/*.graphql"
    graphql-bindings: docs/schema-bindings.yaml
    discover: false
    guides-directory: docs/guides
    base-path: /my-library
    output: api-docs-out
```

Inputs accept comma-separated paths or globs relative to `source-directory`. If no paths are given for a type, discovery recognizes OpenAPI and AsyncAPI documents by their `openapi` or `asyncapi` version field and includes `.graphql` and `.gql` files. Discovery skips common dependency and build directories. Set `discover: false` to use only explicitly listed files.

The optional `graphql-bindings` input points to a YAML or JSON manifest inside `source-directory`. It links GraphQL fields that use generic JSON scalars, OpenAPI operations with embedded or generic JSON bodies, and AsyncAPI operations with JSON-in-string schemas to named OpenAPI component schemas. The action generates reference pages from those components and adds links to the GraphQL type and matching operation pages. References are local to the source directory. Example:

Named schemas referenced by OpenAPI or AsyncAPI `contentSchema` declarations are also discovered automatically from the selected input documents. Their component pages render nested fields and alternatives, and matching operation pages link to the discovered schemas even when no binding manifest is supplied.

```yaml
graphql:
  - type: FeatureControlRequest
    field: payload
    title: Known control payload variants
    description: These named schemas document supported payload variants.
    schemas:
      - document: api/feature-controls.yaml
        component: SpeakerSetVolumePayload
        label: speaker.setVolume
openapi:
  - document: api/openapi.yaml
    path: /api/behaviors/preview
    method: post
    title: Embedded behavior sequence
    schemas:
      - document: api/behaviors.yaml
        component: Sequence
        label: Sequence
asyncapi:
  - document: api/asyncapi.yaml
    operationId: receiveDirectives
    title: Embedded resource metadata JSON
    description: The decoded JSON field is defined by this named component.
    schemas:
      - document: api/feature-events.yaml
        component: ResourceMetadataPayload
        label: Resource metadata
```

Every binding requires a title and at least one `{ document, component }` entry in `schemas`. GraphQL bindings also require the exact `type` and `field`; those names are checked against the supplied SDL documents. OpenAPI bindings require `document`, `path`, and `method`; AsyncAPI bindings require `document` and `operationId`. Both link to matching generated operation pages. Referenced named components and their nested named component dependencies receive generated pages, including declared examples and fields in JSON-in-string schemas.

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
