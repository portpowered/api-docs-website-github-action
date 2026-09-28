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
